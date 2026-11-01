"""Bakes the sample series and their de-identified bundles into a Docker image.

Run at build time (``python -m app.prebuild``) so a cold container on a small host
serves the first scan from disk instead of downloading and de-identifying it.
"""

from __future__ import annotations

import sys

from .main import PREBUILT_DIR, build_bundle, store


def main() -> int:
    PREBUILT_DIR.mkdir(parents=True, exist_ok=True)
    for spec in store.specs():
        try:
            payload, compressed = build_bundle(spec.id)
        except Exception as exc:  # e.g. the archive is unreachable; the server retries at runtime
            print(f"skip {spec.id}: {exc}", file=sys.stderr)
            continue
        (PREBUILT_DIR / f"{spec.id}.d3db").write_bytes(payload)
        (PREBUILT_DIR / f"{spec.id}.d3db.gz").write_bytes(compressed)
        print(f"baked {spec.id}: {len(payload) / 1e6:.1f} MB ({len(compressed) / 1e6:.1f} MB gzip)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
