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


class TestBookkeepingStagesDoNotDecideStatus(unittest.TestCase):
    """Only stages that produce the experiment decide its status.

    Two real cases from the Mill. The driver opened a stage and (at first) never
    closed it. And the exporter reads the ledger from inside its own stage --
    after its stage_start, before its stage_end -- so it always sees itself as
    unfinished. Either would have turned a wholly successful run into "partial"
    carrying a missing-stage_end error. A science stage that is unfinished must
    still do exactly that.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fs-book-")
        self.work = os.path.join(self.tmp, "run")
        for sub in ("backbones", "seqs", "pred", "provenance"):
            os.makedirs(os.path.join(self.work, sub), exist_ok=True)
        self.events = os.path.join(self.work, "provenance", "events.jsonl")
        shutil.copy2(BACKBONE, os.path.join(self.work, "backbones", "design_0.pdb"))
        shutil.copy2(MPNN_FA, os.path.join(self.work, "seqs", "design_0.fa"))
        shutil.copy2(BACKBONE, os.path.join(self.work, "pred", "design_0_s1.pdb"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def start(self, stage):
        ledger.append(self.events, {"run_id": "R", "stage": stage, "event": "stage_start", "host": "n"})

    def end(self, stage, code=0, **kw):
        ledger.append(self.events, {"run_id": "R", "stage": stage, "event": "stage_end",
                                    "exit": code, "wall_seconds": 9.0, **kw})

    def science_ok(self, skip=()):
        for st in ("rfdiffusion", "proteinmpnn", "predict_esmfold"):
            if st not in skip:
                self.start(st)
                self.end(st)

    def build(self):
        _, exp, _ = eb.build(Args(data_dir=os.path.join(self.tmp, "data"),
                                  experiment_id="book", work_dir=self.work))
        return exp

    def test_unclosed_driver_stage_is_harmless(self):
        self.start("driver")
        self.science_ok()
        exp = self.build()
        self.assertEqual(exp["status"], "ok", exp.get("error"))

    def test_exporter_seeing_itself_mid_flight_is_harmless(self):
        self.science_ok()
        self.start("export_bundle")
        exp = self.build()
        self.assertEqual(exp["status"], "ok", exp.get("error"))
        self.assertIsNone(exp.get("error"))

    def test_an_earlier_failed_export_attempt_is_not_the_experiments_failure(self):
        self.science_ok()
        self.start("export_bundle")
        self.end("export_bundle", code=1, error="disk quota")
        self.start("export_bundle")
        self.assertEqual(self.build()["status"], "ok")

    def test_unfinished_science_stage_still_makes_the_run_partial(self):
        self.science_ok(skip=("predict_esmfold",))
        self.start("predict_esmfold")
        exp = self.build()
        self.assertEqual(exp["status"], "partial")
        self.assertIn("no stage_end", exp["error"])

    def test_a_stage_that_failed_then_succeeded_on_retry_is_ok(self):
        self.start("rfdiffusion")
        self.end("rfdiffusion", code=1, error="NVTX functions not installed")
        self.science_ok()
        exp = self.build()
        self.assertEqual(exp["status"], "ok", exp.get("error"))

    def test_driver_alone_does_not_make_a_run_executed(self):
        """Files on disk plus nothing but bookkeeping in the ledger is not a run."""
        self.start("driver")
        self.end("driver")
        self.assertNotEqual(self.build()["kind"], "executed")


class TestMillShapedRun(unittest.TestCase):
    """The layout the first real Mill run produced: one backbone, one MPNN FASTA
    (echoed input record + one design), and a predictor that folded BOTH records.
    Files are the real fixtures standing in for stage outputs; the point is the
    bookkeeping, not the coordinates.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fs-mill-")
        self.work = os.path.join(self.tmp, "run")
        for sub in ("backbones", "seqs", "pred", "provenance"):
            os.makedirs(os.path.join(self.work, sub))
        shutil.copy2(BACKBONE, os.path.join(self.work, "backbones", "design_0.pdb"))
        shutil.copy2(MPNN_FA, os.path.join(self.work, "seqs", "design_0.fa"))
        headers = [h for h, _ in eb.read_fasta(MPNN_FA)]
        for i, plddt in ((0, 31.0), (1, 88.0)):
            pdb = os.path.join(self.work, "pred", f"design_0_s{i}.pdb")
            shutil.copy2(BACKBONE, pdb)
            with open(pdb[:-4] + ".pred.json", "w") as fh:
                json.dump({"name": f"design_0_s{i}", "source_fasta_header": headers[i],
                           "mean_plddt": plddt, "ptm": 0.2 + 0.5 * i,
                           "plddt_units": "model wrote 0-100 already; left unchanged"}, fh)
        events = os.path.join(self.work, "provenance", "events.jsonl")
        for st in ("driver", "rfdiffusion", "proteinmpnn", "predict_esmfold"):
            ledger.append(events, {"run_id": "R", "stage": st, "event": "stage_start", "host": "n"})
            ledger.append(events, {"run_id": "R", "stage": st, "event": "stage_end", "exit": 0,
                                   "wall_seconds": 5.0})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def build(self):
        b, exp, run = eb.build(Args(data_dir=os.path.join(self.tmp, "data"),
                                    experiment_id="mill", work_dir=self.work))
        return b, exp

    def test_run_is_executed_and_ok(self):
        _, exp = self.build()
        self.assertEqual((exp["kind"], exp["status"]), ("executed", "ok"), exp.get("error"))

    def test_input_record_prediction_is_kept_but_labelled(self):
        b, _ = self.build()
        roles = {d["name"]: d["role"] for d in b.per_design}
        self.assertEqual(roles, {"design_0_s0": "input_sequence", "design_0_s1": "design"})

    def test_input_record_never_reaches_an_aggregate(self):
        """ptm 0.2 belongs to the echoed input, 0.7 to the design. A mean of the
        two (0.45) would mean the placeholder leaked into a design metric."""
        b, _ = self.build()
        self.assertEqual(b.metrics["predicted_mean_ptm"], 0.7)
        design = next(d for d in b.per_design if d["role"] == "design")
        self.assertEqual(b.metrics["predicted_mean_plddt"], design["mean_plddt"])
        self.assertEqual(b.metrics["predicted_best_mean_plddt"], design["mean_plddt"])

    def test_input_record_is_recognised_from_the_fasta_when_there_is_no_sidecar(self):
        """Off-cluster predictions can arrive without <name>.pred.json."""
        for i in (0, 1):
            os.remove(os.path.join(self.work, "pred", f"design_0_s{i}.pred.json"))
        b, _ = self.build()
        roles = {d["name"]: d["role"] for d in b.per_design}
        self.assertEqual(roles, {"design_0_s0": "input_sequence", "design_0_s1": "design"})

    def test_structure_sources_cover_every_registered_file(self):
        _, exp = self.build()
        self.assertEqual(exp["structure_sources"],
                         {"design_0.pdb": "uploaded", "design_0_s0.pdb": "predicted",
                          "design_0_s1.pdb": "predicted"})

    def test_rmsd_survives_a_python_without_numpy(self):
        """The export stage ran under a bare system python3 on the Mill."""
        saved = sys.modules.get("numpy", "absent")
        sys.modules["numpy"] = None  # makes `import numpy` raise ImportError
        try:
            b, _ = self.build()
        finally:
            if saved == "absent":
                sys.modules.pop("numpy", None)
            else:
                sys.modules["numpy"] = saved
        # prediction files are copies of the backbone, so the true answer is 0
        self.assertEqual(b.metrics["self_consistency_ca_rmsd_best"], 0.0)
        design = next(d for d in b.per_design if d["role"] == "design")
        self.assertIn("pure Python", design["scrmsd"]["method"])


class TestPureKabschAgreesWithNumpy(unittest.TestCase):
    def test_random_sets_rotations_and_mirror_images(self):
        import math
        import random
        import numpy as np
        rng = random.Random(11)
        for trial in range(120):
            n = rng.randint(3, 90)
            P = [(rng.gauss(0, 9), rng.gauss(0, 9), rng.gauss(0, 9)) for _ in range(n)]
            a, c = rng.uniform(0, 6.28), rng.uniform(0, 6.28)
            R = (np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
                 @ np.array([[math.cos(c), 0, math.sin(c)], [0, 1, 0], [-math.sin(c), 0, math.cos(c)]]))
            noise = (0.0, 0.4, 4.0)[trial % 3]
            Q = [tuple(float(v) + rng.gauss(0, noise) if noise else float(v)
                       for v in (R @ np.array(p)) + np.array([4.0, -2.0, 7.0])) for p in P]
            if trial % 5 == 0:  # a mirror image must not superpose to zero
                Q = [(-x, y, z) for x, y, z in Q]
            ref = eb._kabsch_rmsd_numpy(np, P, Q)
            self.assertAlmostEqual(eb._kabsch_rmsd_pure(P, Q), ref, delta=1e-6)

    def test_exact_copy_and_rigid_transform_are_zero(self):
        P = [(0.0, 0.0, 0.0), (3.8, 0.0, 0.0), (5.0, 3.6, 0.0), (8.1, 4.0, 2.2), (9.0, 7.5, 3.1)]
        self.assertAlmostEqual(eb._kabsch_rmsd_pure(P, list(P)), 0.0, places=9)
        Q = [(-y + 10.0, x - 4.0, z + 2.5) for x, y, z in P]  # 90 degree turn + shift
        self.assertAlmostEqual(eb._kabsch_rmsd_pure(P, Q), 0.0, places=7)

    def test_degenerate_inputs_do_not_crash(self):
        line = [(float(i), 0.0, 0.0) for i in range(6)]            # collinear
        same = [(1.0, 1.0, 1.0)] * 6                               # all coincident
        self.assertAlmostEqual(eb._kabsch_rmsd_pure(line, line), 0.0, places=9)
        self.assertGreaterEqual(eb._kabsch_rmsd_pure(line, same), 0.0)


class TestWorkflowBlock(unittest.TestCase):
    """The `workflow` block drives Stream 5's WorkflowStepper. It must never show
    a greener state than the experiment record justifies."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fs-wf-")
        self.work = os.path.join(self.tmp, "run")
        for sub in ("backbones", "seqs", "pred", "provenance"):
            os.makedirs(os.path.join(self.work, sub), exist_ok=True)
        self.events = os.path.join(self.work, "provenance", "events.jsonl")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def files(self):
        shutil.copy2(BACKBONE, os.path.join(self.work, "backbones", "design_0.pdb"))
        shutil.copy2(MPNN_FA, os.path.join(self.work, "seqs", "design_0.fa"))

    def ran(self, stage, exit_code=0, error=None):
        ledger.append(self.events, {"run_id": "R", "stage": stage, "event": "stage_start",
                                    "host": "n1"})
        rec = {"run_id": "R", "stage": stage, "event": "stage_end", "exit": exit_code,
               "wall_seconds": 5.0}
        if error:
            rec["error"] = error
        ledger.append(self.events, rec)

    def build(self, eid):
        _, exp, _ = build_to(os.path.join(self.tmp, "data"), work_dir=self.work,
                             experiment_id=eid)
        return {r["stage"]: r for r in exp["workflow"]}, exp

    def test_exactly_the_six_stepper_stages_in_order(self):
        self.files()
        self.ran("rfdiffusion")
        _, exp = self.build("hpc_wf_order")
        self.assertEqual([r["stage"] for r in exp["workflow"]],
                         ["Structure", "Backbone generation", "Sequence design",
                          "Structure prediction", "Evaluation", "Candidate review"])

    def test_every_row_has_a_printable_status_label(self):
        self.files()
        self.ran("rfdiffusion")
        _, exp = self.build("hpc_wf_labels")
        for row in exp["workflow"]:
            self.assertTrue(row["status_label"])
            self.assertIn(row["status"],
                          ("not_started", "imported", "demo", "executed", "failed", "partial"))

    def test_executed_stage_is_marked_executed(self):
        self.files()
        self.ran("rfdiffusion")
        self.ran("proteinmpnn")
        rows, _ = self.build("hpc_wf_exec")
        self.assertEqual(rows["Backbone generation"]["status"], "executed")
        self.assertEqual(rows["Backbone generation"]["ledger_stage"], "rfdiffusion")
        self.assertEqual(rows["Sequence design"]["status"], "executed")

    def test_stage_that_never_ran_is_not_started(self):
        self.files()
        self.ran("rfdiffusion")
        rows, _ = self.build("hpc_wf_notstarted")
        self.assertEqual(rows["Structure prediction"]["status"], "not_started")
        self.assertEqual(rows["Structure prediction"]["outputs"], 0)

    def test_failed_stage_carries_the_real_error_text(self):
        self.files()
        self.ran("rfdiffusion")
        self.ran("proteinmpnn")
        self.ran("predict_esmfold", exit_code=1,
                 error="RuntimeError: CUDA out of memory on device 0")
        rows, _ = self.build("hpc_wf_failed")
        self.assertEqual(rows["Structure prediction"]["status"], "failed")
        self.assertIn("CUDA out of memory", rows["Structure prediction"]["error"])

    def test_files_without_ledger_are_not_marked_executed(self):
        self.files()  # files only, no ledger entries at all
        rows, exp = self.build("hpc_wf_nolog")
        self.assertNotEqual(rows["Backbone generation"]["status"], "executed")
        self.assertEqual(exp["kind"], "imported")

    def test_structure_stage_explains_why_it_is_empty(self):
        self.files()
        self.ran("rfdiffusion")
        rows, _ = self.build("hpc_wf_structure")
        self.assertEqual(rows["Structure"]["status"], "not_started")
        self.assertIn("de novo", rows["Structure"]["note"])

    def test_candidate_review_is_left_to_the_app(self):
        self.files()
        self.ran("rfdiffusion")
        rows, _ = self.build("hpc_wf_review")
        self.assertEqual(rows["Candidate review"]["status"], "not_started")
        self.assertIn("FoldStudio", rows["Candidate review"]["note"])

    def test_evaluation_reflects_metrics_actually_computed(self):
        self.files()
        self.ran("rfdiffusion")
        self.ran("proteinmpnn")
        rows, exp = self.build("hpc_wf_eval")
        # mpnn scores are computed from the real FASTA, so Evaluation is not empty.
        self.assertEqual(rows["Evaluation"]["status"], "executed")
        self.assertIn("mpnn_best_score", rows["Evaluation"]["note"])

    def test_preemptions_surface_per_stage(self):
        self.files()
        ledger.append(self.events, {"run_id": "R", "stage": "rfdiffusion",
                                    "event": "stage_start", "host": "n1"})
        ledger.append(self.events, {"run_id": "R", "stage": "rfdiffusion", "event": "preempted"})
        ledger.append(self.events, {"run_id": "R", "stage": "rfdiffusion",
                                    "event": "stage_start", "host": "n2"})
        ledger.append(self.events, {"run_id": "R", "stage": "rfdiffusion",
                                    "event": "stage_end", "exit": 0, "wall_seconds": 7.0})
        rows, _ = self.build("hpc_wf_preempt")
        self.assertEqual(rows["Backbone generation"]["preemptions"], 1)


class TestProvenanceDoesNotOverclaimLocation(unittest.TestCase):
    """A stage may have run off-cluster (see hpc/OFFLOAD.md), so provenance must
    report the evidence rather than assert the Mill."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fs-prov-")
        self.work = os.path.join(self.tmp, "run")
        for sub in ("backbones", "seqs", "provenance"):
            os.makedirs(os.path.join(self.work, sub), exist_ok=True)
        shutil.copy2(BACKBONE, os.path.join(self.work, "backbones", "design_0.pdb"))
        shutil.copy2(MPNN_FA, os.path.join(self.work, "seqs", "design_0.fa"))
        ev = os.path.join(self.work, "provenance", "events.jsonl")
        ledger.append(ev, {"run_id": "R", "stage": "rfdiffusion", "event": "stage_start",
                           "host": "colab-gpu-t4"})
        ledger.append(ev, {"run_id": "R", "stage": "rfdiffusion", "event": "stage_end",
                           "exit": 0, "wall_seconds": 9.0})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        os.environ.pop("FS_SITE", None)

    def test_does_not_claim_the_mill_when_nothing_says_so(self):
        _, exp, _ = build_to(os.path.join(self.tmp, "d"), work_dir=self.work,
                             experiment_id="hpc_prov_nomill")
        blob = json.dumps(exp["provenance"])
        self.assertNotIn("Mill", blob)
        self.assertIn("no Slurm job id was recorded", blob)

    def test_records_the_hosts_it_actually_saw(self):
        _, exp, _ = build_to(os.path.join(self.tmp, "d2"), work_dir=self.work,
                             experiment_id="hpc_prov_hosts")
        self.assertIn("colab-gpu-t4", exp["provenance"]["notes"])

    def test_fs_site_is_reported_when_given(self):
        os.environ["FS_SITE"] = "Google Colab (T4)"
        _, exp, _ = build_to(os.path.join(self.tmp, "d3"), work_dir=self.work,
                             experiment_id="hpc_prov_site")
        self.assertIn("Google Colab (T4)", exp["provenance"]["source"])


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
