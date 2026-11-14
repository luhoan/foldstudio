import json

import pytest

from app.errors import AppError
from app.services import confidence as conf, structure_io as sio
from tests.conftest import helix, make_pdb, upload


@pytest.mark.parametrize(
    "v,expected",
    [(100, "very_high"), (90.01, "very_high"), (90, "very_high"), (89.99, "confident"), (70, "confident"), (69.99, "low"), (50, "low"), (49.99, "very_low"), (0, "very_low")],
)
def test_bin_boundaries(v, expected):
    assert conf.classify(v) == expected


def test_profile_bins_and_histogram():
    b = [95, 91, 90, 80, 70, 69, 55, 50, 49, 10]
    model = sio.parse_structure(make_pdb(helix(10), bfactors=b), "pdb")
    p = conf.plddt_profile(model)
    counts = {x["name"]: x["count"] for x in p["bins"]}
    assert counts == {"very_high": 3, "confident": 2, "low": 3, "very_low": 2}
    assert sum(h["count"] for h in p["histogram"]) == 10
    assert abs(sum(x["fraction"] for x in p["bins"]) - 1) < 1e-6
    assert p["mean"] == pytest.approx(sum(b) / 10) and "does not establish" in p["note"]


def test_value_100_counted_in_last_histogram_bucket():
    p = conf.plddt_profile(sio.parse_structure(make_pdb(helix(2), bfactors=[100, 0]), "pdb"))
    assert p["histogram"][9]["count"] == 1 and p["histogram"][0]["count"] == 1


def test_bfactors_outside_range_not_reported_as_plddt():
    model = sio.parse_structure(make_pdb(helix(3), bfactors=[12.0, 150.5, 20.0]), "pdb")
    with pytest.raises(AppError) as e:
        conf.plddt_profile(model)
    assert e.value.status == 409 and "plddt_unavailable" in e.value.detail


def test_plddt_endpoint_only_for_predicted(client):
    pdb = make_pdb(helix(6), bfactors=[95, 85, 75, 60, 40, 92])
    for src in ("experimental", "uploaded"):
        sid = upload(client, pdb, f"{src}.pdb", source=src).json()["id"]
        r = client.get(f"/api/structures/{sid}/plddt")
        assert r.status_code == 409 and "plddt_unavailable" in r.json()["detail"]
    sid = upload(client, pdb, "p.pdb", source="predicted").json()["id"]
    r = client.get(f"/api/structures/{sid}/plddt")
    assert r.status_code == 200
    j = r.json()
    assert j["n_residues"] == 6 and j["per_residue"][4]["bin"] == "very_low"
    assert client.get(f"/api/structures/{sid}/plddt?chain=Z").status_code == 404


# ---- PAE
def pae_json(n, wrap=True, key="predicted_aligned_error"):
    mat = [[float(i != j) * 2.5 for j in range(n)] for i in range(n)]
    d = {key: mat, "max_predicted_aligned_error": 31.75}
    return json.dumps([d] if wrap else d).encode()


@pytest.mark.parametrize("wrap,key", [(True, "predicted_aligned_error"), (False, "predicted_aligned_error"), (False, "pae")])
def test_parse_pae_layouts(wrap, key):
    r = conf.parse_pae(pae_json(4, wrap, key))
    assert r["size"] == 4 and r["max_pae"] == 31.75 and r["matrix"][0][1] == 2.5


@pytest.mark.parametrize("raw", [b"nope", b"[]", b"{}", b'{"pae": [[1,2],[3]]}', b'{"pae": [[1,"x"],[1,2]]}', b'{"pae": [[-1,2],[1,2]]}', b'"str"'])
def test_parse_pae_rejects(raw):
    with pytest.raises(AppError) as e:
        conf.parse_pae(raw)
    assert e.value.status == 400 and "invalid_pae" in e.value.detail


def test_pae_missing_returns_pae_unavailable(client):
    sid = upload(client, make_pdb(helix(5)), "a.pdb", source="predicted").json()["id"]
    r = client.get(f"/api/structures/{sid}/pae")
    assert r.status_code == 404 and r.json() == {"detail": "pae_unavailable"}


def test_attach_pae_and_mismatch(client):
    sid = upload(client, make_pdb(helix(5)), "a.pdb", source="predicted").json()["id"]
    bad = client.post(f"/api/structures/{sid}/pae", files={"file": ("p.json", pae_json(7), "application/json")})
    assert bad.status_code == 409 and "pae_mismatch" in bad.json()["detail"]
    ok = client.post(f"/api/structures/{sid}/pae", files={"file": ("p.json", pae_json(5), "application/json")})
    assert ok.status_code == 201
    g = client.get(f"/api/structures/{sid}/pae").json()
    assert g["size"] == 5 and client.get(f"/api/structures/{sid}").json()["has_pae"] is True
