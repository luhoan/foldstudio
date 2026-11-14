#!/usr/bin/env python3
"""Write what the backend REALLY returns into frontend/src/api/__fixtures__/.

    python3 scripts/export_api_fixtures.py            # regenerate the fixtures
    python3 scripts/export_api_fixtures.py --check    # exit 1 if the committed ones are stale

Why this exists: the frontend's types and test mocks were written from the
contract document while the backend was written separately, and they drifted
apart on nearly every endpoint (per_residue vs residues, resseq vs seq_id,
ids vs experiment_ids, a report that came back as HTML where JSON was expected,
an /explain route that was never mounted). Every frontend test passed, because
each one mocked the API with the shape the frontend expected.

The fixtures written here are captured from the real FastAPI app, so the
frontend's tests and its mock mode run against real response shapes. The
backend suite runs this script in --check mode (backend/tests/
test_frontend_fixtures.py): change a response and that test fails until the
fixtures are regenerated, at which point the frontend's own tests show what
has to change.

Everything in the dataset is SYNTHETIC: an idealised helix with made-up
B-factors, a made-up PAE matrix and experiment records that say so in their
provenance. It is test data for response SHAPES, not a structure, a model or a
run, and it must never be presented as one.
"""
from __future__ import annotations

import argparse
import itertools
import json
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))

OUT = REPO / "frontend" / "src" / "api" / "__fixtures__"
FIXED_TIME = "2026-01-01T00:00:00Z"
SYNTHETIC = "Synthetic fixture for frontend tests. Not a real structure, model or run."

# Twelve residues whose pLDDT values include every band boundary (90, 70, 50),
# so the frontend can be checked against the backend's own banding.
PLDDT = [95.0, 92.0, 90.0, 85.0, 75.0, 70.0, 65.0, 55.0, 50.0, 45.0, 30.0, 20.0]
AA = ["MET", "LYS", "VAL", "LEU", "ALA", "GLU", "ILE", "THR", "ASP", "PHE", "SER", "ARG"]


def helix(n: int, shift=(0.0, 0.0, 0.0)):
    import math
    return [(2.3 * math.cos(math.radians(100.0 * i)) + shift[0],
             2.3 * math.sin(math.radians(100.0 * i)) + shift[1],
             1.5 * i + shift[2]) for i in range(n)]


def pdb(coords, chain="A", resnames=None, bfactors=None, start=1, end=True) -> str:
    lines = []
    for i, (x, y, z) in enumerate(coords):
        rn = (resnames or AA)[i % len(resnames or AA)]
        b = bfactors[i] if bfactors else 10.0
        lines.append(f"ATOM  {i + 1:5d}  CA  {rn} {chain}{start + i:4d}    {x:8.3f}{y:8.3f}{z:8.3f}"
                     f"  1.00{b:6.2f}           C")
    return "\n".join(lines) + ("\nEND\n" if end else "\n")


def pae_matrix(n: int) -> list[list[float]]:
    return [[0.0 if i == j else round(1.5 + 0.75 * abs(i - j), 2) for j in range(n)] for i in range(n)]


def experiment(eid: str, **over) -> dict:
    base = {
        "id": eid, "created_at": FIXED_TIME, "kind": "imported", "status": "ok",
        "model_name": "none (synthetic fixture)", "model_version": "n/a",
        "settings": {}, "inputs": [], "outputs": [], "metrics": {}, "error": None,
        "provenance": {"source": "fixture", "retrieved_at": FIXED_TIME, "url": None, "notes": SYNTHETIC},
    }
    base.update(over)
    return base


def fetch_script():
    """scripts/fetch_demo_data.py, so fixture metrics come from the producer's own code."""
    sys.path.insert(0, str(REPO / "scripts"))
    import fetch_demo_data
    return fetch_demo_data


def build_data_dir(data: Path) -> None:
    """Lay bundles out exactly the way the two real producers do."""
    n = len(PLDDT)
    structures = data / "structures"
    structures.mkdir(parents=True)

    # --- shaped like scripts/fetch_demo_data.py: dict outputs, paths relative to data/ ---
    (structures / "fixture-predicted.pdb").write_text(pdb(helix(n), bfactors=PLDDT))
    (structures / "fixture-predicted.pae.json").write_text(json.dumps(
        [{"predicted_aligned_error": pae_matrix(n), "max_predicted_aligned_error": 31.75}]))
    two_chain = (pdb(helix(n), chain="A", end=False)
                 + pdb(helix(n, shift=(4.0, 0.0, 0.0)), chain="B", start=101))
    (structures / "fixture-complex.pdb").write_text(two_chain)

    def write(exp: dict) -> None:
        d = data / "experiments" / exp["id"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "experiment.json").write_text(json.dumps(exp, indent=2))

    write(experiment(
        "imported-fixture-predicted",
        model_name="AlphaFold DB (precomputed)", model_version="4", inputs=["fixture-predicted"],
        outputs=[{"type": "structure", "path": "structures/fixture-predicted.pdb", "sha256": "0" * 64,
                  "source": "predicted", "label": "Fixture model (synthetic, with PAE)"},
                 {"type": "pae", "path": "structures/fixture-predicted.pae.json", "sha256": "0" * 64}],
        metrics={"n_residues": n, "n_chains": 1,
                 "mean_plddt_ca": fetch_script().mean_plddt_from_bfactor(
                     fetch_script().parse_pdb(pdb(helix(n), bfactors=PLDDT)))},
        entry={"label": "Fixture model (synthetic, with PAE)", "reason": SYNTHETIC,
               "title_from_entry": "Synthetic twelve-residue helix"},
    ))
    write(experiment(
        "imported-fixture-complex",
        inputs=["fixture-complex"],
        outputs=[{"type": "structure", "path": "structures/fixture-complex.pdb", "sha256": "0" * 64,
                  "source": "experimental", "label": "Fixture complex (synthetic, two chains)"}],
        # a list-valued metric, computed by the real fetch script's own function
        metrics={"n_residues": 2 * n, "n_chains": 2,
                 "interfaces": fetch_script().interface_contacts(
                     fetch_script().parse_pdb(two_chain), fetch_script().CONTACT_CUTOFF)},
        entry={"label": "Fixture complex (synthetic, two chains)", "reason": SYNTHETIC,
               "title_from_entry": "Synthetic two-chain arrangement",
               "chain_descriptions_from_entry": {"A": "Synthetic chain A", "B": "Synthetic chain B"}},
    ))

    # --- shaped like hpc/export_bundle.py: string outputs relative to the bundle directory ---
    run = data / "experiments" / "hpc_fixture_run"
    (run / "structures").mkdir(parents=True)
    (run / "sequences").mkdir()
    (run / "structures" / "design_0.pdb").write_text(pdb(helix(n), resnames=["GLY"]))
    (run / "structures" / "design_0_s1.pdb").write_text(pdb(helix(n), bfactors=PLDDT))
    (run / "structures" / "design_0_s1.pae.json").write_text(json.dumps(
        {"predicted_aligned_error": pae_matrix(n), "max_predicted_aligned_error": 31.75}))
    (run / "sequences" / "design_0.fa").write_text(">design_0, score=1.0\nGGGGGGGGGGGG\n>T=0.1, sample=1, score=0.9\nMKVLAEITDFSR\n")
    write(experiment(
        "hpc_fixture_run", kind="executed", status="partial",
        model_name="RFdiffusion + ProteinMPNN + ESMFold", model_version="fixture",
        settings={"contig": "12-12", "num_designs": 1, "seed": 37},
        outputs=["structures/design_0.pdb", "sequences/design_0.fa",
                 "structures/design_0_s1.pdb", "structures/design_0_s1.pae.json"],
        metrics={"n_backbones": 1, "n_sequences_designed": 1, "n_predicted_structures": 1,
                 "predicted_best_mean_plddt": round(sum(PLDDT) / n, 2),
                 "self_consistency_ca_rmsd_best": 0.0, "mpnn_best_score": 0.9,
                 "mpnn_model_name": "v_48_020"},
        error="Synthetic fixture: one stage is shown as failed so the UI's failure path is exercised.",
        metrics_unavailable={"predicted_mean_ptm": "the predictor did not return a pTM value"},
        metric_definitions={
            "self_consistency_ca_rmsd_best": "Lowest CA RMSD between a predicted structure and the backbone it was designed for, after optimal superposition.",
            "predicted_best_mean_plddt": "Highest mean pLDDT among the predicted structures of designed sequences.",
            "mpnn_best_score": "Lowest ProteinMPNN score= value among designed sequences; lower is better.",
        },
        structure_sources={"design_0.pdb": "uploaded", "design_0_s1.pdb": "predicted"},
        structure_labels={"design_0.pdb": "design_0 (RFdiffusion backbone; no sequence, no confidence)",
                          "design_0_s1.pdb": "design_0_s1 (predicted structure)"},
        workflow=[
            {"stage": "Structure", "status": "not_started", "status_label": "not started", "error": None,
             "outputs": 0, "wall_seconds": None, "preemptions": 0, "ledger_stage": None,
             "note": "No input structure: this is de novo design, so the backbone is generated rather than supplied."},
            {"stage": "Backbone generation", "status": "executed", "status_label": "executed", "error": None,
             "outputs": 1, "wall_seconds": 70.4, "preemptions": 0, "ledger_stage": "rfdiffusion", "note": None},
            {"stage": "Sequence design", "status": "executed", "status_label": "executed", "error": None,
             "outputs": 1, "wall_seconds": 4.3, "preemptions": 1, "ledger_stage": "proteinmpnn", "note": None},
            {"stage": "Structure prediction", "status": "failed", "status_label": "failed",
             "error": "Synthetic fixture: stage marked failed for the failure-path test.",
             "outputs": 1, "wall_seconds": 12.0, "preemptions": 0, "ledger_stage": "predict_esmfold", "note": None},
            {"stage": "Evaluation", "status": "partial", "status_label": "partial", "error": None,
             "outputs": 0, "wall_seconds": None, "preemptions": 0, "ledger_stage": "export_bundle",
             "note": "Some metrics were measured and one was not."},
            {"stage": "Candidate review", "status": "not_started", "status_label": "not started", "error": None,
             "outputs": 0, "wall_seconds": None, "preemptions": 0, "ledger_stage": None,
             "note": "Review happens in the app, not in the pipeline."},
        ],
    ))


def capture() -> dict[str, object]:
    """Boot the real app on the synthetic data and record each response the frontend uses."""
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.services import (experiments as exp_svc, reports as report_svc,
                              structure_io as sio, structure_store)

    # Ids and timestamps are the only things that differ between two runs of the
    # real app, so they are pinned; everything else in a fixture is what the
    # backend computed.
    counter = itertools.count(1)
    originals = (structure_store.new_id, sio.now_iso, exp_svc.now_iso, report_svc.now_iso)
    structure_store.new_id = lambda: f"st_fixture{next(counter):02d}"
    sio.now_iso = exp_svc.now_iso = report_svc.now_iso = lambda: FIXED_TIME
    tmp = Path(tempfile.mkdtemp(prefix="fs-fixtures-"))
    try:
        data = tmp / "data"
        build_data_dir(data)
        with TestClient(create_app(data)) as c:
            def get(url, expect=200):
                r = c.get(url)
                assert r.status_code == expect, f"GET {url} -> {r.status_code}: {r.text[:300]}"
                return r.json()

            structures = get("/api/structures")
            by_label = {s["label"]: s for s in structures}
            predicted = by_label["Fixture model (synthetic, with PAE)"]["id"]
            complex_ = by_label["Fixture complex (synthetic, two chains)"]["id"]
            backbone = by_label["design_0 (RFdiffusion backbone; no sequence, no confidence)"]["id"]
            design = by_label["design_0_s1 (predicted structure)"]["id"]

            align = c.post("/api/analysis/align", json={
                "mobile_id": design, "reference_id": backbone, "selection": {"method": "auto"}})
            assert align.status_code == 200, align.text
            compare = c.post("/api/experiments/compare", json={
                "ids": ["imported-fixture-predicted", "hpc_fixture_run"]})
            assert compare.status_code == 200, compare.text
            upload = c.post("/api/structures/upload",
                            files={"file": ("uploaded.pdb", pdb(helix(6)).encode(), "text/plain")},
                            data={"label": "Uploaded fixture (synthetic)", "source": "uploaded"})
            assert upload.status_code == 201, upload.text

            health = get("/api/health")
            health["data_dir"] = "<data-dir>"

            return {
                "structures": structures,
                "residues": get(f"/api/structures/{predicted}/residues"),
                "plddt": get(f"/api/structures/{predicted}/plddt"),
                "plddt_refused": get(f"/api/structures/{complex_}/plddt", expect=409),
                "pae": get(f"/api/structures/{predicted}/pae"),
                "pae_unavailable": get(f"/api/structures/{complex_}/pae", expect=404),
                "interfaces": get(f"/api/structures/{complex_}/interfaces"),
                "explain_predicted": get(f"/api/explain?structure={predicted}"),
                "explain_residue": get(f"/api/explain?structure={predicted}&chain=A&start=3&end=3"),
                "explain_experimental": get(f"/api/explain?structure={complex_}&chain=A"),
                "explain_uploaded": get(f"/api/explain?structure={backbone}"),
                "align": align.json(),
                "experiments": get("/api/experiments"),
                "compare": compare.json(),
                "report": get("/api/reports?ids=hpc_fixture_run&format=json"),
                "upload": upload.json(),
                "health": health,
            }
    finally:
        structure_store.new_id, sio.now_iso, exp_svc.now_iso, report_svc.now_iso = originals
        shutil.rmtree(tmp, ignore_errors=True)


def render(payload: object) -> str:
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true",
                    help="compare with the committed fixtures instead of writing; exit 1 if they differ")
    args = ap.parse_args(argv)

    fixtures = {f"{name}.json": render(body) for name, body in capture().items()}
    if args.check:
        stale = [n for n, text in fixtures.items()
                 if not (OUT / n).is_file() or (OUT / n).read_text() != text]
        extra = sorted(p.name for p in OUT.glob("*.json") if p.name not in fixtures)
        if stale or extra:
            print("frontend API fixtures are out of date with the backend:")
            for n in stale:
                print(f"  changed or missing: {n}")
            for n in extra:
                print(f"  no longer produced:  {n}")
            print("\nRegenerate them with:  python3 scripts/export_api_fixtures.py\n"
                  "then run the frontend tests (cd frontend && npm test): they run against these\n"
                  "files and will show what the UI has to change.")
            return 1
        print(f"{len(fixtures)} fixtures match what the backend returns")
        return 0

    OUT.mkdir(parents=True, exist_ok=True)
    for stale_file in OUT.glob("*.json"):
        if stale_file.name not in fixtures:
            stale_file.unlink()
    for n, text in fixtures.items():
        (OUT / n).write_text(text)
    print(f"wrote {len(fixtures)} fixtures to {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
