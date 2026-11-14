#!/usr/bin/env python3
"""Tests for hpc/export_bundle.py and the parsers it depends on.

Run:  python -m unittest discover -s hpc/tests -p 'test_*.py' -v
  or: python hpc/tests/test_export_bundle.py

These run entirely offline against the real fixtures in hpc/tests/fixtures
(see that directory's PROVENANCE.md). Where a test needs Stream 1's actual
Experiment model it imports it from backend/ and skips cleanly if the backend's
dependencies are not installed.

Nothing here fabricates a model output. The one place a test needs "a prediction"
it instead applies a rigid rotation to real coordinates, which tests the RMSD
arithmetic without inventing any scientific value, and the result never reaches
a bundle.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

HPC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HPC)
sys.path.insert(0, HPC)
sys.path.insert(0, os.path.join(HPC, "lib"))

import export_bundle as eb  # noqa: E402
import ledger  # noqa: E402

FIXTURES = os.path.join(HPC, "tests", "fixtures")
BACKBONE = os.path.join(FIXTURES, "backbone_like_5L33_chainA.pdb")
MPNN_FA = os.path.join(FIXTURES, "proteinmpnn_5L33_example1.fa")


class Args:
    """Stand-in for argparse's namespace."""

    def __init__(self, **kw):
        self.work_dir = None
        self.data_dir = None
        self.experiment_id = None
        self.dry_run = False
        self.predicted = None
        self.no_copy_structures = False
        self.validate_only = None
        self.__dict__.update(kw)


def build_to(tmp: str, **kw) -> tuple[eb.Bundle, dict, dict]:
    args = Args(data_dir=tmp, **kw)
    b, exp, run = eb.build(args)
    eb.write_bundle(b, exp, run, copy_to_structures=not args.no_copy_structures)
    return b, exp, run


class TestFixtures(unittest.TestCase):
    def test_fixtures_present(self):
        self.assertTrue(os.path.exists(BACKBONE), "run hpc/tests/fixtures/fetch_fixtures.sh")
        self.assertTrue(os.path.exists(MPNN_FA), "run hpc/tests/fixtures/fetch_fixtures.sh")

    def test_backbone_fixture_is_marked_as_not_a_model_output(self):
        # The marker is what stops it being passed off as a prediction.
        with open(BACKBONE) as fh:
            self.assertIn("NOT A MODEL OUTPUT", fh.read(2000))


class TestProteinMPNNParsing(unittest.TestCase):
    """Parse a genuine ProteinMPNN output. The expected values below are read
    directly off the real headers in the fixture, not computed by this code."""

    @classmethod
    def setUpClass(cls):
        cls.info = eb.parse_mpnn_fasta(MPNN_FA)

    def test_input_record_separated_from_designs(self):
        self.assertIsNotNone(self.info["input"])
        self.assertEqual(len(self.info["designs"]), 2, "fixture has 1 input + 2 design records")

    def test_reads_upstreams_own_model_seed_and_githash(self):
        self.assertEqual(self.info["model_name"], "v_48_020")
        self.assertEqual(self.info["seed"], 37)
        self.assertEqual(self.info["git_hash"], "015ff820b9b5741ead6ba6795258f35a9c15e94b")

    def test_reads_real_per_design_scores(self):
        self.assertEqual([d["score"] for d in self.info["designs"]], [0.8221, 0.8356])
        self.assertEqual([d["seq_recovery"] for d in self.info["designs"]], [0.5094, 0.4434])
        self.assertEqual([d["sample"] for d in self.info["designs"]], ["1", "2"])

    def test_bracketed_header_fields_do_not_break_parsing(self):
        # The input header contains designed_chains=['A'], which a naive
        # comma-split would mangle.
        self.assertEqual(self.info["input"]["score"], 1.5874)

    def test_sequence_lengths_are_real(self):
        for d in self.info["designs"]:
            self.assertEqual(d["n_residues"], 106)


class TestPdbReading(unittest.TestCase):
    def test_reads_real_backbone(self):
        info = eb.read_ca(BACKBONE)
        self.assertEqual(info["n_residues"], 106)
        self.assertEqual(info["chains"], ["A"])
        self.assertEqual(info["n_atoms"], 424, "N, CA, C, O for 106 residues")

    def test_experimental_bfactors_look_like_plddt_but_must_not_be_reported_as_it(self):
        info = eb.read_ca(BACKBONE)
        # This is the trap: crystallographic B-factors sit inside 0-100.
        self.assertTrue(info["b_looks_like_plddt"])
        # Measured from the backbone-only fixture itself (N, CA, C, O atoms).
        self.assertAlmostEqual(info["b_min"], 11.88, places=2)
        self.assertAlmostEqual(info["b_max"], 74.13, places=2)
        # ...and the bundle still never reports a pLDDT for it (see
        # TestDryRunBundle.test_no_plddt_metric_for_a_backbone).


class TestKabschRmsd(unittest.TestCase):
    """Verify the RMSD arithmetic on real coordinates under known transforms."""

    @classmethod
    def setUpClass(cls):
        cls.ca = eb.read_ca(BACKBONE)["ca"]

    def test_identical_coordinates_give_zero(self):
        res = eb.kabsch_ca_rmsd(self.ca, self.ca)
        self.assertIsNotNone(res["rmsd"], res.get("reason"))
        self.assertAlmostEqual(res["rmsd"], 0.0, places=6)
        self.assertEqual(res["aligned_atoms"], 106)
        self.assertEqual(res["atom_type"], "CA")

    def test_rigid_rotation_and_translation_give_zero(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy not installed")
        theta = 0.7
        R = np.array([[np.cos(theta), -np.sin(theta), 0.0],
                      [np.sin(theta), np.cos(theta), 0.0],
                      [0.0, 0.0, 1.0]])
        shift = np.array([12.5, -3.0, 7.25])
        moved = []
        for (c, r, i, x, y, z) in self.ca:
            v = R @ np.array([x, y, z]) + shift
            moved.append((c, r, i, float(v[0]), float(v[1]), float(v[2])))
        res = eb.kabsch_ca_rmsd(self.ca, moved)
        # Optimal superposition must undo a rigid motion exactly.
        self.assertAlmostEqual(res["rmsd"], 0.0, places=5)

    def test_known_uniform_displacement_gives_that_displacement(self):
        # Moving every atom along +x by d, alternating sign so the optimal
        # superposition cannot absorb it as a translation, gives RMSD == d.
        d = 2.0
        moved = [(c, r, i, x + (d if n % 2 == 0 else -d), y, z)
                 for n, (c, r, i, x, y, z) in enumerate(self.ca)]
        res = eb.kabsch_ca_rmsd(self.ca, moved)
        self.assertIsNotNone(res["rmsd"])
        # Not exactly d (rotation can reduce it slightly), but it must be real,
        # positive and of the right magnitude -- never silently zero.
        self.assertGreater(res["rmsd"], 1.0)
        self.assertLessEqual(res["rmsd"], d + 1e-6)

    def test_refuses_mismatched_lengths_instead_of_aligning_a_subset(self):
        res = eb.kabsch_ca_rmsd(self.ca, self.ca[:-5])
        self.assertIsNone(res["rmsd"])
        self.assertIn("counts differ", res["reason"])

    def test_reports_what_was_aligned(self):
        res = eb.kabsch_ca_rmsd(self.ca, self.ca)
        # The contract requires the selection alongside any RMSD.
        self.assertIn("aligned_atoms", res)
        self.assertIn("aligned_residues", res)
        self.assertIn("atom_type", res)


class TestDryRunBundle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="fs-dry-")
        cls.b, cls.exp, _ = build_to(cls.tmp, dry_run=True, experiment_id="hpc_test_dry")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_bundle_passes_its_own_validator(self):
        self.assertEqual(eb.validate_bundle(self.b.dir), [])

    def test_a_dry_run_is_demo_never_executed(self):
        self.assertEqual(self.exp["kind"], "demo")

    def test_provenance_says_no_model_was_executed(self):
        notes = self.exp["provenance"]["notes"]
        self.assertIn("DRY RUN", notes)
        self.assertIn("No model was executed", notes)

    def test_metrics_match_the_real_fixture_values(self):
        m = self.exp["metrics"]
        # hand-checked against the fixture's own headers:
        #   scores 0.8221 and 0.8356 -> best 0.8221, mean 0.82885 -> 0.8289
        self.assertEqual(m["mpnn_best_score"], 0.8221)
        self.assertEqual(m["mpnn_mean_score"], 0.8289)
        #   seq_recovery 0.5094 and 0.4434 -> mean 0.4764
        self.assertEqual(m["mpnn_mean_seq_recovery"], 0.4764)
        self.assertEqual(m["n_sequences_designed"], 2)
        self.assertEqual(m["n_backbones"], 1)
        self.assertEqual(m["backbone_n_residues_min"], 106)
        self.assertEqual(m["mpnn_seed"], 37)

    def test_no_plddt_metric_for_a_backbone(self):
        # The fixture's B-factors are in 0-100, so a careless implementation
        # would publish a mean "pLDDT" for a crystal structure.
        for key in self.exp["metrics"]:
            self.assertNotIn("plddt", key.lower())

    def test_prediction_metrics_absent_with_a_stated_reason(self):
        un = self.exp["metrics_unavailable"]
        for key in ("predicted_mean_plddt", "self_consistency_ca_rmsd_best"):
            self.assertIn(key, un)
            self.assertTrue(un[key].strip())
            self.assertNotIn(key, self.exp["metrics"])

    def test_every_metric_has_a_definition(self):
        with open(os.path.join(self.b.dir, "metrics.json")) as fh:
            doc = json.load(fh)
        for key in doc["values"]:
            self.assertIn(key, doc["definitions"], f"{key} has no definition")

    def test_metrics_are_flat_scalars_for_the_ui(self):
        for k, v in self.exp["metrics"].items():
            self.assertIsInstance(v, (int, float, str), f"metrics[{k}] must be a flat scalar")

    def test_backbone_registers_as_uploaded_not_predicted(self):
        with open(os.path.join(self.b.dir, "import_plan.json")) as fh:
            plan = json.load(fh)
        calls = plan["steps"][1]["calls"]
        self.assertTrue(calls)
        for call in calls:
            self.assertEqual(call["body"]["source"], "uploaded")
            self.assertIn("not pLDDT", call["body"]["notes"])

    def test_outputs_all_exist(self):
        for rel in self.exp["outputs"]:
            self.assertTrue(os.path.exists(os.path.join(self.b.dir, rel)), rel)

    def test_checksums_cover_the_shipped_files(self):
        with open(os.path.join(self.b.dir, "checksums.json")) as fh:
            checks = json.load(fh)
        for rel in self.exp["outputs"]:
            self.assertIn(rel, checks)
            self.assertEqual(len(checks[rel]["sha256"]), 64)

    def test_integrity_caveats_are_present(self):
        notes = self.exp["provenance"]["notes"]
        self.assertIn("not evidence of", notes)
        self.assertIn("not a clinical tool", notes.lower())
        self.assertIn("No binder or therapeutic design", notes)


class TestBackendCompatibility(unittest.TestCase):
    """Cross-check a bundle against Stream 1's REAL pydantic Experiment model."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, os.path.join(REPO, "backend"))
        try:
            from app.services.experiments import Experiment  # noqa
        except Exception as exc:
            raise unittest.SkipTest(f"backend deps not installed ({exc})")
        cls.Experiment = Experiment
        cls.tmp = tempfile.mkdtemp(prefix="fs-compat-")
        _, cls.exp, _ = build_to(cls.tmp, dry_run=True, experiment_id="hpc_test_compat")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(getattr(cls, "tmp", ""), ignore_errors=True)

    def test_dry_run_bundle_validates_against_the_backend_model(self):
        model = self.Experiment.model_validate(self.exp)
        self.assertEqual(model.kind, "demo")
        self.assertEqual(model.id, "hpc_test_compat")

    def test_backend_would_reject_a_failed_record_without_an_error(self):
        # Proves the rule we rely on is really enforced upstream.
        bad = dict(self.exp, status="failed", error=None)
        with self.assertRaises(Exception):
            self.Experiment.model_validate(bad)

    def test_backend_would_reject_executed_ok_without_outputs(self):
        bad = dict(self.exp, kind="executed", status="ok", outputs=[])
        with self.assertRaises(Exception):
            self.Experiment.model_validate(bad)

    def test_bundle_dir_name_is_a_legal_experiment_id(self):
        self.assertRegex("hpc_test_compat", eb.ID_RE.pattern)


class TestSimulatedRun(unittest.TestCase):
    """Build work dirs with a real ledger and real files, and check the
    kind/status rules. No stage output is invented: the files are the fixtures."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fs-run-")
        self.work = os.path.join(self.tmp, "run1")
        for sub in ("backbones", "seqs", "pred", "provenance"):
            os.makedirs(os.path.join(self.work, sub), exist_ok=True)
        self.events = os.path.join(self.work, "provenance", "events.jsonl")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add_files(self, backbone=True, seqs=True):
        if backbone:
            shutil.copy2(BACKBONE, os.path.join(self.work, "backbones", "design_0.pdb"))
        if seqs:
            shutil.copy2(MPNN_FA, os.path.join(self.work, "seqs", "design_0.fa"))

    def ran(self, stage, exit_code=0, wall=12.0, preemptions=0, error=None):
        ledger.append(self.events, {"run_id": "R1", "stage": stage, "event": "stage_start",
                                    "host": "node001"})
        for _ in range(preemptions):
            ledger.append(self.events, {"run_id": "R1", "stage": stage, "event": "preempted"})
            ledger.append(self.events, {"run_id": "R1", "stage": stage, "event": "stage_start",
                                        "host": "node002"})
        rec = {"run_id": "R1", "stage": stage, "event": "stage_end", "exit": exit_code,
               "wall_seconds": wall}
        if error:
            rec["error"] = error
        ledger.append(self.events, rec)

    def build(self, **kw):
        out = os.path.join(self.tmp, "data")
        return build_to(out, work_dir=self.work, **kw)

    def test_ledger_plus_files_is_executed(self):
        self.add_files()
        self.ran("rfdiffusion")
        self.ran("proteinmpnn")
        _, exp, _ = self.build(experiment_id="hpc_sim_exec")
        self.assertEqual(exp["kind"], "executed")

    def test_files_without_a_ledger_is_not_executed(self):
        # Files alone must never be enough to claim something ran.
        self.add_files()
        _, exp, _ = self.build(experiment_id="hpc_sim_nolog")
        self.assertEqual(exp["kind"], "imported")

    def test_ledger_without_files_is_not_executed(self):
        self.ran("rfdiffusion")
        _, exp, _ = self.build(experiment_id="hpc_sim_nofiles")
        self.assertEqual(exp["kind"], "imported")

    def test_missing_prediction_stage_is_partial_not_ok(self):
        self.add_files()
        self.ran("rfdiffusion")
        self.ran("proteinmpnn")
        _, exp, _ = self.build(experiment_id="hpc_sim_partial")
        self.assertEqual(exp["status"], "partial")

    def test_nothing_produced_is_failed_with_a_real_error(self):
        self.ran("rfdiffusion", exit_code=1, error="CUDA error: no kernel image is available for execution on the device")
        _, exp, _ = self.build(experiment_id="hpc_sim_failed")
        self.assertEqual(exp["status"], "failed")
        self.assertIn("CUDA error", exp["error"])
        self.assertEqual(eb.validate_bundle(os.path.join(self.tmp, "data", "experiments", "hpc_sim_failed")), [])

    def test_failed_with_no_recorded_error_still_explains_itself(self):
        # The contract forbids a failed experiment with an empty error, and we
        # must not invent a cause: say that nothing was recorded.
        _, exp, _ = self.build(experiment_id="hpc_sim_silent")
        self.assertEqual(exp["status"], "failed")
        self.assertTrue(exp["error"].strip())
        self.assertIn("recorded no error", exp["error"])

    def test_preemptions_are_reported_as_a_metric(self):
        self.add_files()
        self.ran("rfdiffusion", preemptions=2)
        self.ran("proteinmpnn")
        _, exp, _ = self.build(experiment_id="hpc_sim_preempt")
        self.assertEqual(exp["metrics"]["stage_rfdiffusion_preemptions"], 2)
        self.assertEqual(exp["metrics"]["stage_rfdiffusion_wall_seconds"], 12.0)

    def test_seq_recovery_is_suppressed_for_rfdiffusion_backbones(self):
        # ProteinMPNN reports seq_recovery against the input PDB's own sequence.
        # An RFdiffusion backbone has no native sequence, so the number would
        # imply a comparison that was never made.
        self.add_files()
        self.ran("rfdiffusion")
        self.ran("proteinmpnn")
        _, exp, _ = self.build(experiment_id="hpc_sim_recov")
        self.assertNotIn("mpnn_mean_seq_recovery", exp["metrics"])
        self.assertIn("mpnn_mean_seq_recovery", exp["metrics_unavailable"])
        self.assertIn("no native sequence", exp["metrics_unavailable"]["mpnn_mean_seq_recovery"])

    def test_real_scores_still_reported_for_a_real_run(self):
        self.add_files()
        self.ran("rfdiffusion")
        self.ran("proteinmpnn")
        _, exp, _ = self.build(experiment_id="hpc_sim_scores")
        self.assertEqual(exp["metrics"]["mpnn_best_score"], 0.8221)

    def test_no_key_is_both_reported_and_unavailable(self):
        self.add_files()
        self.ran("rfdiffusion")
        self.ran("proteinmpnn")
        _, exp, _ = self.build(experiment_id="hpc_sim_overlap")
        self.assertEqual(set(exp["metrics"]) & set(exp["metrics_unavailable"]), set())


class TestValidatorCatchesViolations(unittest.TestCase):
    """The validator has to actually fail on bad bundles, or it proves nothing."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fs-val-")
        self.b, self.exp, _ = build_to(self.tmp, dry_run=True, experiment_id="hpc_val")
        self.path = self.b.dir

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def mutate(self, **changes):
        exp = dict(self.exp)
        exp.update(changes)
        with open(os.path.join(self.path, "experiment.json"), "w") as fh:
            json.dump(exp, fh)
        return eb.validate_bundle(self.path)

    def test_clean_bundle_passes(self):
        self.assertEqual(eb.validate_bundle(self.path), [])

    def test_catches_failed_without_error(self):
        problems = self.mutate(status="failed", error="")
        self.assertTrue(any("real error message" in p for p in problems), problems)

    def test_catches_executed_ok_without_outputs(self):
        problems = self.mutate(kind="executed", status="ok", outputs=[])
        self.assertTrue(any("must list its output files" in p for p in problems), problems)

    def test_catches_bad_kind(self):
        problems = self.mutate(kind="totally_real_run")
        self.assertTrue(any("kind must be" in p for p in problems), problems)

    def test_catches_nested_metric_values(self):
        problems = self.mutate(metrics={"nested": {"a": 1}})
        self.assertTrue(any("flat scalars" in p for p in problems), problems)

    def test_catches_output_that_does_not_exist(self):
        problems = self.mutate(outputs=["structures/i_was_never_written.pdb"])
        self.assertTrue(any("not present in the bundle" in p for p in problems), problems)

    def test_catches_metric_both_reported_and_unavailable(self):
        problems = self.mutate(metrics={"n_backbones": 1},
                               metrics_unavailable={"n_backbones": "contradiction"})
        self.assertTrue(any("both reported and marked unavailable" in p for p in problems), problems)

    def test_catches_missing_provenance_source(self):
        problems = self.mutate(provenance={"retrieved_at": "now"})
        self.assertTrue(any("provenance.source" in p for p in problems), problems)

    def test_catches_metrics_json_disagreeing_with_experiment_json(self):
        self.mutate(metrics={"n_backbones": 999})
        problems = eb.validate_bundle(self.path)
        self.assertTrue(any("does not match" in p for p in problems), problems)

    def test_catches_missing_metrics_json(self):
        os.remove(os.path.join(self.path, "metrics.json"))
        problems = eb.validate_bundle(self.path)
        self.assertTrue(any("missing metrics.json" in p for p in problems), problems)


class TestPredictedGuard(unittest.TestCase):
    def test_refuses_a_file_that_says_it_is_not_a_model_output(self):
        with self.assertRaises(SystemExit) as ctx:
            eb.refuse_if_not_a_prediction(BACKBONE)
        self.assertIn("not a model output", str(ctx.exception))

    def test_refuses_an_experimental_structure(self):
        tmp = tempfile.mkdtemp(prefix="fs-xray-")
        try:
            p = os.path.join(tmp, "xray.pdb")
            with open(p, "w") as fh:
                fh.write("EXPDTA    X-RAY DIFFRACTION\n")
                fh.write("REMARK   2 RESOLUTION.    1.80 ANGSTROMS.\n")
                fh.write("ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 20.00\n")
            with self.assertRaises(SystemExit) as ctx:
                eb.refuse_if_not_a_prediction(p)
            self.assertIn("not pLDDT", str(ctx.exception))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
