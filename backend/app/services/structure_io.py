"""Parsing, validation and fetching of protein structure and sequence files."""
import hashlib
import io
import re
from datetime import datetime, timezone

import httpx
from Bio.Data.PDBData import protein_letters_3to1_extended as AA3
from Bio.PDB import MMCIFParser, PDBParser
from Bio.PDB.Polypeptide import is_aa

from app.errors import AppError

MAX_BYTES = 50 * 1024 * 1024
RCSB_ID_RE = re.compile(r"^[0-9][A-Za-z0-9]{3}$")
UNIPROT_RE = re.compile(
    r"^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2})$"
)
FASTA_RE = re.compile(r"^[A-Za-z*\-]+$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def decode(data: bytes) -> str:
    if not data or not data.strip():
        raise AppError(400, "invalid_structure: file is empty")
    if len(data) > MAX_BYTES:
        raise AppError(400, f"invalid_structure: file exceeds {MAX_BYTES // (1024 * 1024)} MB limit")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise AppError(400, "invalid_structure: file is not UTF-8 text (binary files are not supported)")


def detect_format(filename: str, text: str) -> str:
    """Return 'pdb', 'mmcif' or 'fasta' from extension, falling back to content sniffing."""
    name = (filename or "").lower()
    if name.endswith((".cif", ".mmcif")):
        return "mmcif"
    if name.endswith((".pdb", ".ent")):
        return "pdb"
    if name.endswith((".fa", ".fasta", ".faa", ".fas")):
        return "fasta"
    head = text.lstrip()[:2000]
    if head.startswith(">"):
        return "fasta"
    if head.startswith("data_") or "_atom_site." in text:
        return "mmcif"
    if re.search(r"^(ATOM  |HETATM)", text, re.M):
        return "pdb"
    raise AppError(
        400,
        "invalid_structure: could not recognise the file as PDB, mmCIF or FASTA "
        "(expected ATOM records, an mmCIF data block, or a '>' FASTA header)",
    )


def parse_structure(text: str, fmt: str):
    """Parse coordinates and return the first model. Raises AppError(400) on any problem."""
    try:
        if fmt == "pdb":
            parser = PDBParser(QUIET=True)
        elif fmt == "mmcif":
            parser = MMCIFParser(QUIET=True)
        else:
            raise AppError(400, f"invalid_structure: unsupported coordinate format '{fmt}'")
        structure = parser.get_structure("s", io.StringIO(text))
    except AppError:
        raise
    except Exception as e:  # Biopython raises many exception types for malformed input
        raise AppError(400, f"invalid_structure: malformed {fmt} file ({type(e).__name__}: {e})")
    models = list(structure)
    if not models:
        raise AppError(400, f"invalid_structure: no ATOM records found in {fmt} file")
    model = models[0]
    n_aa = sum(1 for _ in aa_residues(model))
    if n_aa == 0:
        raise AppError(
            400,
            "invalid_structure: no amino-acid residues found "
            "(empty, nucleic-acid-only or ligand-only structures are not supported)",
        )
    if not any("CA" in r for _, r in aa_residues(model)):
        raise AppError(400, "invalid_structure: no CA atoms found in any amino-acid residue")
    return model


def aa_residues(model):
    """Yield (chain, residue) for amino-acid residues (standard + common modified), skipping water/ligands."""
    for chain in model:
        for res in chain:
            if is_aa(res, standard=False):
                yield chain, res


def res_label(chain_id: str, res) -> str:
    return f"{chain_id}:{res.id[1]}{res.id[2].strip()}"


def summarize(model) -> dict:
    chains: dict[str, dict] = {}
    residues = []
    for chain, res in aa_residues(model):
        c = chains.setdefault(chain.id, {"id": chain.id, "sequence": [], "first": None, "last": None})
        aa = AA3.get(res.get_resname(), "X")
        c["sequence"].append(aa)
        c["first"] = res.id[1] if c["first"] is None else c["first"]
        c["last"] = res.id[1]
        residues.append(
            {
                "chain": chain.id,
                "resseq": res.id[1],
                "icode": res.id[2].strip(),
                "resname": res.get_resname(),
                "aa": aa,
                "has_ca": "CA" in res,
            }
        )
    chain_list = [
        {
            "id": c["id"],
            "n_residues": len(c["sequence"]),
            "sequence": "".join(c["sequence"]),
            "first_resseq": c["first"],
            "last_resseq": c["last"],
        }
        for c in chains.values()
    ]
    return {"chains": chain_list, "residues": residues, "n_residues": len(residues)}


def parse_fasta(text: str) -> list[dict]:
    records, header, seq = [], None, []
    for ln, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        if line.startswith(">"):
            if header is not None:
                records.append((header, "".join(seq)))
            header, seq = line[1:].strip(), []
            if not header:
                raise AppError(400, f"invalid_fasta: empty header on line {ln}")
        else:
            if header is None:
                raise AppError(400, f"invalid_fasta: sequence data before first '>' header (line {ln})")
            if not FASTA_RE.match(line):
                raise AppError(400, f"invalid_fasta: invalid characters on line {ln}")
            seq.append(line.replace("-", "").replace("*", "").upper())
    if header is not None:
        records.append((header, "".join(seq)))
    if not records:
        raise AppError(400, "invalid_fasta: no records found (expected '>' header lines)")
    out = []
    for i, (h, s) in enumerate(records):
        if not s:
            raise AppError(400, f"invalid_fasta: record '{h}' has an empty sequence")
        out.append(
            {
                "id": (h.split()[0] if h.split() else f"seq{i + 1}")[:40],
                "description": h,
                "n_residues": len(s),
                "sequence": s,
            }
        )
    return out


# ---------------------------------------------------------------- remote fetch

def make_client() -> httpx.Client:
    """Factory is module-level so tests can substitute a mock transport."""
    return httpx.Client(timeout=httpx.Timeout(20.0, connect=10.0), follow_redirects=True)


def _get(client: httpx.Client, url: str, what: str) -> httpx.Response:
    try:
        r = client.get(url)
    except httpx.TimeoutException:
        raise AppError(504, f"upstream_timeout: {what} did not respond in time")
    except httpx.HTTPError as e:
        raise AppError(502, f"upstream_error: could not reach {what} ({type(e).__name__})")
    if r.status_code == 404:
        raise AppError(404, f"not_found: {what} has no such entry")
    if r.status_code != 200:
        raise AppError(502, f"upstream_error: {what} returned HTTP {r.status_code}")
    return r


def fetch_rcsb(pdb_id: str) -> dict:
    pid = (pdb_id or "").strip()
    if not RCSB_ID_RE.match(pid):
        raise AppError(400, "invalid_id: a PDB ID is 4 characters, a digit followed by 3 letters/digits (e.g. 1UBQ)")
    url = f"https://files.rcsb.org/download/{pid.upper()}.cif"
    with make_client() as client:
        r = _get(client, url, "RCSB PDB")
    return {
        "data": r.content,
        "format": "mmcif",
        "origin_id": pid.upper(),
        "pae": None,
        "provenance": {
            "source": "RCSB PDB",
            "retrieved_at": now_iso(),
            "url": url,
            "notes": "Downloaded as mmCIF from files.rcsb.org.",
        },
    }


def fetch_afdb(accession: str) -> dict:
    acc = (accession or "").strip().upper()
    if not UNIPROT_RE.match(acc):
        raise AppError(400, "invalid_id: not a valid UniProt accession (e.g. P42212)")
    api = f"https://alphafold.ebi.ac.uk/api/prediction/{acc}"
    with make_client() as client:
        r = _get(client, api, "AlphaFold DB")
        try:
            entries = r.json()
            entry = entries[0] if isinstance(entries, list) else entries
        except Exception:
            raise AppError(502, "upstream_error: AlphaFold DB returned an unreadable response")
        if not isinstance(entry, dict):
            raise AppError(502, "upstream_error: AlphaFold DB returned an unexpected response")
        fmt, struct_url = ("mmcif", entry.get("cifUrl")) if entry.get("cifUrl") else ("pdb", entry.get("pdbUrl"))
        if not struct_url:
            raise AppError(502, "upstream_error: AlphaFold DB response has no structure file URL")
        sr = _get(client, struct_url, "AlphaFold DB file server")
        pae_bytes, pae_note = None, "PAE file not listed by AlphaFold DB for this entry."
        if entry.get("paeDocUrl"):
            try:
                pae_bytes = _get(client, entry["paeDocUrl"], "AlphaFold DB PAE file").content
                pae_note = "PAE JSON downloaded from AlphaFold DB."
            except AppError as e:
                pae_note = f"PAE download failed ({e.detail}); structure imported without PAE."
    return {
        "data": sr.content,
        "format": fmt,
        "origin_id": entry.get("entryId") or acc,
        "pae": pae_bytes,
        "provenance": {
            "source": "AlphaFold Protein Structure Database",
            "retrieved_at": now_iso(),
            "url": struct_url,
            "notes": f"Predicted model; model version {entry.get('latestVersion', 'unknown')}. {pae_note}",
        },
    }
