from typing import Any, Optional

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel

from app.deps import get_ctx
from app.services import experiments as svc

router = APIRouter(prefix="/experiments", tags=["experiments"])


@router.get("")
def list_experiments(kind: Optional[str] = None, status: Optional[str] = None, ctx=Depends(get_ctx)):
    return svc.list_all(ctx, kind, status)


@router.post("", status_code=201)
def create_experiment(payload: dict[str, Any] = Body(...), ctx=Depends(get_ctx)):
    return svc.save(ctx, payload)


class CompareBody(BaseModel):
    ids: list[str]


@router.post("/compare")
def compare(body: CompareBody, ctx=Depends(get_ctx)):
    return svc.compare(ctx, body.ids)


@router.post("/reindex")
def reindex(ctx=Depends(get_ctx)):
    return svc.reindex(ctx)


@router.get("/{exp_id}")
def get_experiment(exp_id: str, ctx=Depends(get_ctx)):
    return svc.get(ctx, exp_id)
