#!/usr/bin/env python3
"""Normalise a ColabFold output directory into the contract hpc/export_bundle.py reads.

ColabFold's file names and score-JSON keys differ between versions, so instead of
hardcoding one layout this script searches for what is actually there, and says
what it found. For each prediction it writes into --out-dir:

    <prefix><stem>.pdb        the ranked-best unrelaxed model, pLDDT in B-factors
    <prefix><stem>.pae.json   {"predicted_aligned_error": [[...]], "max_predicted_aligned_error": x}
    <prefix><stem>.pred.json  mean/min pLDDT, pTM, length, and what was unavailable

Same two rules as the ESMFold runner:
  * the pLDDT scale is measured, not assumed;
  * a number the output did not contain is written as null with a reason, never
    filled in with a plausible-looking value.

`--list-only` reports what it found and writes nothing.

NOT YET EXECUTED against real ColabFold output. The key names it looks for
("plddt", "pae"/"predicted_aligned_error", "ptm") come from ColabFold's scores
JSON; if your version differs, --list-only prints the keys it actually saw, which
is normally a one-line fix. ESMFold is the primary, better-tested path.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from predict_esmfold import bfactor_range, read_fasta, rescale_bfactors  # noqa: E402

RANK_RE = re.compile(r"rank_(\d+)")


def rank_of(path: str) -> int:
    """Lower is better. Unranked files sort last."""
    m = RANK_RE.search(os.path.basename(path))
    return int(m.group(1)) if m else 999


def group_key(filename: str) -> str:
    """Strip ColabFold's decorations to get the original sequence name."""
    stem = os.path.basename(filename)
    for suffix in (".pdb", ".json"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
    stem = re.split(r"_unrelaxed_|_relaxed_|_scores_|_predicted_aligned_error", stem)[0]
    return stem


def collect(in_dir: str) -> dict[str, dict[str, list[str]]]:
    groups: dict[str, dict[str, list[str]]] = {}
    for root, _dirs, files in os.walk(in_dir):
        for f in files:
            full = os.path.join(root, f)
            key = group_key(f)
            g = groups.setdefault(key, {"pdb": [], "scores": [], "pae": []})
            if f.endswith(".pdb"):
                # Prefer unrelaxed: relaxed models have been through Amber
                # minimisation, which perturbs the coordinates we want to compare.
                g["pdb"].append(full)
            elif f.endswith(".json"):
                if "predicted_aligned_error" in f:
                    g["pae"].append(full)
                elif "scores" in f:
                    g["scores"].append(full)
    return groups


def pick_pdb(paths: list[str]) -> str | None:
    if not paths:
        return None
    unrelaxed = [p for p in paths if "unrelaxed" in os.path.basename(p)]
    pool = unrelaxed or paths
    return sorted(pool, key=lambda p: (rank_of(p), p))[0]


def load_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        print(f"  warning: could not read {path}: {exc}", file=sys.stderr)
        return None


def as_matrix(obj):
    """Pull a square PAE matrix out of whatever shape the JSON uses."""
    if obj is None:
        return None
    cand = None
    if isinstance(obj, list):
        if obj and isinstance(obj[0], dict):
            obj = obj[0]
        elif obj and isinstance(obj[0], list):
            cand = obj
    if isinstance(obj, dict):
        for key in ("predicted_aligned_error", "pae"):
            if isinstance(obj.get(key), list):
                cand = obj[key]
                break
    if not (isinstance(cand, list) and cand and isinstance(cand[0], list)):
        return None
    n = len(cand)
    if any(not isinstance(r, list) or len(r) != n for r in cand):
        return None
    return cand


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="normalise ColabFold output for FoldStudio")
    ap.add_argument("--in-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--prefix", default="")
    ap.add_argument("--fasta", action="append", default=[],
                    help="the input FASTA, so sequences/headers can be recorded")
    ap.add_argument("--list-only", action="store_true")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.in_dir):
        print(f"no such directory: {args.in_dir}", file=sys.stderr)
        return 2

    seqs: list[tuple[str, str]] = []
    for fa in args.fasta:
        if os.path.exists(fa):
            seqs.extend(read_fasta(fa))

    groups = collect(args.in_dir)
    if not groups:
        print(f"found no .pdb/.json files under {args.in_dir}", file=sys.stderr)
        return 3

    if args.list_only:
        for key, g in sorted(groups.items()):
            print(f"{key}: {len(g['pdb'])} pdb, {len(g['scores'])} scores, {len(g['pae'])} pae")
            best = pick_pdb(g["pdb"])
            if best:
                print(f"  chosen pdb: {os.path.basename(best)}")
            for s in g["scores"][:1]:
                obj = load_json(s)
                if isinstance(obj, dict):
                    print(f"  scores keys: {sorted(obj.keys())}")
        return 0

    os.makedirs(args.out_dir, exist_ok=True)
    written = 0

    for i, (key, g) in enumerate(sorted(groups.items())):
        pdb_src = pick_pdb(g["pdb"])
        if not pdb_src:
            print(f"skip {key}: no .pdb found", file=sys.stderr)
            continue
        name = f"{args.prefix}{key}"
        unavailable: dict[str, str] = {}

        with open(pdb_src, "r", encoding="utf-8") as fh:
            pdb_text = fh.read()

        lo, hi, n_atoms = bfactor_range(pdb_text)
        if n_atoms == 0:
            units = "absent: no parsable B-factor column"
        elif hi <= 1.0:
            units = "file wrote 0-1; multiplied by 100 for the conventional pLDDT scale"
            pdb_text = rescale_bfactors(pdb_text, 100.0)
            lo, hi, n_atoms = bfactor_range(pdb_text)
        elif hi <= 100.0:
            units = "file wrote 0-100 already; left unchanged"
        else:
            units = (f"unexpected B-factor range {lo:.2f}-{hi:.2f}: neither 0-1 nor 0-100, "
                     "left unchanged and must NOT be read as pLDDT")

        with open(os.path.join(args.out_dir, f"{name}.pdb"), "w", encoding="utf-8") as fh:
            fh.write(pdb_text if pdb_text.endswith("\n") else pdb_text + "\n")

        scores = load_json(g["scores"][0]) if g["scores"] else None
        score_keys = sorted(scores.keys()) if isinstance(scores, dict) else []

        matrix = as_matrix(scores)
        if matrix is None and g["pae"]:
            matrix = as_matrix(load_json(g["pae"][0]))
        if matrix is not None:
            flat_max = max(max(r) for r in matrix)
            mx = scores.get("max_pae") if isinstance(scores, dict) else None
            with open(os.path.join(args.out_dir, f"{name}.pae.json"), "w", encoding="utf-8") as fh:
                json.dump({"predicted_aligned_error": [[round(float(v), 2) for v in r] for r in matrix],
                           "max_predicted_aligned_error": round(float(mx if isinstance(mx, (int, float))
                                                                    else flat_max), 2)}, fh)
        else:
            unavailable["predicted_aligned_error"] = (
                f"no square PAE matrix in the ColabFold output; scores keys seen: {score_keys}")

        # mean pLDDT: prefer the model's own per-residue list; otherwise measure
        # the CA B-factors of the file we just wrote. Both are real; neither is a guess.
        mean_plddt = None
        plddt = scores.get("plddt") if isinstance(scores, dict) else None
        if isinstance(plddt, list) and plddt and all(isinstance(v, (int, float)) for v in plddt):
            vals = [float(v) for v in plddt]
            if max(vals) <= 1.0:
                vals = [v * 100.0 for v in vals]
            mean_plddt = round(sum(vals) / len(vals), 2)
            source = "mean of the ColabFold scores-JSON per-residue plddt"
        else:
            ca = []
            for line in pdb_text.splitlines():
                if line.startswith("ATOM  ") and line[12:16].strip() == "CA":
                    try:
                        ca.append(float(line[60:66]))
                    except ValueError:
                        pass
            if ca:
                mean_plddt = round(sum(ca) / len(ca), 2)
                source = "mean CA B-factor of the written PDB (scores JSON had no plddt list)"
            else:
                source = "unavailable"
                unavailable["mean_plddt"] = f"no plddt list and no CA B-factors; scores keys: {score_keys}"

        ptm = scores.get("ptm") if isinstance(scores, dict) else None
        if not isinstance(ptm, (int, float)):
            ptm = None
            unavailable["ptm"] = f"not in the ColabFold output; scores keys seen: {score_keys}"

        seq = seqs[i][1] if i < len(seqs) else None
        header = seqs[i][0] if i < len(seqs) else None

        sidecar = {
            "name": name,
            "source_fasta_header": header,
            "sequence": seq,
            "n_residues": len(seq) if seq else None,
            "model_name": "ColabFold (AlphaFold2)",
            "model_version": "see the ColabFold log for the exact model/params version",
            "predictor_api": "colabfold_batch --msa-mode single_sequence",
            "source_pdb_file": os.path.basename(pdb_src),
            "mean_plddt": mean_plddt,
            "mean_plddt_source": source,
            "min_plddt_bfactor": round(lo, 2) if n_atoms else None,
            "max_plddt_bfactor": round(hi, 2) if n_atoms else None,
            "ptm": round(float(ptm), 4) if isinstance(ptm, (int, float)) else None,
            "plddt_units": units,
            "pae_written": matrix is not None,
            "scores_json_keys": score_keys,
            "unavailable": unavailable,
            "caveat": ("pLDDT and PAE are the model's own confidence estimates. They are not "
                       "evidence of folding, binding, affinity, efficacy or safety."),
        }
        with open(os.path.join(args.out_dir, f"{name}.pred.json"), "w", encoding="utf-8") as fh:
            json.dump(sidecar, fh, indent=2, sort_keys=True)
        print(f"normalised {name}: mean pLDDT {mean_plddt}, pTM {ptm}, PAE={matrix is not None}")
        written += 1

    if written == 0:
        print("nothing was normalised", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
