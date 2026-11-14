import json
import uuid
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.db import db, structure_row_to_dict
from app.deps import get_ctx
from app.errors import AppError
from app.services import confidence, structure_io as sio

router = APIRouter(prefix="/structures", tags=["structures"])

Source = Literal["experimental", "predicted", "uploaded"]


def _new_id() -> str:
    return f"st_{uuid.uuid4().hex[:10]}"


def _store(ctx, *, data: bytes, fmt: str, label: str, source: str, origin_id, provenance: dict, pae: Optional[bytes] = None, fixed_path: Optional[Path] = None) -> dict:
    """Validate, persist file (+PAE) and DB row; returns the public structure dict."""
    text = sio.decode(data)
    if fmt == "fasta":
        records = sio.parse_fasta(text)
        chains = [{"id": r["id"], "n_residues": r["n_residues"], "sequence": r["sequence"]} for r in records]
        n_res = sum(c["n_residues"] for c in chains)
    else:
        model = sio.parse_structure(text, fmt)
        info = sio.summarize(model)
        chains, n_res = info["chains"], info["n_residues"]
    pae_info = None
    if pae is not None:
        pae_info = confidence.parse_pae(pae)  # validates JSON shape
    sid = _new_id()
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
            "INSERT INTO structures (id,label,source,origin_id,format,sha256,chains,n_residues,file_path,pae_path,provenance,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, label, source, origin_id, fmt, sio.sha256(data), json.dumps(chains), n_res, ctx.rel(path), pae_rel, json.dumps(prov), sio.now_iso()),
        )
        row = c.execute("SELECT * FROM structures WHERE id=?", (sid,)).fetchone()
    return structure_row_to_dict(row)


def _inside(base: Path, rel: str, label: str) -> Path:
    p = (base / rel).resolve()
    if base.resolve() not in p.parents:
        raise AppError(400, f"invalid_path: path must stay inside {label}")
    return p


def _row(ctx, sid: str):
    with db(ctx) as c:
        row = c.execute("SELECT * FROM structures WHERE id=?", (sid,)).fetchone()
    if not row:
        raise AppError(404, f"not_found: structure '{sid}'")
    return row


def load_model(ctx, sid: str):
    row = _row(ctx, sid)
    if row["format"] == "fasta":
        raise AppError(409, "no_coordinates: this record is a FASTA sequence with no 3D coordinates")
    text = ctx.abs(row["file_path"]).read_text()
    return row, sio.parse_structure(text, row["format"])


@router.post("/upload", status_code=201)
async def upload(file: UploadFile = File(...), label: Optional[str] = Form(None), source: Source = Form("uploaded"), ctx=Depends(get_ctx)):
    data = await file.read()
    text = sio.decode(data)
    fmt = sio.detect_format(file.filename or "", text)
    if fmt == "fasta" and source != "uploaded":
        raise AppError(400, "invalid_request: FASTA sequences have no coordinates, so source must be 'uploaded'")
    prov = {"source": "User upload", "retrieved_at": sio.now_iso(), "url": None, "notes": f"Uploaded file '{file.filename}'. Declared source: {source}."}
    return _store(ctx, data=data, fmt=fmt, label=(label or file.filename or "uploaded structure"), source=source, origin_id=file.filename, provenance=prov)


class FetchBody(BaseModel):
    source: Literal["rcsb", "afdb"]
    id: str
    label: Optional[str] = None


@router.post("/fetch", status_code=201)
def fetch(body: FetchBody, ctx=Depends(get_ctx)):
    res = sio.fetch_rcsb(body.id) if body.source == "rcsb" else sio.fetch_afdb(body.id)
    pae = res["pae"]
    try:
        return _store(
            ctx, data=res["data"], fmt=res["format"], label=body.label or res["origin_id"],
            source="experimental" if body.source == "rcsb" else "predicted",
            origin_id=res["origin_id"], provenance=res["provenance"], pae=pae,
        )
    except AppError as e:
        if pae is not None and e.detail.startswith("invalid_pae"):
            # Structure is fine; an unreadable PAE file must not block the import.
            res["provenance"]["notes"] += " PAE file was downloaded but could not be parsed, so it was not stored."
            return _store(ctx, data=res["data"], fmt=res["format"], label=body.label or res["origin_id"],
                          source="predicted", origin_id=res["origin_id"], provenance=res["provenance"])
        raise


class RegisterBody(BaseModel):
    path: str
    label: str
    source: Source
    origin_id: Optional[str] = None
    pae_path: Optional[str] = None
    notes: Optional[str] = None


@router.post("/register", status_code=201)
def register(body: RegisterBody, ctx=Depends(get_ctx)):
    """Register a file already placed under data/structures/ (e.g. by the data-fetch script)."""
    p = _inside(ctx.structures_dir, body.path, "data/structures")
    if not p.is_file():
        raise AppError(404, f"not_found: data/structures/{body.path}")
    data = p.read_bytes()
    fmt = sio.detect_format(p.name, sio.decode(data))
    pae = None
    if body.pae_path:
        pp = _inside(ctx.pae_dir, body.pae_path, "data/pae")
        if not pp.is_file():
            raise AppError(404, f"not_found: data/pae/{body.pae_path}")
        pae = pp.read_bytes()
    prov = {"source": "Local registration", "retrieved_at": sio.now_iso(), "url": None, "notes": body.notes or f"Registered local file structures/{body.path}."}
    return _store(ctx, data=data, fmt=fmt, label=body.label, source=body.source, origin_id=body.origin_id, provenance=prov, pae=pae, fixed_path=p)


@router.get("")
def list_structures(ctx=Depends(get_ctx)):
    with db(ctx) as c:
        rows = c.execute("SELECT * FROM structures ORDER BY created_at DESC, id").fetchall()
    return [structure_row_to_dict(r) for r in rows]


@router.get("/{sid}")
def get_structure(sid: str, ctx=Depends(get_ctx)):
    return structure_row_to_dict(_row(ctx, sid))


@router.get("/{sid}/file")
def get_file(sid: str, ctx=Depends(get_ctx)):
    row = _row(ctx, sid)
    p = ctx.abs(row["file_path"])
    ext = {"pdb": "pdb", "mmcif": "cif", "fasta": "fasta"}[row["format"]]
    return FileResponse(p, media_type="text/plain", filename=f"{row['label'].replace('/', '_')}.{ext}")


@router.get("/{sid}/residues")
def get_residues(sid: str, chain: Optional[str] = None, ctx=Depends(get_ctx)):
    row, model = load_model(ctx, sid)
    info = sio.summarize(model)
    residues = [r for r in info["residues"] if not chain or r["chain"] == chain]
    if chain and not residues:
        raise AppError(404, f"not_found: chain '{chain}' in structure '{sid}'")
    return {"structure_id": sid, "source": row["source"], "chains": info["chains"], "residues": residues}


@router.get("/{sid}/plddt")
def get_plddt(sid: str, chain: Optional[str] = None, ctx=Depends(get_ctx)):
    row, model = load_model(ctx, sid)
    if row["source"] != "predicted":
        raise AppError(
            409,
            f"plddt_unavailable: structure source is '{row['source']}'. pLDDT is only read from structures "
            "declared as 'predicted' (B-factors of experimental or unlabelled files are a different quantity).",
        )
    return {"structure_id": sid, "source": row["source"], **confidence.plddt_profile(model, chain)}


@router.get("/{sid}/pae")
def get_pae(sid: str, ctx=Depends(get_ctx)):
    row = _row(ctx, sid)
    if not row["pae_path"]:
        raise AppError(404, "pae_unavailable")
    p = ctx.abs(row["pae_path"])
    if not p.is_file():
        raise AppError(404, "pae_unavailable")
    return {"structure_id": sid, **confidence.parse_pae(p.read_bytes())}


@router.post("/{sid}/pae", status_code=201)
async def attach_pae(sid: str, file: UploadFile = File(...), ctx=Depends(get_ctx)):
    row = _row(ctx, sid)
    raw = await file.read()
    info = confidence.parse_pae(raw)
    if row["n_residues"] and info["size"] != row["n_residues"]:
        raise AppError(409, f"pae_mismatch: PAE matrix is {info['size']}x{info['size']} but the structure has {row['n_residues']} residues")
    path = ctx.pae_dir / f"{sid}.json"
    path.write_bytes(raw)
    with db(ctx) as c:
        c.execute("UPDATE structures SET pae_path=? WHERE id=?", (ctx.rel(path), sid))
    return {"structure_id": sid, "size": info["size"], "max_pae": info["max_pae"]}
