"""Experiment registry: validation, storage, comparison, and bundle import."""
import json
import re
import uuid
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from app.db import db
from app.errors import AppError
from app.services.structure_io import now_iso

ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


class Provenance(BaseModel):
    model_config = ConfigDict(extra="allow")
    source: str
    retrieved_at: Optional[str] = None
    url: Optional[str] = None
    notes: Optional[str] = None


class Experiment(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: Optional[str] = None
    created_at: Optional[str] = None
    kind: Literal["executed", "imported", "demo"]
    status: Literal["ok", "failed", "partial"]
    model_name: str
    model_version: Optional[str] = None
    settings: dict[str, Any] = Field(default_factory=dict)
    inputs: list[Any] = Field(default_factory=list)
    outputs: list[Any] = Field(default_factory=list)
    metrics: dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = None
    provenance: Provenance

    @model_validator(mode="after")
    def _integrity(self):
        if self.id is not None and not ID_RE.match(self.id):
            raise ValueError("id may contain only letters, digits, '_', '.', '-' (max 80 chars)")
        if self.status == "failed" and not (self.error and self.error.strip()):
            raise ValueError("a failed experiment must record the real error message")
        if self.kind == "executed" and self.status == "ok" and not self.outputs:
            raise ValueError("an 'executed' experiment with status 'ok' must list its output files")
        return self


def _validate(payload: dict) -> dict:
    try:
        exp = Experiment.model_validate(payload)
    except ValidationError as e:
        msgs = "; ".join(f"{'.'.join(map(str, err['loc'])) or 'experiment'}: {err['msg']}" for err in e.errors())
        raise AppError(422, f"invalid_experiment: {msgs}")
    d = exp.model_dump()
    d["id"] = d["id"] or f"exp_{uuid.uuid4().hex[:10]}"
    d["created_at"] = d["created_at"] or now_iso()
    return d


def save(ctx, payload: dict, overwrite: bool = False) -> dict:
    d = _validate(payload)
    with db(ctx) as c:
        exists = c.execute("SELECT 1 FROM experiments WHERE id=?", (d["id"],)).fetchone()
        if exists and not overwrite:
            raise AppError(409, f"conflict: experiment '{d['id']}' already exists")
        c.execute(
            "INSERT OR REPLACE INTO experiments (id, created_at, kind, status, body) VALUES (?,?,?,?,?)",
            (d["id"], d["created_at"], d["kind"], d["status"], json.dumps(d)),
        )
    return d


def get(ctx, exp_id: str) -> dict:
    with db(ctx) as c:
        row = c.execute("SELECT body FROM experiments WHERE id=?", (exp_id,)).fetchone()
    if not row:
        raise AppError(404, f"not_found: experiment '{exp_id}'")
    return json.loads(row["body"])


def list_all(ctx, kind=None, status=None) -> list[dict]:
    q, args = "SELECT body FROM experiments WHERE 1=1", []
    if kind:
        q += " AND kind=?"
        args.append(kind)
    if status:
        q += " AND status=?"
        args.append(status)
    with db(ctx) as c:
        rows = c.execute(q + " ORDER BY created_at DESC, id", args).fetchall()
    return [json.loads(r["body"]) for r in rows]


def compare(ctx, ids: list[str]) -> dict:
    if len(ids) < 2:
        raise AppError(400, "invalid_request: provide at least two experiment ids")
    if len(set(ids)) != len(ids):
        raise AppError(400, "invalid_request: experiment ids must be distinct")
    exps = [get(ctx, i) for i in ids]

    def row(name, vals):
        return {"field": name, "values": dict(zip(ids, vals)), "differs": len({json.dumps(v, sort_keys=True) for v in vals}) > 1}

    fields = [row(f, [e.get(f) for e in exps]) for f in ("kind", "status", "model_name", "model_version", "error")]
    fields.append(row("provenance.source", [e["provenance"].get("source") for e in exps]))
    settings = [row(k, [e["settings"].get(k) for e in exps]) for k in sorted({k for e in exps for k in e["settings"]})]
    metrics = [row(k, [e["metrics"].get(k) for e in exps]) for k in sorted({k for e in exps for k in e["metrics"]})]
    return {
        "ids": ids,
        "experiments": exps,
        "fields": fields,
        "settings": settings,
        "metrics": metrics,
        "note": "Values are shown as recorded; a null means the experiment did not record that field. Metrics from different models or kinds are not directly comparable evidence.",
    }


def reindex(ctx) -> dict:
    """Load <data>/experiments/<dir>/experiment.json bundles (from the data and HPC streams)."""
    imported, errors = [], []
    for d in sorted(p for p in ctx.experiments_dir.iterdir() if p.is_dir()):
        f = d / "experiment.json"
        if not f.exists():
            continue
        try:
            payload = json.loads(f.read_text())
            if not isinstance(payload, dict):
                raise AppError(422, "invalid_experiment: top level must be a JSON object")
            payload.setdefault("id", d.name)
            saved = save(ctx, payload, overwrite=True)
            imported.append(saved["id"])
        except AppError as e:
            errors.append({"path": str(f.relative_to(ctx.data_dir)), "error": e.detail})
        except Exception as e:
            errors.append({"path": str(f.relative_to(ctx.data_dir)), "error": f"{type(e).__name__}: {e}"})
    return {"imported": imported, "errors": errors}
