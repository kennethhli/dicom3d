"""Real, publicly licensed DICOM series fetched on demand from The Cancer Imaging Archive.

Files are downloaded once into the data directory and then served like the
synthetic phantoms, so they pass through the same de-identification path.
"""

from __future__ import annotations

import shutil
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

TCIA_IMAGE_URL = "https://services.cancerimagingarchive.net/nbia-api/services/v1/getImage?SeriesInstanceUID={uid}"
DOWNLOAD_TIMEOUT_S = 120
COMPLETE_MARKER = ".complete"


class DatasetUnavailable(RuntimeError):
    """The series could not be downloaded (offline, archive down, bad payload)."""


@dataclass(frozen=True)
class RemoteSpec:
    id: str
    name: str
    description: str
    body_part: str
    rows: int
    cols: int
    slices: int
    pixel_spacing_mm: float
    slice_thickness_mm: float
    window_center: float
    window_width: float
    url: str
    attribution: str
    license_url: str
    source: str = "tcia"


def download_series(spec: RemoteSpec, series_dir: Path) -> list[Path]:
    """Download and unpack a zipped series into ``series_dir`` atomically."""
    series_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f"{spec.id}-", dir=series_dir.parent))
    try:
        archive = staging / "series.zip"
        try:
            with urllib.request.urlopen(spec.url, timeout=DOWNLOAD_TIMEOUT_S) as res, archive.open("wb") as out:
                shutil.copyfileobj(res, out, length=1 << 20)
        except OSError as exc:
            raise DatasetUnavailable(f"Could not download {spec.name}: {exc}") from exc

        try:
            with zipfile.ZipFile(archive) as zf:
                members = [m for m in zf.infolist() if m.filename.lower().endswith(".dcm") and not m.is_dir()]
                if not members:
                    raise DatasetUnavailable(f"{spec.name}: archive contained no DICOM files")
                for i, member in enumerate(sorted(members, key=lambda m: m.filename)):
                    # Flatten paths so a hostile archive cannot write outside the staging dir.
                    target = staging / f"IM{i + 1:04d}.dcm"
                    with zf.open(member) as src, target.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
        except zipfile.BadZipFile as exc:
            raise DatasetUnavailable(f"{spec.name}: archive is corrupt") from exc
        archive.unlink()
        (staging / COMPLETE_MARKER).touch()

        if series_dir.exists():
            shutil.rmtree(series_dir)
        staging.replace(series_dir)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return sorted(series_dir.glob("*.dcm"))


def cached_series(series_dir: Path) -> list[Path] | None:
    if not (series_dir / COMPLETE_MARKER).exists():
        return None
    return sorted(series_dir.glob("*.dcm"))


REMOTE_DATASETS: dict[str, RemoteSpec] = {
    spec.id: spec
    for spec in (
        RemoteSpec(
            id="lidc-chest-ct",
            name="Real Chest CT · LIDC-IDRI-0001",
            description="Low-dose thoracic CT from the LIDC-IDRI lung nodule study (The Cancer Imaging Archive).",
            body_part="CHEST",
            rows=512,
            cols=512,
            slices=133,
            pixel_spacing_mm=0.703125,
            slice_thickness_mm=2.5,
            window_center=-600.0,
            window_width=1500.0,
            url=TCIA_IMAGE_URL.format(uid="1.3.6.1.4.1.14519.5.2.1.6279.6001.179049373636438705059720603192"),
            attribution=(
                "Armato SG III, et al. Data from LIDC-IDRI. The Cancer Imaging Archive. "
                "https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX"
            ),
            license_url="https://creativecommons.org/licenses/by/3.0/",
        ),
    )
}
