"""GET /api/explain and GET /api/structures/{id}/interfaces.

The frontend called /explain from day one and the rules engine existed, but no
route joined them, so every structure showed a "Not Found" error in the sidebar.

Coordinates are synthetic (conftest helix), used only to check arithmetic and
wording. They are not real proteins.
"""
import json

import numpy as np
import pytest

from app.services import explain_rules as rules
from .conftest import helix, make_pdb, upload

FORBIDDEN_NAMES = {"plddt", "mean_plddt", "mean_pae", "max_pae"}


def pae_json(n, value=2.0):
    mat = [[0.0 if i == j else value + abs(i - j) * 0.1 for j in range(n)] for i in range(n)]
    return json.dumps({"predicted_aligned_error": mat, "max_predicted_aligned_error": 31.75}).encode()


def two_chain_pdb(n=12, shift=4.0, bfactors=None):
    """Chain A and chain B: the same helix, B displaced so the chains touch."""
    a = helix(n)
    b = a + np.array([shift, 0.0, 0.0])
    text_a = make_pdb(a, chain="A", bfactors=bfactors).replace("END\n", "")
    text_b = make_pdb(b, chain="B", bfactors=bfactors, start=101)
    return text_a + text_b


@pytest.fixture()
def predicted(client):
    b = [95, 92, 90, 85, 75, 70, 65, 55, 50, 45, 30, 20]
    sid = upload(client, make_pdb(helix(12), bfactors=b), "p.pdb", source="predicted").json()["id"]
    return sid, b


# ------------------------------------------------------------------ /explain

def test_region_explanation_uses_exactly_the_profile_numbers(client, predicted):
    sid, b = predicted
    j = client.get(f"/api/explain?structure={sid}").json()
    assert (j["chain"], j["start"], j["end"], j["n_residues"]) == ("A", 1, 12, 12)
    assert j["source"] == "predicted"
    assert j["explanations"][0]["rule_id"] == "plddt_region"
    assert j["numbers_used"]["mean_plddt"] == pytest.approx(sum(b) / 12, abs=1e-3)
    profile = client.get(f"/api/structures/{sid}/plddt").json()
    assert j["numbers_used"]["mean_plddt"] == pytest.approx(profile["mean"], abs=0.01)
    assert f"mean pLDDT {sum(b) / 12:.1f}" in j["summary"]


def test_disclaimer_is_returned_once_and_not_buried_in_the_summary(client, predicted):
    sid, _ = predicted
    j = client.get(f"/api/explain?structure={sid}").json()
    assert j["limitations"] == [rules.DISCLAIMER]
    assert rules.DISCLAIMER not in j["summary"]
    for e in j["explanations"]:
        assert e["text"].endswith(rules.DISCLAIMER), "each rule's own text still carries it"


def test_sub_range_and_single_residue(client, predicted):
    sid, b = predicted
    j = client.get(f"/api/explain?structure={sid}&chain=A&start=1&end=3").json()
    assert j["n_residues"] == 3
    assert j["numbers_used"]["mean_plddt"] == pytest.approx(sum(b[:3]) / 3, abs=1e-3)
    one = client.get(f"/api/explain?structure={sid}&start=3&end=3").json()
    assert one["explanations"][0]["rule_id"] == "plddt_residue"
    assert one["numbers_used"]["plddt"] == 90
    assert one["numbers_used"]["bin"] == "very_high", "90.00 is very high everywhere in the app"


def test_pae_block_is_explained_when_the_structure_has_pae(client, predicted):
    sid, _ = predicted
    client.post(f"/api/structures/{sid}/pae", files={"file": ("p.json", pae_json(12), "application/json")})
    j = client.get(f"/api/explain?structure={sid}&start=1&end=4").json()
    assert [e["rule_id"] for e in j["explanations"]] == ["plddt_region", "pae_region"]
    block = [0.0 if i == k else 2.0 + abs(i - k) * 0.1 for i in range(4) for k in range(4)]
    assert j["numbers_used"]["mean_pae"] == pytest.approx(sum(block) / 16, abs=1e-3)
    assert j["numbers_used"]["n_pairs"] == 16


@pytest.mark.parametrize("source,needle", [("experimental", "experimental B-factors"),
                                           ("uploaded", "not declared")])
def test_non_predicted_structures_are_explained_without_any_confidence_number(client, source, needle):
    """B-factors of 95 look exactly like good pLDDT. They must not be read as it."""
    sid = upload(client, make_pdb(helix(8), bfactors=[95.0] * 8), "x.pdb", source=source).json()["id"]
    j = client.get(f"/api/explain?structure={sid}").json()
    assert j["explanations"][0]["rule_id"] == "no_confidence"
    assert needle in j["summary"]
    assert not (set(j["numbers_used"]) & FORBIDDEN_NAMES)
    assert "95" not in j["summary"]


def test_predicted_file_whose_bfactors_cannot_be_plddt_is_refused(client):
    sid = upload(client, make_pdb(helix(4), bfactors=[10.0, 250.0, 30.0, 40.0]), "odd.pdb",
                 source="predicted").json()["id"]
    r = client.get(f"/api/explain?structure={sid}")
    assert r.status_code == 409 and "plddt_unavailable" in r.json()["detail"]


def test_errors(client, predicted):
    sid, _ = predicted
    assert client.get("/api/explain?structure=st_missing").status_code == 404
    assert client.get(f"/api/explain?structure={sid}&chain=Z").status_code == 404
    assert client.get(f"/api/explain?structure={sid}&start=9&end=2").status_code == 400
    assert client.get(f"/api/explain?structure={sid}&start=500&end=600").status_code == 404
    assert client.get("/api/explain").status_code == 422


def test_fasta_record_has_nothing_to_explain(client):
    sid = upload(client, ">seq1\nMKVLAAGIV\n", "s.fasta").json()["id"]
    r = client.get(f"/api/explain?structure={sid}")
    assert r.status_code == 409 and "no_coordinates" in r.json()["detail"]


# --------------------------------------------------------------- /interfaces

def brute_force_pairs(text, cutoff):
    """Independent O(n^2) count of inter-chain residue pairs with an atom pair within cutoff."""
    atoms = []
    for line in text.splitlines():
        if line.startswith("ATOM"):
            atoms.append((line[21], int(line[22:26]),
                          np.array([float(line[30:38]), float(line[38:46]), float(line[46:54])])))
    pairs = set()
    for ca, ra, xa in atoms:
        for cb, rb, xb in atoms:
            if ca < cb and np.linalg.norm(xa - xb) <= cutoff:
                pairs.add((ra, rb))
    return pairs


def test_interface_matches_an_independent_brute_force_count(client):
    text = two_chain_pdb()
    sid = upload(client, text, "c.pdb", source="experimental").json()["id"]
    j = client.get(f"/api/structures/{sid}/interfaces").json()
    expected = brute_force_pairs(text, 4.5)
    assert expected, "the synthetic chains must actually touch for this test to mean anything"
    assert len(j["interfaces"]) == 1
    iface = j["interfaces"][0]
    assert (iface["chain_a"], iface["chain_b"]) == ("A", "B")
    assert iface["n_residue_pairs"] == len(expected)
    assert iface["residues_a"] == sorted({a for a, _ in expected})
    assert iface["residues_b"] == sorted({b for _, b in expected})
    assert j["cutoff_angstrom"] == 4.5 and j["n_chains"] == 2


def test_cutoff_changes_the_answer_and_is_bounded(client):
    text = two_chain_pdb()
    sid = upload(client, text, "c.pdb").json()["id"]
    tight = client.get(f"/api/structures/{sid}/interfaces?cutoff=4.05").json()["interfaces"]
    loose = client.get(f"/api/structures/{sid}/interfaces?cutoff=8").json()["interfaces"]
    assert loose[0]["n_residue_pairs"] == len(brute_force_pairs(text, 8.0))
    assert loose[0]["n_residue_pairs"] > tight[0]["n_residue_pairs"]
    assert client.get(f"/api/structures/{sid}/interfaces?cutoff=0.5").status_code == 400
    assert client.get(f"/api/structures/{sid}/interfaces?cutoff=99").status_code == 400


def test_ranges_are_contiguous_runs_for_highlighting(client):
    sid = upload(client, two_chain_pdb(), "c.pdb").json()["id"]
    iface = client.get(f"/api/structures/{sid}/interfaces").json()["interfaces"][0]
    covered = [n for r in iface["ranges_a"] for n in range(r["start"], r["end"] + 1)]
    assert covered == iface["residues_a"]
    assert all(r["start"] <= r["end"] for r in iface["ranges_a"])


def test_single_chain_has_no_interfaces(client):
    sid = upload(client, make_pdb(helix(10)), "m.pdb").json()["id"]
    j = client.get(f"/api/structures/{sid}/interfaces").json()
    assert j["interfaces"] == [] and j["n_chains"] == 1


def test_chains_far_apart_have_no_interface(client):
    sid = upload(client, two_chain_pdb(shift=60.0), "far.pdb").json()["id"]
    assert client.get(f"/api/structures/{sid}/interfaces").json()["interfaces"] == []


def test_wording_follows_what_is_known_about_the_file(client):
    text = two_chain_pdb(bfactors=[80.0] * 12)

    def explanation(source, with_pae=False):
        sid = upload(client, text, f"{source}{with_pae}.pdb", source=source).json()["id"]
        if with_pae:
            r = client.post(f"/api/structures/{sid}/pae",
                            files={"file": ("p.json", pae_json(24, 6.0), "application/json")})
            assert r.status_code == 201
        return client.get(f"/api/structures/{sid}/interfaces").json()["interfaces"][0]

    exp = explanation("experimental")
    assert exp["explanation"]["rule_id"] == "interface"
    assert "deposited coordinates" in exp["explanation"]["text"]
    assert exp["interface_mean_plddt"] is None and exp["mean_interchain_pae"] is None

    upl = explanation("uploaded")
    assert upl["explanation"]["rule_id"] == "interface_coordinates"
    for word in ("experimental", "deposited", "pLDDT"):
        assert word not in upl["explanation"]["text"].replace(rules.DISCLAIMER, "")

    # predicted, but no PAE: half the confidence picture is not enough to use that wording
    half = explanation("predicted")
    assert half["explanation"]["rule_id"] == "interface_coordinates"
    assert half["interface_mean_plddt"] == 80.0 and half["mean_interchain_pae"] is None

    full = explanation("predicted", with_pae=True)
    assert full["explanation"]["rule_id"] == "interface"
    assert "Mean pLDDT of interface residues is 80.0" in full["explanation"]["text"]
    assert full["mean_interchain_pae"] is not None


def test_interchain_pae_is_the_mean_of_the_off_diagonal_blocks(client):
    text = two_chain_pdb(bfactors=[80.0] * 12)
    sid = upload(client, text, "p.pdb", source="predicted").json()["id"]
    n = 24
    mat = [[0.0] * n for _ in range(n)]
    for i in range(12):
        for k in range(12, 24):
            mat[i][k] = 4.0   # A -> B
            mat[k][i] = 10.0  # B -> A
    raw = json.dumps({"predicted_aligned_error": mat}).encode()
    assert client.post(f"/api/structures/{sid}/pae", files={"file": ("p.json", raw, "application/json")}).status_code == 201
    iface = client.get(f"/api/structures/{sid}/interfaces").json()["interfaces"][0]
    assert iface["mean_interchain_pae"] == 7.0


def test_a_negative_residue_number_does_not_render_as_a_run_of_dashes():
    """PDB files really do number residues from zero or below -- expression
    tags and cloning artefacts keep their own numbering. Formatting such a
    range as `{start}-{end}` produced "Residues -1-104", which reads as
    nonsense rather than as a range. Nothing about the data changed here;
    only how it is said."""
    assert rules.residue_range(1, 104) == "1-104"
    assert rules.residue_range(-1, 104) == "-1 to 104"
    assert rules.residue_range(0, 12) == "0 to 12"
    assert rules.residue_range(-20, -3) == "-20 to -3"
    # a single residue is a point, not a range
    assert rules.residue_range(7, 7) == "7"
    assert rules.residue_range(-5, -5) == "-5"


def test_the_no_confidence_sentence_uses_that_range(client):
    text = "\n".join(
        f"ATOM  {i + 1:5d}  CA  ALA A{n:4d}    "
        f"{i * 3.8:8.3f}{0.0:8.3f}{0.0:8.3f}  1.00 50.00           C"
        for i, n in enumerate(range(-1, 5))
    ) + "\nEND\n"
    sid = upload(client, text, "tagged.pdb", source="experimental").json()["id"]
    body = client.get(f"/api/explain", params={"structure": sid}).json()
    assert "Residues -1 to 4 of chain A" in json.dumps(body)
    assert "-1-4" not in json.dumps(body)
