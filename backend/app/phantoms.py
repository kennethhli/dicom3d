"""Procedural CT phantoms used as built-in sample datasets.

Each generator yields one axial slice at a time as a float32 array of
Hounsfield Units with shape (rows, cols). Coordinates follow the DICOM
patient (LPS) system: +x towards patient left, +y posterior, +z superior.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterator

import numpy as np

HU_AIR = -1000.0
HU_LUNG = -860.0
HU_FAT = -100.0
HU_WATER = 0.0
HU_MUSCLE = 50.0
HU_BLOOD_CONTRAST = 260.0
HU_CANCELLOUS = 320.0
HU_CORTICAL = 1100.0


@dataclass(frozen=True)
class PhantomSpec:
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
    generator: Callable[["PhantomSpec"], Iterator[np.ndarray]] = field(repr=False)

    def z_positions(self) -> np.ndarray:
        half = (self.slices - 1) / 2.0
        return (np.arange(self.slices) - half) * self.slice_thickness_mm

    def grid(self) -> tuple[np.ndarray, np.ndarray]:
        """Pixel-centre coordinates in mm, centred on the isocentre."""
        xs = (np.arange(self.cols) - (self.cols - 1) / 2.0) * self.pixel_spacing_mm
        ys = (np.arange(self.rows) - (self.rows - 1) / 2.0) * self.pixel_spacing_mm
        return np.meshgrid(xs, ys)

    def origin_mm(self) -> tuple[float, float]:
        return (
            -(self.cols - 1) / 2.0 * self.pixel_spacing_mm,
            -(self.rows - 1) / 2.0 * self.pixel_spacing_mm,
        )


def _ellipse(x: np.ndarray, y: np.ndarray, cx: float, cy: float, a: float, b: float) -> np.ndarray:
    return ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1.0


def _ellipsoid_section(
    x: np.ndarray, y: np.ndarray, z: float, c: tuple[float, float, float], r: tuple[float, float, float]
) -> np.ndarray:
    dz = (z - c[2]) / r[2]
    if abs(dz) >= 1.0:
        return np.zeros_like(x, dtype=bool)
    k = np.sqrt(1.0 - dz * dz)
    return _ellipse(x, y, c[0], c[1], r[0] * k, r[1] * k)


def _segment_mask(
    x: np.ndarray, y: np.ndarray, p0: tuple[float, float], p1: tuple[float, float], radius: float
) -> np.ndarray:
    px, py = p1[0] - p0[0], p1[1] - p0[1]
    denom = px * px + py * py or 1.0
    t = np.clip(((x - p0[0]) * px + (y - p0[1]) * py) / denom, 0.0, 1.0)
    dx = x - (p0[0] + t * px)
    dy = y - (p0[1] + t * py)
    return dx * dx + dy * dy <= radius * radius


def _chest(spec: PhantomSpec) -> Iterator[np.ndarray]:
    rng = np.random.default_rng(42)
    x, y = spec.grid()
    zs = spec.z_positions()
    z_extent = zs[-1]

    # Pulmonary vessels: straight tubes radiating from each hilum.
    vessels: list[tuple[np.ndarray, np.ndarray, float]] = []
    for side in (-1.0, 1.0):
        hilum = np.array([side * 32.0, 5.0, 10.0])
        for _ in range(46):
            direction = rng.normal(size=3)
            direction[0] = abs(direction[0]) * side * 1.4
            direction /= np.linalg.norm(direction)
            length = rng.uniform(45.0, 120.0)
            vessels.append((hilum, hilum + direction * length, rng.uniform(1.6, 3.4)))

    for z in zs:
        t = z / z_extent
        img = np.full(x.shape, HU_AIR, dtype=np.float32)

        body_a = 165.0 * (1.0 - 0.06 * t * t)
        body_b = 112.0
        body = _ellipse(x, y, 0.0, 0.0, body_a, body_b)
        img[body] = HU_FAT
        muscle = _ellipse(x, y, 0.0, 0.0, body_a - 14.0, body_b - 12.0)
        img[muscle] = HU_MUSCLE

        # Lungs taper at the apex and are cut by the domed diaphragm.
        apex_scale = np.clip((1.0 - t) / 0.45, 0.0, 1.0) ** 0.5 if t > 0.55 else 1.0
        for side, dome in ((-1.0, -0.62), (1.0, -0.72)):
            if t < dome:
                continue
            base_scale = np.clip((t - dome) / 0.2, 0.0, 1.0) ** 0.5
            s = float(apex_scale * base_scale)
            if s <= 0.05:
                continue
            lung = _ellipse(x, y, side * 68.0, 0.0, 52.0 * s, 74.0 * s)
            mediastinum = _ellipse(x, y, 0.0, -18.0, 34.0, 70.0)
            lung &= ~mediastinum
            img[lung] = HU_LUNG

        # Trachea and main bronchi.
        if t > -0.05:
            img[_ellipse(x, y, 0.0, -30.0 + 18.0 * t, 9.0, 8.0)] = HU_AIR
        elif t > -0.2:
            k = (t + 0.2) / 0.15
            for side in (-1.0, 1.0):
                img[_ellipse(x, y, side * 20.0 * (1.0 - k), -30.0, 6.0, 6.0)] = HU_AIR

        for p0, p1, r in vessels:
            if (z - p0[2]) * (z - p1[2]) > 0:
                continue
            dz = p1[2] - p0[2]
            frac = 0.0 if abs(dz) < 1e-6 else (z - p0[2]) / dz
            cx = p0[0] + frac * (p1[0] - p0[0])
            cy = p0[1] + frac * (p1[1] - p0[1])
            radius = r * (1.0 - 0.6 * frac)
            m = _ellipse(x, y, cx, cy, radius, radius) & (img < -500)
            img[m] = 40.0

        # Heart with contrast-filled chambers.
        heart_c = (18.0, -38.0, -55.0)
        heart = _ellipsoid_section(x, y, z, heart_c, (58.0, 46.0, 52.0))
        img[heart] = HU_MUSCLE
        for cx, cy, rx in ((-4.0, -30.0, 20.0), (34.0, -44.0, 22.0)):
            img[_ellipsoid_section(x, y, z, (cx, cy, heart_c[2]), (rx, 18.0, 34.0))] = HU_BLOOD_CONTRAST

        # Aorta: ascending limb, arch and descending limb next to the spine.
        if -40.0 < z < 95.0:
            img[_ellipse(x, y, 6.0, -26.0, 14.0, 14.0)] = HU_BLOOD_CONTRAST
        if z < 105.0:
            img[_ellipse(x, y, 24.0, 38.0, 12.0, 12.0)] = HU_BLOOD_CONTRAST
        if 85.0 <= z <= 110.0:
            img[_segment_mask(x, y, (6.0, -26.0), (24.0, 38.0), 13.0)] = HU_BLOOD_CONTRAST

        # Spine: vertebral bodies separated by discs, canal and posterior elements.
        in_disc = (z % 26.0) < 5.0
        body_r = 19.0
        vb = _ellipse(x, y, 0.0, 62.0, body_r, body_r * 0.85)
        img[vb] = 80.0 if in_disc else HU_CANCELLOUS
        if not in_disc:
            shell = vb & ~_ellipse(x, y, 0.0, 62.0, body_r - 3.0, body_r * 0.85 - 3.0)
            img[shell] = HU_CORTICAL * 0.8
            arch = _ellipse(x, y, 0.0, 88.0, 15.0, 13.0) & ~_ellipse(x, y, 0.0, 88.0, 8.5, 7.5)
            img[arch] = HU_CORTICAL * 0.75
            img[_segment_mask(x, y, (0.0, 98.0), (0.0, 116.0), 4.0)] = HU_CORTICAL * 0.7
            for side in (-1.0, 1.0):
                img[_segment_mask(x, y, (side * 10.0, 84.0), (side * 30.0, 78.0), 4.5)] = HU_CORTICAL * 0.7
        img[_ellipse(x, y, 0.0, 88.0, 8.0, 7.0)] = 20.0

        # Ribs: inclined bands on an ellipse just inside the muscle wall.
        ra, rb = body_a - 24.0, body_b - 20.0
        r_norm = np.sqrt((x / ra) ** 2 + (y / rb) ** 2)
        theta = np.arctan2(y / rb, x / ra)
        near_shell = np.abs(r_norm - 1.0) * rb < 4.5
        for i in range(12):
            z0 = z_extent * 0.85 - i * 22.0
            z_rib = z0 - 38.0 * (1.0 - np.sin(theta)) / 2.0
            rib = near_shell & (np.abs(z - z_rib) < 5.0) & ~((np.abs(x) < 24.0) & (y < 0))
            img[rib] = HU_CORTICAL
        if -110.0 < z < 110.0:
            img[(np.abs(x) < 16.0) & (y > -body_b + 8.0) & (y < -body_b + 20.0)] = HU_CORTICAL * 0.6

        # Scapulae on the posterior chest wall.
        if z > -40.0:
            for side in (-1.0, 1.0):
                img[_segment_mask(x, y, (side * 60.0, 92.0), (side * 118.0, 70.0), 4.0)] = HU_CORTICAL * 0.85

        # Patient table beneath the body.
        table = (y > body_b + 10.0) & (y < body_b + 20.0) & (np.abs(x) < 190.0)
        img[table] = 250.0

        noise = rng.normal(0.0, 14.0, size=img.shape).astype(np.float32)
        img += np.where(img > -950, noise, noise * 0.3)
        yield img


def _head(spec: PhantomSpec) -> Iterator[np.ndarray]:
    rng = np.random.default_rng(7)
    x, y = spec.grid()
    for z in spec.z_positions():
        img = np.full(x.shape, HU_AIR, dtype=np.float32)
        c = (0.0, 0.0, 0.0)
        scalp = _ellipsoid_section(x, y, z, c, (78.0, 98.0, 88.0))
        img[scalp] = 40.0
        skull = _ellipsoid_section(x, y, z, c, (74.0, 94.0, 84.0))
        img[skull] = HU_CORTICAL * 1.2
        inner = _ellipsoid_section(x, y, z, c, (67.0, 87.0, 77.0))
        img[inner] = 18.0
        brain = _ellipsoid_section(x, y, z, c, (65.0, 85.0, 75.0))
        img[brain] = 40.0
        white = _ellipsoid_section(x, y, z, (0.0, 0.0, 10.0), (52.0, 68.0, 52.0))
        img[white] = 27.0
        img[brain & (np.abs(x) < 1.6)] = 15.0
        for side in (-1.0, 1.0):
            ventricle = _ellipsoid_section(x, y, z, (side * 11.0, -4.0, 16.0), (6.0, 26.0, 11.0))
            img[ventricle] = 5.0
            img[_ellipsoid_section(x, y, z, (side * 24.0, 8.0, 0.0), (9.0, 7.0, 8.0))] = 45.0

        if z < -24.0:
            # Below the skull base the cranial cavity is replaced by facial soft tissue.
            img[inner] = 45.0
            base = _ellipsoid_section(x, y, z, c, (70.0, 90.0, 80.0)) & ~_ellipsoid_section(
                x, y, z, c, (62.0, 82.0, 72.0)
            )
            img[base & (y > -40.0)] = HU_CORTICAL
        face = _ellipsoid_section(x, y, z, (0.0, -32.0, -62.0), (54.0, 62.0, 44.0))
        img[face & (img < -500)] = 40.0
        for side in (-1.0, 1.0):
            img[_ellipsoid_section(x, y, z, (side * 31.0, -80.0, -26.0), (12.0, 12.0, 12.0))] = 12.0
            img[_ellipsoid_section(x, y, z, (side * 31.0, -91.0, -26.0), (4.5, 2.0, 4.5))] = 120.0
            img[_ellipsoid_section(x, y, z, (side * 24.0, -64.0, -58.0), (14.0, 16.0, 15.0))] = -950.0
        img[_ellipsoid_section(x, y, z, (0.0, -78.0, -10.0), (14.0, 9.0, 8.0))] = -950.0
        if z < -60.0:
            jaw_outer = _ellipse(x, y, 0.0, -38.0, 52.0, 55.0)
            jaw_inner = _ellipse(x, y, 0.0, -30.0, 44.0, 49.0)
            img[jaw_outer & ~jaw_inner & (y < 10.0)] = HU_CORTICAL
        neck = _ellipsoid_section(x, y, z, (0.0, 22.0, -120.0), (44.0, 42.0, 70.0))
        img[neck & (img < 100)] = HU_MUSCLE
        if z < -60.0:
            img[_ellipse(x, y, 0.0, -4.0, 7.0, 6.0)] = HU_AIR
        if z < -40.0 and (z % 18.0) > 3.0:
            img[_ellipse(x, y, 0.0, 26.0, 10.0, 9.0)] = HU_CORTICAL * 0.8

        img += rng.normal(0.0, 6.0, size=img.shape).astype(np.float32) * (img > -950)
        yield img


CALIBRATION_INSERTS: tuple[tuple[str, float], ...] = (
    ("Air", -1000.0),
    ("Lung", -800.0),
    ("Adipose", -100.0),
    ("Water", 0.0),
    ("Acrylic", 120.0),
    ("Delrin", 340.0),
    ("Bone 50%", 700.0),
    ("Teflon", 990.0),
)


def _calibration(spec: PhantomSpec) -> Iterator[np.ndarray]:
    rng = np.random.default_rng(3)
    x, y = spec.grid()
    half_len = spec.z_positions()[-1] * 0.85
    for z in spec.z_positions():
        img = np.full(x.shape, HU_AIR, dtype=np.float32)
        if abs(z) <= half_len:
            img[_ellipse(x, y, 0.0, 0.0, 95.0, 95.0)] = 110.0
            img[_ellipse(x, y, 0.0, 0.0, 90.0, 90.0)] = HU_WATER
            for i, (_, hu) in enumerate(CALIBRATION_INSERTS):
                angle = 2.0 * np.pi * i / len(CALIBRATION_INSERTS)
                img[_ellipse(x, y, 58.0 * np.cos(angle), 58.0 * np.sin(angle), 12.0, 12.0)] = hu
            # Helical wire ramp, useful for checking slice geometry in 3D.
            phase = z / 30.0
            img[_ellipse(x, y, 25.0 * np.cos(phase), 25.0 * np.sin(phase), 2.5, 2.5)] = 1500.0
            img += rng.normal(0.0, 5.0, size=img.shape).astype(np.float32) * (img > -950)
        yield img


PHANTOMS: dict[str, PhantomSpec] = {
    spec.id: spec
    for spec in (
        PhantomSpec(
            id="chest-ct",
            name="Chest CT (contrast-enhanced)",
            description="Thorax with lungs, airways, pulmonary vessels, contrast heart and aorta, ribs and spine.",
            body_part="CHEST",
            rows=256,
            cols=256,
            slices=96,
            pixel_spacing_mm=1.4,
            slice_thickness_mm=3.0,
            window_center=40.0,
            window_width=400.0,
            generator=_chest,
        ),
        PhantomSpec(
            id="head-ct",
            name="Head CT",
            description="Skull, brain grey/white matter, ventricles, orbits, sinuses and cervical spine.",
            body_part="HEAD",
            rows=224,
            cols=224,
            slices=110,
            pixel_spacing_mm=1.0,
            slice_thickness_mm=2.0,
            window_center=40.0,
            window_width=80.0,
            generator=_head,
        ),
        PhantomSpec(
            id="hu-calibration",
            name="HU Calibration Phantom",
            description="Water cylinder with eight reference inserts from air (-1000 HU) to Teflon (990 HU).",
            body_part="PHANTOM",
            rows=192,
            cols=192,
            slices=64,
            pixel_spacing_mm=1.1,
            slice_thickness_mm=2.5,
            window_center=0.0,
            window_width=2200.0,
            generator=_calibration,
        ),
    )
}
