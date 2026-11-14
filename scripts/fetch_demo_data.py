#!/usr/bin/env python3
"""Download real public structures into data/structures/ and build data/manifest.json.

Stdlib only. Every candidate is VERIFIED against its source API before it is
included; anything that cannot be verified is dropped and listed in
data/fetch_report.json. Nothing here invents citations or functional claims:
publication references are copied only from the RCSB entry's own
`rcsb_primary_citation` metadata, and interface descriptions are limited to
chain IDs, entity names from the entry, and contacts computed here.

Usage:  python scripts/fetch_demo_data.py [--data-dir data] [--only ID ...]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

RCSB_ENTRY = "https://data.rcsb.org/rest/v1/core/entry/{id}"
RCSB_ENTITY = "https://data.rcsb.org/rest/v1/core/polymer_entity/{id}/{n}"
RCSB_FILE = "https://files.rcsb.org/download/{id}.pdb"
RCSB_SEARCH = "https://search.rcsb.org/rcsbsearch/v2/query"
AFDB_API = "https://alphafold.ebi.ac.uk/api/prediction/{acc}"
CONTACT_CUTOFF = 4.5  # Angstrom, any heavy atom pair

# Candidates are tried in order; the first one that verifies wins for that slot.
# `expect` = case-insensitive substrings; at least one must appear in the entry title.
SLOTS = [
    {"slot": "crambin", "label": "Crambin", "db": "rcsb", "ids": ["1CRN"], "expect": ["crambin"]},
    {"slot": "ubiquitin", "label": "Ubiquitin", "db": "rcsb", "ids": ["1UBQ"], "expect": ["ubiquitin"]},
    {"slot": "hewl_experimental", "label": "Hen egg-white lysozyme (experimental)", "db": "rcsb",
     "ids": ["1LYZ", "193L"], "expect": ["lysozyme"]},
    {"slot": "hewl_predicted", "label": "Hen egg-white lysozyme (AlphaFold DB model)", "db": "afdb",
     "ids": ["P00698"], "expect": []},
    {"slot": "gfp_predicted", "label": "GFP (AlphaFold DB model, with PAE)", "db": "afdb",
     "ids": ["P42212"], "expect": [], "want_pae": True},
    {"slot": "gfp_experimental", "label": "GFP (experimental)", "db": "rcsb",
     "ids": ["1EMA", "1GFL"], "expect": ["green fluorescent"]},
    {"slot": "rbd_ace2", "label": "SARS-CoV-2 RBD / ACE2 complex", "db": "rcsb",
     "ids": ["6M0J"], "expect": ["ace2", "spike", "receptor"]},
    {"slot": "antibody_antigen", "label": "Antibody-antigen complex (curated, public)", "db": "rcsb",
     "ids": ["1MLC", "1VFB"], "expect": ["lysozyme", "antibody", "fab", "fv", "idiotyp"]},
    {"slot": "de_novo_designed", "label": "De novo designed protein (deposited)", "db": "rcsb",
     "ids": ["1QYS"], "expect": ["top7", "designed"], "search_fallback": "de novo designed protein"},
]

# Curated pairs for prediction-vs-experiment review. Chosen by this stream, not
# asserted by either database; sequences may differ, so alignments must report
# which residues were aligned.
PAIRS = [
    {"experimental": "hewl_experimental", "predicted": "hewl_predicted"},
    {"experimental": "gfp_experimental", "predicted": "gfp_predicted"},
]


# ---------------------------------------------------------------- HTTP layer
class Http:
    def __init__(self, retries: int = 3, timeout: int = 60):
        self.retries, self.timeout = retries, timeout

    def get(self, url: str, data: bytes | None = None, headers: dict | None = None) -> bytes:
        last: Exception | None = None
        for i in range(self.retries):
            try:
                req = urllib.request.Request(url, data=data, headers={
                    "User-Agent": "foldstudio-fetch/1.0 (hackathon demo data)", **(headers or {})})
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return r.read()
            except urllib.error.HTTPError as e:
                if e.code in (400, 401, 403, 404):  # not retryable
                    raise
                last = e
            except Exception as e:  # noqa: BLE001
                last = e
            time.sleep(1.5 * (i + 1))
        raise RuntimeError(f"GET {url} failed: {last}")

    def json(self, url: str, **kw):
        return json.loads(self.get(url, **kw))


HTTP = Http()


# ------------------------------------------------------------ PDB utilities
def parse_pdb(text: str):
    """Yield protein ATOM records from the first model: dict per atom."""
    atoms = []
    for line in text.splitlines():
        if line.startswith("ENDMDL"):
            break
        if not line.startswith("ATOM"):
            continue
        alt = line[16:17]
        if alt not in (" ", "A", "1"):
            continue
        try:
            atoms.append({
                "name": line[12:16].strip(), "resn": line[17:20].strip(), "chain": line[21:22].strip() or "_",
                "res": (line[21:22].strip() or "_", line[22:26].strip(), line[26:27].strip()),
                "xyz": (float(line[30:38]), float(line[38:46]), float(line[46:54])),
                "b": float(line[60:66]) if line[60:66].strip() else math.nan,
                "elem": (line[76:78].strip() or line[12:16].strip()[:1]).upper(),
            })
        except ValueError:
            continue
    return atoms


def summarize(atoms):
    residues = {a["res"] for a in atoms}
    chains = sorted({a["chain"] for a in atoms})
    return {"chains": chains, "n_residues": len(residues)}


def mean_plddt_from_bfactor(atoms):
    """AlphaFold DB files store pLDDT in the B-factor column; mean over CA atoms."""
    v = [a["b"] for a in atoms if a["name"] == "CA" and not math.isnan(a["b"])]
    return round(sum(v) / len(v), 3) if v else None


def interface_contacts(atoms, cutoff: float = CONTACT_CUTOFF):
    """Residue-pair contacts between each pair of chains (any heavy atom within cutoff)."""
    heavy = [a for a in atoms if a["elem"] != "H"]
    grid = defaultdict(list)
    for i, a in enumerate(heavy):
        grid[tuple(int(math.floor(c / cutoff)) for c in a["xyz"])].append(i)
    pairs = defaultdict(set)  # (chainA, chainB) -> {(resA, resB)}
    c2 = cutoff * cutoff
    for i, a in enumerate(heavy):
        cx, cy, cz = (int(math.floor(c / cutoff)) for c in a["xyz"])
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for j in grid.get((cx + dx, cy + dy, cz + dz), ()):
                        b = heavy[j]
                        if a["chain"] >= b["chain"]:
                            continue
                        d2 = sum((p - q) ** 2 for p, q in zip(a["xyz"], b["xyz"]))
                        if d2 <= c2:
                            pairs[(a["chain"], b["chain"])].add((a["res"], b["res"]))
    out = []
    for (ca, cb), s in sorted(pairs.items()):
        out.append({"chain_a": ca, "chain_b": cb, "cutoff_angstrom": cutoff,
                    "n_residue_pairs": len(s),
                    "n_residues_a": len({p[0] for p in s}), "n_residues_b": len({p[1] for p in s})})
    return out


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------- Verifiers
def verify_rcsb(pdb_id: str, expect: list[str]) -> dict:
    meta = HTTP.json(RCSB_ENTRY.format(id=pdb_id))
    title = (meta.get("struct") or {}).get("title", "")
    if expect and not any(e.lower() in title.lower() for e in expect):
        raise ValueError(f"{pdb_id} resolves but title {title!r} matches none of {expect}")
    return meta


def entity_names(pdb_id: str, meta: dict) -> dict[str, str]:
    """chain -> entity description, taken only from the entry's own entity records."""
    out: dict[str, str] = {}
    ids = (meta.get("rcsb_entry_container_identifiers") or {}).get("polymer_entity_ids") or []
    for n in ids:
        try:
            e = HTTP.json(RCSB_ENTITY.format(id=pdb_id, n=n))
        except Exception:  # noqa: BLE001
            continue
        desc = (e.get("rcsb_polymer_entity") or {}).get("pdbx_description", "")
        for ch in (e.get("rcsb_polymer_entity_container_identifiers") or {}).get("auth_asym_ids", []):
            out[ch] = desc
    return out


def citation_from_entry(meta: dict) -> dict | None:
    c = meta.get("rcsb_primary_citation")
    if not c:
        return None
    keep = {"title": c.get("title"), "journal": c.get("rcsb_journal_abbrev"),
            "year": c.get("year"), "doi": c.get("pdbx_database_id_doi"),
            "pubmed_id": c.get("pdbx_database_id_pub_med")}
    return {k: v for k, v in keep.items() if v}


def search_fallback(query: str) -> list[str]:
    """Deterministic RCSB full-text search for an experimental entry; earliest release first."""
    body = {"query": {"type": "terminal", "service": "full_text", "parameters": {"value": query}},
            "return_type": "entry",
            "request_options": {"paginate": {"start": 0, "rows": 5},
                                "sort": [{"sort_by": "rcsb_accession_info.initial_release_date", "direction": "asc"}]}}
    r = HTTP.json(RCSB_SEARCH, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return [x["identifier"] for x in r.get("result_set", [])]


# ------------------------------------------------------------------ Fetchers
def fetch_rcsb(slot: dict, pdb_id: str, out_dir: Path, now: str) -> tuple[dict, dict]:
    meta = verify_rcsb(pdb_id, slot["expect"])
    url = RCSB_FILE.format(id=pdb_id)
    raw = HTTP.get(url)
    atoms = parse_pdb(raw.decode("utf-8", "replace"))
    if not atoms:
        raise ValueError(f"{pdb_id}: downloaded file has no ATOM records")
    sid = pdb_id.lower()
    (out_dir / f"{sid}.pdb").write_bytes(raw)
    summ = summarize(atoms)
    names = entity_names(pdb_id, meta)
    info = {
        "id": sid, "label": slot["label"], "source": "experimental", "database": "rcsb",
        "origin_id": pdb_id, "format": "pdb", "url": url, "retrieved_at": now,
        "sha256": sha256_bytes(raw), "file": f"structures/{sid}.pdb", **summ,
        "title_from_entry": (meta.get("struct") or {}).get("title"),
        "method_from_entry": [e.get("method") for e in meta.get("exptl", [])],
        "chain_descriptions_from_entry": {c: names[c] for c in summ["chains"] if c in names},
        "citation_from_entry": citation_from_entry(meta),
    }
    extra = {"interfaces": interface_contacts(atoms) if len(summ["chains"]) > 1 else []}
    return info, extra


def fetch_afdb(slot: dict, acc: str, out_dir: Path, now: str) -> tuple[dict, dict]:
    api = AFDB_API.format(acc=acc)
    recs = HTTP.json(api)
    want = f"AF-{acc}-F1"
    rec = next((r for r in recs if r.get("entryId") == want), None)
    if rec is None:
        raise ValueError(f"{api} returned no entry {want}")
    if rec.get("uniprotAccession") not in (None, acc):
        raise ValueError(f"{want}: uniprotAccession mismatch {rec.get('uniprotAccession')}")
    url = rec["pdbUrl"]
    raw = HTTP.get(url)
    atoms = parse_pdb(raw.decode("utf-8", "replace"))
    if not atoms:
        raise ValueError(f"{want}: downloaded file has no ATOM records")
    sid = want.lower()
    (out_dir / f"{sid}.pdb").write_bytes(raw)
    summ = summarize(atoms)
    info = {
        "id": sid, "label": slot["label"], "source": "predicted", "database": "afdb",
        "origin_id": want, "uniprot": acc, "format": "pdb", "url": url, "retrieved_at": now,
        "sha256": sha256_bytes(raw), "file": f"structures/{sid}.pdb", **summ,
        "model_version": rec.get("latestVersion"), "model_created": rec.get("modelCreatedDate"),
        "organism_from_entry": rec.get("organismScientificName"),
    }
    extra = {"mean_plddt_ca": mean_plddt_from_bfactor(atoms), "interfaces": []}
    pae_url = rec.get("paeDocUrl")
    if slot.get("want_pae"):
        if not pae_url:
            extra["pae_error"] = "AlphaFold DB record has no paeDocUrl"
        else:
            try:
                praw = HTTP.get(pae_url)
                pj = json.loads(praw)
                obj = pj[0] if isinstance(pj, list) else pj
                mat = obj.get("predicted_aligned_error")
                if not (isinstance(mat, list) and mat and len(mat) == len(mat[0])):
                    raise ValueError("PAE JSON lacks a square predicted_aligned_error matrix")
                (out_dir / f"{sid}.pae.json").write_bytes(praw)
                info["pae"] = {"file": f"structures/{sid}.pae.json", "url": pae_url,
                               "sha256": sha256_bytes(praw), "size": len(mat)}
                if len(mat) != summ["n_residues"]:
                    extra["pae_warning"] = f"PAE size {len(mat)} != n_residues {summ['n_residues']}"
            except Exception as e:  # noqa: BLE001
                extra["pae_error"] = str(e)
    return info, extra


# ------------------------------------------------------------- Experiments
def write_experiment(info: dict, extra: dict, data_dir: Path) -> Path:
    eid = f"imported-{info['id']}"
    predicted = info["source"] == "predicted"
    notes = []
    if predicted:
        notes.append("Precomputed AlphaFold DB model imported as-is. FoldStudio did not run any model. "
                     "pLDDT/PAE are model confidence, not proof of folding, binding, affinity, efficacy or safety.")
    else:
        notes.append("Deposited experimental coordinates imported as-is. FoldStudio did not run any experiment or model. "
                     "Coordinates reflect the deposited sample and conditions only.")
    if info.get("citation_from_entry"):
        notes.append("Primary citation as listed in the entry metadata: "
                     + json.dumps(info["citation_from_entry"], ensure_ascii=False))
    notes.append("Limitations: single static model per entry; contact counts are geometric (heavy atoms within "
                 f"{CONTACT_CUTOFF} A) and are not measurements of any physical property.")
    metrics = {"n_residues": info["n_residues"], "n_chains": len(info["chains"])}
    if "mean_plddt_ca" in extra:
        metrics["mean_plddt_ca"] = extra["mean_plddt_ca"]
    if extra.get("interfaces"):
        metrics["interfaces"] = extra["interfaces"]
    # "source" is read by the backend when it auto-registers this structure:
    # GET /structures/{id}/plddt reads B-factors as pLDDT for "predicted" only,
    # and a deposited entry's B-factors are a different quantity entirely.
    # "label" is what the backend calls the structure when it registers it, so
    # the app lists "Crambin" rather than "1crn.pdb (imported-1crn)".
    outputs = [{"type": "structure", "path": info["file"], "sha256": info["sha256"],
                "source": "predicted" if predicted else "experimental",
                "label": info["label"]}]
    if info.get("pae"):
        outputs.append({"type": "pae", "path": info["pae"]["file"], "sha256": info["pae"]["sha256"]})
    # What the entry says about itself, verbatim from its own metadata, for the
    # app to show next to the structure. Only keys that were actually returned.
    entry = {k: info[k] for k in ("label", "reason", "title_from_entry", "method_from_entry",
                                  "chain_descriptions_from_entry", "citation_from_entry",
                                  "selection_note", "database", "origin_id", "url") if info.get(k)}
    exp = {
        "id": eid, "created_at": info["retrieved_at"], "kind": "imported", "status": "ok",
        "model_name": "AlphaFold DB (precomputed)" if predicted else "none (experimental entry)",
        "model_version": str(info.get("model_version") or "n/a"),
        "settings": {}, "inputs": [info["id"]], "outputs": outputs, "metrics": metrics, "error": None,
        "entry": entry,
        "provenance": {"source": f"{info['database']}:{info['origin_id']}", "retrieved_at": info["retrieved_at"],
                       "url": info["url"], "notes": " ".join(notes)},
    }
    p = data_dir / "experiments" / eid / "experiment.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(exp, indent=2, ensure_ascii=False) + "\n")
    return p


# ------------------------------------------------------------------- Main
def try_slot(slot: dict, out_dir: Path, now: str):
    """Return (info, extra, tried_errors). info is None if nothing verified."""
    fn = fetch_rcsb if slot["db"] == "rcsb" else fetch_afdb
    tried: list[dict] = []
    for cid in slot["ids"]:
        try:
            info, extra = fn(slot, cid, out_dir, now)
            return info, extra, tried
        except Exception as e:  # noqa: BLE001
            tried.append({"id": cid, "error": str(e)})
    query = slot.get("search_fallback")
    if query and slot["db"] == "rcsb":
        try:
            candidates = [i for i in search_fallback(query) if i not in slot["ids"]]
        except Exception as e:  # noqa: BLE001
            tried.append({"id": "search:" + query, "error": str(e)})
            candidates = []
        for cid in candidates:
            try:
                info, extra = fn(slot, cid, out_dir, now)
                info["selection_note"] = ("Pinned IDs failed verification; selected via deterministic RCSB "
                                          f"full-text search {query!r} (earliest release first).")
                return info, extra, tried
            except Exception as e:  # noqa: BLE001
                tried.append({"id": cid, "error": str(e)})
    return None, None, tried


def run(data_dir: Path, only: set[str] | None = None) -> dict:
    out_dir = data_dir / "structures"
    out_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    slot_to_id: dict[str, str] = {}
    failed, skipped_candidates, items, extras = [], {}, [], {}
    for slot in SLOTS:
        if only and slot["slot"] not in only:
            continue
        info, extra, tried = try_slot(slot, out_dir, now)
        if info is None:
            failed.append({"slot": slot["slot"], "tried": tried})
            continue
        info["slot"] = slot["slot"]
        items.append(info); extras[info["id"]] = extra; slot_to_id[slot["slot"]] = info["id"]
        if tried:
            skipped_candidates[slot["slot"]] = tried
    pairs = [{"experimental": slot_to_id[p["experimental"]], "predicted": slot_to_id[p["predicted"]]}
             for p in PAIRS if p["experimental"] in slot_to_id and p["predicted"] in slot_to_id]
    for info in items:
        write_experiment(info, extras[info["id"]], data_dir)
    manifest = {"generated_at": now, "generator": "scripts/fetch_demo_data.py",
                "contact_cutoff_angstrom": CONTACT_CUTOFF,
                "pairs_for_prediction_vs_experiment": pairs, "structures": items}
    (data_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    warnings = {i: {k: v for k, v in e.items() if k.startswith("pae_")} for i, e in extras.items()
                if any(k.startswith("pae_") for k in e)}
    report = {"generated_at": now, "succeeded": [m["id"] for m in items],
              "failed_verification_or_download": failed,
              "earlier_candidates_that_failed_before_a_later_one_verified": skipped_candidates,
              "warnings": warnings}
    (data_dir / "fetch_report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--only", nargs="*", help="slot names, e.g. crambin gfp_predicted")
    a = ap.parse_args(argv)
    rep = run(Path(a.data_dir), set(a.only) if a.only else None)
    print(json.dumps(rep, indent=2))
    return 0 if not rep["failed_verification_or_download"] else 1


if __name__ == "__main__":
    sys.exit(main())
