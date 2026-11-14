"""The NVTX patch applied to SE3Transformer before stage 20 can run.

Mill, 2026-11-14: RFdiffusion loaded its weights, entered the forward pass and
died 19s in with "NVTX functions not installed. Are you sure you have a CUDA
build?" from se3_transformer/model/basis.py. The labels are NVIDIA profiling
annotations and carry no numerics, so a no-op fallback is sound -- but it must
not quietly replace a working profiler, and re-running setup must not corrupt
an already-patched file.
"""
import contextlib
import os
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest

HPC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATCH = os.path.join(HPC, "patch_se3_nvtx.py")
ORIGINAL_IMPORT = "from torch.cuda.nvtx import range as nvtx_range"


def make_package(root: str) -> str:
    pkg = os.path.join(root, "se3_transformer", "model")
    os.makedirs(pkg)
    open(os.path.join(root, "se3_transformer", "__init__.py"), "w").close()
    open(os.path.join(pkg, "__init__.py"), "w").close()
    with open(os.path.join(pkg, "basis.py"), "w") as f:
        f.write(textwrap.dedent(f"""\
            import torch
            {ORIGINAL_IMPORT}

            def spherical(x):
                with nvtx_range('spherical harmonics'):
                    return x * 2
            """))
    return os.path.join(root, "se3_transformer")


def run_patch(pkg: str) -> str:
    out = subprocess.run([sys.executable, PATCH, pkg], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return out.stdout


def import_basis(root: str, nvtx_range_impl):
    """Import the patched module against a stub torch whose nvtx we control."""
    torch = types.ModuleType("torch")
    cuda = types.ModuleType("torch.cuda")
    nvtx = types.ModuleType("torch.cuda.nvtx")
    nvtx.range = nvtx_range_impl
    cuda.nvtx = nvtx
    torch.cuda = cuda
    saved = {k: sys.modules.get(k) for k in
             ("torch", "torch.cuda", "torch.cuda.nvtx")}
    stale = [k for k in sys.modules if k.startswith("se3_transformer")]
    for k in stale:
        del sys.modules[k]
    sys.modules.update({"torch": torch, "torch.cuda": cuda, "torch.cuda.nvtx": nvtx})
    sys.path.insert(0, root)
    try:
        from se3_transformer.model import basis
        return basis
    finally:
        sys.path.remove(root)
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
        for k in [k for k in sys.modules if k.startswith("se3_transformer")]:
            del sys.modules[k]


@contextlib.contextmanager
def broken_nvtx(_msg):
    raise RuntimeError("NVTX functions not installed. Are you sure you have a CUDA build?")
    yield  # pragma: no cover


class TestNvtxPatch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fs-nvtx-")
        self.pkg = make_package(self.tmp)

    def test_unpatched_code_really_does_crash(self):
        """Without the patch the failure must reproduce, or the fix proves nothing."""
        basis = import_basis(self.tmp, broken_nvtx)
        with self.assertRaises(RuntimeError):
            basis.spherical(3)

    def test_patched_code_runs_when_nvtx_is_missing(self):
        run_patch(self.pkg)
        basis = import_basis(self.tmp, broken_nvtx)
        self.assertEqual(basis.spherical(3), 6)

    def test_a_working_nvtx_is_still_used(self):
        """The no-op is a fallback, not a replacement: real labels must survive."""
        run_patch(self.pkg)
        seen = []

        @contextlib.contextmanager
        def good(msg):
            seen.append(msg)
            yield

        basis = import_basis(self.tmp, good)
        self.assertEqual(basis.spherical(3), 6)
        self.assertIn("spherical harmonics", seen)

    def test_patch_is_idempotent(self):
        run_patch(self.pkg)
        target = os.path.join(self.pkg, "model", "basis.py")
        with open(target) as fh:
            once = fh.read()
        out = run_patch(self.pkg)
        with open(target) as fh:
            twice = fh.read()
        self.assertEqual(once, twice)
        self.assertIn("already patched", out)

    def test_reports_what_it_did(self):
        out = run_patch(self.pkg)
        self.assertIn("basis.py", out)

    def test_missing_directory_is_not_an_error(self):
        out = subprocess.run([sys.executable, PATCH, os.path.join(self.tmp, "nope")],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0)
        self.assertIn("nothing to do", out.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
