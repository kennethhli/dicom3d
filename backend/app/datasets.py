"""Builds the sample DICOM series on disk and serves them from a cache."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, PYDICOM_IMPLEMENTATION_UID, generate_uid

from .phantoms import PHANTOMS, PhantomSpec

HU_INTERCEPT = -1024.0
STORED_MAX = 4095


@dataclass(frozen=True)
class SeriesFiles:
    spec: PhantomSpec
    paths: tuple[Path, ...]


def _uid(*parts: str) -> str:
    return generate_uid(entropy_srcs=["dicom3d", *parts])


def _build_slice(spec: PhantomSpec, index: int, z: float, hu: np.ndarray) -> Dataset:
    """Create one CT slice. Patient tags are populated with synthetic PHI on purpose so
    the de-identification path has something real to strip."""
    study_uid = _uid(spec.id, "study")
    series_uid = _uid(spec.id, "series")
    sop_uid = _uid(spec.id, "sop", str(index))

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = PYDICOM_IMPLEMENTATION_UID

    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.FrameOfReferenceUID = _uid(spec.id, "for")

    ds.PatientName = "DOE^JANE^Q"
    ds.PatientID = "MRN-00428817"
    ds.PatientBirthDate = "19670412"
    ds.PatientSex = "F"
    ds.PatientAge = "059Y"
    ds.PatientAddress = "1200 Harbor Blvd, Springfield"
    ds.PatientTelephoneNumbers = "555-0142"
    ds.OtherPatientIDs = "SSN-123-45-6789"
    ds.InstitutionName = "Springfield General Hospital"
    ds.InstitutionAddress = "500 Medical Center Dr, Springfield"
    ds.ReferringPhysicianName = "HOUSE^GREGORY"
    ds.PerformingPhysicianName = "CUDDY^LISA"
    ds.OperatorsName = "TECH^ALEX"
    ds.AccessionNumber = "ACC20260314001"
    ds.StudyID = "S-77821"
    ds.StationName = "CT-SCANNER-03"

    now = datetime(2026, 3, 14, 9, 26, 53)
    ds.StudyDate = ds.SeriesDate = ds.AcquisitionDate = ds.ContentDate = now.strftime("%Y%m%d")
    ds.StudyTime = ds.SeriesTime = ds.AcquisitionTime = ds.ContentTime = now.strftime("%H%M%S")
    ds.StudyDescription = f"{spec.body_part} CT"
    ds.SeriesDescription = spec.name
    ds.Modality = "CT"
    ds.Manufacturer = "DICOM3D Synthetic"
    ds.ManufacturerModelName = "Procedural Phantom v1"
    ds.BodyPartExamined = spec.body_part
    ds.KVP = "120"
    ds.SeriesNumber = 2
    ds.InstanceNumber = index + 1
    ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]

    ox, oy = spec.origin_mm()
    ds.ImagePositionPatient = [f"{ox:.3f}", f"{oy:.3f}", f"{z:.3f}"]
    ds.ImageOrientationPatient = ["1", "0", "0", "0", "1", "0"]
    ds.SliceLocation = f"{z:.3f}"
    ds.SliceThickness = f"{spec.slice_thickness_mm:.3f}"
    ds.PixelSpacing = [f"{spec.pixel_spacing_mm:.4f}", f"{spec.pixel_spacing_mm:.4f}"]

    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = spec.rows
    ds.Columns = spec.cols
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.RescaleIntercept = f"{HU_INTERCEPT:.0f}"
    ds.RescaleSlope = "1"
    ds.RescaleType = "HU"
    ds.WindowCenter = f"{spec.window_center:.0f}"
    ds.WindowWidth = f"{spec.window_width:.0f}"

    private = ds.private_block(0x0011, "DICOM3D SITE NOTES", create=True)
    private.add_new(0x01, "LO", "Pt. Jane Doe, call before results")

    stored = np.clip(np.rint(hu - HU_INTERCEPT), 0, STORED_MAX).astype(np.uint16)
    ds.PixelData = stored.tobytes()
    return ds


class SampleStore:
    """Lazily materialises phantom series as .dcm files under ``root``."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._locks = {pid: threading.Lock() for pid in PHANTOMS}

    def specs(self) -> list[PhantomSpec]:
        return list(PHANTOMS.values())

    def get(self, dataset_id: str) -> SeriesFiles:
        spec = PHANTOMS.get(dataset_id)
        if spec is None:
            raise KeyError(dataset_id)
        series_dir = self.root / spec.id
        with self._locks[spec.id]:
            paths = sorted(series_dir.glob("*.dcm"))
            if len(paths) != spec.slices:
                paths = self._generate(spec, series_dir)
        return SeriesFiles(spec=spec, paths=tuple(paths))

    def _generate(self, spec: PhantomSpec, series_dir: Path) -> list[Path]:
        series_dir.mkdir(parents=True, exist_ok=True)
        for stale in series_dir.glob("*.dcm"):
            stale.unlink()
        paths: list[Path] = []
        for index, (z, hu) in enumerate(zip(spec.z_positions(), spec.generator(spec))):
            path = series_dir / f"IM{index + 1:04d}.dcm"
            ds = _build_slice(spec, index, float(z), hu)
            tmp = path.with_suffix(".tmp")
            ds.save_as(tmp, enforce_file_format=True)
            tmp.replace(path)
            paths.append(path)
        return paths
