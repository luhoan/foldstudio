from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.deps import get_ctx

router = APIRouter(prefix="/jobs", tags=["jobs"])


class JobBody(BaseModel):
    runner: Optional[str] = None
    spec: dict[str, Any] = Field(default_factory=dict)


@router.post("", status_code=202)
def submit(body: JobBody, request: Request, ctx=Depends(get_ctx)):
    runner = request.app.state.runners.get(body.runner)  # raises 501 no_runner when none registered
    return runner.submit(ctx, body.spec)


@router.get("/{job_id}")
def get_job(job_id: str, request: Request, ctx=Depends(get_ctx)):
    return request.app.state.runners.get(None).get(ctx, job_id)
