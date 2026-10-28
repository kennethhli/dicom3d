from __future__ import annotations

import base64
import json
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydicom import dcmread

from app import main
from app.bundle import decode_bundle, encode_bundle
from app.datasets import SampleStore
from app.deid import deidentify_bytes

PHI_KEYWORDS = ("PatientBirthDate", "PatientAddress", "InstitutionName", "OtherPatientIDs", "StudyDate")


@pytest.fixture(scope="session")
def client(tmp_path_factory: pytest.TempPathFactory) -> TestClient:
    main.store = SampleStore(Path(tmp_path_factory.mktemp("data")))
    main._deidentified_series.cache_clear()
    return TestClient(main.app)


def test_bundle_roundtrip() -> None:
    files = [b"a", b"", b"\x00" * 1000]
    assert decode_bundle(encode_bundle(files)) == files


def test_list_datasets(client: TestClient) -> None:
    res = client.get("/api/datasets")
    assert res.status_code == 200
    ids = {d["id"] for d in res.json()}
    assert {"chest-ct", "head-ct", "hu-calibration"} <= ids


def test_bundle_is_deidentified_and_geometry_preserved(client: TestClient) -> None:
    res = client.get("/api/datasets/hu-calibration/bundle")
    assert res.status_code == 200
    files = decode_bundle(res.content)
    assert len(files) == int(res.headers["X-Slice-Count"]) == 64

    zs = []
    for raw in files:
        ds = dcmread(BytesIO(raw))
        assert str(ds.PatientName) == "ANONYMIZED"
        assert ds.PatientIdentityRemoved == "YES"
        for kw in PHI_KEYWORDS:
            assert kw not in ds
        assert not any(elem.tag.is_private for elem in ds)
        assert len(ds.ImagePositionPatient) == 3
        assert float(ds.PixelSpacing[0]) == pytest.approx(1.1)
        zs.append(float(ds.ImagePositionPatient[2]))
    assert np.allclose(np.diff(sorted(zs)), 2.5)
    assert len({dcmread(BytesIO(f)).SeriesInstanceUID for f in files}) == 1


def test_hounsfield_values_survive_deid(client: TestClient) -> None:
    res = client.get("/api/datasets/hu-calibration/slices/32")
    ds = dcmread(BytesIO(res.content))
    hu = ds.pixel_array.astype(np.float32) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
    centre = hu[ds.Rows // 2 - 3 : ds.Rows // 2 + 3, ds.Columns // 2 - 3 : ds.Columns // 2 + 3]
    assert abs(float(centre.mean())) < 15.0
    assert hu.min() == pytest.approx(-1024, abs=40)


def test_deid_report_lists_changes(client: TestClient) -> None:
    res = client.get("/api/datasets/chest-ct/deid-report", params={"index": 3})
    assert res.status_code == 200
    body = res.json()
    changed = {c["keyword"] for c in body["changes"]}
    assert {"PatientName", "PatientBirthDate", "InstitutionName"} <= changed
    assert "ImagePositionPatient" in body["preserved"]


def test_upload_deidentifies_and_rejects_garbage(client: TestClient) -> None:
    raw = main.store.get("hu-calibration").paths[0].read_bytes()
    res = client.post(
        "/api/deidentify",
        files=[("files", ("a.dcm", raw, "application/dicom")), ("files", ("notes.txt", b"hello", "text/plain"))],
    )
    assert res.status_code == 200
    report = json.loads(base64.b64decode(res.headers["X-Deid-Report"]))
    assert report["accepted"] == 1
    assert report["rejected"] == ["notes.txt"]
    assert all("original" not in c for c in report["changes"])
    ds = dcmread(BytesIO(decode_bundle(res.content)[0]))
    assert "PatientBirthDate" not in ds


def test_upload_requires_dicom(client: TestClient) -> None:
    res = client.post("/api/deidentify", files=[("files", ("x.txt", b"nope", "text/plain"))])
    assert res.status_code == 422


def test_unknown_dataset(client: TestClient) -> None:
    assert client.get("/api/datasets/nope/bundle").status_code == 404


def test_deid_is_deterministic() -> None:
    from app.datasets import _build_slice
    from app.phantoms import PHANTOMS

    spec = PHANTOMS["hu-calibration"]
    ds = _build_slice(spec, 0, 0.0, np.zeros((spec.rows, spec.cols), dtype=np.float32))
    buf = BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    a = dcmread(BytesIO(deidentify_bytes(buf.getvalue()).data))
    b = dcmread(BytesIO(deidentify_bytes(buf.getvalue()).data))
    assert a.SOPInstanceUID == b.SOPInstanceUID != ds.SOPInstanceUID
    assert a.PatientID == b.PatientID
