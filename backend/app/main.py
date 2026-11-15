import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles

from app.context import Context
from app.db import init_db
from app.errors import AppError
from app.jobs.base import RunnerRegistry
from app.jobs.runners import PrecomputedRunner
from app.routers import analysis, experiments, explain, jobs, reports, structures
from app.services import experiments as exp_svc


# uvicorn configures "uvicorn.error" with a console handler; logging through it
# means these lines show up in the terminal that runs ./run.sh.
log = logging.getLogger("uvicorn.error")


def create_app(data_dir=None) -> FastAPI:
    ctx = Context(data_dir)
    init_db(ctx)
    app = FastAPI(title="FoldStudio API", version="0.1.0")
    app.state.ctx = ctx
    app.state.runners = RunnerRegistry()
    # Opt-in only: FOLDSTUDIO_RUNNERS=precomputed. No runner is registered by default.
    for name in filter(None, os.environ.get("FOLDSTUDIO_RUNNERS", "").split(",")):
        if name.strip() == "precomputed":
            app.state.runners.register(PrecomputedRunner())

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # FOLDSTUDIO_DEMO=1 makes a public deployment read-only. Every write path is
    # refused; the two POSTs the UI needs to work (alignment, experiment compare)
    # compute from what is already loaded and write nothing, so they stay open.
    if os.environ.get("FOLDSTUDIO_DEMO") == "1":
        allowed_posts = {"/api/analysis/align", "/api/experiments/compare"}

        @app.middleware("http")
        async def _read_only(request: Request, call_next):
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                if request.url.path.rstrip("/") not in allowed_posts:
                    return JSONResponse(
                        status_code=403,
                        content={"detail": "demo_read_only: this deployment does not accept writes"},
                    )
            return await call_next(request)

    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError):
        return JSONResponse(status_code=exc.status, content={"detail": exc.detail})

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        msgs = "; ".join(f"{'.'.join(str(x) for x in e['loc'] if x != 'body')}: {e['msg']}" for e in exc.errors())
        return JSONResponse(status_code=422, content={"detail": f"invalid_request: {msgs}"})

    for r in (structures.router, analysis.router, experiments.router, reports.router, jobs.router,
              explain.router):
        app.include_router(r, prefix="/api")

    @app.get("/api/health")
    def health():
        return {"status": "ok", "data_dir": str(ctx.data_dir), "runners": app.state.runners.names(),
                "reindex": app.state.last_reindex}

    # Pick up bundles under data/experiments/*/experiment.json. The outcome is
    # kept and served from /api/health, and problems are logged: a bundle that
    # fails to load is otherwise just absent from the app with nothing to say why.
    app.state.last_reindex = exp_svc.reindex(ctx)
    _log_reindex(app.state.last_reindex)

    # Serve the built frontend from the same origin as the API, so one deployment
    # answers everything and no CORS origin has to be configured. Mounted last:
    # the catch-all below must not shadow /api/*.
    static_dir = os.environ.get("FOLDSTUDIO_STATIC_DIR")
    if static_dir:
        root = Path(static_dir)
        index = root / "index.html"
        if not index.is_file():
            log.warning("FOLDSTUDIO_STATIC_DIR=%s has no index.html; serving API only", root)
        else:
            if (root / "assets").is_dir():
                app.mount("/assets", StaticFiles(directory=root / "assets"), name="assets")

            @app.get("/{path:path}")
            def _spa(path: str):
                # A real file wins; anything else falls back to index.html so the
                # client-side router owns /explorer, /analysis and the rest.
                candidate = (root / path).resolve()
                if path and root.resolve() in candidate.parents and candidate.is_file():
                    return FileResponse(candidate)
                return FileResponse(index)

            log.info("serving frontend from %s", root)

    return app


def _log_reindex(report: dict) -> None:
    log.info("indexed %d experiment bundle(s); registered %d and refreshed %d structure(s); removed %d",
             len(report["imported"]), len(report["structures_registered"]),
             len(report["structures_updated"]), len(report["removed"]))
    for err in report["errors"]:
        log.warning("bundle problem: %s: %s", err.get("path"), err.get("error"))
