#!/usr/bin/env python3
"""Export an HPC run as a FoldStudio experiment bundle.

Writes ``<data-dir>/experiments/<id>/`` containing:

    experiment.json      matches the FoldStudio Experiment contract
    metrics.json         values + what was unavailable and why + definitions
    structures/          the backbone and predicted PDB files that really exist
    sequences/           the ProteinMPNN FASTA files that really exist
    provenance/          a copy of the append-only ledger + the folded summary
    import_plan.json     the exact API calls that register these structures
    README.md            what this bundle is, and what it is not

The backend picks it up with ``POST /api/experiments/reindex``, which scans
``data/experiments/*/experiment.json`` and uses the directory name as the id.

THE RULES THIS FILE EXISTS TO ENFORCE
-------------------------------------
1. ``kind`` is ``"executed"`` only when the ledger shows the stage really ran
   **and** the output files are on disk right now. The ledger alone is never
   enough, and neither are the files alone. A dry run is always ``"demo"``.
2. ``status`` is derived from what exists: ``ok`` (everything expected is here),
   ``partial`` (some stages produced output), ``failed`` (nothing did). A
   ``failed`` bundle carries the real error text from the ledger, never a
   paraphrase.
3. **No placeholder metrics, ever.** Every number is computed from a file in
   this bundle. A metric that cannot be computed is left out of ``metrics`` and
   recorded in ``metrics.json["unavailable"]`` with the reason.
4. Designed backbones are registered as ``source: "uploaded"``, never
   ``"predicted"``. Their B-factor column is not pLDDT, and labelling them
   ``predicted`` would make the app report a confidence that does not exist.
5. pLDDT, PAE and pTM are model confidence. Self-consistency RMSD is a
   computational check. None of them is experimental validation.

Usage
-----
    # after a real run on the cluster
    python hpc/export_bundle.py --work-dir ~/foldstudio-hpc/runs/<RUN_ID> --data-dir data

    # offline format check against real fixture files (writes a `demo` bundle)
    python hpc/export_bundle.py --dry-run --data-dir /tmp/dryrun-data

    # exercise the prediction path too, with a real predicted model you have
    python hpc/export_bundle.py --dry-run --data-dir /tmp/d --predicted AF-P42212-F1.pdb

    # re-check a bundle someone else produced
    python hpc/export_bundle.py --validate-only data/experiments/hpc_20261114T...
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
sys.path.insert(0, HERE)

import ledger  # noqa: E402  (hpc/lib/ledger.py)
from predict_esmfold import read_fasta  # noqa: E402

ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
KV_RE = re.compile(r"(\w+)=(\[[^\]]*\]|[^,]+)")

CONFIDENCE_CAVEAT = (
    "pLDDT, PAE and pTM are the model's own confidence estimates. They are not evidence of "
    "folding, binding, affinity, efficacy, safety or biological function."
)
SCRMSD_CAVEAT = (
    "Self-consistency RMSD compares a designed backbone with a structure predicted from the "
    "designed sequence. It measures agreement between two computational models, not "
    "experimental validation."
)
NOT_CLINICAL = "FoldStudio is not a clinical tool and this bundle is not evidence for any therapeutic use."


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------- PDB inspection

def read_ca(path: str) -> dict:
    """CA atoms, chains, and the B-factor range of a PDB file.

    Returns real measurements only. `b_looks_like_plddt` says whether the
    B-factor column could be pLDDT at all (0-100) -- it never asserts that it is.
    """
    cas: list[tuple[str, int, str, float, float, float]] = []
    chains: list[str] = []
    bvals: list[float] = []
    n_atoms = 0
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("ENDMDL"):
                break
            if not line.startswith("ATOM  "):
                continue
            n_atoms += 1
            altloc = line[16]
            if altloc not in (" ", "A"):
                continue
            chain = line[21]
            if chain not in chains:
                chains.append(chain)
            try:
                b = float(line[60:66])
                bvals.append(b)
            except ValueError:
                pass
            if line[12:16].strip() == "CA":
                try:
                    cas.append((chain, int(line[22:26]), line[26].strip(),
                                float(line[30:38]), float(line[38:46]), float(line[46:54])))
                except ValueError:
                    continue
    return {
        "path": path,
        "n_atoms": n_atoms,
        "ca": cas,
        "n_residues": len(cas),
        "chains": chains,
        "b_min": round(min(bvals), 2) if bvals else None,
        "b_max": round(max(bvals), 2) if bvals else None,
        "b_looks_like_plddt": bool(bvals) and min(bvals) >= 0.0 and max(bvals) <= 100.0,
    }


def refuse_if_not_a_prediction(path: str) -> None:
    """Guard --predicted against being handed a non-predicted structure.

    Experimental B-factors (crystallographic ones often run ~10-80) sit inside
    the same 0-100 window as pLDDT, so a file passed in by mistake would be
    silently reported as model confidence. We cannot verify in general that a
    file is a prediction, but we can refuse the cases that announce they are not:
    our own fixtures, and anything carrying crystallographic/NMR records.
    """
    head = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh):
            if i >= 400:
                break
            head.append(line)
    text = "".join(head)
    if "NOT A MODEL OUTPUT" in text:
        raise SystemExit(
            f"refusing --predicted {path}: the file says it is not a model output.\n"
            "Its B-factor column is not pLDDT, and reporting it as confidence would be false.\n"
            "Pass a real predicted model (ESMFold/ColabFold output, or an AlphaFold DB model).")
    for marker in ("EXPDTA    X-RAY DIFFRACTION", "EXPDTA    SOLUTION NMR",
                   "EXPDTA    ELECTRON MICROSCOPY", "REMARK   2 RESOLUTION."):
        if marker in text:
            raise SystemExit(
                f"refusing --predicted {path}: it carries '{marker.strip()}', so it is an\n"
                "experimentally determined structure. Its B-factors are not pLDDT.")


def mean_ca_b(path: str) -> float | None:
    vals = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("ENDMDL"):
                break
            if line.startswith("ATOM  ") and line[12:16].strip() == "CA" and line[16] in (" ", "A"):
                try:
                    vals.append(float(line[60:66]))
                except ValueError:
                    pass
    return round(sum(vals) / len(vals), 2) if vals else None


def _kabsch_rmsd_pure(P: list, Q: list) -> float:
    """Minimum RMSD after optimal rigid superposition, with no numpy.

    Horn's closed form: the best rotation corresponds to the largest eigenvalue
    lam of a symmetric 4x4 matrix built from the covariance of the centred
    coordinate sets, and  rmsd^2 = (sum|p|^2 + sum|q|^2 - 2*lam) / n.
    The eigenvalue comes from cyclic Jacobi rotations. The tests compare this
    against the numpy SVD route on random sets, rigid transforms and mirror
    images, unrounded, to 1e-6 A.
    """
    n = len(P)
    cp = [sum(p[i] for p in P) / n for i in range(3)]
    cq = [sum(q[i] for q in Q) / n for i in range(3)]
    P = [(p[0] - cp[0], p[1] - cp[1], p[2] - cp[2]) for p in P]
    Q = [(q[0] - cq[0], q[1] - cq[1], q[2] - cq[2]) for q in Q]
    S = [[sum(p[i] * q[j] for p, q in zip(P, Q)) for j in range(3)] for i in range(3)]
    (sxx, sxy, sxz), (syx, syy, syz), (szx, szy, szz) = S
    N = [
        [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
    ]
    for _sweep in range(100):
        off = sum(N[i][j] ** 2 for i in range(4) for j in range(4) if i != j)
        if off < 1e-22:
            break
        for i in range(3):
            for j in range(i + 1, 4):
                if abs(N[i][j]) < 1e-300:
                    continue
                theta = (N[j][j] - N[i][i]) / (2.0 * N[i][j])
                t = (1.0 if theta >= 0 else -1.0) / (abs(theta) + (theta * theta + 1.0) ** 0.5)
                c = 1.0 / (t * t + 1.0) ** 0.5
                sn = t * c
                for k in range(4):
                    nik, njk = N[i][k], N[j][k]
                    N[i][k], N[j][k] = c * nik - sn * njk, sn * nik + c * njk
                for k in range(4):
                    nki, nkj = N[k][i], N[k][j]
                    N[k][i], N[k][j] = c * nki - sn * nkj, sn * nki + c * nkj
    lam = max(N[i][i] for i in range(4))
    e0 = sum(x * x + y * y + z * z for x, y, z in P) + sum(x * x + y * y + z * z for x, y, z in Q)
    return (max(0.0, (e0 - 2.0 * lam) / n)) ** 0.5


def _kabsch_rmsd_numpy(np, P: list, Q: list) -> float:
    """Minimum RMSD after optimal rigid superposition (Kabsch, via SVD)."""
    P = np.array(P, dtype=float)
    Q = np.array(Q, dtype=float)
    P = P - P.mean(axis=0)
    Q = Q - Q.mean(axis=0)
    V, _S, Wt = np.linalg.svd(P.T @ Q)
    d = np.sign(np.linalg.det(V @ Wt))
    U = V @ np.diag([1.0, 1.0, d]) @ Wt
    diff = (P @ U) - Q
    return float(np.sqrt((diff * diff).sum() / len(P)))


def kabsch_ca_rmsd(a: list, b: list) -> dict:
    """Optimal-superposition CA RMSD between two equal-length CA lists.

    Returns the RMSD together with what was aligned, because an RMSD without its
    atom selection is not a reportable number (and the FoldStudio contract
    requires the selection alongside it).
    """
    if len(a) != len(b):
        return {"rmsd": None, "aligned_atoms": 0, "atom_type": "CA",
                "reason": (f"residue counts differ ({len(a)} vs {len(b)}), so there is no 1:1 CA "
                           "correspondence; refusing to align a subset silently")}
    if len(a) < 3:
        return {"rmsd": None, "aligned_atoms": len(a), "atom_type": "CA",
                "reason": "fewer than 3 CA atoms in common"}
    try:
        import numpy as np
    except ImportError:
        # The export stage runs wherever python3 happens to be (on the Mill, a
        # bare system interpreter with no numpy), and this is the pipeline's
        # headline number, so compute it without numpy rather than drop it.
        rmsd = _kabsch_rmsd_pure([(x, y, z) for (_c, _r, _i, x, y, z) in a],
                                 [(x, y, z) for (_c, _r, _i, x, y, z) in b])
        return {"rmsd": round(rmsd, 3), "aligned_atoms": len(a), "aligned_residues": len(a),
                "atom_type": "CA", "reason": None,
                "method": "optimal superposition, Horn quaternion method (pure Python; numpy absent)"}

    rmsd = _kabsch_rmsd_numpy(np, [(x, y, z) for (_c, _r, _i, x, y, z) in a],
                              [(x, y, z) for (_c, _r, _i, x, y, z) in b])
    return {"rmsd": round(rmsd, 3), "aligned_atoms": len(a), "aligned_residues": len(a),
            "atom_type": "CA", "reason": None,
            "method": "optimal superposition, Kabsch algorithm (numpy SVD)"}


# ------------------------------------------------------- ProteinMPNN FASTA parsing

def parse_mpnn_fasta(path: str) -> dict:
    """Parse a real ProteinMPNN output FASTA.

    Record 0 is the input sequence and carries model_name / git_hash / seed.
    Later records are the designs and carry sample / score / global_score /
    seq_recovery. Only values actually present are returned.
    """
    records = read_fasta(path)
    info: dict = {"path": path, "input": None, "designs": [], "model_name": None,
                  "git_hash": None, "seed": None}
    for i, (header, seq) in enumerate(records):
        kv = {k: v.strip() for k, v in KV_RE.findall(header)}

        def num(key):
            try:
                return float(kv[key])
            except (KeyError, ValueError):
                return None

        entry = {
            "index": i,
            "header": header,
            "sequence": seq,
            "n_residues": len(seq),
            "score": num("score"),
            "global_score": num("global_score"),
            "seq_recovery": num("seq_recovery"),
            "sample": kv.get("sample"),
            "temperature": num("T"),
        }
        # ProteinMPNN marks designs with sample=N; record 0 (no sample) is the input.
        if i == 0 and "sample" not in kv:
            info["input"] = entry
            info["model_name"] = kv.get("model_name")
            info["git_hash"] = kv.get("git_hash")
            try:
                info["seed"] = int(kv["seed"])
            except (KeyError, ValueError):
                info["seed"] = None
        else:
            info["designs"].append(entry)
    return info


# ------------------------------------------------------------------ run gathering

def gather(work_dir: str) -> dict:
    """Find what a run actually produced. Missing things are simply absent."""
    def listing(sub, pred):
        d = os.path.join(work_dir, sub)
        if not os.path.isdir(d):
            return []
        return sorted(os.path.join(d, f) for f in os.listdir(d) if pred(f))

    events_path = os.path.join(work_dir, "provenance", "events.jsonl")
    events = ledger.read_events(events_path)
    stages = {st: ledger.stage_summary(events, st) for st in ledger.stages_in(events)}
    return {
        "work_dir": work_dir,
        "events_path": events_path if os.path.exists(events_path) else None,
        "events": events,
        "stages": stages,
        "backbones": listing("backbones", lambda f: f.startswith("design_") and f.endswith(".pdb")),
        "sequences": listing("seqs", lambda f: f.endswith(".fa")),
        "predictions": listing("pred", lambda f: f.endswith(".pdb")),
    }


def sidecar_for(pdb_path: str) -> dict | None:
    cand = pdb_path[:-4] + ".pred.json"
    if os.path.exists(cand):
        try:
            with open(cand, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            return None
    return None


def pae_for(pdb_path: str) -> str | None:
    cand = pdb_path[:-4] + ".pae.json"
    return cand if os.path.exists(cand) else None


# -------------------------------------------------------------------- the export

class Bundle:
    def __init__(self, exp_id: str, data_dir: str, dry_run: bool):
        self.id = exp_id
        self.dry_run = dry_run
        self.data_dir = os.path.abspath(data_dir)
        self.dir = os.path.join(self.data_dir, "experiments", exp_id)
        self.metrics: dict[str, float | int | str | None] = {}
        self.unavailable: dict[str, str] = {}
        self.definitions: dict[str, str] = {}
        self.outputs: list[str] = []
        self.per_design: list[dict] = []
        self.register: list[dict] = []
        self.notes: list[str] = []

    # a metric is only ever set from a real measurement
    def set_metric(self, key: str, value, definition: str):
        if value is None:
            self.unavailable.setdefault(key, "not computed: the underlying value was unavailable")
            return
        self.metrics[key] = value
        self.definitions[key] = definition

    def mark_unavailable(self, key: str, reason: str):
        self.unavailable[key] = reason
        self.metrics.pop(key, None)

    def copy_in(self, src: str, subdir: str, name: str | None = None) -> str:
        dst_dir = os.path.join(self.dir, subdir)
        os.makedirs(dst_dir, exist_ok=True)
        base = name or os.path.basename(src)
        shutil.copy2(src, os.path.join(dst_dir, base))
        rel = f"{subdir}/{base}"
        if rel not in self.outputs:
            self.outputs.append(rel)
        return rel


def build(args) -> tuple[Bundle, dict, dict]:
    work_dir = args.work_dir
    dry = bool(args.dry_run)

    if dry:
        # Dry run: real files, but NOT produced by any model run of ours. The
        # resulting bundle is `demo` and says so in several places.
        fixtures = os.path.join(HERE, "tests", "fixtures")
        run = {
            "work_dir": fixtures,
            "events_path": None,
            "events": [],
            "stages": {},
            "backbones": [os.path.join(fixtures, "backbone_like_5L33_chainA.pdb")],
            "sequences": [os.path.join(fixtures, "proteinmpnn_5L33_example1.fa")],
            "predictions": [args.predicted] if args.predicted else [],
        }
        for p in run["backbones"] + run["sequences"]:
            if not os.path.exists(p):
                raise SystemExit(f"dry run needs fixture {p}; run hpc/tests/fixtures/fetch_fixtures.sh")
        if args.predicted:
            if not os.path.exists(args.predicted):
                raise SystemExit(f"--predicted file not found: {args.predicted}")
            refuse_if_not_a_prediction(args.predicted)
    else:
        if not work_dir or not os.path.isdir(work_dir):
            raise SystemExit("--work-dir must point at a run directory (or pass --dry-run)")
        run = gather(work_dir)

    exp_id = args.experiment_id or default_id(run, dry)
    if not ID_RE.match(exp_id):
        raise SystemExit(f"experiment id {exp_id!r} must match {ID_RE.pattern}")

    b = Bundle(exp_id, args.data_dir, dry)
    os.makedirs(b.dir, exist_ok=True)

    stages = run["stages"]
    rfd = stages.get("rfdiffusion", {})

    # ---------------------------------------------------------------- backbones
    b.set_metric("n_backbones", len(run["backbones"]),
                 "Number of backbone PDB files present in this bundle (counted, not predicted).")
    bb_info: dict[str, dict] = {}
    for p in run["backbones"]:
        info = read_ca(p)
        bb_info[os.path.basename(p)] = info
        rel = b.copy_in(p, "structures")
        label_src = "RFdiffusion backbone" if not dry else "real coordinate excerpt (fixture)"
        b.register.append({
            "method": "POST",
            "path": "/api/structures/register",
            "body": {
                "path": f"{exp_id}/{os.path.basename(p)}",
                "label": f"{os.path.splitext(os.path.basename(p))[0]} ({label_src})",
                # NOT "predicted": a designed backbone has no pLDDT. Labelling it
                # predicted would make the app report confidence that does not exist.
                "source": "uploaded",
                "origin_id": f"{exp_id}:{os.path.basename(p)}",
                "notes": ("Designed backbone from RFdiffusion; the B-factor column is NOT pLDDT."
                          if not dry else
                          "Real coordinate excerpt used as a format fixture; B-factors are "
                          "EXPERIMENTAL B-factors, not pLDDT."),
            },
            "local_file": rel,
        })
    if bb_info:
        lens = sorted({i["n_residues"] for i in bb_info.values()})
        b.set_metric("backbone_n_residues_min", lens[0], "Fewest CA atoms in any backbone file here.")
        b.set_metric("backbone_n_residues_max", lens[-1], "Most CA atoms in any backbone file here.")

    # ---------------------------------------------------------------- sequences
    mpnn_files = {}
    all_designs: list[dict] = []
    for p in run["sequences"]:
        parsed = parse_mpnn_fasta(p)
        mpnn_files[os.path.basename(p)] = parsed
        all_designs.extend(parsed["designs"])
        b.copy_in(p, "sequences")

    b.set_metric("n_sequences_designed", len(all_designs),
                 "Number of ProteinMPNN design records (records carrying sample=N; the input "
                 "sequence record is excluded).")

    scores = [d["score"] for d in all_designs if isinstance(d["score"], float)]
    if scores:
        b.set_metric("mpnn_best_score", round(min(scores), 4),
                     "Lowest (best) ProteinMPNN score= value, read verbatim from the FASTA "
                     "headers it wrote. Lower is better; it is a negative log-likelihood, "
                     "not a probability of folding.")
        b.set_metric("mpnn_mean_score", round(sum(scores) / len(scores), 4),
                     "Mean of the ProteinMPNN score= values in this bundle.")
    else:
        b.mark_unavailable("mpnn_best_score", "no score= field was present in any FASTA header")
        b.mark_unavailable("mpnn_mean_score", "no score= field was present in any FASTA header")

    # seq_recovery needs care: ProteinMPNN measures it against the INPUT pdb's own
    # sequence. For an RFdiffusion backbone there is no native sequence (it is
    # effectively poly-glycine), so the number would not mean what its name says.
    recs = [d["seq_recovery"] for d in all_designs if isinstance(d["seq_recovery"], float)]
    designed_from_rfdiffusion = bool(rfd.get("ran")) and not dry
    if recs and not designed_from_rfdiffusion:
        b.set_metric("mpnn_mean_seq_recovery", round(sum(recs) / len(recs), 4),
                     "Mean ProteinMPNN seq_recovery= against the input structure's own sequence. "
                     "Meaningful here only because the input was a real structure with a real "
                     "native sequence.")
    elif recs and designed_from_rfdiffusion:
        b.mark_unavailable(
            "mpnn_mean_seq_recovery",
            "ProteinMPNN reported seq_recovery, but it is measured against the input PDB's own "
            "sequence, and an RFdiffusion backbone has no native sequence to recover. Reporting "
            "it would imply a comparison that was not made.")
    else:
        b.mark_unavailable("mpnn_mean_seq_recovery", "no seq_recovery= field was present in any header")

    if mpnn_files:
        first = next(iter(mpnn_files.values()))
        if first.get("model_name"):
            b.metrics["mpnn_model_name"] = first["model_name"]
            b.definitions["mpnn_model_name"] = "ProteinMPNN model name, read from its own FASTA header."
        if first.get("seed") is not None:
            b.metrics["mpnn_seed"] = first["seed"]
            b.definitions["mpnn_seed"] = "Seed ProteinMPNN recorded in its own FASTA header."

    # -------------------------------------------------------------- predictions
    plddts: list[float] = []
    ptms: list[float] = []
    rmsds: list[float] = []

    if not run["predictions"]:
        why = ("this run has no predicted structures: the prediction stage has not produced "
               "any output yet" if not dry else
               "the dry run was given no real predicted model. No pLDDT-bearing prediction is "
               "bundled with the repo, and inventing B-factors and calling them pLDDT is not "
               "acceptable. Pass --predicted <real predicted model> to exercise this path.")
        for key in ("predicted_mean_plddt", "predicted_best_mean_plddt", "predicted_mean_ptm",
                    "self_consistency_ca_rmsd_best", "self_consistency_ca_rmsd_mean"):
            b.mark_unavailable(key, why)
    else:
        for p in run["predictions"]:
            info = read_ca(p)
            side = sidecar_for(p)
            rel = b.copy_in(p, "structures")
            name = os.path.splitext(os.path.basename(p))[0]
            entry: dict = {"name": name, "file": rel, "n_residues": info["n_residues"]}

            # ProteinMPNN writes the INPUT sequence as record 0 of its FASTA, and
            # for an RFdiffusion backbone that input is a placeholder (poly-Gly),
            # not a design. If the predictor folded it anyway, keep the file --
            # it is a real output -- but never pool it with the designs: its
            # pLDDT and RMSD would drag the design metrics around for no reason.
            input_rec = input_record_for(name, mpnn_files, side)
            is_input = input_rec is not None
            if is_input:
                seq = input_rec.get("sequence") or ""
                poly_g = bool(seq) and seq.count("G") >= 0.9 * len(seq)
                entry["role"] = "input_sequence"
                entry["note"] = (
                    "Prediction of the sequence ProteinMPNN echoes as record 0 -- its INPUT, not a "
                    "design" + (". Here that input is a poly-glycine placeholder, because an "
                                "RFdiffusion backbone has no sequence of its own" if poly_g else "")
                    + ". Kept because the predictor really produced it; excluded from every "
                    "aggregate metric.")
            else:
                entry["role"] = "design"

            # pLDDT: only if the B-factor column can be pLDDT at all. The value
            # reported is measured from the PDB the app will display; the
            # predictor's own figure is kept beside it as corroboration.
            mp = None
            side_mp = side.get("mean_plddt") if side else None
            if info["b_looks_like_plddt"] and side:
                mp = mean_ca_b(p)
                entry["mean_plddt_source"] = "mean CA B-factor of the predicted PDB (written by the predictor)"
                if isinstance(side_mp, (int, float)):
                    entry["mean_plddt_reported_by_predictor"] = float(side_mp)
                    if mp is not None and abs(float(side_mp) - mp) > 1.0:
                        entry["mean_plddt_note"] = (
                            "the predictor's own mean_plddt differs from the CA mean of the file by more "
                            "than 1; it may average over all atoms or use a different scale. The file-derived "
                            "value is the one reported.")
            elif side and isinstance(side_mp, (int, float)):
                mp = float(side_mp)
                entry["mean_plddt_source"] = "predictor sidecar (<name>.pred.json)"
            elif info["b_looks_like_plddt"]:
                mp = mean_ca_b(p)
                entry["mean_plddt_source"] = (
                    "mean CA B-factor of the PDB, with no predictor sidecar to corroborate it. "
                    "This is pLDDT only if the file really is a predicted model; that was asserted "
                    "by whoever supplied it, not verified here.")
            else:
                entry["mean_plddt_source"] = (
                    f"unavailable: B-factor range {info['b_min']}-{info['b_max']} is outside "
                    "0-100, so it cannot be pLDDT and was not reported as such")
            if mp is not None:
                entry["mean_plddt"] = mp
                if not is_input:
                    plddts.append(mp)
            if side and isinstance(side.get("ptm"), (int, float)):
                entry["ptm"] = float(side["ptm"])
                if not is_input:
                    ptms.append(float(side["ptm"]))

            pae = pae_for(p)
            entry["pae_file"] = b.copy_in(pae, "structures") if pae else None

            # self-consistency CA RMSD against the matching backbone
            bb = match_backbone(name, bb_info)
            if bb is None:
                entry["scrmsd"] = {"rmsd": None, "reason": "no backbone file matched this prediction by name"}
            else:
                res = kabsch_ca_rmsd(bb_info[bb]["ca"], info["ca"])
                res["backbone"] = bb
                entry["scrmsd"] = res
                if res["rmsd"] is not None and not is_input:
                    rmsds.append(res["rmsd"])

            # predicted models DO carry pLDDT, so these register as "predicted"
            reg_body = {
                "path": f"{exp_id}/{os.path.basename(p)}",
                "label": (f"{name} (prediction of ProteinMPNN's input record, not a design)"
                          if is_input else f"{name} (predicted structure)"),
                "source": "predicted",
                "origin_id": f"{exp_id}:{os.path.basename(p)}",
                "notes": ((side or {}).get("plddt_units") or "pLDDT read from the B-factor column.")
                + " " + CONFIDENCE_CAVEAT,
            }
            if pae:
                reg_body["pae_path"] = f"{exp_id}/{os.path.basename(pae)}"
            b.register.append({"method": "POST", "path": "/api/structures/register",
                               "body": reg_body, "local_file": rel})
            b.per_design.append(entry)

        if plddts:
            b.set_metric("predicted_mean_plddt", round(sum(plddts) / len(plddts), 2),
                         "Mean over predictions of each prediction's mean pLDDT. " + CONFIDENCE_CAVEAT)
            b.set_metric("predicted_best_mean_plddt", round(max(plddts), 2),
                         "Highest mean pLDDT among the predictions here. " + CONFIDENCE_CAVEAT)
        else:
            b.mark_unavailable("predicted_mean_plddt",
                               "no prediction carried a usable pLDDT (see per_design[].mean_plddt_source)")
            b.mark_unavailable("predicted_best_mean_plddt",
                               "no prediction carried a usable pLDDT (see per_design[].mean_plddt_source)")
        if ptms:
            b.set_metric("predicted_mean_ptm", round(sum(ptms) / len(ptms), 4),
                         "Mean pTM reported by the predictor. " + CONFIDENCE_CAVEAT)
        else:
            b.mark_unavailable("predicted_mean_ptm", "the predictor did not report pTM for any sequence")
        if rmsds:
            b.set_metric("self_consistency_ca_rmsd_best", round(min(rmsds), 3),
                         "Lowest CA RMSD (Angstrom) between a designed backbone and the structure "
                         "predicted from its designed sequence, by optimal superposition over all "
                         "paired CA atoms. " + SCRMSD_CAVEAT)
            b.set_metric("self_consistency_ca_rmsd_mean", round(sum(rmsds) / len(rmsds), 3),
                         "Mean of the per-design CA RMSD values. " + SCRMSD_CAVEAT)
            b.metrics["self_consistency_atom_type"] = "CA"
            b.definitions["self_consistency_atom_type"] = (
                "Atoms used for the RMSD above. The contract requires reporting which atoms were "
                "aligned; per-design atom counts are in per_design[].scrmsd.aligned_atoms.")
        else:
            b.mark_unavailable("self_consistency_ca_rmsd_best",
                               "no backbone/prediction pair had a 1:1 CA correspondence "
                               "(see per_design[].scrmsd.reason)")
            b.mark_unavailable("self_consistency_ca_rmsd_mean",
                               "no backbone/prediction pair had a 1:1 CA correspondence")

    # ----------------------------------------------------- timing / preemptions
    for sname, s in stages.items():
        if isinstance(s.get("wall_seconds"), (int, float)):
            key = f"stage_{sname}_wall_seconds"
            b.metrics[key] = s["wall_seconds"]
            b.definitions[key] = f"Wall seconds the '{sname}' stage recorded for itself."
        if s.get("preemptions"):
            key = f"stage_{sname}_preemptions"
            b.metrics[key] = s["preemptions"]
            b.definitions[key] = (f"Times the '{sname}' stage was preempted on the requeue "
                                  "partition and resumed from its checkpoints.")

    # ------------------------------------------------------------- kind/status
    produced_backbones = bool(run["backbones"])
    produced_seqs = bool(run["sequences"])
    produced_preds = bool(run["predictions"])

    if dry:
        kind = "demo"
    else:
        # "executed" needs BOTH a ledger that says a stage ran AND files on disk.
        ran_any = any(s.get("ran") for name, s in stages.items() if is_science_stage(name))
        kind = "executed" if (ran_any and (produced_backbones or produced_seqs or produced_preds)) else "imported"

    # Only the stages that produce the experiment decide its status. The driver
    # and the exporter are bookkeeping around it -- and the exporter reads this
    # ledger from INSIDE its own stage, after its stage_start and before its
    # stage_end, so counting it would make every run it exports "partial" with
    # a missing-stage_end error about itself.
    errors = [s["error"] for name, s in stages.items()
              if s.get("error") and is_science_stage(name)]
    expected_all = produced_backbones and produced_seqs and produced_preds
    if dry:
        status = "ok" if (produced_backbones and produced_seqs) else "failed"
    elif expected_all and not errors:
        status = "ok"
    elif produced_backbones or produced_seqs or produced_preds:
        status = "partial"
    else:
        status = "failed"

    error_text = None
    if status in ("failed", "partial") and errors:
        error_text = " | ".join(errors)
    if status == "failed" and not error_text:
        # The contract requires a failed experiment to carry a real error. If the
        # ledger has none, say exactly that rather than inventing a cause.
        error_text = (
            f"No stage produced any output under {run['work_dir']}, and the ledger "
            f"({run['events_path'] or 'absent'}) recorded no error explaining why. "
            "The run most likely never started.")

    if kind == "executed" and status == "ok" and not b.outputs:
        status = "partial"
        error_text = (error_text or "") + " (no output files were copied into the bundle)"

    # ------------------------------------------------------------- model naming
    predictor = None
    for k in stages:
        if k.startswith("predict_"):
            predictor = k[len("predict_"):]
    tool_git = {}
    for s in stages.values():
        tool_git.update(s.get("git") or {})
    versions = []
    if tool_git.get("rfdiffusion"):
        versions.append(f"RFdiffusion@{tool_git['rfdiffusion'][:12]}")
    if tool_git.get("proteinmpnn"):
        versions.append(f"ProteinMPNN@{tool_git['proteinmpnn'][:12]}")
    if mpnn_files:
        mn = next(iter(mpnn_files.values())).get("model_name")
        gh = next(iter(mpnn_files.values())).get("git_hash")
        if mn:
            versions.append(f"ProteinMPNN model {mn}")
        if gh and not tool_git.get("proteinmpnn"):
            versions.append(f"ProteinMPNN git_hash(from FASTA)={gh[:12]}")
    pred_versions = {((sidecar_for(p) or {}).get("model_version")) for p in run["predictions"]}
    pred_versions.discard(None)
    versions.extend(sorted(v for v in pred_versions if v))

    if dry:
        model_name = "FoldStudio HPC pipeline (dry run: no model was executed)"
    else:
        parts = []
        if produced_backbones:
            parts.append("RFdiffusion")
        if produced_seqs:
            parts.append("ProteinMPNN")
        if produced_preds:
            parts.append({"esmfold": "ESMFold", "colabfold": "ColabFold (AlphaFold2)"}.get(
                predictor or "", predictor or "structure predictor"))
        model_name = " + ".join(parts) if parts else "FoldStudio HPC pipeline (nothing ran)"

    settings: dict = {}
    for s in stages.values():
        settings.update(s.get("settings") or {})
    seeds: dict = {}
    for s in stages.values():
        seeds.update(s.get("seeds") or {})
    if seeds:
        settings["seeds"] = seeds
    settings["rfdiffusion_seed_mechanism"] = (
        "inference.deterministic=True; RFdiffusion's stock config exposes no per-design seed, so a "
        "design regenerated after a preemption is not guaranteed bit-identical to the same index "
        "inside one uninterrupted multi-design run.")
    if dry:
        settings["dry_run"] = True

    # --------------------------------------------------------------- provenance
    notes_parts = []
    if dry:
        notes_parts.append(
            "DRY RUN. No model was executed. The files here are real public data used to validate "
            "the bundle format: a real ProteinMPNN output committed by its authors, and a real "
            "coordinate excerpt of PDB 5L33 chain A standing in for a designed backbone. "
            "See hpc/tests/fixtures/PROVENANCE.md. Nothing here is evidence about any designed "
            "protein, and the ProteinMPNN scores are upstream's own numbers for 5L33.")
    else:
        host_list = sorted({h for s in stages.values() for h in (s.get("hosts") or [])})
        # Do not assert WHERE this ran. A GPU stage may have been run off-cluster
        # (Colab/Kaggle/Adroit -- see hpc/OFFLOAD.md), and claiming "the Mill"
        # for work that happened elsewhere would be false provenance. Report the
        # evidence: recorded hostnames, and whether a Slurm job id exists.
        slurm_ids = sorted({jid for s in stages.values()
                            for k, jid in (s.get("slurm") or {}).items()
                            if k == "SLURM_JOB_ID"})
        where = (f"Slurm job id(s) {', '.join(slurm_ids)}" if slurm_ids
                 else "no Slurm job id was recorded, so at least one stage ran outside a "
                      "Slurm batch job")
        site = os.environ.get("FS_SITE", "").strip()
        science = {k: v for k, v in stages.items() if is_science_stage(k)}
        if any(v.get("ran") for v in science.values()):
            notes_parts.append(
                "Executed by the FoldStudio Stream 3 pipeline"
                + (f" at {site}" if site else "")
                + f" (hosts: {', '.join(host_list) or 'not recorded'}; {where}). Stages: "
                + "; ".join(f"{k}={'ran' if v.get('ran') else 'did not run'}"
                            f"{' preempted x' + str(v['preemptions']) if v.get('preemptions') else ''}"
                            f" exit={v.get('exit_status')}" for k, v in stages.items()))
        else:
            # Nothing ran, so the note must not open with "Executed by".
            notes_parts.append(
                "Exported by the FoldStudio Stream 3 pipeline from a run in which no design stage ran"
                + (f" at {site}" if site else "")
                + (". Stages recorded in the ledger: "
                   + "; ".join(f"{k}=did not run exit={v.get('exit_status')}" for k, v in stages.items())
                   if stages else ". The ledger recorded no stage at all")
                + ".")
        notes_parts.append(
            "Backbones are registered as source 'uploaded', not 'predicted': a designed backbone "
            "carries no pLDDT, and its B-factor column must not be read as confidence.")
    notes_parts.append(CONFIDENCE_CAVEAT)
    if rmsds:
        notes_parts.append(SCRMSD_CAVEAT)
    notes_parts.append(NOT_CLINICAL)
    notes_parts.append(
        "No binder or therapeutic design was performed: the design target is an unconditional "
        "monomeric scaffold with no binding partner.")

    experiment = {
        "id": exp_id,
        "created_at": now_iso(),
        "kind": kind,
        "status": status,
        "model_name": model_name,
        "model_version": "; ".join(versions) if versions else "unknown",
        "settings": settings,
        "inputs": [],
        "outputs": list(b.outputs),
        # outputs stays a list of strings, which is what the frontend's
        # Experiment type declares. The per-file source the backend needs in
        # order to auto-register these structures goes here instead, taken from
        # the same register bodies that drive import_plan.json -- so a backbone
        # is "uploaded" and only a real prediction is "predicted".
        "structure_sources": {os.path.basename(r["body"]["path"]): r["body"]["source"]
                              for r in b.register if "source" in r.get("body", {})},
        # What the app should call each of those structures (same register bodies).
        "structure_labels": {os.path.basename(r["body"]["path"]): r["body"]["label"]
                             for r in b.register if r.get("body", {}).get("label")},
        # One sentence per reported metric saying what it is and how it was
        # computed, so a number in the app or a report can carry its meaning.
        "metric_definitions": dict(b.definitions),
        "metrics": dict(b.metrics),
        "error": error_text,
        "provenance": {
            # Derived from evidence, never asserted: see the note built above.
            "source": ("FoldStudio HPC pipeline dry run (no execution)" if dry
                       else "FoldStudio HPC pipeline"
                            + (f" ({os.environ['FS_SITE'].strip()})"
                               if os.environ.get("FS_SITE", "").strip() else "")),
            "retrieved_at": now_iso(),
            "url": None,
            "notes": " ".join(notes_parts),
        },
        # extra, contract-compatible detail (the Experiment model allows extras)
        "per_design": b.per_design,
        "metrics_unavailable": dict(b.unavailable),
        # Stream 5's WorkflowStepper reads this instead of guessing at our stage names.
        "workflow": workflow_block(
            stages, kind,
            {"backbones": len(run["backbones"]), "sequences": len(run["sequences"]),
             "predictions": len(run["predictions"])},
            b.metrics, b.unavailable),
        "stage_summary": {k: {kk: vv for kk, vv in v.items() if kk != "commands"}
                          for k, v in stages.items()},
    }

    if dry and args.predicted:
        experiment["provenance"]["notes"] += (
            f" A real predicted model was supplied for the dry run ({os.path.basename(args.predicted)}); "
            "its pLDDT-derived metrics describe that file, which this pipeline did not produce.")

    return b, experiment, run


# Stream 5's WorkflowStepper shows these six stages, in this order, with a status
# of "not started / imported / executed / failed with error text" taken from the
# experiment record. Our ledger uses tool names, so the bundle publishes an
# explicit mapping instead of making the UI guess. `status_label` is there so a
# panel can print it directly without knowing our vocabulary.
UI_WORKFLOW = (
    ("Structure", None),
    ("Backbone generation", "rfdiffusion"),
    ("Sequence design", "proteinmpnn"),
    ("Structure prediction", "predict_*"),
    ("Evaluation", None),
    ("Candidate review", None),
)
STATUS_LABELS = {
    "not_started": "not started",
    "imported": "imported",
    "demo": "demo",
    "executed": "executed",
    "failed": "failed",
    "partial": "partial",
}

EVALUATION_METRIC_KEYS = (
    "self_consistency_ca_rmsd_best", "self_consistency_ca_rmsd_mean",
    "predicted_mean_plddt", "predicted_best_mean_plddt", "predicted_mean_ptm",
    "mpnn_best_score", "mpnn_mean_score",
)


def workflow_block(stages: dict, kind: str, produced: dict, metrics: dict,
                   unavailable: dict) -> list[dict]:
    """Map our ledger stages onto Stream 5's WorkflowStepper stages.

    A stage counts as done only when its ledger entry ran AND its files exist --
    the same rule the bundle's own `kind` uses, so the stepper can never show a
    greener state than the experiment record justifies.
    """
    def resolve(pattern: str | None) -> tuple[str | None, dict]:
        if pattern is None:
            return None, {}
        if pattern.endswith("*"):
            prefix = pattern[:-1]
            for name, s in stages.items():
                if name.startswith(prefix):
                    return name, s
            return None, {}
        return (pattern, stages[pattern]) if pattern in stages else (None, {})

    files_for = {
        "rfdiffusion": produced.get("backbones", 0),
        "proteinmpnn": produced.get("sequences", 0),
        "predict_*": produced.get("predictions", 0),
    }

    rows: list[dict] = []
    for ui_name, pattern in UI_WORKFLOW:
        ledger_name, s = resolve(pattern)
        row: dict = {
            "stage": ui_name,
            "ledger_stage": ledger_name,
            "status": "not_started",
            "error": None,
            "outputs": 0,
            "wall_seconds": None,
            "preemptions": 0,
            "note": None,
        }

        if ui_name == "Structure":
            row["note"] = ("No input structure: this is de novo design, so the backbone is "
                           "generated rather than supplied. Nothing is missing.")
            row["status"] = "not_started"
        elif ui_name == "Evaluation":
            have = [k for k in EVALUATION_METRIC_KEYS if k in metrics]
            if have:
                row["status"] = "executed" if kind == "executed" else kind
                row["note"] = "Computed from the bundled files: " + ", ".join(sorted(have)) + "."
                row["outputs"] = len(have)
            else:
                row["status"] = "not_started"
                row["note"] = ("No evaluation metric could be computed. Reasons are in "
                               "metrics.json['unavailable'].")
        elif ui_name == "Candidate review":
            row["note"] = ("Performed by a person in FoldStudio; the pipeline does not review "
                           "its own candidates.")
            row["status"] = "not_started"
        else:
            n_files = files_for.get(pattern, 0)
            row["outputs"] = n_files
            row["wall_seconds"] = s.get("wall_seconds")
            row["preemptions"] = s.get("preemptions", 0) or 0
            if s.get("error"):
                row["status"] = "failed"
                row["error"] = s["error"]
            elif s.get("ran") and n_files > 0:
                row["status"] = "executed" if kind == "executed" else kind
            elif n_files > 0:
                # Files but no ledger: real data, but we did not run it.
                row["status"] = "imported" if kind != "demo" else "demo"
                row["note"] = ("Files are present but no ledger entry records this stage running "
                               "here, so it is not reported as executed.")
            elif s.get("ran"):
                row["status"] = "failed"
                row["error"] = ("the stage ran but produced no output files, and recorded no "
                                "error explaining why")
            else:
                row["status"] = "not_started"

        row["status_label"] = STATUS_LABELS.get(row["status"], row["status"])
        rows.append(row)
    return rows


def input_record_for(pred_name: str, mpnn_files: dict, sidecar: dict | None) -> dict | None:
    """Return ProteinMPNN's echoed input record if `pred_name` is a fold of it.

    Predictions are named <fasta stem>_s<record index>. Record 0 of a ProteinMPNN
    FASTA carries no `sample=` field: it is the input sequence, written back out
    for reference. Two independent signals are accepted, because a prediction can
    arrive without a sidecar (off-cluster runs) or without its FASTA:
      * the FASTA in this bundle says record <index> is the input record;
      * the predictor's sidecar kept the source header, and it has no sample=.
    """
    m = re.match(r"^(?P<stem>.+)_s(?P<i>\d+)$", pred_name)
    if not m:
        return None
    idx = int(m.group("i"))
    parsed = mpnn_files.get(m.group("stem") + ".fa")
    if parsed and parsed.get("input") is not None and parsed["input"]["index"] == idx:
        return parsed["input"]
    header = (sidecar or {}).get("source_fasta_header")
    if idx == 0 and isinstance(header, str) and header and "sample=" not in header:
        return {"index": 0, "header": header, "sequence": (sidecar or {}).get("sequence") or ""}
    return None


def is_science_stage(name: str) -> bool:
    """True for stages whose outcome is the experiment's outcome."""
    return not (name == "driver" or name.startswith(("export", "setup", "weights")))


def match_backbone(pred_name: str, bb_info: dict) -> str | None:
    """Pair a prediction with its backbone by name, e.g. design_0_s1 -> design_0.pdb."""
    for bb in bb_info:
        stem = os.path.splitext(bb)[0]
        if pred_name.startswith(stem):
            return bb
    if len(bb_info) == 1:
        return next(iter(bb_info))
    return None


def default_id(run: dict, dry: bool) -> str:
    if dry:
        return "hpc_dryrun_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_ids = [e.get("run_id") for e in run["events"] if e.get("run_id")]
    base = run_ids[0] if run_ids else os.path.basename(os.path.normpath(run["work_dir"]))
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "_", f"hpc_{base}")
    return cleaned[:80]


def write_bundle(b: Bundle, experiment: dict, run: dict, copy_to_structures: bool) -> dict:
    os.makedirs(b.dir, exist_ok=True)

    with open(os.path.join(b.dir, "experiment.json"), "w", encoding="utf-8") as fh:
        json.dump(experiment, fh, indent=2, sort_keys=True)

    metrics_doc = {
        "experiment_id": b.id,
        "generated_at": now_iso(),
        "kind": experiment["kind"],
        "status": experiment["status"],
        "values": dict(b.metrics),
        "unavailable": dict(b.unavailable),
        "definitions": dict(b.definitions),
        "per_design": b.per_design,
        "caveats": [CONFIDENCE_CAVEAT, SCRMSD_CAVEAT, NOT_CLINICAL,
                    "Every value under 'values' was computed from a file in this bundle. Nothing "
                    "here is a placeholder: a metric that could not be computed appears under "
                    "'unavailable' with the reason, and is absent from 'values'."],
    }
    with open(os.path.join(b.dir, "metrics.json"), "w", encoding="utf-8") as fh:
        json.dump(metrics_doc, fh, indent=2, sort_keys=True)

    # provenance: copy the raw ledger and the folded summary
    prov_dir = os.path.join(b.dir, "provenance")
    os.makedirs(prov_dir, exist_ok=True)
    if run.get("events_path") and os.path.exists(run["events_path"]):
        shutil.copy2(run["events_path"], os.path.join(prov_dir, "events.jsonl"))
    with open(os.path.join(prov_dir, "stages.json"), "w", encoding="utf-8") as fh:
        json.dump(run.get("stages", {}), fh, indent=2, sort_keys=True)

    # checksums of everything shipped
    checks = {}
    for root, _d, files in os.walk(b.dir):
        for f in sorted(files):
            full = os.path.join(root, f)
            rel = os.path.relpath(full, b.dir)
            if rel in ("checksums.json",):
                continue
            checks[rel] = {"sha256": sha256_file(full), "bytes": os.path.getsize(full)}
    with open(os.path.join(b.dir, "checksums.json"), "w", encoding="utf-8") as fh:
        json.dump(checks, fh, indent=2, sort_keys=True)

    # import plan + optional copy into data/structures so /register works directly
    copied = []
    if copy_to_structures and b.register:
        sdir = os.path.join(b.data_dir, "structures", b.id)
        pdir = os.path.join(b.data_dir, "pae", b.id)
        os.makedirs(sdir, exist_ok=True)
        for item in b.register:
            src = os.path.join(b.dir, item["local_file"])
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(sdir, os.path.basename(src)))
                copied.append(f"structures/{b.id}/{os.path.basename(src)}")
            pae_rel = item["body"].get("pae_path")
            if pae_rel:
                os.makedirs(pdir, exist_ok=True)
                pae_src = os.path.join(b.dir, "structures", os.path.basename(pae_rel))
                if os.path.exists(pae_src):
                    shutil.copy2(pae_src, os.path.join(pdir, os.path.basename(pae_rel)))
                    copied.append(f"pae/{b.id}/{os.path.basename(pae_rel)}")

    plan = {
        "experiment_id": b.id,
        "generated_at": now_iso(),
        "steps": [
            {"order": 1, "method": "POST", "path": "/api/experiments/reindex",
             "why": "loads data/experiments/*/experiment.json, using the directory name as the id"},
            {"order": 2, "note": "register the structure files so the viewer can open them",
             "calls": b.register},
        ],
        "files_copied_into_data": copied,
        "notes": [
            "POST /api/structures/register requires the file to already sit under data/structures/, "
            "which --copy-structures (default) has done.",
            "Backbones register as source 'uploaded' on purpose: GET /structures/{id}/plddt must "
            "refuse them, because their B-factors are not pLDDT.",
        ],
    }
    with open(os.path.join(b.dir, "import_plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan, fh, indent=2, sort_keys=True)

    readme = f"""# Experiment bundle `{b.id}`

- **kind**: `{experiment['kind']}`  **status**: `{experiment['status']}`
- **model**: {experiment['model_name']}
- **version**: {experiment['model_version']}
- **created**: {experiment['created_at']}

{experiment['provenance']['notes']}

## Import into FoldStudio

```bash
curl -X POST http://localhost:8000/api/experiments/reindex
# then register the structures listed in import_plan.json
```

## Files

| path | what it is |
|---|---|
| `experiment.json` | the Experiment record (matches `docs/CONTRACT.MD`) |
| `metrics.json` | every metric, its definition, and what was unavailable and why |
| `structures/` | backbone and predicted PDB files, plus PAE JSON where it exists |
| `sequences/` | ProteinMPNN FASTA output |
| `provenance/` | the append-only ledger and the per-stage summary |
| `checksums.json` | sha256 of every file above |
| `import_plan.json` | the exact API calls to register these structures |

## What this is not

{CONFIDENCE_CAVEAT}

{SCRMSD_CAVEAT}

{NOT_CLINICAL}
"""
    with open(os.path.join(b.dir, "README.md"), "w", encoding="utf-8") as fh:
        fh.write(readme)

    return {"dir": b.dir, "files": len(checks), "copied_into_data": copied}


# -------------------------------------------------------------------- validation

def validate_bundle(path: str) -> list[str]:
    """Check a bundle against the contract. Returns a list of problems (empty = OK).

    This mirrors the backend's own Experiment rules so a bundle can be checked
    without a running server; hpc/tests/test_export_bundle.py additionally
    cross-checks against the backend's real pydantic model when it is importable.
    """
    problems: list[str] = []
    exp_path = os.path.join(path, "experiment.json")
    if not os.path.exists(exp_path):
        return [f"missing {exp_path}"]
    try:
        with open(exp_path, "r", encoding="utf-8") as fh:
            exp = json.load(fh)
    except Exception as exc:
        return [f"experiment.json is not valid JSON: {exc}"]
    if not isinstance(exp, dict):
        return ["experiment.json top level must be a JSON object"]

    if exp.get("id") is not None and not ID_RE.match(str(exp["id"])):
        problems.append(f"id {exp.get('id')!r} does not match {ID_RE.pattern}")
    if not ID_RE.match(os.path.basename(os.path.normpath(path))):
        problems.append("the bundle directory name is not a legal experiment id")
    if exp.get("kind") not in ("executed", "imported", "demo"):
        problems.append(f"kind must be executed|imported|demo, got {exp.get('kind')!r}")
    if exp.get("status") not in ("ok", "failed", "partial"):
        problems.append(f"status must be ok|failed|partial, got {exp.get('status')!r}")
    if not isinstance(exp.get("model_name"), str) or not exp.get("model_name"):
        problems.append("model_name must be a non-empty string")
    for field, typ in (("settings", dict), ("metrics", dict), ("inputs", list), ("outputs", list)):
        if not isinstance(exp.get(field, typ()), typ):
            problems.append(f"{field} must be a {typ.__name__}")
    prov = exp.get("provenance")
    if not isinstance(prov, dict) or not isinstance(prov.get("source"), str) or not prov.get("source"):
        problems.append("provenance.source must be a non-empty string")

    # the two integrity rules the backend enforces
    if exp.get("status") == "failed" and not (exp.get("error") or "").strip():
        problems.append("a failed experiment must record the real error message")
    if exp.get("kind") == "executed" and exp.get("status") == "ok" and not exp.get("outputs"):
        problems.append("an 'executed' experiment with status 'ok' must list its output files")

    # every listed output must actually be here
    for rel in exp.get("outputs", []):
        if not isinstance(rel, str) or not os.path.exists(os.path.join(path, rel)):
            problems.append(f"outputs lists {rel!r}, which is not present in the bundle")

    # metrics must be flat scalars (the UI renders Record<string, number|string|null>)
    for k, v in (exp.get("metrics") or {}).items():
        if not isinstance(v, (int, float, str, bool)) and v is not None:
            problems.append(f"metrics[{k!r}] is {type(v).__name__}; metrics must be flat scalars")

    # no metric may be both reported and declared unavailable
    overlap = set((exp.get("metrics") or {})) & set((exp.get("metrics_unavailable") or {}))
    if overlap:
        problems.append(f"these keys are both reported and marked unavailable: {sorted(overlap)}")

    mpath = os.path.join(path, "metrics.json")
    if not os.path.exists(mpath):
        problems.append("missing metrics.json")
    else:
        try:
            with open(mpath, "r", encoding="utf-8") as fh:
                m = json.load(fh)
            if m.get("values") != (exp.get("metrics") or {}):
                problems.append("metrics.json 'values' does not match experiment.json 'metrics'")
            missing_defs = [k for k in (m.get("values") or {}) if k not in (m.get("definitions") or {})]
            if missing_defs:
                problems.append(f"metrics.json has values without definitions: {sorted(missing_defs)}")
        except Exception as exc:
            problems.append(f"metrics.json is not valid JSON: {exc}")

    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="export an HPC run as a FoldStudio experiment bundle")
    ap.add_argument("--work-dir", help="the run directory (FS_WORK), e.g. ~/foldstudio-hpc/runs/<RUN_ID>")
    ap.add_argument("--data-dir", default="data", help="FoldStudio data dir (default: data)")
    ap.add_argument("--experiment-id", help="bundle id; defaults to hpc_<run_id>")
    ap.add_argument("--dry-run", action="store_true",
                    help="build a 'demo' bundle from real fixture files to validate the format")
    ap.add_argument("--predicted", help="a real predicted model to include in a dry run")
    ap.add_argument("--no-copy-structures", action="store_true",
                    help="do not copy structures into data/structures/<id>/")
    ap.add_argument("--validate-only", help="validate an existing bundle directory and exit")
    args = ap.parse_args(argv)

    if args.validate_only:
        problems = validate_bundle(args.validate_only)
        if problems:
            print(f"INVALID: {args.validate_only}")
            for p in problems:
                print(f"  - {p}")
            return 1
        print(f"VALID: {args.validate_only}")
        return 0

    # build() returns the gathered run so the ledger is not read twice (and so a
    # dry run keeps the fixture paths it actually used).
    b, experiment, run = build(args)
    info = write_bundle(b, experiment, run, copy_to_structures=not args.no_copy_structures)

    problems = validate_bundle(b.dir)
    print(f"wrote {info['files']} files to {info['dir']}")
    print(f"  kind={experiment['kind']} status={experiment['status']} "
          f"outputs={len(experiment['outputs'])} metrics={len(experiment['metrics'])} "
          f"unavailable={len(experiment.get('metrics_unavailable') or {})}")
    if info["copied_into_data"]:
        print(f"  copied {len(info['copied_into_data'])} file(s) into the data dir for /register")
    if problems:
        print("BUNDLE FAILED VALIDATION:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("  bundle passes contract validation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
