"""Persisting structures, and registering the ones an experiment already lists.

`store()` is the single place a structure row is created; the structures router
and the experiment reindex both go through it, so validation, PAE handling and
provenance cannot drift apart.

`register_experiment_outputs()` exists because an experiment bundle and the
structure table were previously populated by two unrelated steps: reindex read
`experiment.json` files, while structures only appeared if something separately
POSTed /api/structures/register. Nothing did, so after a data fetch the
API-driven panels (PAE, confidence) had an empty list to choose from while the
experiment list showed nine rows.

Source is never guessed. An output says `"source": "predicted"` or it is
registered as "uploaded", because GET /structures/{id}/plddt reads B-factors as
pLDDT for predicted structures only, and an experimental file's B-factors are a
different physical quantity. Defaulting to "uploaded" makes an unlabelled file
refuse to report confidence rather than report a wrong one.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Iterable, Optional

from app.db import db, structure_row_to_dict
from app.services import confidence, structure_io as sio

VALID_SOURCES = ("experimental", "predicted", "uploaded")


def new_id() -> str:
    return f"st_{uuid.uuid4().hex[:10]}"


def store(ctx, *, data: bytes, fmt: str, label: str, source: str, origin_id,
          provenance: dict, pae: Optional[bytes] = None,
          fixed_path: Optional[Path] = None) -> dict:
    """Validate, persist file (+PAE) and DB row; returns the public structure dict."""
    text = sio.decode(data)
    if fmt == "fasta":
        records = sio.parse_fasta(text)
        chains = [{"id": r["id"], "n_residues": r["n_residues"], "sequence": r["sequence"]}
                  for r in records]
        n_res = sum(c["n_residues"] for c in chains)
    else:
        model = sio.parse_structure(text, fmt)
        info = sio.summarize(model)
        chains, n_res = info["chains"], info["n_residues"]
    pae_info = None
    if pae is not None:
        pae_info = confidence.parse_pae(pae)  # validates JSON shape
    sid = new_id()
    ext = {"pdb": "pdb", "mmcif": "cif", "fasta": "fasta"}[fmt]
    if fixed_path is None:
        path = ctx.structures_dir / f"{sid}.{ext}"
        path.write_bytes(data)
    else:
        path = fixed_path
    pae_rel = None
    if pae_info is not None:
        pae_path = ctx.pae_dir / f"{sid}.json"
        pae_path.write_bytes(pae)
        pae_rel = ctx.rel(pae_path)
    prov = dict(provenance)
    with db(ctx) as c:
        c.execute(
            "INSERT INTO structures (id,label,source,origin_id,format,sha256,chains,"
            "n_residues,file_path,pae_path,provenance,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, label, source, origin_id, fmt, sio.sha256(data), json.dumps(chains),
             n_res, ctx.rel(path), pae_rel, json.dumps(prov), sio.now_iso()),
        )
        row = c.execute("SELECT * FROM structures WHERE id=?", (sid,)).fetchone()
    return structure_row_to_dict(row)


# --------------------------------------------------------------- registration

def _normalise_outputs(outputs: Any) -> list[dict]:
    """Accept both output shapes in use.

    The data-fetch stream writes dicts: {"type","path","sha256",...}.
    The HPC stream writes bare path strings. Neither is wrong, so read both
    rather than forcing one producer to churn.
    """
    out: list[dict] = []
    if not isinstance(outputs, Iterable) or isinstance(outputs, (str, bytes)):
        return out
    for item in outputs:
        if isinstance(item, str):
            out.append({"path": item})
        elif isinstance(item, dict) and isinstance(item.get("path"), str):
            out.append(dict(item))
    return out


def _kind_of(entry: dict) -> str:
    """structure | pae | other, from the declared type or the file name."""
    declared = (entry.get("type") or "").strip().lower()
    if declared in ("structure", "pae"):
        return declared
    name = entry["path"].lower()
    if name.endswith(".pae.json"):
        return "pae"
    if name.endswith((".pdb", ".cif", ".mmcif", ".ent")):
        return "structure"
    return "other"


def _resolve(ctx, exp_id: str, rel: str) -> Optional[Path]:
    """Find a file an experiment refers to, whichever root its producer used.

    Paths are written relative to the data dir by one stream and relative to the
    bundle directory by another, and bundles also copy their files into
    data/structures/<exp_id>/. Try each, and never escape the data dir.
    """
    base = ctx.data_dir.resolve()
    name = Path(rel).name
    for cand in (ctx.data_dir / rel,
                 ctx.experiments_dir / exp_id / rel,
                 ctx.structures_dir / exp_id / name,
                 ctx.pae_dir / exp_id / name):
        try:
            p = cand.resolve()
        except OSError:
            continue
        if base in p.parents and p.is_file():
            return p
    return None


def _already_registered(ctx, origin_id: str) -> bool:
    with db(ctx) as c:
        return c.execute("SELECT 1 FROM structures WHERE origin_id=? LIMIT 1",
                         (origin_id,)).fetchone() is not None


def register_experiment_outputs(ctx, exp: dict) -> dict:
    """Register structure outputs of one experiment. Idempotent, best-effort.

    Returns {"registered": [ids], "skipped": n, "errors": [...]}. Errors are
    reported, never raised: a malformed output must not stop an experiment from
    being indexed, and reindex runs on every startup.
    """
    exp_id = str(exp.get("id") or "")
    result: dict[str, Any] = {"registered": [], "skipped": 0, "errors": []}
    if not exp_id:
        return result

    entries = _normalise_outputs(exp.get("outputs"))
    raw_sources = exp.get("structure_sources")
    sources_map = {str(k): str(v) for k, v in raw_sources.items()} if isinstance(raw_sources, dict) else {}
    paes = {Path(e["path"]).name[: -len(".pae.json")]: e
            for e in entries if _kind_of(e) == "pae" and e["path"].endswith(".pae.json")}

    for entry in entries:
        if _kind_of(entry) != "structure":
            continue
        rel = entry["path"]
        name = Path(rel).name
        origin_id = f"{exp_id}:{name}"
        if _already_registered(ctx, origin_id):
            result["skipped"] += 1
            continue
        path = _resolve(ctx, exp_id, rel)
        if path is None:
            result["errors"].append({"path": rel, "error": "not_found under data/"})
            continue

        # Declared on the output entry (dict-style outputs), else in the
        # experiment's structure_sources map (for producers whose outputs are
        # bare strings, which is what the frontend's Experiment type declares),
        # else the safe default.
        declared = entry.get("source") or sources_map.get(name) or sources_map.get(rel)
        source = str(declared or "uploaded").strip().lower()
        if source not in VALID_SOURCES:
            result["errors"].append({"path": rel, "error": f"unknown source {source!r}"})
            source = "uploaded"

        pae_bytes = None
        pae_entry = paes.get(Path(name).stem)
        if pae_entry is not None:
            pae_path = _resolve(ctx, exp_id, pae_entry["path"])
            if pae_path is None:
                result["errors"].append({"path": pae_entry["path"],
                                         "error": "PAE listed but not found under data/"})
            else:
                pae_bytes = pae_path.read_bytes()

        try:
            data = path.read_bytes()
            fmt = sio.detect_format(path.name, sio.decode(data))
            row = store(
                ctx, data=data, fmt=fmt,
                label=entry.get("label") or f"{name} ({exp_id})",
                source=source, origin_id=origin_id,
                provenance={
                    "source": f"experiment:{exp_id}",
                    "retrieved_at": sio.now_iso(),
                    "url": None,
                    "notes": ("Registered automatically from the experiment bundle that "
                              f"lists it as an output. Source '{source}' is as the bundle "
                              "declared it; it was not inferred from the file."),
                },
                pae=pae_bytes, fixed_path=path,
            )
            result["registered"].append(row["id"])
        except Exception as e:  # noqa: BLE001 - reported, never fatal to reindex
            result["errors"].append({"path": rel, "error": f"{type(e).__name__}: {e}"})
    return result
