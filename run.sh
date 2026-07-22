#!/usr/bin/env bash
# One-command dev run: install deps, ingest, serve. Usage: ./run.sh
set -e
cd "$(dirname "$0")/backend"
[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
pip install -q -r requirements.txt
echo "Ingesting listings…"
python -m internscout.run_ingest || echo "(ingest hit source errors; continuing)"
echo "Starting dashboard at http://localhost:8000"
exec python -m uvicorn internscout.api:app --port 8000
