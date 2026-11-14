from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.deps import get_ctx
from app.errors import AppError
from app.routers.structures import load_model
from app.services import alignment

router = APIRouter(prefix="/analysis", tags=["analysis"])


class Selection(BaseModel):
    mobile_chain: Optional[str] = None
    reference_chain: Optional[str] = None
    mobile_range: Optional[tuple[int, int]] = None
    reference_range: Optional[tuple[int, int]] = None
    method: str = "sequence"


class AlignBody(BaseModel):
    mobile_id: str
    reference_id: str
    selection: Selection = Field(default_factory=Selection)


@router.post("/align")
def align(body: AlignBody, ctx=Depends(get_ctx)):
    if body.mobile_id == body.reference_id and not (body.selection.mobile_chain and body.selection.reference_chain):
        raise AppError(400, "invalid_selection: aligning a structure to itself requires explicit, different chains")
    mrow, mmodel = load_model(ctx, body.mobile_id)
    rrow, rmodel = load_model(ctx, body.reference_id)
    res = alignment.align(mmodel, rmodel, body.selection.model_dump())
    res["mobile_id"], res["reference_id"] = body.mobile_id, body.reference_id
    res["mobile_source"], res["reference_source"] = mrow["source"], rrow["source"]
    return res
