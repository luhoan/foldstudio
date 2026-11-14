from typing import Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse, HTMLResponse

from app.deps import get_ctx
from app.errors import AppError
from app.services import reports

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("")
def report(ids: str = Query(..., description="comma-separated experiment ids"), format: Literal["html", "markdown", "json"] = "html", ctx=Depends(get_ctx)):
    id_list = [i.strip() for i in ids.split(",") if i.strip()]
    if not id_list:
        raise AppError(400, "invalid_request: provide at least one experiment id")
    if len(set(id_list)) != len(id_list):
        raise AppError(400, "invalid_request: experiment ids must be distinct")
    built = reports.build(ctx, id_list)
    if format == "html":
        return HTMLResponse(built["html"])
    if format == "markdown":
        return PlainTextResponse(built["markdown"], media_type="text/markdown")
    return built
