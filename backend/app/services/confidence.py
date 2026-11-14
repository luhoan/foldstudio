"""pLDDT (from B-factor column of *predicted* models) and PAE loading.

pLDDT is a model-reported local confidence (0-100). It is NOT experimental evidence of
folding, binding, affinity, safety or function. B-factors of experimental structures are
a different quantity and are never reported as pLDDT.
"""
import json
import statistics

from app.errors import AppError
from app.services.structure_io import aa_residues, res_label

# One banding for the whole app -- this API, the explanation rules and the 3D
# viewer's colours -- with the lower bound inclusive:
#   very_high: >= 90 | confident: 70 to <90 | low: 50 to <70 | very_low: < 50
# AlphaFold's published legend ("> 90", "90 > x > 70", ...) leaves the exact
# boundary values unassigned; they are assigned here, once, so that a residue at
# exactly 90.00 cannot be "very high" in one panel and "confident" in the next.
# tests/test_plddt_convention.py holds the three implementations to it.
BINS = [
    ("very_high", ">= 90"),
    ("confident", "70 - <90"),
    ("low", "50 - <70"),
    ("very_low", "< 50"),
]

NOTE = (
    "pLDDT is the model's own estimate of local structural confidence. It does not establish "
    "experimentally observed folding, binding, affinity, safety or biological function."
)


def classify(v: float) -> str:
    if v >= 90:
        return "very_high"
    if v >= 70:
        return "confident"
    if v >= 50:
        return "low"
    return "very_low"


def plddt_profile(model, chain: str | None = None) -> dict:
    rows = []
    for ch, res in aa_residues(model):
        if chain and ch.id != chain:
            continue
        if "CA" in res:
            v = float(res["CA"].get_bfactor())
        else:
            atoms = [a.get_bfactor() for a in res]
            if not atoms:
                continue
            v = float(statistics.fmean(atoms))
        rows.append(
            {
                "chain": ch.id,
                "resseq": res.id[1],
                "icode": res.id[2].strip(),
                "resname": res.get_resname(),
                "label": res_label(ch.id, res),
                "plddt": round(v, 2),
                "bin": None,
            }
        )
    if not rows:
        raise AppError(404, f"not_found: no residues found{' in chain ' + chain if chain else ''}")
    vals = [r["plddt"] for r in rows]
    if min(vals) < 0 or max(vals) > 100.0:
        raise AppError(
            409,
            "plddt_unavailable: B-factor values fall outside 0-100, so they do not look like pLDDT. "
            "Not reporting them as model confidence.",
        )
    for r in rows:
        r["bin"] = classify(r["plddt"])
    n = len(vals)
    counts = {name: 0 for name, _ in BINS}
    for r in rows:
        counts[r["bin"]] += 1
    hist = []
    for i in range(10):
        lo, hi = i * 10, (i + 1) * 10
        c = sum(1 for v in vals if (lo <= v < hi) or (i == 9 and v == 100))
        hist.append({"lo": lo, "hi": hi, "count": c})
    return {
        "per_residue": rows,
        "n_residues": n,
        "mean": round(statistics.fmean(vals), 2),
        "median": round(statistics.median(vals), 2),
        "bins": [
            {"name": name, "range": rng, "count": counts[name], "fraction": round(counts[name] / n, 4)}
            for name, rng in BINS
        ],
        "histogram": hist,
        "note": NOTE,
    }


def parse_pae(raw: bytes) -> dict:
    """Accepts AlphaFold DB JSON (list-wrapped or bare dict) and ColabFold-style {"pae": ...}."""
    try:
        obj = json.loads(raw)
    except Exception:
        raise AppError(400, "invalid_pae: file is not valid JSON")
    if isinstance(obj, list):
        if not obj or not isinstance(obj[0], dict):
            raise AppError(400, "invalid_pae: unexpected JSON layout")
        obj = obj[0]
    if not isinstance(obj, dict):
        raise AppError(400, "invalid_pae: unexpected JSON layout")
    mat = obj.get("predicted_aligned_error", obj.get("pae"))
    if not isinstance(mat, list) or not mat:
        raise AppError(400, "invalid_pae: no 'predicted_aligned_error' (or 'pae') matrix found")
    n = len(mat)
    for row in mat:
        if not isinstance(row, list) or len(row) != n:
            raise AppError(400, "invalid_pae: matrix is not square")
        for v in row:
            if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
                raise AppError(400, "invalid_pae: matrix contains non-numeric or negative values")
    max_pae = obj.get("max_predicted_aligned_error", obj.get("max_pae"))
    flat_max = max(max(r) for r in mat)
    return {
        "size": n,
        "max_pae": float(max_pae) if isinstance(max_pae, (int, float)) else float(flat_max),
        "matrix": [[round(float(v), 2) for v in r] for r in mat],
        "note": (
            "PAE is the model's expected position error (in Angstroms) of residue j when the "
            "structure is aligned on residue i. It describes relative confidence in domain "
            "placement, not experimental accuracy."
        ),
    }
