"""CA-atom superposition (Kabsch), explicit residue matching, and TM-score.

Conventions
- Matrix is 4x4 for column vectors: x_ref_frame = M @ [x, y, z, 1] maps MOBILE coordinates
  onto the REFERENCE frame.
- RMSD is computed over exactly the CA atoms of the matched residues returned in `pairs`,
  after a single optimal rigid superposition of those atoms (no outlier rejection).
"""
import os
import re
import shutil
import subprocess
import tempfile

import numpy as np
from Bio import Align
from Bio.Align import substitution_matrices
from Bio.Data.PDBData import protein_letters_3to1_extended as AA3
from Bio.PDB.Polypeptide import is_aa

from app.errors import AppError

ATOM_TYPE = "CA"
_BLOSUM = substitution_matrices.load("BLOSUM62")
_ALPHABET = set(_BLOSUM.alphabet)


# ------------------------------------------------------------------ math

def kabsch(P: np.ndarray, Q: np.ndarray):
    """Rotation R and translation t minimising |R P + t - Q| (proper rotation, det=+1)."""
    cP, cQ = P.mean(axis=0), Q.mean(axis=0)
    H = (P - cP).T @ (Q - cQ)
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d if d != 0 else 1.0])
    R = Vt.T @ D @ U.T
    t = cQ - R @ cP
    return R, t


def apply(R, t, X):
    return X @ R.T + t


def rmsd_after_superposition(P, Q):
    R, t = kabsch(P, Q)
    diff = apply(R, t, P) - Q
    return float(np.sqrt((diff ** 2).sum(axis=1).mean())), R, t


def to_matrix4(R, t):
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = t
    return [[round(float(v), 6) for v in row] for row in M]


# ------------------------------------------------------------------ TM-score

def _d0(L: int) -> float:
    return 0.5 if L <= 21 else max(0.5, 1.24 * (L - 15) ** (1.0 / 3.0) - 1.8)


def tm_score_fixed_correspondence(P: np.ndarray, Q: np.ndarray, L_norm: int) -> float:
    """TM-score for a FIXED residue correspondence (P[i] <-> Q[i]), normalised by L_norm.

    Heuristic search over superpositions (fragment seeds + iterative refinement, as in the
    original TM-score program). The result is a lower bound of the optimum, so it can
    slightly underestimate the value reported by the official TM-score/USalign programs.
    """
    n = len(P)
    if n < 3 or L_norm < 1:
        return 0.0
    d0 = _d0(L_norm)
    d_search = min(max(d0, 4.5), 8.0)

    def score(R, t):
        d = np.linalg.norm(apply(R, t, P) - Q, axis=1)
        return float((1.0 / (1.0 + (d / d0) ** 2)).sum() / L_norm), d

    best = 0.0
    frag_lens = sorted({n, max(4, n // 2), max(4, n // 4), max(4, n // 8), 4}, reverse=True)
    for fl in frag_lens:
        if fl > n:
            continue
        step = max(1, fl // 2)
        for start in range(0, n - fl + 1, step):
            idx = np.arange(start, start + fl)
            last = None
            for _ in range(20):
                if len(idx) < 3:
                    break
                R, t = kabsch(P[idx], Q[idx])
                s, d = score(R, t)
                best = max(best, s)
                cut = d_search
                sel = np.where(d < cut)[0]
                while len(sel) < 3 and cut < 50:
                    cut += 0.5
                    sel = np.where(d < cut)[0]
                if last is not None and np.array_equal(sel, last):
                    break
                last, idx = sel, sel
    return min(best, 1.0)


_TM_RE = re.compile(r"TM-score=\s*([0-9]*\.?[0-9]+)\s*\(normalized by length of Structure_2", re.I)


def parse_usalign_tm(stdout: str):
    m = _TM_RE.search(stdout)
    return float(m.group(1)) if m else None


def _ca_pdb(coords: np.ndarray) -> str:
    lines = []
    for i, (x, y, z) in enumerate(coords, 1):
        lines.append(
            f"ATOM  {i:5d}  CA  ALA A{i:4d}    {x:8.3f}{y:8.3f}{z:8.3f}  1.00  0.00           C"
        )
    return "\n".join(lines) + "\nEND\n"


def usalign_tm(mob_ca: np.ndarray, ref_ca: np.ndarray):
    """Run USalign (sequence-independent alignment of the two CA traces) if installed.

    Returns (tm_normalised_by_reference, method) or None when the binary is unavailable
    or its output cannot be parsed.
    """
    exe = os.environ.get("FOLDSTUDIO_USALIGN") or shutil.which("USalign")
    if not exe:
        return None
    with tempfile.TemporaryDirectory() as td:
        a, b = os.path.join(td, "mobile.pdb"), os.path.join(td, "reference.pdb")
        open(a, "w").write(_ca_pdb(mob_ca))
        open(b, "w").write(_ca_pdb(ref_ca))
        try:
            out = subprocess.run([exe, a, b], capture_output=True, text=True, timeout=60).stdout
        except Exception:
            return None
    tm = parse_usalign_tm(out)
    if tm is None:
        return None
    return tm, "USalign (sequence-independent structural alignment of all selected CA atoms; normalised by reference length)"


# ------------------------------------------------------------------ matching

def chain_residues(model, chain_id, rng=None):
    if chain_id not in [c.id for c in model]:
        raise AppError(400, f"invalid_selection: chain '{chain_id}' not found (available: {', '.join(c.id for c in model)})")
    out = []
    for res in model[chain_id]:
        if not is_aa(res, standard=False):
            continue
        if rng and not (rng[0] <= res.id[1] <= rng[1]):
            continue
        out.append(
            {
                "resseq": res.id[1],
                "icode": res.id[2].strip(),
                "aa": AA3.get(res.get_resname(), "X"),
                "ca": np.array(res["CA"].coord, dtype=float) if "CA" in res else None,
                "label": f"{chain_id}:{res.id[1]}{res.id[2].strip()}",
            }
        )
    return out


def default_chain(model) -> str:
    for c in model:
        if any(is_aa(r, standard=False) and "CA" in r for r in c):
            return c.id
    raise AppError(400, "invalid_selection: structure has no chain with CA atoms")


def _seq(res):
    return "".join(r["aa"] if r["aa"] in _ALPHABET else "X" for r in res)


def match_by_sequence(M, R):
    aligner = Align.PairwiseAligner()
    aligner.substitution_matrix = _BLOSUM
    aligner.open_gap_score = -10
    aligner.extend_gap_score = -0.5
    aln = next(iter(aligner.align(_seq(M), _seq(R))))
    pairs = []
    for (m0, m1), (r0, r1) in zip(aln.aligned[0], aln.aligned[1]):
        pairs.extend((m0 + k, r0 + k) for k in range(m1 - m0))
    return pairs


def match_by_resnum(M, R):
    ref_index = {(r["resseq"], r["icode"]): j for j, r in enumerate(R)}
    return [(i, ref_index[(m["resseq"], m["icode"])]) for i, m in enumerate(M) if (m["resseq"], m["icode"]) in ref_index]


# ------------------------------------------------------------------ main entry

def align(mobile_model, reference_model, sel: dict | None = None) -> dict:
    sel = sel or {}
    method = sel.get("method") or "sequence"
    if method not in ("sequence", "resnum"):
        raise AppError(400, "invalid_selection: method must be 'sequence' or 'resnum'")
    mc = sel.get("mobile_chain") or default_chain(mobile_model)
    rc = sel.get("reference_chain") or default_chain(reference_model)
    M = chain_residues(mobile_model, mc, sel.get("mobile_range"))
    R = chain_residues(reference_model, rc, sel.get("reference_range"))
    if not M or not R:
        raise AppError(400, "invalid_selection: selected residue range is empty")

    idx = match_by_sequence(M, R) if method == "sequence" else match_by_resnum(M, R)
    idx = [(i, j) for i, j in idx if M[i]["ca"] is not None and R[j]["ca"] is not None]
    if len(idx) < 3:
        raise AppError(400, f"alignment_error: only {len(idx)} matched residues with CA atoms; need at least 3")

    P = np.array([M[i]["ca"] for i, _ in idx])
    Q = np.array([R[j]["ca"] for _, j in idx])
    rmsd, Rm, t = rmsd_after_superposition(P, Q)
    identical = sum(1 for i, j in idx if M[i]["aa"] == R[j]["aa"])

    ref_ca_all = np.array([r["ca"] for r in R if r["ca"] is not None])
    mob_ca_all = np.array([r["ca"] for r in M if r["ca"] is not None])
    us = usalign_tm(mob_ca_all, ref_ca_all)
    if us:
        tm, tm_method = us
    else:
        tm = round(tm_score_fixed_correspondence(P, Q, len(ref_ca_all)), 4)
        tm_method = (
            "FoldStudio built-in: TM-score for the fixed matched-residue correspondence, heuristic "
            "superposition search, normalised by reference chain length (CA count). May slightly "
            "underestimate official TM-score/USalign values; USalign was not available."
        )
    return {
        "rmsd": round(rmsd, 4),
        "tm_score": tm,
        "tm_score_method": tm_method,
        "aligned_atoms": len(idx),
        "aligned_residues": len(idx),
        "atom_type": ATOM_TYPE,
        "matrix": to_matrix4(Rm, t),
        "matrix_convention": "4x4 column-vector transform mapping mobile coordinates into the reference frame",
        "mobile_chain": mc,
        "reference_chain": rc,
        "matching": method,
        "sequence_identity": round(identical / len(idx), 4),
        "mobile_residues_in_selection": len(M),
        "reference_residues_in_selection": len(R),
        "pairs": [
            {"mobile": M[i]["label"], "reference": R[j]["label"], "identical": M[i]["aa"] == R[j]["aa"]}
            for i, j in idx
        ],
        "procedure": "Single optimal rigid-body (Kabsch) superposition of matched CA atoms; no outlier rejection or iterative refinement for RMSD.",
        "notes": [
            "RMSD depends on which residues are matched; low-confidence or disordered regions are included unless excluded via the selection ranges.",
            "RMSD and TM-score measure geometric similarity only, not function or binding.",
        ],
    }
