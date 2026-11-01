# Single-container build: FastAPI serves both the API and the built frontend.
# Works on Hugging Face Spaces, Render, Fly.io, or `docker run -p 7860:7860`.

FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DICOM3D_DATA_DIR=/data \
    DICOM3D_STATIC_DIR=/app/static \
    PORT=7860

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install -r requirements.txt
COPY backend/app ./app
COPY --from=web /web/dist ./static

# Hugging Face Spaces runs containers as uid 1000.
RUN useradd --uid 1000 --create-home dicom3d && mkdir -p /data && chown dicom3d /data
USER dicom3d
# Bake samples and de-identified bundles into the image so cold starts are fast.
RUN DICOM3D_GZIP_LEVEL=6 python -m app.prebuild

EXPOSE 7860
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health')"
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
