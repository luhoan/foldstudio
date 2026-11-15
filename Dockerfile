# Single-service image: builds the frontend, then serves it from the FastAPI app
# so one URL answers both the UI and /api. Build from the repo root:
#   docker build -t foldstudio .
#   docker run -p 8000:8000 foldstudio

FROM node:20-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /srv

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY data/ ./data/
COPY --from=frontend /build/dist ./static/

ENV PYTHONUNBUFFERED=1 \
    FOLDSTUDIO_DATA_DIR=/srv/data \
    FOLDSTUDIO_STATIC_DIR=/srv/static \
    FOLDSTUDIO_DEMO=1 \
    PORT=8000

WORKDIR /srv/backend
EXPOSE 8000
# $PORT is set by most hosts; the default above covers a plain docker run.
CMD ["sh", "-c", "python -m uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT:-8000}"]
