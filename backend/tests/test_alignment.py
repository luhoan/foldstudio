import numpy as np
import pytest

from app.errors import AppError
from app.services import alignment as al, structure_io as sio
from tests.conftest import AA_CYCLE, helix, make_pdb, rot, upload


def model_of(coords, **kw):
    return sio.parse_structure(make_pdb(coords, **kw), "pdb")


def test_rotated_copy_gives_zero_rmsd_and_recovers_transform():
    P = helix(40, noise=0.8, seed=1)
    R0 = rot([1, 2, 3], 67)
    t0 = np.array([10.0, -4.0, 7.5])
    Q = P @ R0.T + t0
    r = al.align(model_of(P), model_of(Q))
    assert r["rmsd"] < 1e-3 and r["aligned_residues"] == 40 and r["atom_type"] == "CA"
    M = np.array(r["matrix"])
    assert np.allclose(M[:3, :3], R0, atol=1e-4) and np.allclose(M[:3, 3], t0, atol=1e-3)
    assert np.allclose((np.c_[P, np.ones(40)] @ M.T)[:, :3], Q, atol=1e-3)


def test_known_noise_gives_expected_rmsd():
    P = helix(200, seed=0)
    noise = np.random.default_rng(5).normal(0, 1.0, P.shape)
    r = al.align(model_of(P), model_of(P + noise))
    # per-atom noise sigma=1 on 3 axes -> RMSD near sqrt(3) minus the fitting reduction
    assert 1.4 < r["rmsd"] < 1.8


def test_mirror_image_is_not_superimposed_by_rotation():
    P = helix(40, noise=0.5, seed=2)
    mirror = P * np.array([1, 1, -1])
    assert al.align(model_of(P), model_of(mirror))["rmsd"] > 1.0  # proper rotations only, no reflection


def test_kabsch_det_is_positive():
    P = helix(30, noise=0.5)
    R, _ = al.kabsch(P, P * np.array([-1, 1, 1]))
    assert np.linalg.det(R) == pytest.approx(1.0)


def test_sequence_matching_handles_deleted_residue_and_reports_pairs():
    P = helix(40, noise=0.5, seed=3)
    Q = P @ rot([0, 1, 0], 30).T
    r = al.align(model_of(P, skip=()), model_of(Q, skip=(10,)))
    assert r["aligned_residues"] == 39 and r["rmsd"] < 1e-3 and r["sequence_identity"] == 1.0
    labels = {p["mobile"] for p in r["pairs"]}
    assert "A:11" not in {p["reference"] for p in r["pairs"]} and len(labels) == 39


def test_resnum_matching_and_ranges():
    P = helix(40, seed=4)
    Q = P @ rot([1, 0, 0], 20).T + 5
    r = al.align(model_of(P), model_of(Q), {"method": "resnum", "mobile_range": [5, 24], "reference_range": [5, 24]})
    assert r["aligned_residues"] == 20 and r["matching"] == "resnum" and r["rmsd"] < 1e-3
    r2 = al.align(model_of(P), model_of(Q), {"method": "resnum", "mobile_range": [1, 10], "reference_range": [6, 40]})
    assert r2["aligned_residues"] == 5  # overlap only: residues 6-10


def test_too_few_residues_rejected():
    P = helix(6)
    with pytest.raises(AppError) as e:
        al.align(model_of(P), model_of(P), {"method": "resnum", "mobile_range": [1, 2], "reference_range": [1, 2]})
    assert e.value.status == 400 and "need at least 3" in e.value.detail


def test_bad_chain_and_method():
    m = model_of(helix(10))
    with pytest.raises(AppError) as e:
        al.align(m, m, {"mobile_chain": "Z"})
    assert "not found" in e.value.detail
    with pytest.raises(AppError):
        al.align(m, m, {"method": "magic"})


def test_tm_score_identical_vs_random():
    P = helix(60, noise=0.5, seed=6)
    Q = P @ rot([1, 1, 0], 100).T + 3
    same = al.align(model_of(P), model_of(Q))
    assert same["tm_score"] > 0.99
    rng = np.random.default_rng(7)
    scrambled = rng.normal(0, 15, (60, 3))
    diff = al.align(model_of(P), model_of(scrambled))
    assert diff["tm_score"] < 0.35
    assert "built-in" in same["tm_score_method"]  # method is always reported with the value


def test_tm_score_normalised_by_reference_length():
    P = helix(60, seed=8)
    # mobile is the first 30 residues only; normalised by the 60-residue reference
    r = al.align(model_of(P[:30]), model_of(P))
    assert 0.3 < r["tm_score"] < 0.6 and r["aligned_residues"] == 30


def test_usalign_output_parser():
    sample = (
        "Name of Structure_1: mobile.pdb:A (to be superimposed onto Structure_2)\n"
        "TM-score= 0.81234 (normalized by length of Structure_1: L=100, d0=3.5)\n"
        "TM-score= 0.79000 (normalized by length of Structure_2: L=110, d0=3.7)\n"
    )
    assert al.parse_usalign_tm(sample) == 0.79
    assert al.parse_usalign_tm("garbage") is None


def test_usalign_absent_falls_back(monkeypatch):
    monkeypatch.setattr(al.shutil, "which", lambda _: None)
    monkeypatch.delenv("FOLDSTUDIO_USALIGN", raising=False)
    P = helix(30)
    assert al.usalign_tm(P, P) is None


def test_usalign_used_when_present(monkeypatch):
    class Out:
        stdout = "TM-score= 0.5 (normalized by length of Structure_1: L=1\nTM-score= 0.4242 (normalized by length of Structure_2: L=1\n"

    monkeypatch.setattr(al.shutil, "which", lambda _: "/fake/USalign")
    monkeypatch.setattr(al.subprocess, "run", lambda *a, **k: Out())
    P = helix(30)
    r = al.align(model_of(P), model_of(P))
    assert r["tm_score"] == 0.4242 and r["tm_score_method"].startswith("USalign")


# ---- API
def test_align_endpoint(client):
    P = helix(30, noise=0.4, seed=9)
    a = upload(client, make_pdb(P), "a.pdb", source="predicted").json()["id"]
    b = upload(client, make_pdb(P @ rot([0, 0, 1], 45).T + 2), "b.pdb", source="experimental").json()["id"]
    r = client.post("/api/analysis/align", json={"mobile_id": a, "reference_id": b})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["rmsd"] < 1e-3 and j["aligned_atoms"] == 30 and j["atom_type"] == "CA"
    assert len(j["matrix"]) == 4 and j["mobile_source"] == "predicted" and j["reference_source"] == "experimental"
    assert len(j["pairs"]) == 30 and j["tm_score_method"]


def test_align_endpoint_errors(client):
    a = upload(client, make_pdb(helix(10)), "a.pdb").json()["id"]
    f = upload(client, ">s\nMKT\n", "s.fasta").json()["id"]
    assert client.post("/api/analysis/align", json={"mobile_id": a, "reference_id": f}).status_code == 409
    assert client.post("/api/analysis/align", json={"mobile_id": a, "reference_id": "nope"}).status_code == 404
    assert client.post("/api/analysis/align", json={"mobile_id": a, "reference_id": a}).status_code == 400
    assert client.post("/api/analysis/align", json={"mobile_id": a}).status_code == 422
