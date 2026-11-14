import json

import pytest

from tests.conftest import helix, make_pdb, upload


def exp(**over):
    base = {
        "kind": "imported",
        "status": "ok",
        "model_name": "AlphaFold DB",
        "model_version": "v4",
        "settings": {"seed": 1},
        "inputs": [],
        "outputs": [],
        "metrics": {"plddt_mean": 91.2},
        "error": None,
        "provenance": {"source": "AlphaFold DB", "retrieved_at": "2026-11-13T00:00:00+00:00", "url": "https://alphafold.ebi.ac.uk/", "notes": "n"},
    }
    base.update(over)
    return base


def post(client, **over):
    return client.post("/api/experiments", json=exp(**over))


# ------------------------------------------------------------ registry
def test_create_get_list_filter(client):
    r = post(client, id="e1")
    assert r.status_code == 201 and r.json()["id"] == "e1" and r.json()["created_at"]
    auto = post(client, kind="demo", id=None).json()
    assert auto["id"].startswith("exp_")
    assert client.get("/api/experiments/e1").json()["model_name"] == "AlphaFold DB"
    assert {e["id"] for e in client.get("/api/experiments").json()} == {"e1", auto["id"]}
    assert [e["id"] for e in client.get("/api/experiments?kind=demo").json()] == [auto["id"]]
    assert client.get("/api/experiments/missing").status_code == 404


def test_duplicate_id_conflict(client):
    assert post(client, id="dup").status_code == 201
    assert post(client, id="dup").status_code == 409


@pytest.mark.parametrize(
    "over,frag",
    [
        ({"kind": "magic"}, "kind"),
        ({"status": "pending"}, "status"),
        ({"status": "failed", "error": None}, "real error message"),
        ({"status": "failed", "error": "  "}, "real error message"),
        ({"kind": "executed", "status": "ok", "outputs": []}, "must list its output files"),
        ({"id": "bad id/../x"}, "letters, digits"),
        ({"provenance": None}, "provenance"),
        ({"model_name": None}, "model_name"),
    ],
)
def test_experiment_integrity_rules(client, over, frag):
    r = post(client, **over)
    assert r.status_code == 422 and frag in r.json()["detail"]


def test_failed_run_with_error_is_stored_verbatim(client):
    r = post(client, id="bad", kind="executed", status="failed", error="CUDA out of memory at step 3", outputs=[])
    assert r.status_code == 201 and client.get("/api/experiments/bad").json()["error"] == "CUDA out of memory at step 3"


def test_compare_shows_differences(client):
    post(client, id="a", settings={"seed": 1, "steps": 10}, metrics={"plddt_mean": 91.2, "rmsd": 1.1})
    post(client, id="b", settings={"seed": 2, "steps": 10}, metrics={"plddt_mean": 78.0}, model_version="v3")
    c = client.post("/api/experiments/compare", json={"ids": ["a", "b"]}).json()
    fields = {f["field"]: f for f in c["fields"]}
    assert fields["model_version"]["differs"] and not fields["model_name"]["differs"]
    st = {s["field"]: s for s in c["settings"]}
    assert st["seed"]["differs"] and not st["steps"]["differs"]
    mt = {m["field"]: m for m in c["metrics"]}
    assert mt["plddt_mean"]["values"] == {"a": 91.2, "b": 78.0} and mt["rmsd"]["values"]["b"] is None and mt["rmsd"]["differs"]


def test_compare_validation(client):
    post(client, id="a")
    assert client.post("/api/experiments/compare", json={"ids": ["a"]}).status_code == 400
    assert client.post("/api/experiments/compare", json={"ids": ["a", "a"]}).status_code == 400
    assert client.post("/api/experiments/compare", json={"ids": ["a", "zzz"]}).status_code == 404


def test_reindex_loads_bundles_and_reports_bad_ones(client):
    d = client.ctx.experiments_dir
    (d / "good").mkdir()
    (d / "good" / "experiment.json").write_text(json.dumps(exp()))
    (d / "broken").mkdir()
    (d / "broken" / "experiment.json").write_text("{not json")
    (d / "invalid").mkdir()
    (d / "invalid" / "experiment.json").write_text(json.dumps(exp(kind="executed", outputs=[])))
    (d / "empty_dir").mkdir()
    r = client.post("/api/experiments/reindex").json()
    assert r["imported"] == ["good"] and {e["path"] for e in r["errors"]} == {"experiments/broken/experiment.json", "experiments/invalid/experiment.json"}
    assert client.get("/api/experiments/good").status_code == 200
    assert client.post("/api/experiments/reindex").json()["imported"] == ["good"]  # idempotent


# ------------------------------------------------------------ reports
def test_report_markdown_html_json(client):
    sid = upload(client, make_pdb(helix(5)), "a.pdb", source="predicted").json()
    post(client, id="e1", inputs=[sid["id"]], kind="executed", outputs=["out/model.pdb"], settings={"seed": 7})
    post(client, id="e2", metrics={"plddt_mean": 70.0})
    md = client.get("/api/reports?ids=e1,e2&format=markdown")
    assert md.status_code == 200 and md.headers["content-type"].startswith("text/markdown")
    t = md.text
    for frag in ["## e1 (Executed", "## e2 (Imported", "seed", "sha256 " + sid["sha256"], "## Comparison", "## Limitations", "does not replace experimental validation", "Provenance source: AlphaFold DB"]:
        assert frag in t, frag
    h = client.get("/api/reports?ids=e1").text
    assert h.startswith("<!doctype html>") and "<h2>e1" in h and "Executed" in h and "Comparison" not in h
    j = client.get("/api/reports?ids=e1,e2&format=json").json()
    assert set(j) == {"generated_at", "markdown", "html"}


def test_report_escapes_html(client):
    post(client, id="xss", model_name="<script>alert(1)</script>", provenance={"source": "<img src=x onerror=1>", "notes": "a|b"})
    h = client.get("/api/reports?ids=xss").text
    assert "<script>alert" not in h and "&lt;script&gt;" in h and "<img src=x" not in h


def test_report_errors(client):
    post(client, id="a")
    assert client.get("/api/reports?ids=nope").status_code == 404
    assert client.get("/api/reports?ids=").status_code == 400
    assert client.get("/api/reports?ids=a,a").status_code == 400
    assert client.get("/api/reports").status_code == 422


def test_report_failed_run_shows_error(client):
    post(client, id="f", kind="executed", status="failed", error="CUDA OOM")
    assert "Error: CUDA OOM" in client.get("/api/reports?ids=f&format=markdown").text


# ------------------------------------------------------------ jobs
def test_jobs_501_without_runner(client):
    r = client.post("/api/jobs", json={"spec": {}})
    assert r.status_code == 501 and r.json() == {"detail": "no_runner"}


def test_stub_runners_cannot_register():
    from app.errors import AppError
    from app.jobs.base import RunnerRegistry
    from app.jobs.runners import LocalRunner, RemoteRunner

    reg = RunnerRegistry()
    for r in (LocalRunner(), RemoteRunner()):
        with pytest.raises(AppError) as e:
            reg.register(r)
        assert e.value.status == 501
    assert reg.names() == []


def test_precomputed_runner_when_registered(client):
    from app.jobs.runners import PrecomputedRunner

    client.app_.state.runners.register(PrecomputedRunner())
    post(client, id="pre", kind="imported")
    r = client.post("/api/jobs", json={"spec": {"experiment_id": "pre"}})
    assert r.status_code == 202
    j = r.json()
    assert j["status"] == "completed" and j["result_kind"] == "imported" and "No computation was performed" in j["note"]
    assert client.post("/api/jobs", json={"spec": {}}).status_code == 400
    assert client.post("/api/jobs", json={"runner": "gpu", "spec": {}}).status_code == 400
    assert client.post("/api/jobs", json={"spec": {"experiment_id": "ghost"}}).status_code == 404


# ------------------------------------------------------------ misc
def test_cors_and_health(client):
    r = client.options("/api/health", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert client.get("/api/health").json()["status"] == "ok"
    bad = client.options("/api/health", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers


def test_register_local_file(client):
    (client.ctx.structures_dir / "demo.pdb").write_text(make_pdb(helix(8)))
    r = client.post("/api/structures/register", json={"path": "demo.pdb", "label": "demo", "source": "experimental", "origin_id": "TEST"})
    assert r.status_code == 201 and r.json()["n_residues"] == 8
    for evil in ("../foldstudio.db", "../../etc/passwd", "/etc/passwd"):
        r = client.post("/api/structures/register", json={"path": evil, "label": "x", "source": "uploaded"})
        assert r.status_code == 400 and "invalid_path" in r.json()["detail"], evil
    (client.ctx.pae_dir / "ok.json").write_text("[]")
    r = client.post("/api/structures/register", json={"path": "demo.pdb", "label": "x", "source": "uploaded", "pae_path": "../foldstudio.db"})
    assert r.status_code == 400 and "invalid_path" in r.json()["detail"]
    assert client.post("/api/structures/register", json={"path": "missing.pdb", "label": "x", "source": "uploaded"}).status_code == 404


# ---- reports: what a pipeline bundle carries beyond the core fields

def _pipeline_experiment(**over):
    body = {
        "id": "hpc_run", "kind": "executed", "status": "partial", "model_name": "RFdiffusion + ProteinMPNN + ESMFold",
        "outputs": ["structures/design_0.pdb"], "error": "predict stage died",
        "metrics": {"n_backbones": 1, "mpnn_best_score": 0.8221},
        "metric_definitions": {"mpnn_best_score": "Lowest ProteinMPNN score= value; lower is better."},
        "metrics_unavailable": {"self_consistency_ca_rmsd_best": "the prediction stage produced no output"},
        "workflow": [
            {"stage": "Backbone generation", "status": "executed", "status_label": "executed",
             "wall_seconds": 70.381, "outputs": 1, "preemptions": 0, "error": None, "note": None},
            {"stage": "Structure prediction", "status": "failed", "status_label": "failed",
             "wall_seconds": None, "outputs": 0, "preemptions": 2, "error": "CUDA out of memory", "note": None},
        ],
        "provenance": {"source": "FoldStudio HPC pipeline"},
    }
    body.update(over)
    return body


def test_report_lists_metrics_that_were_not_measured(client):
    client.post("/api/experiments", json=_pipeline_experiment())
    md = client.get("/api/reports?ids=hpc_run&format=markdown").text
    assert "### Metrics not measured" in md
    assert "self_consistency_ca_rmsd_best: the prediction stage produced no output" in md
    assert "They are not zero; they are absent." in md
    html_ = client.get("/api/reports?ids=hpc_run&format=html").text
    assert "Metrics not measured" in html_ and "the prediction stage produced no output" in html_


def test_report_shows_each_pipeline_stage_with_its_real_outcome(client):
    client.post("/api/experiments", json=_pipeline_experiment())
    md = client.get("/api/reports?ids=hpc_run&format=markdown").text
    assert "| Backbone generation | executed | 70.381 s | 1 | 0 |  |" in md
    assert "| Structure prediction | failed | not recorded | 0 | 2 | CUDA out of memory |" in md
    html_ = client.get("/api/reports?ids=hpc_run&format=html").text
    assert "<td>Structure prediction</td><td>failed</td>" in html_
    assert "CUDA out of memory" in html_


def test_report_puts_the_definition_next_to_the_metric(client):
    client.post("/api/experiments", json=_pipeline_experiment())
    md = client.get("/api/reports?ids=hpc_run&format=markdown").text
    assert "- mpnn_best_score: 0.8221 (Lowest ProteinMPNN score= value; lower is better.)" in md
    assert "- n_backbones: 1\n" in md, "a metric without a definition is printed bare"


def test_report_without_the_optional_blocks_is_unchanged(client):
    client.post("/api/experiments", json={"id": "plain", "kind": "demo", "status": "ok", "model_name": "m",
                                          "provenance": {"source": "s"}})
    md = client.get("/api/reports?ids=plain&format=markdown").text
    assert "Metrics not measured" not in md and "Pipeline stages" not in md


def test_report_escapes_pipeline_text_in_html(client):
    evil = "<script>alert(1)</script>"
    client.post("/api/experiments", json=_pipeline_experiment(
        metrics_unavailable={"x": evil},
        workflow=[{"stage": evil, "status_label": evil, "error": evil}],
        metric_definitions={"n_backbones": evil}))
    html_ = client.get("/api/reports?ids=hpc_run&format=html").text
    assert "<script>" not in html_
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html_


def test_report_tolerates_malformed_optional_blocks(client):
    """extra='allow' means anything can arrive in these fields; a report must still render."""
    client.post("/api/experiments", json=_pipeline_experiment(
        metrics_unavailable=["not", "a", "dict"], workflow="nope", metric_definitions=7))
    r = client.get("/api/reports?ids=hpc_run&format=json")
    assert r.status_code == 200
    assert "Metrics not measured" not in r.json()["markdown"]
