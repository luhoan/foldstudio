"""Reindex keeps the registry in step with the bundles on disk.

Three things used to go quietly wrong once a bundle had been seen once:

* A structure first registered as "uploaded" (its bundle did not yet declare a
  source) stayed "uploaded" for good, so /plddt kept refusing a real predicted
  model after the bundle was corrected. This happened for real: the dev server
  auto-reloaded on `git pull` and indexed the old experiment.json files a moment
  before the data was re-fetched with sources declared.
* A re-exported bundle kept the residue counts and PAE of the export before it.
* A bundle deleted from disk stayed in the app until the database was deleted.

Coordinates are the synthetic helix from conftest, not a real protein.
"""
import json
import shutil

import pytest

from .conftest import helix, make_pdb


def bundle(client, eid, outputs, *, files=None, dirname=None, **extra):
    ctx = client.ctx
    d = ctx.experiments_dir / (dirname or eid)
    d.mkdir(parents=True, exist_ok=True)
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
        **extra,
    }
    (d / "experiment.json").write_text(json.dumps(payload))
    return d


def pae_json(n):
    return json.dumps({"predicted_aligned_error": [[1.0] * n for _ in range(n)],
                       "max_predicted_aligned_error": 31.75})


def reindex(client):
    return client.post("/api/experiments/reindex").json()


def structures(client):
    return client.get("/api/structures").json()


@pytest.fixture()
def pdb30():
    return make_pdb(helix(30), bfactors=[88.0] * 30)


# ------------------------------------------------------------------ labels

def test_label_from_the_output_entry(client, pdb30):
    bundle(client, "e", [{"type": "structure", "path": "structures/a.pdb", "label": "Crambin"}],
           files={"structures/a.pdb": pdb30})
    reindex(client)
    assert structures(client)[0]["label"] == "Crambin"


def test_label_from_the_structure_labels_map(client, pdb30):
    bundle(client, "e", ["structures/a.pdb"], files={"structures/a.pdb": pdb30},
           structure_labels={"a.pdb": "design_0 (RFdiffusion backbone)"})
    reindex(client)
    assert structures(client)[0]["label"] == "design_0 (RFdiffusion backbone)"


def test_default_label_names_the_file_and_the_experiment(client, pdb30):
    bundle(client, "e", ["structures/a.pdb"], files={"structures/a.pdb": pdb30})
    reindex(client)
    assert structures(client)[0]["label"] == "a.pdb (e)"


def test_provenance_names_the_experiment(client, pdb30):
    bundle(client, "exp-1", ["structures/a.pdb"], files={"structures/a.pdb": pdb30})
    reindex(client)
    assert structures(client)[0]["provenance"]["experiment_id"] == "exp-1"


# ------------------------------------------------------------- refresh in place

def test_source_declared_later_is_picked_up_and_plddt_starts_working(client, pdb30):
    """The real failure: registered 'uploaded', then the bundle said 'predicted'."""
    bundle(client, "e", [{"type": "structure", "path": "structures/a.pdb"}],
           files={"structures/a.pdb": pdb30})
    reindex(client)
    before = structures(client)[0]
    assert before["source"] == "uploaded"
    assert client.get(f"/api/structures/{before['id']}/plddt").status_code == 409

    bundle(client, "e", [{"type": "structure", "path": "structures/a.pdb", "source": "predicted"}])
    report = reindex(client)
    after = structures(client)
    assert len(after) == 1, "refreshed in place, not registered a second time"
    assert after[0]["id"] == before["id"], "the structure id is stable across a refresh"
    assert after[0]["source"] == "predicted"
    assert report["structures_updated"] == [before["id"]]
    assert client.get(f"/api/structures/{before['id']}/plddt").status_code == 200


def test_a_predicted_structure_can_be_downgraded_too(client, pdb30):
    """If a bundle stops vouching for a file, confidence must stop being reported."""
    bundle(client, "e", [{"type": "structure", "path": "structures/a.pdb", "source": "predicted"}],
           files={"structures/a.pdb": pdb30})
    reindex(client)
    sid = structures(client)[0]["id"]
    bundle(client, "e", [{"type": "structure", "path": "structures/a.pdb"}])
    reindex(client)
    assert structures(client)[0]["source"] == "uploaded"
    assert client.get(f"/api/structures/{sid}/plddt").status_code == 409


def test_changed_file_updates_residue_count_and_hash(client, pdb30):
    bundle(client, "e", ["structures/a.pdb"], files={"structures/a.pdb": pdb30})
    reindex(client)
    before = structures(client)[0]
    (client.ctx.data_dir / "structures" / "a.pdb").write_text(make_pdb(helix(42)))
    reindex(client)
    after = structures(client)[0]
    assert after["id"] == before["id"]
    assert (before["n_residues"], after["n_residues"]) == (30, 42)
    assert after["sha256"] != before["sha256"]
    assert "Refreshed" in after["provenance"]["notes"]


def test_unchanged_bundle_is_left_alone(client, pdb30):
    bundle(client, "e", ["structures/a.pdb"], files={"structures/a.pdb": pdb30})
    reindex(client)
    report = reindex(client)
    assert report["structures_registered"] == [] and report["structures_updated"] == []


# ------------------------------------------------------------------------ PAE

def test_pae_added_later_is_attached(client, pdb30):
    out = [{"type": "structure", "path": "structures/a.pdb", "source": "predicted"}]
    bundle(client, "e", out, files={"structures/a.pdb": pdb30})
    reindex(client)
    sid = structures(client)[0]["id"]
    assert client.get(f"/api/structures/{sid}/pae").status_code == 404

    bundle(client, "e", out + [{"type": "pae", "path": "structures/a.pae.json"}],
           files={"structures/a.pae.json": pae_json(30)})
    reindex(client)
    assert client.get(f"/api/structures/{sid}/pae").json()["size"] == 30


def test_pae_removed_from_the_bundle_is_detached(client, pdb30):
    out = [{"type": "structure", "path": "structures/a.pdb", "source": "predicted"}]
    bundle(client, "e", out + [{"type": "pae", "path": "structures/a.pae.json"}],
           files={"structures/a.pdb": pdb30, "structures/a.pae.json": pae_json(30)})
    reindex(client)
    sid = structures(client)[0]["id"]
    assert client.get(f"/api/structures/{sid}/pae").status_code == 200
    bundle(client, "e", out)
    reindex(client)
    assert client.get(f"/api/structures/{sid}/pae").status_code == 404
    assert structures(client)[0]["has_pae"] is False


def test_pae_of_the_wrong_size_is_reported_and_not_attached(client, pdb30):
    """A sidecar from a different model must not be drawn as if it were this one's."""
    bundle(client, "e", [{"type": "structure", "path": "structures/a.pdb", "source": "predicted"},
                         {"type": "pae", "path": "structures/a.pae.json"}],
           files={"structures/a.pdb": pdb30, "structures/a.pae.json": pae_json(12)})
    report = reindex(client)
    rows = structures(client)
    assert len(rows) == 1 and rows[0]["has_pae"] is False
    assert any("pae_mismatch" in e["error"] for e in report["errors"])


def test_register_endpoint_refuses_a_mismatched_pae(client, pdb30):
    ctx = client.ctx
    (ctx.structures_dir / "r.pdb").write_text(pdb30)
    (ctx.pae_dir / "r.json").write_text(pae_json(7))
    r = client.post("/api/structures/register", json={
        "path": "r.pdb", "label": "r", "source": "predicted", "pae_path": "r.json"})
    assert r.status_code == 409 and "pae_mismatch" in r.json()["detail"]


# -------------------------------------------------------------------- pruning

def test_bundle_removed_from_disk_disappears_with_its_structures(client, pdb30):
    d = bundle(client, "gone", ["structures/a.pdb"], files={"structures/a.pdb": pdb30})
    bundle(client, "kept", ["structures/b.pdb"], files={"structures/b.pdb": pdb30})
    reindex(client)
    assert {e["id"] for e in client.get("/api/experiments").json()} == {"gone", "kept"}

    shutil.rmtree(d)
    report = reindex(client)
    assert report["removed"] == ["gone"]
    assert {e["id"] for e in client.get("/api/experiments").json()} == {"kept"}
    assert [s["origin_id"] for s in structures(client)] == ["kept:b.pdb"]
    assert (client.ctx.data_dir / "structures" / "a.pdb").exists(), "files are never deleted"


def test_records_created_through_the_api_are_never_pruned(client):
    body = {"id": "by-hand", "kind": "demo", "status": "ok", "model_name": "m",
            "provenance": {"source": "typed in"}}
    assert client.post("/api/experiments", json=body).status_code == 201
    reindex(client)
    assert [e["id"] for e in client.get("/api/experiments").json()] == ["by-hand"]


def test_a_bundle_that_stops_loading_is_kept_not_pruned(client, pdb30):
    """Broken is not the same as deleted: keep the last good record and say why."""
    d = bundle(client, "e", ["structures/a.pdb"], files={"structures/a.pdb": pdb30})
    reindex(client)
    (d / "experiment.json").write_text("{ not json")
    report = reindex(client)
    assert report["removed"] == []
    assert [e["id"] for e in client.get("/api/experiments").json()] == ["e"]
    assert any("experiment.json" in e["path"] for e in report["errors"])


def test_pruning_does_not_treat_underscores_as_wildcards(client, pdb30):
    """'_' is a LIKE wildcard; ids such as hpc_2026... are full of them."""
    d = bundle(client, "hpc_a", ["structures/a.pdb"], files={"structures/a.pdb": pdb30})
    bundle(client, "hpcXa", ["structures/b.pdb"], files={"structures/b.pdb": pdb30})
    reindex(client)
    shutil.rmtree(d)
    reindex(client)
    assert [s["origin_id"] for s in structures(client)] == ["hpcXa:b.pdb"]


# ---------------------------------------------------------------- bookkeeping

def test_record_says_which_bundle_it_came_from(client, pdb30):
    bundle(client, "e", ["structures/a.pdb"], files={"structures/a.pdb": pdb30})
    reindex(client)
    assert client.get("/api/experiments/e").json()["bundle"] == {"dir": "e", "path": "experiments/e"}


def test_id_different_from_the_directory_name_still_resolves_bundle_files(client, pdb30):
    bundle(client, "the-id", ["structures/in.pdb"], dirname="some-folder",
           files={"experiments/some-folder/structures/in.pdb": pdb30})
    report = reindex(client)
    assert report["errors"] == []
    assert [s["origin_id"] for s in structures(client)] == ["the-id:in.pdb"]


def test_health_reports_the_last_reindex(client, pdb30):
    bundle(client, "e", ["structures/missing.pdb"])
    reindex(client)
    health = client.get("/api/health").json()
    assert health["reindex"]["imported"] == ["e"]
    assert health["reindex"]["errors"][0]["path"] == "e/structures/missing.pdb"
    assert health["reindex"]["at"]


def test_startup_reindex_is_reported_too(tmp_path, pdb30):
    """Bundles present before the server starts are indexed without any request."""
    from fastapi.testclient import TestClient
    from app.main import create_app

    data = tmp_path / "data"
    (data / "experiments" / "boot").mkdir(parents=True)
    (data / "structures").mkdir(parents=True)
    (data / "structures" / "a.pdb").write_text(pdb30)
    (data / "experiments" / "boot" / "experiment.json").write_text(json.dumps({
        "kind": "imported", "status": "ok", "model_name": "m",
        "outputs": [{"type": "structure", "path": "structures/a.pdb", "source": "predicted"}],
        "provenance": {"source": "test"}}))
    with TestClient(create_app(data)) as c:
        assert c.get("/api/health").json()["reindex"]["imported"] == ["boot"]
        assert [s["source"] for s in c.get("/api/structures").json()] == ["predicted"]
