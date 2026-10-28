#!/usr/bin/env bash
# Starts the FastAPI backend (port 8765) and the Vite dev server (port 5297).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -x "$ROOT/backend/.venv/bin/uvicorn" ]; then
  python3 -m venv "$ROOT/backend/.venv"
  "$ROOT/backend/.venv/bin/pip" install -r "$ROOT/backend/requirements-dev.txt"
fi
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  (cd "$ROOT/frontend" && npm install)
fi

(cd "$ROOT/backend" && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8765 --reload) &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT

cd "$ROOT/frontend" && npm run dev
