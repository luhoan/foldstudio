"""Chain-chain contacts computed from coordinates.

A contact here is purely geometric: two amino-acid residues on different chains
with any pair of heavy atoms within the cutoff. It says which residues sit next
to each other in this one set of coordinates and nothing about whether, or how
strongly, the chains associate.
"""
from collections import defaultdict

from Bio.PDB import NeighborSearch

from app.errors import AppError
from app.services.structure_io import aa_residues

DEFAULT_CUTOFF = 4.5  # Angstrom; the same value scripts/fetch_demo_data.py uses
MIN_CUTOFF, MAX_CUTOFF = 2.0, 12.0
# Modified residues recorded as HETATM (selenomethionine, for one) are amino-acid
# residues here, as they are everywhere else in this backend. A count made from
# ATOM records alone can therefore be lower by the pairs such a residue takes part in.
ATOM_SELECTION = "heavy atoms of amino-acid residues, modified residues (e.g. MSE) included"

NOTE = (
    "Contacts are geometric: residue pairs on different chains with any heavy atoms within the "
    "cutoff, in this one set of coordinates. They are not measurements of any physical property."
)


def _ranges(numbers: list[int]) -> list[dict]:
    """[3,4,5,9,10] -> [{start:3,end:5},{start:9,end:10}], for highlighting in the viewer."""
    out: list[dict] = []
    for n in numbers:
        if out and n == out[-1]["end"] + 1:
            out[-1]["end"] = n
        elif not out or n != out[-1]["end"]:
            out.append({"start": n, "end": n})
    return out


def chain_interfaces(model, cutoff: float = DEFAULT_CUTOFF) -> list[dict]:
    """One entry per pair of chains that have at least one residue contact."""
    if not (MIN_CUTOFF <= cutoff <= MAX_CUTOFF):
        raise AppError(400, f"invalid_request: cutoff must be between {MIN_CUTOFF} and {MAX_CUTOFF} A")
    atoms = [a for _, res in aa_residues(model) for a in res
             if (a.element or "").upper() not in ("H", "D")]
    if not atoms:
        return []
    pairs: dict[tuple[str, str], set] = defaultdict(set)
    for a, b in NeighborSearch(atoms).search_all(cutoff, level="A"):
        ra, rb = a.get_parent(), b.get_parent()
        ca, cb = ra.get_parent().id, rb.get_parent().id
        if ca == cb:
            continue
        if ca > cb:
            ca, cb, ra, rb = cb, ca, rb, ra
        pairs[(ca, cb)].add((ra.id[1], ra.id[2].strip(), rb.id[1], rb.id[2].strip()))

    out = []
    for (ca, cb), contacts in sorted(pairs.items()):
        res_a = sorted({(n, i) for n, i, _, _ in contacts})
        res_b = sorted({(n, i) for _, _, n, i in contacts})
        nums_a = sorted({n for n, _ in res_a})
        nums_b = sorted({n for n, _ in res_b})
        out.append({
            "chain_a": ca,
            "chain_b": cb,
            "n_residue_pairs": len(contacts),
            "n_residues_a": len(res_a),
            "n_residues_b": len(res_b),
            "residues_a": nums_a,
            "residues_b": nums_b,
            "ranges_a": _ranges(nums_a),
            "ranges_b": _ranges(nums_b),
        })
    return out
