"""DICOM de-identification modelled on a subset of the PS3.15 Basic Application
Confidentiality Profile.

Pixel data and geometry (ImagePositionPatient, ImageOrientationPatient,
PixelSpacing, SliceLocation, SliceThickness, rescale tags) are preserved so the
volume can be reconstructed exactly. UIDs are remapped deterministically so
slices of one series still group together after anonymisation.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from io import BytesIO
from typing import Literal

from pydicom import dcmread
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ImplicitVRLittleEndian, PYDICOM_IMPLEMENTATION_UID, generate_uid

Action = Literal["removed", "replaced", "emptied"]

REMOVE_TAGS: tuple[str, ...] = (
    "PatientBirthDate",
    "PatientBirthTime",
    "PatientAddress",
    "PatientTelephoneNumbers",
    "PatientMotherBirthName",
    "OtherPatientIDs",
    "OtherPatientNames",
    "OtherPatientIDsSequence",
    "MilitaryRank",
    "EthnicGroup",
    "Occupation",
    "AdditionalPatientHistory",
    "PatientComments",
    "MedicalRecordLocator",
    "InstitutionName",
    "InstitutionAddress",
    "InstitutionalDepartmentName",
    "ReferringPhysicianAddress",
    "ReferringPhysicianTelephoneNumbers",
    "PerformingPhysicianName",
    "NameOfPhysiciansReadingStudy",
    "PhysiciansOfRecord",
    "OperatorsName",
    "RequestingPhysician",
    "StationName",
    "DeviceSerialNumber",
    "RequestAttributesSequence",
    "ImageComments",
    "StudyDate",
    "SeriesDate",
    "AcquisitionDate",
    "ContentDate",
    "StudyTime",
    "SeriesTime",
    "AcquisitionTime",
    "ContentTime",
    "AcquisitionDateTime",
    "PatientAge",
)

EMPTY_TAGS: tuple[str, ...] = (
    "ReferringPhysicianName",
    "AccessionNumber",
    "StudyID",
)

UID_TAGS: tuple[str, ...] = (
    "StudyInstanceUID",
    "SeriesInstanceUID",
    "SOPInstanceUID",
    "FrameOfReferenceUID",
)

PRESERVED_GEOMETRY_TAGS: tuple[str, ...] = (
    "ImagePositionPatient",
    "ImageOrientationPatient",
    "PixelSpacing",
    "SliceThickness",
    "SliceLocation",
    "RescaleSlope",
    "RescaleIntercept",
    "Rows",
    "Columns",
)


@dataclass(frozen=True)
class TagChange:
    keyword: str
    tag: str
    action: Action
    original: str | None = None


@dataclass
class DeidResult:
    data: bytes
    changes: list[TagChange] = field(default_factory=list)


def _pseudonym(value: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{value}".encode()).hexdigest()[:12].upper()


def _format(ds: Dataset, keyword: str) -> str:
    elem = ds.data_element(keyword)
    if elem is None:
        return ""
    if elem.VR == "SQ":
        return f"<sequence of {len(elem.value)} item(s)>"
    return str(elem.value)


def deidentify_dataset(ds: Dataset, salt: str = "dicom3d", keep_values: bool = False) -> list[TagChange]:
    """Mutates ``ds`` in place and returns the list of changes.

    ``keep_values`` records the original values in the report; only enable it for
    synthetic data, never for real uploads.
    """
    changes: list[TagChange] = []

    def record(keyword: str, action: Action) -> None:
        tag = ds.data_element(keyword).tag  # type: ignore[union-attr]
        changes.append(
            TagChange(
                keyword=keyword,
                tag=f"({tag.group:04X},{tag.element:04X})",
                action=action,
                original=_format(ds, keyword) if keep_values else None,
            )
        )

    if "PatientName" in ds:
        record("PatientName", "replaced")
    if "PatientID" in ds:
        record("PatientID", "replaced")
    original_id = str(ds.get("PatientID", ""))
    ds.PatientName = "ANONYMIZED"
    ds.PatientID = f"ANON-{_pseudonym(original_id, salt)}" if original_id else "ANON"

    for keyword in REMOVE_TAGS:
        if keyword in ds:
            record(keyword, "removed")
            del ds[keyword]

    for keyword in EMPTY_TAGS:
        if keyword in ds and ds.data_element(keyword).value not in ("", None):  # type: ignore[union-attr]
            record(keyword, "emptied")
            setattr(ds, keyword, "")

    for keyword in UID_TAGS:
        if keyword in ds:
            record(keyword, "replaced")
            setattr(ds, keyword, generate_uid(entropy_srcs=[salt, str(ds.data_element(keyword).value)]))  # type: ignore[union-attr]

    if hasattr(ds, "file_meta") and "SOPInstanceUID" in ds:
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID

    private_tags = [elem.tag for elem in ds if elem.tag.is_private]
    if private_tags:
        changes.append(TagChange(keyword=f"{len(private_tags)} private tag(s)", tag="(gggg,xxxx)", action="removed"))
        ds.remove_private_tags()

    for group in range(0x6000, 0x601F, 2):
        overlay = [elem.tag for elem in ds if elem.tag.group == group]
        for tag in overlay:
            del ds[tag]

    ds.PatientIdentityRemoved = "YES"
    ds.DeidentificationMethod = "DICOM3D Basic Profile (PS3.15 subset); geometry retained"
    return changes


class NotDicomError(ValueError):
    pass


def _ensure_file_meta(ds: Dataset) -> None:
    meta = ds.file_meta if hasattr(ds, "file_meta") else FileMetaDataset()
    if "TransferSyntaxUID" not in meta:
        meta.TransferSyntaxUID = ImplicitVRLittleEndian
    if "SOPClassUID" in ds:
        meta.MediaStorageSOPClassUID = ds.SOPClassUID
    if "SOPInstanceUID" in ds:
        meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    meta.ImplementationClassUID = PYDICOM_IMPLEMENTATION_UID
    ds.file_meta = meta


def deidentify_bytes(raw: bytes, salt: str = "dicom3d", keep_values: bool = False) -> DeidResult:
    try:
        ds = dcmread(BytesIO(raw), force=True)
    except Exception as exc:  # pydicom raises a wide range of errors on garbage input
        raise NotDicomError(str(exc)) from exc
    if "PixelData" not in ds or "Rows" not in ds:
        raise NotDicomError("file has no image pixel data")
    changes = deidentify_dataset(ds, salt=salt, keep_values=keep_values)
    _ensure_file_meta(ds)
    out = BytesIO()
    ds.save_as(out, enforce_file_format=True)
    return DeidResult(data=out.getvalue(), changes=changes)
