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
from app.errors import AppError
from app.services import confidence, structure_io as sio

VALID_SOURCES = ("experimental", "predicted", "uploaded")


def new_id() -> str:
    return f"st_{uuid.uuid4().hex[:10]}"


def check_pae_size(size: int, n_residues: int) -> None:
    """A PAE matrix describes residue pairs, so it must be n_residues square.

    A sidecar that belongs to a different model would otherwise be attached and
    drawn as if it described this one.
    """
    if n_residues and size != n_residues:
        raise AppError(409, f"pae_mismatch: PAE matrix is {size}x{size} but the structure has "
                            f"{n_residues} residues")


def describe(data: bytes, fmt: str) -> tuple[list, int]:
    """(chains, n_residues) for a structure or FASTA payload; raises AppError if unreadable."""
    text = sio.decode(data)
    if fmt == "fasta":
        records = sio.parse_fasta(text)
        chains = [{"id": r["id"], "n_residues": r["n_residues"], "sequence": r["sequence"]}
                  for r in records]
        return chains, sum(c["n_residues"] for c in chains)
    info = sio.summarize(sio.parse_structure(text, fmt))
    return info["chains"], info["n_residues"]


def store(ctx, *, data: bytes, fmt: str, label: str, source: str, origin_id,
          provenance: dict, pae: Optional[bytes] = None,
          fixed_path: Optional[Path] = None) -> dict:
    """Validate, persist file (+PAE) and DB row; returns the public structure dict."""
    chains, n_res = describe(data, fmt)
    pae_info = None
    if pae is not None:
        pae_info = confidence.parse_pae(pae)  # validates JSON shape
        check_pae_size(pae_info["size"], n_res)
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


def _resolve(ctx, exp_id: str, rel: str, bundle_dir: Optional[Path] = None) -> Optional[Path]:
    """Find a file an experiment refers to, whichever root its producer used.

    Paths are written relative to the data dir by one stream and relative to the
    bundle directory by another, and bundles also copy their files into
    data/structures/<exp_id>/. Try each, and never escape the data dir.
    """
    base = ctx.data_dir.resolve()
    name = Path(rel).name
    candidates = []
    if bundle_dir is not None:
        candidates.append(bundle_dir / rel)
    candidates += [ctx.data_dir / rel,
                   ctx.experiments_dir / exp_id / rel,
                   ctx.structures_dir / exp_id / name,
                   ctx.pae_dir / exp_id / name]
    for cand in candidates:
        try:
            p = cand.resolve()
        except OSError:
            continue
        if base in p.parents and p.is_file():
            return p
    return None


def _existing(ctx, origin_id: str):
    with db(ctx) as c:
        return c.execute("SELECT * FROM structures WHERE origin_id=? ORDER BY created_at, id LIMIT 1",
                         (origin_id,)).fetchone()


def _str_map(value: Any) -> dict[str, str]:
    return {str(k): str(v) for k, v in value.items()} if isinstance(value, dict) else {}


PAE_ATTACHED_KEY = "pae_attached_by_user"


def pae_was_attached_by_a_person(row) -> bool:
    """Did someone upload this PAE, rather than it arriving in the bundle?

    A bundle is the source of truth for the files it exported, so a refresh
    normally makes the row match the bundle exactly. A PAE that a person
    attached by hand did not come from the bundle, and deleting it because the
    bundle never mentioned it is data loss, not reconciliation.
    """
    try:
        prov = json.loads(row["provenance"] or "{}")
    except (ValueError, TypeError):
        return False
    return bool(isinstance(prov, dict) and prov.get(PAE_ATTACHED_KEY))


def _provenance(exp_id: str, source: str, refreshed: bool,
                pae_attached: bool = False) -> dict:
    return {
        "source": f"experiment:{exp_id}",
        "experiment_id": exp_id,
        "retrieved_at": sio.now_iso(),
        "url": None,
        "notes": ("Registered automatically from the experiment bundle that lists it as an "
                  f"output. Source '{source}' is as the bundle declared it; it was not inferred "
                  "from the file."
                  + (" Refreshed because the bundle changed since it was first registered."
                     if refreshed else "")
                  + (" Its PAE matrix was attached here by a person and is kept across "
                     "refreshes; the bundle did not supply one." if pae_attached else "")),
        **({PAE_ATTACHED_KEY: True} if pae_attached else {}),
    }


def _refresh(ctx, row, *, data: bytes, fmt: str, label: str, source: str, path: Path,
             pae: Optional[bytes], exp_id: str) -> None:
    """Bring an existing row back in line with its bundle, keeping the structure id.

    The bundle is the source of truth for a structure it registered. Without
    this, a record first registered as "uploaded" (before its bundle declared a
    source) would keep refusing to report pLDDT forever, and a re-exported
    bundle would be shown with the previous export's residue counts.
    """
    chains, n_res = describe(data, fmt)
    pae_rel = None
    pae_file = ctx.pae_dir / f"{row['id']}.json"
    keep_attached = pae is None and pae_was_attached_by_a_person(row) and pae_file.exists()
    if pae is not None:
        # The bundle now ships a PAE. It wins, and the row stops being marked
        # as carrying a hand-attached one.
        pae_file.write_bytes(pae)
        pae_rel = ctx.rel(pae_file)
    elif keep_attached:
        pae_rel = ctx.rel(pae_file)
    elif pae_file.exists():
        pae_file.unlink()
    with db(ctx) as c:
        c.execute(
            "UPDATE structures SET label=?, source=?, format=?, sha256=?, chains=?, n_residues=?, "
            "file_path=?, pae_path=?, provenance=? WHERE id=?",
            (label, source, fmt, sio.sha256(data), json.dumps(chains), n_res, ctx.rel(path),
             pae_rel,
             json.dumps(_provenance(exp_id, source, refreshed=True, pae_attached=keep_attached)),
             row["id"]),
        )


def _differs(ctx, row, *, sha: str, label: str, source: str, path: Path,
             pae: Optional[bytes]) -> bool:
    if (row["sha256"], row["label"], row["source"]) != (sha, label, source):
        return True
    if row["file_path"] != ctx.rel(path):
        return True
    if pae is None and row["pae_path"] and pae_was_attached_by_a_person(row):
        # Not a difference to reconcile: the bundle never claimed to have one.
        return False
    if (pae is None) != (not row["pae_path"]):
        return True
    if pae is not None:
        try:
            return ctx.abs(row["pae_path"]).read_bytes() != pae
        except OSError:
            return True
    return False


def register_experiment_outputs(ctx, exp: dict, bundle_dir: Optional[Path] = None) -> dict:
    """Make the structure table agree with the structures one experiment lists.

    New structures are registered; ones already registered from this bundle are
    refreshed in place (same id) when the file, label, declared source or PAE
    changed, and left alone otherwise. Best-effort: problems are returned in
    "errors", never raised, because a malformed output must not stop an
    experiment from being indexed and reindex runs on every startup.

    Returns {"registered": [ids], "updated": [ids], "skipped": n, "errors": [...]}.
    """
    exp_id = str(exp.get("id") or "")
    result: dict[str, Any] = {"registered": [], "updated": [], "skipped": 0, "errors": []}
    if not exp_id:
        return result

    entries = _normalise_outputs(exp.get("outputs"))
    sources_map = _str_map(exp.get("structure_sources"))
    labels_map = _str_map(exp.get("structure_labels"))
    paes = {Path(e["path"]).name[: -len(".pae.json")]: e
            for e in entries if _kind_of(e) == "pae" and e["path"].endswith(".pae.json")}

    for entry in entries:
        if _kind_of(entry) != "structure":
            continue
        rel = entry["path"]
        name = Path(rel).name
        origin_id = f"{exp_id}:{name}"
        path = _resolve(ctx, exp_id, rel, bundle_dir)
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
        label = str(entry.get("label") or labels_map.get(name) or labels_map.get(rel)
                    or f"{name} ({exp_id})")

        try:
            data = path.read_bytes()
            fmt = sio.detect_format(path.name, sio.decode(data))

            pae_bytes = None
            pae_entry = paes.get(Path(name).stem)
            if pae_entry is not None:
                pae_path = _resolve(ctx, exp_id, pae_entry["path"], bundle_dir)
                if pae_path is None:
                    result["errors"].append({"path": pae_entry["path"],
                                             "error": "PAE listed but not found under data/"})
                else:
                    candidate = pae_path.read_bytes()
                    try:
                        _, n_res = describe(data, fmt)
                        check_pae_size(confidence.parse_pae(candidate)["size"], n_res)
                        pae_bytes = candidate
                    except AppError as e:
                        # The structure is still worth having; its PAE is not attached.
                        result["errors"].append({"path": pae_entry["path"], "error": e.detail})

            row = _existing(ctx, origin_id)
            if row is None:
                created = store(ctx, data=data, fmt=fmt, label=label, source=source,
                                origin_id=origin_id,
                                provenance=_provenance(exp_id, source, refreshed=False),
                                pae=pae_bytes, fixed_path=path)
                result["registered"].append(created["id"])
            elif _differs(ctx, row, sha=sio.sha256(data), label=label, source=source,
                          path=path, pae=pae_bytes):
                _refresh(ctx, row, data=data, fmt=fmt, label=label, source=source, path=path,
                         pae=pae_bytes, exp_id=exp_id)
                result["updated"].append(row["id"])
            else:
                result["skipped"] += 1
        except Exception as e:  # noqa: BLE001 - reported, never fatal to reindex
            detail = e.detail if isinstance(e, AppError) else f"{type(e).__name__}: {e}"
            result["errors"].append({"path": rel, "error": detail})
    return result


def forget_experiment_structures(ctx, exp_id: str) -> int:
    """Drop the rows a bundle registered, when the bundle itself is gone.

    Only database rows and this app's own PAE copies are removed. The structure
    files belong to whoever put them under data/ and are never deleted here.
    """
    removed = 0
    prefix = f"{exp_id}:"
    with db(ctx) as c:
        # substr, not LIKE: "_" is a LIKE wildcard and experiment ids are full of them.
        rows = c.execute("SELECT id, pae_path FROM structures WHERE substr(origin_id, 1, ?) = ?",
                         (len(prefix), prefix)).fetchall()
        for r in rows:
            c.execute("DELETE FROM structures WHERE id=?", (r["id"],))
            removed += 1
            if r["pae_path"]:
                try:
                    ctx.abs(r["pae_path"]).unlink()
                except (OSError, ValueError):
                    pass
    return removed
