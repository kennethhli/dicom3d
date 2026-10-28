# DICOM3D

A browser-based 3D volumetric renderer and slice viewer for CT/MRI series in DICOM format.

DICOM3D takes a stack of 2D DICOM slices and de-identifies them on a FastAPI backend. Web Workers decode the slices off the main thread. The slices are then rebuilt into one 3D texture and rendered with a custom GPU ray-marching shader in Three.js. Clinical controls run in real time: window/level, density thresholds, clipping planes, and render modes.

## Features

- **Real patient scan.** A real low-dose chest CT (LIDC-IDRI-0001, 512×512×133, 0.70×0.70×2.5 mm) from [The Cancer Imaging Archive](https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX), licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The backend downloads it once (~35 MB) from TCIA's public API into `backend/data/samples/`, then serves it through the same de-identifier as everything else. If the archive can't be reached, that entry returns a 503 and the other datasets still work.
- **Synthetic datasets.** Three procedurally generated CT series are built on first start: a contrast chest CT, a head CT, and an HU calibration phantom. Every slice carries synthetic PHI (fake name, DOB, MRN, institution, private tags), so the de-identification path has real data to strip.
- **Upload.** You can drag and drop `.dcm` files or whole folders, or use the *Open files* / *Folder* buttons. Uploads go to `POST /api/deidentify` and are scrubbed before the browser parses them. If the API can't be reached, the files are parsed entirely in the browser and never leave the device.
- **De-identification (PS3.15 Basic Profile subset).**
  - Removes or empties patient, physician, institution, and date/time tags, strips private tags and overlays, and pseudonymises PatientID.
  - Remaps Study, Series, SOP, and Frame-of-Reference UIDs deterministically, so a series still groups together after scrubbing.
  - Keeps geometry intact: `ImagePositionPatient`, `ImageOrientationPatient`, `PixelSpacing`, `SliceThickness`, `SliceLocation`, rescale tags, and pixel data.
  - The **De-identified** badge opens a per-tag report.
- **Multi-threaded parser.** A pool of Web Workers (up to 6, based on CPU cores) parses slices in parallel using `dicom-parser`:
  - It handles 8/16/32-bit, signed or unsigned, BitsStored masking, big-endian data, and MONOCHROME1.
  - It applies `HU = stored × RescaleSlope + RescaleIntercept`.
  - A worker then sorts slices along the normal from `ImageOrientationPatient`, derives the slice spacing, normalises values, builds a histogram, and packs half floats for the GPU.
  - All buffers are *transferred* (zero-copy), not cloned.
- **GPU volume rendering.** A single-pass ray marcher over a `Data3DTexture` (R16F, trilinear filtering) with:
  - **DVR** (front-to-back compositing with opacity correction and gradient lighting), **MIP**, **MinIP**, and **isosurface** (bisection-refined).
  - Ray jitter to suppress banding, and early ray termination.
  - Clip-box intersection: cutting into the volume also makes rendering faster.
  - **Adaptive rendering for weak GPUs.** Frames are drawn only when something changes. While you drag the camera or a slider, the viewer renders with fewer ray steps at a reduced resolution, which a controller tunes to a ~19 ms frame budget (down to 30%). About 220 ms after the last change, it draws one full-resolution, full-step frame and then goes idle. Turn off *Adaptive resolution* to render every frame at full quality for benchmarking.
- **Clinical controls.**
  - Presets: Bone, Soft Tissue, Lung, Angio, Brain, MIP, Mediastinum. Keys `1`–`7` select them.
  - Window center/width with a live histogram, HU threshold range, opacity, brightness, and colormaps.
  - X/Y/Z clipping range sliders.
  - Camera views A/P/L/R/S/I, which are also keyboard shortcuts.
  - PNG export.
- **MPR slice viewer.** Axial, coronal, and sagittal 2D views in radiological orientation. Hovering shows the HU value under the cursor, the mouse wheel pages through slices, and the current clip box is drawn on the slice.
- **Measurement tools.**
  - **Ruler:** distance in mm, using the pixel spacing of each view, so it stays correct on anisotropic coronal and sagittal planes.
  - **Elliptical ROI:** mean, standard deviation, min/max HU, and area.
  - Measurements are listed under the viewer. Click one to jump to its slice.
- **Performance monitor.** An overlay shows the render mode (idle, adaptive, or continuous), FPS with a sparkline, frame time, render resolution, GPU time (via `EXT_disjoint_timer_query_webgl2` when available), CPU submit time, ray steps, drawing-buffer size, and texture upload time. The sidebar also shows per-stage pipeline timings.
- **Shareable views.** The URL keeps the dataset and preset, e.g. `?dataset=head-ct&preset=brain`.

## Architecture

```
backend/                     FastAPI · pydicom · numpy
  app/phantoms.py            procedural CT phantoms (partial-volume + PSF + noise)
  app/datasets.py            writes phantoms as DICOM Part 10 files with synthetic PHI
  app/remote.py              real TCIA series, downloaded once and cached
  app/deid.py                de-identification profile
  app/bundle.py              length-prefixed binary container for many .dcm files
  app/main.py                REST API
frontend/                    React 19 · TypeScript · Vite · Tailwind v4 · shadcn/ui · Three.js
  src/workers/               Web Worker entry + message protocol
  src/lib/dicom/             parse.ts (binary → HU), assemble.ts (slices → volume), workerPool.ts
  src/render/                VolumeRenderer.ts (scene, controls, GPU timers), shaders.ts (GLSL 3)
  src/components/            viewport, MPR slice viewer, control panel, privacy report
```

Data flow: `API (pydicom de-id) → binary bundle → Web Worker pool (parse, HU) → assembler worker (sort, normalise, half-float) → Data3DTexture → ray-marching shader`.

### API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/datasets` | Sample series metadata |
| GET | `/api/datasets/{id}/bundle` | All slices, de-identified, as one binary bundle |
| GET | `/api/datasets/{id}/slices/{index}` | One de-identified `.dcm` slice |
| GET | `/api/datasets/{id}/deid-report?index=0` | Tags changed on one slice and the geometry tags preserved |
| POST | `/api/deidentify` | Multipart upload of `.dcm` files. Returns a bundle plus an `X-Deid-Report` summary (tag names and counts, never values) |

Bundle format (little-endian): `"D3DB"`, `u32 version=1`, `u32 count`, then `count × (u32 length, bytes)`.

Interactive API docs are available at `http://localhost:8765/docs`.

## Running locally

Requirements: Python 3.10+, Node 20+, and a browser with WebGL 2.

```bash
./scripts/dev.sh
```

Or run the two services yourself:

```bash
# backend → http://localhost:8765
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --port 8765 --reload

# frontend → http://localhost:5297 (proxies /api to :8765)
cd frontend
npm install
npm run dev
```

Sample series are generated into `backend/data/samples/` on first start, which takes a few seconds. The real chest CT is downloaded there in the background at the same time.

### Docker

```bash
docker compose up --build
# open http://localhost:8297
```

nginx serves the static build and proxies `/api` to the FastAPI container. Generated samples persist in the `dicom3d-data` volume.

### Tests and checks

```bash
cd backend && .venv/bin/python -m pytest          # API, de-identification, geometry/HU preservation
cd frontend && npm test                           # bundle decoding, HU parsing, volume assembly, half floats, measurements
cd frontend && npm run typecheck && npm run lint
```

The frontend parser tests read the series generated by the backend, so start the API once first.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DICOM3D_DATA_DIR` | `backend/data` | Where generated samples are written |
| `DICOM3D_CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `DICOM3D_MAX_UPLOAD_FILES` / `DICOM3D_MAX_UPLOAD_BYTES` | `1500` / `768 MiB` | Upload limits |
| `DICOM3D_WARM_SAMPLES` | `1` | Generate samples in the background at startup |
| `VITE_API_BASE` | *(same origin)* | Frontend API base URL when not using the dev proxy |
| `DICOM3D_API_URL` | `http://127.0.0.1:8765` | Target of the Vite dev proxy |

## Limitations

- Only uncompressed transfer syntaxes are decoded. JPEG, JPEG-LS, JPEG 2000, and RLE are rejected with a clear message.
- Multi-frame (enhanced) DICOM objects are not supported yet.
- Series larger than ~40 M voxels are downsampled 2× in-plane to fit the texture budget.
- Measurements live in the browser session only. They are not saved as DICOM SR.
- Anatomical labels assume an axial acquisition. Other orientations still render, but the A/P/L/R/S/I labels refer to volume axes.
- The de-identifier implements a practical subset of the DICOM confidentiality profile and is not a certified anonymisation tool. Burned-in pixel text is not detected.
