"""Reindex registers the structures an experiment bundle lists.

Before this, `POST /api/experiments/reindex` loaded experiment.json files and
nothing else, while structures only entered the table if something separately
POSTed /api/structures/register. Nothing did. The observable result was an
Experiment History with nine rows next to an empty /api/structures, so every
API-driven panel (PAE, confidence) had nothing to offer.

The safety-critical part is `source`. GET /structures/{id}/plddt reads
B-factors as pLDDT, and will only do so for a structure declared "predicted",
because the same column in a crystal structure is a different physical
quantity. Auto-registration must therefore never promote a file to "predicted"
by guessing: these tests pin the default to "uploaded" for anything that does
not say otherwise.

Coordinates here are the synthetic helix from conftest, not a real protein.
"""
import json

import pytest

from .conftest import helix, make_pdb


def write_experiment(client, eid, outputs, *, structure_sources=None, files=None):
    """Lay out a bundle the way a producer would, and return its directory."""
    ctx = client.ctx
    exp_dir = ctx.experiments_dir / eid
    exp_dir.mkdir(parents=True, exist_ok=True)
    for rel, text in (files or {}).items():
        p = ctx.data_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    payload = {
        "id": eid, "created_at": "2026-11-14T00:00:00Z", "kind": "imported", "status": "ok",
        "model_name": "test", "model_version": "1", "settings": {}, "inputs": [],
        "outputs": outputs, "metrics": {}, "error": None,
        "provenance": {"source": "test", "retrieved_at": "2026-11-14T00:00:00Z",
                       "url": None, "notes": "synthetic fixture"},
    }
    if structure_sources is not None:
        payload["structure_sources"] = structure_sources
    (exp_dir / "experiment.json").write_text(json.dumps(payload))
    return exp_dir


@pytest.fixture()
def pdb_text():
    return make_pdb(helix(30), bfactors=[90.0] * 30)


def structures(client):
    return client.get("/api/structures").json()


def test_reindex_registers_a_listed_structure(client, pdb_text):
    write_experiment(
        client, "exp-a",
        outputs=[{"type": "structure", "path": "structures/a.pdb", "source": "predicted"}],
        files={"structures/a.pdb": pdb_text},
    )
    body = client.post("/api/experiments/reindex").json()
    assert body["errors"] == []
    assert len(body["structures_registered"]) == 1

    rows = structures(client)
    assert len(rows) == 1
    assert rows[0]["source"] == "predicted"
    assert rows[0]["origin_id"] == "exp-a:a.pdb"


def test_bare_string_outputs_are_understood(client, pdb_text):
    """One producer writes dicts, another writes plain paths. Both are read."""
    write_experiment(
        client, "exp-strings",
        outputs=["structures/s.pdb"],
        structure_sources={"s.pdb": "predicted"},
        files={"structures/s.pdb": pdb_text},
    )
    client.post("/api/experiments/reindex")
    rows = structures(client)
    assert len(rows) == 1
    assert rows[0]["source"] == "predicted"


def test_paths_relative_to_the_bundle_directory_resolve(client, pdb_text):
    """HPC bundles carry their own copies under experiments/<id>/structures/."""
    write_experiment(
        client, "exp-bundle",
        outputs=["structures/inside.pdb"],
        files={"experiments/exp-bundle/structures/inside.pdb": pdb_text},
    )
    client.post("/api/experiments/reindex")
    rows = structures(client)
    assert len(rows) == 1
    assert rows[0]["origin_id"] == "exp-bundle:inside.pdb"


@pytest.mark.parametrize("declared", [None, "wizardry", ""])
def test_unstated_or_bogus_source_never_becomes_predicted(client, pdb_text, declared):
    """The whole point of the guard: confidence is refused unless it was claimed.

    An experimental entry's B-factors sit in the same 0-100 window as pLDDT, so
    a file we cannot vouch for must not be reported as model confidence.
    """
    out = {"type": "structure", "path": "structures/u.pdb"}
    if declared is not None:
        out["source"] = declared
    write_experiment(client, "exp-unstated", outputs=[out],
                     files={"structures/u.pdb": pdb_text})
    client.post("/api/experiments/reindex")

    row = structures(client)[0]
    assert row["source"] == "uploaded"
    assert client.get(f"/api/structures/{row['id']}/plddt").status_code == 409


def test_experimental_source_is_kept_and_still_refuses_plddt(client, pdb_text):
    write_experiment(
        client, "exp-xtal",
        outputs=[{"type": "structure", "path": "structures/x.pdb", "source": "experimental"}],
        files={"structures/x.pdb": pdb_text},
    )
    client.post("/api/experiments/reindex")
    row = structures(client)[0]
    assert row["source"] == "experimental"
    assert client.get(f"/api/structures/{row['id']}/plddt").status_code == 409


def test_pae_sidecar_is_attached_and_served(client, pdb_text):
    n = 30
    pae = {"predicted_aligned_error": [[1.0] * n for _ in range(n)],
           "max_predicted_aligned_error": 31.75}
    write_experiment(
        client, "exp-pae",
        outputs=[{"type": "structure", "path": "structures/p.pdb", "source": "predicted"},
                 {"type": "pae", "path": "structures/p.pae.json"}],
        files={"structures/p.pdb": pdb_text, "structures/p.pae.json": json.dumps(pae)},
    )
    client.post("/api/experiments/reindex")
    row = structures(client)[0]
    r = client.get(f"/api/structures/{row['id']}/pae")
    assert r.status_code == 200
    assert r.json()["size"] == n


def test_reindex_is_idempotent(client, pdb_text):
    """reindex runs on every startup; it must not grow the table each time."""
    write_experiment(
        client, "exp-idem",
        outputs=[{"type": "structure", "path": "structures/i.pdb", "source": "predicted"}],
        files={"structures/i.pdb": pdb_text},
    )
    client.post("/api/experiments/reindex")
    first = [r["id"] for r in structures(client)]
    for _ in range(3):
        client.post("/api/experiments/reindex")
    assert [r["id"] for r in structures(client)] == first


def test_a_missing_file_is_reported_without_losing_the_experiment(client):
    """A broken output must not stop the experiment itself from being indexed."""
    write_experiment(client, "exp-missing",
                     outputs=[{"type": "structure", "path": "structures/gone.pdb"}])
    body = client.post("/api/experiments/reindex").json()
    assert "exp-missing" in body["imported"]
    assert any("gone.pdb" in e["path"] for e in body["errors"])
    assert structures(client) == []


def test_output_paths_cannot_escape_the_data_directory(client, pdb_text):
    """/etc/passwd exists, so an empty table alone would not prove much: the
    path must be refused while resolving, before anything reads the file."""
    write_experiment(client, "exp-escape",
                     outputs=[{"type": "structure", "path": "../../../../etc/passwd",
                               "source": "predicted"}])
    body = client.post("/api/experiments/reindex").json()
    assert structures(client) == []
    assert [e["error"] for e in body["errors"]] == ["not_found under data/"]


def test_non_structure_outputs_are_left_alone(client):
    write_experiment(client, "exp-seqs", outputs=["sequences/design_0.fa"],
                     files={"sequences/design_0.fa": ">a\nMKV\n"})
    body = client.post("/api/experiments/reindex").json()
    assert body["errors"] == []
    assert structures(client) == []
