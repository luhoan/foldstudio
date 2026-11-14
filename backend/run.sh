#!/usr/bin/env bash
# Start the FoldStudio API on http://localhost:8000 (interactive docs at /docs).
cd "$(dirname "$0")"
exec uvicorn app.main:create_app --factory --reload --port 8000
