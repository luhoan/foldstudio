#!/usr/bin/env python3
"""Run ESMFold on designed sequences and write files FoldStudio can import.

Called by hpc/40_predict.sbatch. Per input sequence it writes, into --out-dir:

    <name>.pdb        predicted structure, pLDDT in the B-factor column (0-100)
    <name>.pae.json   {"predicted_aligned_error": [[...]], "max_predicted_aligned_error": x}
                      -- the shape the FoldStudio backend's PAE parser accepts
    <name>.pred.json  real per-sequence numbers: mean/min pLDDT, pTM, length,
                      plus the exact unit handling applied (see below)

Two things this script refuses to do:

1. **Guess the pLDDT scale.** Different ESMFold versions have written the
   B-factor column on a 0-1 and on a 0-100 scale. Rather than assume, this
   script measures the range of what the model actually produced, normalises to
   0-100 only when the evidence says it is 0-1, and records exactly which branch
   it took in `<name>.pred.json` under "plddt_units". The FoldStudio backend
   independently refuses to report B-factors outside 0-100 as pLDDT, so a
   mistake here fails loudly instead of silently mislabelling confidence.

2. **Invent a number when the model did not report one.** If an expected output
   key is absent, the value is written as null with a reason, and the script
   prints the keys the model did return so the mismatch takes a minute to fix.

PARTLY EXECUTED: this has been launched once against a real ESMFold install on
the Mill (run 20261114T115930Z) after the OpenFold build was repaired, but the
job was still running when the session lost its view of the cluster, so NO ONE
HAS SEEN IT FINISH and no output of it has been inspected. The ESM output-dict
key names are still the most likely thing to need a one-line correction; see
"What has and has not run" in hpc/README.md.

pLDDT and PAE are the model's own confidence estimates. They are not evidence of
folding, binding, affinity, efficacy or safety.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

# ----------------------------------------------------------------- FASTA input


def read_fasta(path: str) -> list[tuple[str, str]]:
    """Return [(header, sequence)]. Accepts ProteinMPNN's output format."""
    records: list[tuple[str, str]] = []
    header: str | None = None
    chunks: list[str] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if header is not None:
                    records.append((header, "".join(chunks)))
                header, chunks = line[1:].strip(), []
            else:
                chunks.append(line.replace("-", "").replace("*", "").upper())
    if header is not None:
        records.append((header, "".join(chunks)))
    return [(h, s) for h, s in records if s]


def bfactor_range(pdb_text: str) -> tuple[float, float, int]:
    """Min/max/count of the B-factor column (cols 61-66) over ATOM records."""
    vals: list[float] = []
    for line in pdb_text.splitlines():
        if line.startswith(("ATOM  ", "HETATM")):
            raw = line[60:66].strip()
            if raw:
                try:
                    vals.append(float(raw))
                except ValueError:
                    continue
    if not vals:
        return (0.0, 0.0, 0)
    return (min(vals), max(vals), len(vals))


def rescale_bfactors(pdb_text: str, factor: float) -> str:
    """Multiply the B-factor column by `factor`, preserving PDB column widths."""
    out = []
    for line in pdb_text.splitlines():
        if line.startswith(("ATOM  ", "HETATM")) and len(line) >= 66:
            raw = line[60:66].strip()
            try:
                v = float(raw) * factor
            except ValueError:
                out.append(line)
                continue
            out.append(f"{line[:60]}{min(v, 999.99):6.2f}{line[66:]}")
        else:
            out.append(line)
    return "\n".join(out) + "\n"


def to_list(x):
    """Tensor/array -> nested python lists, without importing torch here."""
    if x is None:
        return None
    if hasattr(x, "detach"):
        x = x.detach().cpu()
    if hasattr(x, "tolist"):
        return x.tolist()
    return x


def first_number(x):
    """Pull a scalar out of a 0-d/1-d tensor or list."""
    v = to_list(x)
    while isinstance(v, list):
        if not v:
            return None
        v = v[0]
    return float(v) if isinstance(v, (int, float)) else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="ESMFold runner for FoldStudio (Stream 3)")
    ap.add_argument("--fasta", action="append", required=True,
                    help="FASTA file (repeatable). ProteinMPNN output works directly.")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--prefix", default="", help="prefix for output file names")
    ap.add_argument("--chunk-size", type=int, default=128,
                    help="axial attention chunk size; lower = less GPU memory")
    ap.add_argument("--max-sequences", type=int, default=0, help="0 = no limit")
    ap.add_argument("--skip-existing", action="store_true",
                    help="leave finished outputs alone (used for resume)")
    ap.add_argument("--include-input-record", action="store_true",
                    help="also fold ProteinMPNN's record 0 (the echoed input sequence, a poly-Gly "
                         "placeholder for an RFdiffusion backbone). Off by default: it is not a design.")
    ap.add_argument("--list-only", action="store_true",
                    help="parse inputs and print what would be predicted; loads no model")
    args = ap.parse_args(argv)

    os.makedirs(args.out_dir, exist_ok=True)

    # Collect (name, sequence). ProteinMPNN writes the native/input sequence as
    # the FIRST record and its designs after it. Designs are predicted; the
    # echoed input is skipped unless asked for (see --include-input-record).
    jobs: list[tuple[str, str, str]] = []
    for fa in args.fasta:
        stem = os.path.splitext(os.path.basename(fa))[0]
        records = read_fasta(fa)
        has_designs = any("sample=" in h for h, _ in records)
        for i, (header, seq) in enumerate(records):
            # Indices are kept as-is (designs stay _s1, _s2, ...) so names do not
            # shift depending on whether the input record was folded.
            if (i == 0 and has_designs and "sample=" not in header
                    and not args.include_input_record):
                print(f"skip {stem}_s0: ProteinMPNN's echoed input sequence, not a design")
                continue
            name = f"{args.prefix}{stem}_s{i}"
            jobs.append((name, seq, header))
    if args.max_sequences:
        jobs = jobs[: args.max_sequences]

    if not jobs:
        print("no sequences found in the given FASTA file(s)", file=sys.stderr)
        return 2

    if args.list_only:
        for name, seq, header in jobs:
            print(f"{name}\tlen={len(seq)}\t{header}")
        print(f"total: {len(jobs)} sequence(s)")
        return 0

    pending = []
    for name, seq, header in jobs:
        pdb_path = os.path.join(args.out_dir, f"{name}.pdb")
        if args.skip_existing and os.path.exists(pdb_path) and os.path.getsize(pdb_path) > 0:
            print(f"skip {name} (exists)")
            continue
        pending.append((name, seq, header))
    if not pending:
        print("nothing to do: all outputs already present")
        return 0

    # Import here so --list-only works without a GPU or the heavy deps.
    try:
        import esm  # noqa: F401
        import torch
    except ImportError as exc:
        print(f"could not import esm/torch: {exc}\n"
              "Run hpc/10_setup_env.sh pred-env (FS_PREDICTOR=esmfold) first.", file=sys.stderr)
        return 3

    print(f"loading esmfold_v1 (torch {torch.__version__}, cuda={torch.cuda.is_available()})")
    model = esm.pretrained.esmfold_v1()
    model = model.eval()
    if torch.cuda.is_available():
        model = model.cuda()
    else:
        print("WARNING: no CUDA device visible; ESMFold on CPU is very slow", file=sys.stderr)
    if args.chunk_size:
        try:
            model.set_chunk_size(args.chunk_size)
        except Exception as exc:  # not fatal: only affects memory use
            print(f"note: set_chunk_size({args.chunk_size}) failed: {exc}")

    failures = 0
    for name, seq, header in pending:
        t0 = time.time()
        print(f"predicting {name} (len {len(seq)})")
        try:
            with torch.no_grad():
                output = model.infer([seq])
            pdb_list = model.output_to_pdb(output)
            pdb_text = pdb_list[0] if isinstance(pdb_list, (list, tuple)) else str(pdb_list)
        except Exception as exc:
            failures += 1
            print(f"FAILED {name}: {type(exc).__name__}: {exc}", file=sys.stderr)
            with open(os.path.join(args.out_dir, f"{name}.error.txt"), "w", encoding="utf-8") as fh:
                fh.write(f"{type(exc).__name__}: {exc}\n")
            continue

        keys = sorted(output.keys()) if hasattr(output, "keys") else []

        # --- pLDDT units: measure, do not assume (see module docstring) --------
        lo, hi, n_atoms = bfactor_range(pdb_text)
        if n_atoms == 0:
            units = "absent: no parsable B-factor column in the model's PDB output"
            scale = 1.0
        elif hi <= 1.0:
            units = "model wrote 0-1; multiplied by 100 to give pLDDT on the conventional 0-100 scale"
            scale = 100.0
        elif hi <= 100.0:
            units = "model wrote 0-100 already; left unchanged"
            scale = 1.0
        else:
            units = (f"unexpected: B-factor column ranges {lo:.2f}-{hi:.2f}, which is neither 0-1 nor "
                     "0-100, so it was left unchanged and must NOT be read as pLDDT")
            scale = 1.0
        if scale != 1.0:
            pdb_text = rescale_bfactors(pdb_text, scale)
            lo, hi, n_atoms = bfactor_range(pdb_text)

        pdb_path = os.path.join(args.out_dir, f"{name}.pdb")
        with open(pdb_path, "w", encoding="utf-8") as fh:
            fh.write(pdb_text if pdb_text.endswith("\n") else pdb_text + "\n")

        # --- PAE, in the shape the backend parser accepts ---------------------
        pae = to_list(output.get("predicted_aligned_error")) if hasattr(output, "get") else None
        if isinstance(pae, list) and pae and isinstance(pae[0], list) and isinstance(pae[0][0], list):
            pae = pae[0]  # drop the batch dimension
        pae_written = False
        if isinstance(pae, list) and pae and isinstance(pae[0], list):
            max_pae = first_number(output.get("max_predicted_aligned_error"))
            if max_pae is None:
                max_pae = max(max(row) for row in pae)
            with open(os.path.join(args.out_dir, f"{name}.pae.json"), "w", encoding="utf-8") as fh:
                json.dump({"predicted_aligned_error": [[round(float(v), 2) for v in row] for row in pae],
                           "max_predicted_aligned_error": round(float(max_pae), 2)}, fh)
            pae_written = True

        # --- real numbers only; null + reason when the model did not report one
        mean_plddt = first_number(output.get("mean_plddt")) if hasattr(output, "get") else None
        unavailable = {}
        if mean_plddt is None:
            # Derive it from the file we just wrote rather than leaving a hole:
            # this is measured from real coordinates, not invented.
            if n_atoms:
                total = 0.0
                count = 0
                for line in pdb_text.splitlines():
                    if line.startswith("ATOM  ") and line[12:16].strip() == "CA":
                        try:
                            total += float(line[60:66])
                            count += 1
                        except ValueError:
                            pass
                mean_plddt = round(total / count, 2) if count else None
                if mean_plddt is not None:
                    unavailable["mean_plddt_source"] = (
                        "model output had no 'mean_plddt' key; computed as the mean CA B-factor "
                        "of the written PDB")
            if mean_plddt is None:
                unavailable["mean_plddt"] = f"not reported by the model; available keys: {keys}"

        ptm = first_number(output.get("ptm")) if hasattr(output, "get") else None
        if ptm is None:
            unavailable["ptm"] = f"not reported by the model; available keys: {keys}"
        if not pae_written:
            unavailable["predicted_aligned_error"] = (
                f"not reported by the model; available keys: {keys}")

        sidecar = {
            "name": name,
            "source_fasta_header": header,
            "sequence": seq,
            "n_residues": len(seq),
            "model_name": "ESMFold",
            "model_version": "esmfold_v1",
            "predictor_api": "esm.pretrained.esmfold_v1().infer + output_to_pdb",
            "mean_plddt": mean_plddt,
            "min_plddt_bfactor": round(lo, 2) if n_atoms else None,
            "max_plddt_bfactor": round(hi, 2) if n_atoms else None,
            "ptm": round(ptm, 4) if isinstance(ptm, float) else ptm,
            "plddt_units": units,
            "pae_written": pae_written,
            "wall_seconds": round(time.time() - t0, 3),
            "torch_version": torch.__version__,
            "cuda_available": bool(torch.cuda.is_available()),
            "model_output_keys": keys,
            "unavailable": unavailable,
            "caveat": ("pLDDT and PAE are the model's own confidence estimates. They are not "
                       "evidence of folding, binding, affinity, efficacy or safety."),
        }
        with open(os.path.join(args.out_dir, f"{name}.pred.json"), "w", encoding="utf-8") as fh:
            json.dump(sidecar, fh, indent=2, sort_keys=True)
        print(f"  wrote {name}.pdb (mean pLDDT {mean_plddt}, pTM {ptm}, {units})")

    if failures:
        print(f"{failures} sequence(s) failed; .error.txt written next to the outputs",
              file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
