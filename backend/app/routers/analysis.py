from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.deps import get_ctx
from app.errors import AppError
from app.routers.structures import load_model
from app.services import alignment, confidence, explain_rules as rules
from app.services.explanations import package

router = APIRouter(prefix="/analysis", tags=["analysis"])


class Selection(BaseModel):
    mobile_chain: Optional[str] = None
    reference_chain: Optional[str] = None
    mobile_range: Optional[tuple[int, int]] = None
    reference_range: Optional[tuple[int, int]] = None
    # "sequence" | "resnum" | "auto". "auto" is sequence alignment, falling back to
    # residue numbers when the alignment is not believable; the response says which
    # one was used (services/alignment.py: choose_matching).
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
    res["mobile_label"], res["reference_label"] = mrow["label"], rrow["label"]
    res.update(package(_explain(res, mrow, rrow, mmodel, rmodel)))
    return res


def _mean_plddt_of_matched(model, chain: str, labels: list[str]):
    """Mean pLDDT over exactly the matched residues of a predicted model, or None."""
    try:
        profile = confidence.plddt_profile(model, chain)
    except AppError:
        return None
    by_label = {r["label"]: r["plddt"] for r in profile["per_residue"]}
    vals = [by_label[x] for x in labels if x in by_label]
    return round(sum(vals) / len(vals), 2) if vals else None


def _explain(res: dict, mrow, rrow, mmodel, rmodel) -> list:
    """Rule-based wording for an alignment result, built only from its own numbers."""
    args = (res["rmsd"], res["tm_score"], res["aligned_atoms"], res["aligned_residues"], res["atom_type"])
    sources = (mrow["source"], rrow["source"])
    if set(sources) == {"experimental", "predicted"}:
        pred_is_mobile = mrow["source"] == "predicted"
        pred_row, exp_row = (mrow, rrow) if pred_is_mobile else (rrow, mrow)
        mean = _mean_plddt_of_matched(
            mmodel if pred_is_mobile else rmodel,
            res["mobile_chain"] if pred_is_mobile else res["reference_chain"],
            [p["mobile" if pred_is_mobile else "reference"] for p in res["pairs"]])
        out = [rules.explain_experimental_vs_predicted(exp_row["label"], pred_row["label"], *args, mean)]
    else:
        out = [rules.explain_alignment(*args, mrow["label"], rrow["label"])]
    if res["matching"] == "sequence" and res["sequence_identity"] < alignment.LOW_IDENTITY and res["pairs"]:
        first = res["pairs"][0]["mobile"].split(":")[-1]
        digits = "".join(ch for ch in first if ch.isdigit() or ch == "-")
        out.append(rules.explain_low_identity_matching(res["sequence_identity"], int(digits or 1)))
        res["notes"] = res["notes"] + [
            f"Matched residues share only {100 * res['sequence_identity']:.0f}% sequence identity; "
            "pairing by sequence alignment may be unreliable here. If both structures use the same "
            "numbering, repeat with selection.method = 'resnum'."]
    return out
