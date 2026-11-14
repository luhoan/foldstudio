"""GET /api/explain and the interface endpoint: numbers first, then words built only from them.

Every sentence returned here comes from services/explain_rules, whose templates
are fixed text with the measured values substituted in. Nothing is generated,
and each explanation carries `refs`: the exact numbers its text was built from.
"""
from typing import Optional

from fastapi import APIRouter, Depends

from app.deps import get_ctx
from app.errors import AppError
from app.routers.structures import load_model
from app.services import confidence, explain_rules as rules, interfaces
from app.services.explanations import package
from app.services.structure_io import aa_residues

router = APIRouter(tags=["explain"])


def _chain_order(model) -> list[tuple[str, int]]:
    """(chain id, residue number) for every amino-acid residue, in file order.

    This is the order a PAE matrix is indexed in.
    """
    return [(ch.id, res.id[1]) for ch, res in aa_residues(model)]


@router.get("/explain")
def explain(structure: str, chain: Optional[str] = None, start: Optional[int] = None,
            end: Optional[int] = None, ctx=Depends(get_ctx)):
    row, model = load_model(ctx, structure)
    order = _chain_order(model)
    chain_ids = list(dict.fromkeys(c for c, _ in order))
    chain_id = chain or chain_ids[0]
    if chain_id not in chain_ids:
        raise AppError(404, f"not_found: chain '{chain_id}' in structure '{structure}' "
                            f"(available: {', '.join(chain_ids)})")
    numbers = [n for c, n in order if c == chain_id]
    lo = min(numbers) if start is None else start
    hi = max(numbers) if end is None else end
    if lo > hi:
        raise AppError(400, "invalid_request: start must not be greater than end")
    selected = [i for i, (c, n) in enumerate(order) if c == chain_id and lo <= n <= hi]
    if not selected:
        raise AppError(404, f"not_found: no residues {lo}-{hi} in chain '{chain_id}'")

    explanations = []
    if row["source"] != "predicted":
        explanations.append(rules.explain_no_confidence(row["source"], chain_id, lo, hi, len(selected)))
    else:
        profile = confidence.plddt_profile(model, chain_id)  # 409 if the column is not pLDDT-like
        values = [r["plddt"] for r in profile["per_residue"] if lo <= r["resseq"] <= hi]
        if len(values) == 1:
            explanations.append(rules.explain_plddt_residue(values[0], chain_id, lo))
        else:
            explanations.append(rules.explain_plddt_region(values, chain_id, lo, hi))
        if row["pae_path"] and len(selected) > 1:
            pae_file = ctx.abs(row["pae_path"])
            if pae_file.is_file():
                matrix = confidence.parse_pae(pae_file.read_bytes())["matrix"]
                if len(matrix) == len(order):
                    block = [[matrix[i][j] for j in selected] for i in selected]
                    explanations.append(rules.explain_pae_region(block, chain_id, lo, hi))

    return {"structure_id": structure, "source": row["source"], "chain": chain_id,
            "start": lo, "end": hi, "n_residues": len(selected), **package(explanations)}


@router.get("/structures/{sid}/interfaces")
def get_interfaces(sid: str, cutoff: float = interfaces.DEFAULT_CUTOFF, ctx=Depends(get_ctx)):
    row, model = load_model(ctx, sid)
    found = interfaces.chain_interfaces(model, cutoff)
    predicted = row["source"] == "predicted"

    order = _chain_order(model)
    plddt_by_residue: dict = {}
    matrix = None
    if predicted and found:
        try:
            profile = confidence.plddt_profile(model)
            plddt_by_residue = {(r["chain"], r["resseq"]): r["plddt"] for r in profile["per_residue"]}
        except AppError:
            plddt_by_residue = {}
        if row["pae_path"] and ctx.abs(row["pae_path"]).is_file():
            parsed = confidence.parse_pae(ctx.abs(row["pae_path"]).read_bytes())["matrix"]
            matrix = parsed if len(parsed) == len(order) else None

    for item in found:
        iface_plddt = iface_pae = None
        if plddt_by_residue:
            vals = [plddt_by_residue[k] for k in
                    [(item["chain_a"], n) for n in item["residues_a"]]
                    + [(item["chain_b"], n) for n in item["residues_b"]] if k in plddt_by_residue]
            iface_plddt = round(sum(vals) / len(vals), 2) if vals else None
        if matrix is not None:
            ia = [i for i, (c, _) in enumerate(order) if c == item["chain_a"]]
            ib = [i for i, (c, _) in enumerate(order) if c == item["chain_b"]]
            block = [matrix[i][j] for i in ia for j in ib] + [matrix[j][i] for i in ia for j in ib]
            iface_pae = round(sum(block) / len(block), 2) if block else None
        item["interface_mean_plddt"] = iface_plddt
        item["mean_interchain_pae"] = iface_pae
        common = (row["label"], item["chain_a"], item["chain_b"], item["n_residue_pairs"], cutoff)
        if row["source"] == "experimental":
            ex = rules.explain_interface(*common)  # "deposited coordinates" wording
        elif iface_plddt is not None and iface_pae is not None:
            ex = rules.explain_interface(*common, iface_plddt, iface_pae)
        else:
            # Not a declared experimental entry, and not a model with both
            # confidence numbers: say only what the coordinates show.
            ex = rules.explain_interface_coordinates(*common)
        item["explanation"] = ex.to_dict()

    return {"structure_id": sid, "source": row["source"], "cutoff_angstrom": cutoff,
            "atom_selection": interfaces.ATOM_SELECTION, "n_chains": len(dict.fromkeys(c for c, _ in order)),
            "interfaces": found, "note": interfaces.NOTE,
            "pae_note": ("mean_interchain_pae averages both directions, PAE(i in A, j in B) and "
                         "PAE(j in B, i in A); it is null when the structure has no PAE."),
            "limitations": [rules.DISCLAIMER]}
