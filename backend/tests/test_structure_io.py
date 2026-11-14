import io

import httpx
import numpy as np
import pytest
from Bio.PDB import MMCIFIO, PDBParser

from app.errors import AppError
from app.services import structure_io as sio
from tests.conftest import helix, make_pdb, upload


def test_parse_pdb_summary():
    model = sio.parse_structure(make_pdb(helix(12)), "pdb")
    s = sio.summarize(model)
    assert s["n_residues"] == 12 and len(s["chains"]) == 1
    assert s["chains"][0]["sequence"] == "AGLSVKETDIAG"
    assert s["chains"][0]["first_resseq"] == 1 and s["chains"][0]["last_resseq"] == 12


def test_mmcif_roundtrip():
    st = PDBParser(QUIET=True).get_structure("s", io.StringIO(make_pdb(helix(8))))
    io_ = MMCIFIO()
    io_.set_structure(st)
    buf = io.StringIO()
    io_.save(buf)
    text = buf.getvalue()
    assert sio.detect_format("", text) == "mmcif"
    s = sio.summarize(sio.parse_structure(text, "mmcif"))
    assert s["n_residues"] == 8


@pytest.mark.parametrize(
    "data,frag",
    [
        (b"", "empty"),
        (b"   \n  ", "empty"),
        (b"\xff\xfe\x00\x01binary", "UTF-8"),
    ],
)
def test_decode_rejects(data, frag):
    with pytest.raises(AppError) as e:
        sio.decode(data)
    assert e.value.status == 400 and frag in e.value.detail


def test_no_atom_records():
    with pytest.raises(AppError) as e:
        sio.parse_structure("HEADER nothing here\nREMARK 1\nEND\n", "pdb")
    assert e.value.status == 400 and "no ATOM records" in e.value.detail


def test_malformed_coordinates():
    bad = "ATOM      1  CA  ALA A   1    abc     def     ghi  1.00 50.00           C\nEND\n"
    with pytest.raises(AppError) as e:
        sio.parse_structure(bad, "pdb")
    assert e.value.status == 400 and "malformed" in e.value.detail


def test_garbage_mmcif():
    with pytest.raises(AppError) as e:
        sio.parse_structure("data_x\nloop_\n_atom_site.id\n1 2 3 garbage", "mmcif")
    assert e.value.status == 400


def test_nucleic_acid_only_rejected():
    dna = "\n".join(
        f"ATOM  {i:5d}  C1' {r:>3s} A{i:4d}    {i:8.3f}   0.000   0.000  1.00 20.00           C" for i, r in enumerate(["DA", "DT", "DG", "DC"], 1)
    )
    with pytest.raises(AppError) as e:
        sio.parse_structure(dna + "\nEND\n", "pdb")
    assert "no amino-acid residues" in e.value.detail


def test_unrecognised_format():
    with pytest.raises(AppError) as e:
        sio.detect_format("notes.txt", "just some prose")
    assert e.value.status == 400


def test_fasta_ok_and_errors():
    recs = sio.parse_fasta(">sp|P1|X desc\nMKT\nAYI\n>second\nGG\n")
    assert [r["n_residues"] for r in recs] == [6, 2] and recs[0]["sequence"] == "MKTAYI"
    for bad, frag in [("MKT\n", "before first"), (">a\n", "empty sequence"), (">a\nMK1T\n", "invalid characters"), ("", "no records"), (">\nMKT\n", "empty header")]:
        with pytest.raises(AppError) as e:
            sio.parse_fasta(bad)
        assert frag in e.value.detail


# ---- API: upload
def test_upload_pdb_and_file_roundtrip(client):
    r = upload(client, make_pdb(helix(10)), "a.pdb", label="synthetic")
    assert r.status_code == 201
    s = r.json()
    assert s["source"] == "uploaded" and s["format"] == "pdb" and s["n_residues"] == 10 and len(s["sha256"]) == 64
    assert client.get(f"/api/structures/{s['id']}/file").text.startswith("ATOM")
    assert client.get("/api/structures").json()[0]["id"] == s["id"]
    res = client.get(f"/api/structures/{s['id']}/residues").json()
    assert res["residues"][0]["resname"] == "ALA" and res["chains"][0]["id"] == "A"


@pytest.mark.parametrize(
    "name,body,frag",
    [
        ("e.pdb", "", "empty"),
        ("n.pdb", "REMARK only\nEND\n", "no ATOM records"),
        ("t.txt", "hello world", "could not recognise"),
        ("m.pdb", "ATOM      1  CA  ALA A   1    abc     def     ghi  1.00 50.00           C\n", "malformed"),
    ],
)
def test_upload_invalid_returns_400(client, name, body, frag):
    r = upload(client, body, name)
    assert r.status_code == 400 and frag in r.json()["detail"]


def test_upload_fasta_sequence_record(client):
    r = upload(client, ">p1 test\nMKTAYIAK\n", "seq.fasta")
    assert r.status_code == 201
    s = r.json()
    assert s["format"] == "fasta" and s["n_residues"] == 8 and s["chains"][0]["sequence"] == "MKTAYIAK"
    for ep in ("residues", "plddt"):
        assert client.get(f"/api/structures/{s['id']}/{ep}").status_code == 409
    assert client.get(f"/api/structures/{s['id']}/residues").json()["detail"].startswith("no_coordinates")


def test_upload_fasta_with_predicted_source_rejected(client):
    assert upload(client, ">a\nMKT\n", "s.fa", source="predicted").status_code == 400


def test_structure_not_found(client):
    assert client.get("/api/structures/nope").status_code == 404


# ---- API: remote fetch with mocked network
def _mock(monkeypatch, handler):
    monkeypatch.setattr(sio, "make_client", lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True))


def test_fetch_rcsb_ok(client, monkeypatch):
    cif = io_cif(helix(6))
    _mock(monkeypatch, lambda req: httpx.Response(200, content=cif.encode()) if req.url.path.endswith("1UBQ.cif") else httpx.Response(404))
    r = client.post("/api/structures/fetch", json={"source": "rcsb", "id": "1ubq"})
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["source"] == "experimental" and s["origin_id"] == "1UBQ" and s["format"] == "mmcif"
    assert s["provenance"]["url"].startswith("https://files.rcsb.org/")


def test_fetch_rcsb_errors(client, monkeypatch):
    assert client.post("/api/structures/fetch", json={"source": "rcsb", "id": "zz"}).status_code == 400
    _mock(monkeypatch, lambda req: httpx.Response(404))
    assert client.post("/api/structures/fetch", json={"source": "rcsb", "id": "9XXX"}).status_code == 404

    def boom(req):
        raise httpx.ConnectTimeout("slow")

    _mock(monkeypatch, boom)
    r = client.post("/api/structures/fetch", json={"source": "rcsb", "id": "1UBQ"})
    assert r.status_code == 504 and "upstream_timeout" in r.json()["detail"]
    _mock(monkeypatch, lambda req: httpx.Response(500))
    assert client.post("/api/structures/fetch", json={"source": "rcsb", "id": "1UBQ"}).status_code == 502


def io_cif(coords):
    st = PDBParser(QUIET=True).get_structure("s", io.StringIO(make_pdb(coords)))
    w = MMCIFIO()
    w.set_structure(st)
    buf = io.StringIO()
    w.save(buf)
    return buf.getvalue()


def _afdb_handler(n, pae_ok=True, pae_valid=True):
    cif = io_cif(helix(n))

    def h(req):
        u = str(req.url)
        if u.endswith("/api/prediction/P42212"):
            return httpx.Response(200, json=[{"entryId": "AF-P42212-F1", "latestVersion": 4, "cifUrl": "https://af.test/m.cif", "paeDocUrl": "https://af.test/pae.json"}])
        if u.endswith("m.cif"):
            return httpx.Response(200, content=cif.encode())
        if u.endswith("pae.json"):
            if not pae_ok:
                return httpx.Response(500)
            body = json_pae(n) if pae_valid else "not json"
            return httpx.Response(200, content=body.encode())
        return httpx.Response(404)

    return h


def json_pae(n):
    import json

    return json.dumps([{"predicted_aligned_error": [[1.0] * n for _ in range(n)], "max_predicted_aligned_error": 31.75}])


def test_fetch_afdb_with_pae(client, monkeypatch):
    _mock(monkeypatch, _afdb_handler(10))
    r = client.post("/api/structures/fetch", json={"source": "afdb", "id": "p42212"})
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["source"] == "predicted" and s["has_pae"] and "version 4" in s["provenance"]["notes"]
    assert client.get(f"/api/structures/{s['id']}/pae").json()["size"] == 10


def test_fetch_afdb_pae_failure_is_not_fatal(client, monkeypatch):
    _mock(monkeypatch, _afdb_handler(10, pae_ok=False))
    s = client.post("/api/structures/fetch", json={"source": "afdb", "id": "P42212"}).json()
    assert not s["has_pae"] and "PAE download failed" in s["provenance"]["notes"]
    _mock(monkeypatch, _afdb_handler(10, pae_valid=False))
    s = client.post("/api/structures/fetch", json={"source": "afdb", "id": "P42212"}).json()
    assert not s["has_pae"] and "could not be parsed" in s["provenance"]["notes"]


def test_fetch_afdb_bad_accession(client):
    assert client.post("/api/structures/fetch", json={"source": "afdb", "id": "hello"}).status_code == 400
