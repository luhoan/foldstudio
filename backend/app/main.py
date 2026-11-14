import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from app.context import Context
from app.db import init_db
from app.errors import AppError
from app.jobs.base import RunnerRegistry
from app.jobs.runners import PrecomputedRunner
from app.routers import analysis, experiments, jobs, reports, structures
from app.services import experiments as exp_svc


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

    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError):
        return JSONResponse(status_code=exc.status, content={"detail": exc.detail})

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        msgs = "; ".join(f"{'.'.join(str(x) for x in e['loc'] if x != 'body')}: {e['msg']}" for e in exc.errors())
        return JSONResponse(status_code=422, content={"detail": f"invalid_request: {msgs}"})

    for r in (structures.router, analysis.router, experiments.router, reports.router, jobs.router):
        app.include_router(r, prefix="/api")

    @app.get("/api/health")
    def health():
        return {"status": "ok", "data_dir": str(ctx.data_dir), "runners": app.state.runners.names()}

    exp_svc.reindex(ctx)  # pick up bundles under data/experiments/*/experiment.json
    return app
