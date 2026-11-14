"""scripts/hpc_import_bundle.py: getting a bundle off the cluster and into the app.

The bundles built here come from the real fixtures run through the real
exporter in dry-run mode (kind "demo"), so the importer is exercised on the
exact files the exporter writes. Nothing here is a pipeline run.
"""
import http.server
import io
import json
import os
import shutil
import sys
import tarfile
import tempfile
import threading
import unittest

HPC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HPC)
sys.path.insert(0, HPC)
sys.path.insert(0, os.path.join(HPC, "lib"))
sys.path.insert(0, os.path.join(REPO, "scripts"))

import export_bundle as eb  # noqa: E402
import hpc_import_bundle as imp  # noqa: E402


class Args:
    def __init__(self, data_dir, experiment_id):
        self.work_dir = None
        self.data_dir = data_dir
        self.experiment_id = experiment_id
        self.dry_run = True
        self.predicted = None
        self.no_copy_structures = True
        self.validate_only = None


def make_bundle(root: str, exp_id: str = "hpc_dryrun_import") -> str:
    """Write a real dry-run bundle and return its directory."""
    b, exp, run = eb.build(Args(os.path.join(root, "srcdata"), exp_id))
    eb.write_bundle(b, exp, run, copy_to_structures=False)
    return os.path.join(root, "srcdata", "experiments", exp_id)


def tar_of(bundle_dir: str, out_path: str) -> str:
    with tarfile.open(out_path, "w:gz") as tf:
        tf.add(bundle_dir, arcname=os.path.basename(bundle_dir))
    return out_path


def run_cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    old = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        code = imp.main(list(argv))
    finally:
        sys.stdout, sys.stderr = old
    return code, out.getvalue(), err.getvalue()


class ImportBundleCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fs-imp-")
        self.bundle = make_bundle(self.tmp)
        self.tarball = tar_of(self.bundle, os.path.join(self.tmp, "bundle.tar.gz"))
        self.data = os.path.join(self.tmp, "data")
        self.target = os.path.join(self.data, "experiments", "hpc_dryrun_import")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestHappyPath(ImportBundleCase):
    def test_tarball_is_unpacked_validated_and_placed(self):
        code, out, _ = run_cli(self.tarball, "--data-dir", self.data, "--no-reindex")
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.isfile(os.path.join(self.target, "experiment.json")))
        self.assertEqual(eb.validate_bundle(self.target), [])
        self.assertIn("kind     demo", out)

    def test_a_bundle_directory_works_too(self):
        code, _, _ = run_cli(self.bundle, "--data-dir", self.data, "--no-reindex")
        self.assertEqual(code, 0)
        self.assertTrue(os.path.isfile(os.path.join(self.target, "metrics.json")))

    def test_the_bundle_is_not_edited_on_the_way_in(self):
        run_cli(self.tarball, "--data-dir", self.data, "--no-reindex")
        with open(os.path.join(self.bundle, "experiment.json"), "rb") as a, \
                open(os.path.join(self.target, "experiment.json"), "rb") as b:
            self.assertEqual(a.read(), b.read())

    def test_importing_a_bundle_already_in_place_is_a_no_op(self):
        run_cli(self.tarball, "--data-dir", self.data, "--no-reindex")
        code, _, _ = run_cli(self.target, "--data-dir", self.data, "--no-reindex")
        self.assertEqual(code, 0)


class TestOverwrite(ImportBundleCase):
    def test_existing_bundle_is_left_alone_without_replace(self):
        run_cli(self.tarball, "--data-dir", self.data, "--no-reindex")
        marker = os.path.join(self.target, "MARKER")
        open(marker, "w").close()
        code, _, err = run_cli(self.tarball, "--data-dir", self.data, "--no-reindex")
        self.assertEqual(code, 1)
        self.assertIn("--replace", err)
        self.assertTrue(os.path.exists(marker), "the existing bundle must be untouched")

    def test_replace_moves_the_old_bundle_aside_instead_of_deleting_it(self):
        run_cli(self.tarball, "--data-dir", self.data, "--no-reindex")
        open(os.path.join(self.target, "MARKER"), "w").close()
        code, out, _ = run_cli(self.tarball, "--data-dir", self.data, "--no-reindex", "--replace")
        self.assertEqual(code, 0, out)
        self.assertFalse(os.path.exists(os.path.join(self.target, "MARKER")))
        aside = os.path.join(self.data, ".replaced_experiments")
        kept = os.listdir(aside)
        self.assertEqual(len(kept), 1)
        self.assertTrue(os.path.exists(os.path.join(aside, kept[0], "MARKER")))


class TestRefusals(ImportBundleCase):
    def _tar_with(self, name, data=b"x", kind=tarfile.REGTYPE, linkname=""):
        path = os.path.join(self.tmp, "evil.tar.gz")
        with tarfile.open(path, "w:gz") as tf:
            tf.add(self.bundle, arcname="hpc_dryrun_import")
            info = tarfile.TarInfo(name)
            info.type = kind
            info.linkname = linkname
            info.size = len(data) if kind == tarfile.REGTYPE else 0
            tf.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
        return path

    def assert_refused(self, tar_path, needle):
        code, _, err = run_cli(tar_path, "--data-dir", self.data, "--no-reindex")
        self.assertEqual(code, 1)
        self.assertIn(needle, err)
        self.assertFalse(os.path.exists(self.target), "nothing may be placed when the import is refused")

    def test_member_climbing_out_of_the_directory(self):
        self.assert_refused(self._tar_with("hpc_dryrun_import/../../escaped.txt"), "escape")

    def test_absolute_member(self):
        self.assert_refused(self._tar_with("/tmp/fs_absolute_escape.txt"), "escape")
        self.assertFalse(os.path.exists("/tmp/fs_absolute_escape.txt"))

    def test_symlink_member(self):
        self.assert_refused(
            self._tar_with("hpc_dryrun_import/link", kind=tarfile.SYMTYPE, linkname="/etc/passwd"),
            "link or device")

    def test_two_top_level_directories(self):
        self.assert_refused(self._tar_with("another_dir/file.txt"), "one top-level directory")

    def test_not_a_tar_file(self):
        junk = os.path.join(self.tmp, "junk.tar.gz")
        with open(junk, "wb") as fh:
            fh.write(b"this is not an archive")
        self.assert_refused(junk, "not a readable tar archive")

    def test_missing_path(self):
        self.assert_refused(os.path.join(self.tmp, "nope.tar.gz"), "no such file")

    def test_bundle_that_fails_validation_is_not_imported(self):
        """An 'executed, ok' record that lists no outputs breaks an integrity rule."""
        with open(os.path.join(self.bundle, "experiment.json")) as fh:
            exp = json.load(fh)
        exp.update(kind="executed", status="ok", outputs=[])
        with open(os.path.join(self.bundle, "experiment.json"), "w") as fh:
            json.dump(exp, fh)
        self.assert_refused(tar_of(self.bundle, os.path.join(self.tmp, "bad.tar.gz")),
                            "contract validation")

    def test_directory_without_experiment_json(self):
        empty = os.path.join(self.tmp, "emptydir")
        os.makedirs(empty)
        self.assert_refused(empty, "not a bundle directory")


class _Reindex(http.server.BaseHTTPRequestHandler):
    payload = {}

    def do_POST(self):  # noqa: N802 (http.server naming)
        body = json.dumps(type(self).payload).encode()
        self.send_response(200 if self.path == "/api/experiments/reindex" else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # keep test output quiet
        pass


class TestReindex(ImportBundleCase):
    def serve(self, payload):
        handler = type("H", (_Reindex,), {"payload": payload})
        srv = http.server.HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)  # cleanups run last-in first-out:
        self.addCleanup(srv.shutdown)      # stop serving, then close the socket
        return f"http://127.0.0.1:{srv.server_address[1]}"

    def test_no_backend_is_not_an_error(self):
        code, out, _ = run_cli(self.tarball, "--data-dir", self.data, "--api", "http://127.0.0.1:9")
        self.assertEqual(code, 0)
        self.assertIn("no backend answered", out)

    def test_backend_that_indexed_it(self):
        api = self.serve({"imported": ["hpc_dryrun_import"], "errors": [], "structures_registered": ["st_1"]})
        code, out, _ = run_cli(self.tarball, "--data-dir", self.data, "--api", api)
        self.assertEqual(code, 0, out)
        self.assertIn("this experiment is indexed", out)
        self.assertIn("1 structure(s) newly registered", out)

    def test_backend_that_did_not_index_it_is_reported(self):
        api = self.serve({"imported": [], "errors": [], "structures_registered": []})
        code, out, _ = run_cli(self.tarball, "--data-dir", self.data, "--api", api)
        self.assertEqual(code, 2)
        self.assertIn("NOT INDEXED", out)

    def test_backend_errors_about_this_bundle_are_shown(self):
        api = self.serve({"imported": ["hpc_dryrun_import"], "structures_registered": [],
                          "errors": [{"path": "hpc_dryrun_import/structures/x.pdb", "error": "not_found"},
                                     {"path": "someone_else/y.pdb", "error": "unrelated"}]})
        code, out, _ = run_cli(self.tarball, "--data-dir", self.data, "--api", api)
        self.assertEqual(code, 2)
        self.assertIn("x.pdb", out)
        self.assertNotIn("unrelated", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
