from __future__ import annotations

import base64
import json
import os
import threading
from contextlib import asynccontextmanager
from collections import Counter
from dataclasses import asdict
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from pydicom import dcmread

from .bundle import MEDIA_TYPE, encode_bundle
from .datasets import SampleStore
from .deid import NotDicomError, TagChange, deidentify_bytes
from .remote import DatasetUnavailable

DATA_DIR = Path(os.environ.get("DICOM3D_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
MAX_UPLOAD_FILES = int(os.environ.get("DICOM3D_MAX_UPLOAD_FILES", "1500"))
MAX_UPLOAD_BYTES = int(os.environ.get("DICOM3D_MAX_UPLOAD_BYTES", str(768 * 1024 * 1024)))
CORS_ORIGINS = [o for o in os.environ.get("DICOM3D_CORS_ORIGINS", "*").split(",") if o]

store = SampleStore(DATA_DIR / "samples")


def _warm_samples() -> None:
    for spec in store.specs():
        try:
            store.get(spec.id)
        except Exception:  # warming is best-effort; requests will retry generation
            pass


@asynccontextmanager
async def lifespan(_: FastAPI):
    if os.environ.get("DICOM3D_WARM_SAMPLES", "1") == "1":
        threading.Thread(target=_warm_samples, name="warm-samples", daemon=True).start()
    yield


app = FastAPI(
    lifespan=lifespan,
    title="DICOM3D API",
    version="1.0.0",
    description="Serves de-identified DICOM series for browser-side volumetric rendering.",
)
app.add_middleware(GZipMiddleware, minimum_size=4096, compresslevel=5)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=["X-Slice-Count", "X-Deid-Report", "X-Deid-Changes"],
)


class DatasetInfo(BaseModel):
    id: str
    name: str
    description: str
    body_part: str
    modality: str
    rows: int
    cols: int
    slices: int
    pixel_spacing_mm: float
    slice_thickness_mm: float
    window_center: float
    window_width: float
    source: str
    attribution: str | None = None
    license_url: str | None = None
    cached: bool


class TagChangeOut(BaseModel):
    keyword: str
    tag: str
    action: str
    original: str | None = None


class HeaderComparison(BaseModel):
    dataset_id: str
    slice_index: int
    changes: list[TagChangeOut]
    preserved: dict[str, str]


class UploadSummary(BaseModel):
    accepted: int
    rejected: list[str]
    changes: list[dict[str, str | int]]


@lru_cache(maxsize=4)
def _deidentified_series(dataset_id: str) -> tuple[bytes, int]:
    series = store.get(dataset_id)
    files = [deidentify_bytes(p.read_bytes()).data for p in series.paths]
    return encode_bundle(files), len(files)


def _spec_or_404(dataset_id: str):
    try:
        return store.get(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown dataset '{dataset_id}'") from None
    except DatasetUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


def _summarise(changes: list[TagChange]) -> list[dict[str, str | int]]:
    counts = Counter((c.keyword, c.tag, c.action) for c in changes)
    return [
        {"keyword": k, "tag": t, "action": a, "count": n}
        for (k, t, a), n in sorted(counts.items(), key=lambda item: item[0][1])
    ]


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/datasets", response_model=list[DatasetInfo])
def list_datasets() -> list[DatasetInfo]:
    return [
        DatasetInfo(
            id=s.id,
            name=s.name,
            description=s.description,
            body_part=s.body_part,
            modality="CT",
            rows=s.rows,
            cols=s.cols,
            slices=s.slices,
            pixel_spacing_mm=s.pixel_spacing_mm,
            slice_thickness_mm=s.slice_thickness_mm,
            window_center=s.window_center,
            window_width=s.window_width,
            source=getattr(s, "source", "synthetic"),
            attribution=getattr(s, "attribution", None),
            license_url=getattr(s, "license_url", None),
            cached=store.is_cached(s.id),
        )
        for s in store.specs()
    ]


@app.get("/api/datasets/{dataset_id}/bundle")
async def dataset_bundle(dataset_id: str) -> Response:
    """All slices of a series, de-identified, packed into one binary bundle."""
    await run_in_threadpool(_spec_or_404, dataset_id)
    payload, count = await run_in_threadpool(_deidentified_series, dataset_id)
    return Response(
        content=payload,
        media_type=MEDIA_TYPE,
        headers={"X-Slice-Count": str(count), "Cache-Control": "public, max-age=3600"},
    )


@app.get("/api/datasets/{dataset_id}/slices/{index}")
async def dataset_slice(dataset_id: str, index: int) -> Response:
    series = await run_in_threadpool(_spec_or_404, dataset_id)
    if not 0 <= index < len(series.paths):
        raise HTTPException(status_code=404, detail="Slice index out of range")
    result = await run_in_threadpool(deidentify_bytes, series.paths[index].read_bytes())
    return Response(
        content=result.data,
        media_type="application/dicom",
        headers={"Content-Disposition": f'attachment; filename="{dataset_id}-{index + 1:04d}.dcm"'},
    )


@app.get("/api/datasets/{dataset_id}/deid-report", response_model=HeaderComparison)
async def deid_report(dataset_id: str, index: Annotated[int, Query(ge=0)] = 0) -> HeaderComparison:
    """What the de-identifier changed on one slice. Original values are only echoed for
    synthetic phantoms; real series and uploads report tag names only."""
    series = await run_in_threadpool(_spec_or_404, dataset_id)
    if index >= len(series.paths):
        raise HTTPException(status_code=404, detail="Slice index out of range")
    raw = series.paths[index].read_bytes()
    synthetic = getattr(series.spec, "source", "synthetic") == "synthetic"
    result = await run_in_threadpool(deidentify_bytes, raw, "dicom3d", synthetic)
    ds = dcmread(BytesIO(result.data))
    preserved = {
        kw: str(ds.data_element(kw).value)  # type: ignore[union-attr]
        for kw in ("ImagePositionPatient", "ImageOrientationPatient", "PixelSpacing", "SliceThickness",
                   "SliceLocation", "RescaleSlope", "RescaleIntercept", "PatientIdentityRemoved")
        if kw in ds
    }
    return HeaderComparison(
        dataset_id=dataset_id,
        slice_index=index,
        changes=[TagChangeOut(**asdict(c)) for c in result.changes],
        preserved=preserved,
    )


@app.post("/api/deidentify")
async def deidentify_upload(files: Annotated[list[UploadFile], File(description="DICOM Part 10 files")]) -> Response:
    """De-identifies uploaded slices and returns them as a bundle. A JSON summary of the
    changes (tag names and counts only, never values) is returned in X-Deid-Report."""
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(status_code=413, detail=f"At most {MAX_UPLOAD_FILES} files per upload")

    accepted: list[bytes] = []
    rejected: list[str] = []
    changes: list[TagChange] = []
    total = 0
    for upload in files:
        raw = await upload.read()
        total += len(raw)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Upload too large")
        try:
            result = await run_in_threadpool(deidentify_bytes, raw)
        except NotDicomError:
            rejected.append(upload.filename or "unnamed")
            continue
        accepted.append(result.data)
        changes.extend(result.changes)

    if not accepted:
        raise HTTPException(status_code=422, detail="None of the uploaded files contained DICOM image data")

    summary = UploadSummary(accepted=len(accepted), rejected=rejected[:50], changes=_summarise(changes))
    report = base64.b64encode(json.dumps(summary.model_dump()).encode()).decode()
    return Response(
        content=encode_bundle(accepted),
        media_type=MEDIA_TYPE,
        headers={"X-Slice-Count": str(len(accepted)), "X-Deid-Report": report},
    )
