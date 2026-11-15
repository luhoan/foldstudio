"""hpc/patch_openfold.py: the three edits that let ESMFold's pinned OpenFold build and import.

The text patched here is copied from the real upstream files at the commit the
pipeline pins (aqlaboratory/openfold @ 4b41059694619831a7db195b7e0988fc4ff3a307),
so these tests fail if the patch stops matching what upstream actually wrote.

    python3 hpc/tests/test_openfold_patch.py
"""
import os
import subprocess
import sys
import tempfile
import unittest

HPC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATCH = os.path.join(HPC, "patch_openfold.py")
sys.path.insert(0, HPC)
import patch_openfold  # noqa: E402

# setup.py, lines 15-72 of the pinned commit, verbatim (the part the patch touches).
UPSTREAM_SETUP = '''import os
from setuptools import setup, Extension, find_packages
import subprocess

from torch.utils.cpp_extension import BuildExtension, CUDAExtension, CUDA_HOME

from scripts.utils import get_nvidia_cc


version_dependent_macros = [
    '-DVERSION_GE_1_1',
    '-DVERSION_GE_1_3',
    '-DVERSION_GE_1_5',
]

extra_cuda_flags = [
    '-std=c++14',
    '-maxrregcount=50',
    '-U__CUDA_NO_HALF_OPERATORS__',
    '-U__CUDA_NO_HALF_CONVERSIONS__',
    '--expt-relaxed-constexpr',
    '--expt-extended-lambda'
]

def get_cuda_bare_metal_version(cuda_dir):
    raw_output = subprocess.check_output([cuda_dir + "/bin/nvcc", "-V"], universal_newlines=True)
    output = raw_output.split()
    release_idx = output.index("release") + 1
    release = output[release_idx].split(".")
    bare_metal_major = release[0]
    bare_metal_minor = release[1][0]

    return raw_output, bare_metal_major, bare_metal_minor

compute_capabilities = set([
    (3, 7), # K80, e.g.
    (5, 2), # Titan X
    (6, 1), # GeForce 1000-series
])

compute_capabilities.add((7, 0))
_, bare_metal_major, _ = get_cuda_bare_metal_version(CUDA_HOME)
if int(bare_metal_major) >= 11:
    compute_capabilities.add((8, 0))

compute_capability, _ = get_nvidia_cc()
if compute_capability is not None:
    compute_capabilities = set([compute_capability])

cc_flag = []
for major, minor in list(compute_capabilities):
    cc_flag.extend([
        '-gencode',
        f'arch=compute_{major}{minor},code=sm_{major}{minor}',
    ])

extra_cuda_flags += cc_flag
'''

# openfold/utils/seed.py of the pinned commit, verbatim.
UPSTREAM_SEED = '''import os
import logging
import random
import numpy as np
from pytorch_lightning.utilities.seed import seed_everything

from openfold.utils.suppress_output import SuppressLogging


def seed_globally(seed=None):
    if("PL_GLOBAL_SEED" not in os.environ):
        if(seed is None):
            seed = random.randint(0, np.iinfo(np.uint32).max)
        os.environ["PL_GLOBAL_SEED"] = str(seed)
        logging.info(f'os.environ["PL_GLOBAL_SEED"] set to {seed}')

    # seed_everything is a bit log-happy
    with SuppressLogging(logging.INFO):
        seed_everything(seed=None)
'''


def make_checkout(root, setup=UPSTREAM_SETUP, seed=UPSTREAM_SEED):
    os.makedirs(os.path.join(root, "openfold", "utils"))
    with open(os.path.join(root, "setup.py"), "w") as fh:
        fh.write(setup)
    with open(os.path.join(root, "openfold", "utils", "seed.py"), "w") as fh:
        fh.write(seed)
    return root


def read(*parts):
    with open(os.path.join(*parts)) as fh:
        return fh.read()


def run(*args):
    return subprocess.run([sys.executable, PATCH, *args], capture_output=True, text=True)


def gencode_flags(setup_text, override, detected):
    """Run only the capability-selection part of a setup.py and return its arch flags."""
    start = setup_text.index("compute_capabilities = set([")
    end = setup_text.index("extra_cuda_flags += cc_flag")
    ns = {
        "os": os,
        "CUDA_HOME": "/cuda",
        "get_cuda_bare_metal_version": lambda _dir: ("", "12", "9"),
        "get_nvidia_cc": lambda: (detected, None if detected else "no GPU on this machine"),
    }
    saved = os.environ.pop("FS_OPENFOLD_CC", None)
    try:
        if override is not None:
            os.environ["FS_OPENFOLD_CC"] = override
        exec(setup_text[start:end], ns)  # noqa: S102 - our own fixture text
    finally:
        os.environ.pop("FS_OPENFOLD_CC", None)
        if saved is not None:
            os.environ["FS_OPENFOLD_CC"] = saved
    return sorted(flag for flag in ns["cc_flag"] if flag.startswith("arch="))


class SourcePatch(unittest.TestCase):
    def test_patches_the_three_things_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_checkout(tmp)
            result = run("source", root)
            self.assertEqual(result.returncode, 0, result.stderr)
            setup, seed = read(root, "setup.py"), read(root, "openfold", "utils", "seed.py")

            self.assertIn("'-std=c++17'", setup)
            self.assertNotIn("c++14", setup)
            self.assertIn(patch_openfold.CC_MARKER, setup)
            self.assertIn("from pytorch_lightning import seed_everything", seed)
            self.assertNotIn("pytorch_lightning.utilities.seed", seed)

            # Everything else is byte-for-byte upstream.
            restored = setup.replace("'-std=c++17'", "'-std=c++14'").replace(patch_openfold.CC_OVERRIDE, "")
            self.assertEqual(restored, UPSTREAM_SETUP)
            self.assertEqual(seed.replace("from pytorch_lightning import", "from pytorch_lightning.utilities.seed import"),
                             UPSTREAM_SEED)
            compile(setup, "setup.py", "exec")
            compile(seed, "seed.py", "exec")

    def test_running_it_twice_changes_nothing_the_second_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_checkout(tmp)
            self.assertEqual(run("source", root).returncode, 0)
            first = (read(root, "setup.py"), read(root, "openfold", "utils", "seed.py"))
            second_run = run("source", root)
            self.assertEqual(second_run.returncode, 0, second_run.stderr)
            self.assertEqual(first, (read(root, "setup.py"), read(root, "openfold", "utils", "seed.py")))
            self.assertIn("already", second_run.stdout)
            self.assertEqual(read(root, "setup.py").count(patch_openfold.CC_MARKER), 1)

    def test_unpatched_setup_would_ask_cuda_12_for_an_architecture_it_dropped(self):
        # The reason for the override: on a node with no GPU, upstream builds for sm_37.
        self.assertIn("arch=compute_37,code=sm_37", gencode_flags(UPSTREAM_SETUP, None, None))

    def test_override_builds_for_exactly_the_architectures_named(self):
        patched, _ = patch_openfold.patch_compute_capabilities(UPSTREAM_SETUP)
        self.assertEqual(gencode_flags(patched, "70", None), ["arch=compute_70,code=sm_70"])
        # ... the same flags the hand build got on a V100 node, where upstream detects 7.0 itself:
        self.assertEqual(gencode_flags(UPSTREAM_SETUP, None, (7, 0)), ["arch=compute_70,code=sm_70"])
        self.assertEqual(gencode_flags(patched, "70", (9, 0)), ["arch=compute_70,code=sm_70"])
        self.assertEqual(gencode_flags(patched, "70, 80", None),
                         ["arch=compute_70,code=sm_70", "arch=compute_80,code=sm_80"])

    def test_without_the_variable_upstream_behaviour_is_untouched(self):
        patched, _ = patch_openfold.patch_compute_capabilities(UPSTREAM_SETUP)
        for detected in (None, (7, 0), (9, 0)):
            self.assertEqual(gencode_flags(patched, None, detected), gencode_flags(UPSTREAM_SETUP, None, detected))
        self.assertEqual(gencode_flags(patched, "", (7, 0)), gencode_flags(UPSTREAM_SETUP, None, (7, 0)))

    def test_a_file_it_does_not_recognise_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_checkout(tmp, setup="from setuptools import setup\nsetup(name='openfold')\n")
            result = run("source", root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("Nothing in that file was changed", result.stderr)
            self.assertEqual(read(root, "setup.py"), "from setuptools import setup\nsetup(name='openfold')\n")
            # seed.py is not reached, so it is untouched too: one failure, no half-patched tree.
            self.assertEqual(read(root, "openfold", "utils", "seed.py"), UPSTREAM_SEED)

    def test_a_missing_checkout_is_an_error_not_a_silent_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run("source", os.path.join(tmp, "nope"))
            self.assertEqual(result.returncode, 1)
            self.assertIn("does not exist", result.stderr)


class InstalledPatch(unittest.TestCase):
    def test_repairs_an_installed_copy_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = os.path.join(tmp, "site-packages", "openfold")
            os.makedirs(os.path.join(pkg, "utils"))
            with open(os.path.join(pkg, "utils", "seed.py"), "w") as fh:
                fh.write(UPSTREAM_SEED)
            first = run("installed", pkg)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertIn("seed_everything import updated", first.stdout)
            patched = read(pkg, "utils", "seed.py")
            self.assertIn("from pytorch_lightning import seed_everything", patched)
            second = run("installed", pkg)
            self.assertEqual(second.returncode, 0)
            self.assertIn("already current", second.stdout)
            self.assertEqual(read(pkg, "utils", "seed.py"), patched)

    def test_the_patched_import_works_with_old_and_new_pytorch_lightning(self):
        # Both layouts export seed_everything from the package root; only the old one
        # also has pytorch_lightning.utilities.seed. Stand-ins for the two layouts:
        import types
        for has_utilities_seed in (True, False):
            pl = types.ModuleType("pytorch_lightning")
            pl.seed_everything = lambda seed=None: seed
            modules = {"pytorch_lightning": pl}
            if has_utilities_seed:
                util = types.ModuleType("pytorch_lightning.utilities")
                seed_mod = types.ModuleType("pytorch_lightning.utilities.seed")
                seed_mod.seed_everything = pl.seed_everything
                modules.update({"pytorch_lightning.utilities": util, "pytorch_lightning.utilities.seed": seed_mod})
            saved = {name: sys.modules.get(name) for name in
                     ("pytorch_lightning", "pytorch_lightning.utilities", "pytorch_lightning.utilities.seed")}
            for name in saved:
                sys.modules.pop(name, None)
            sys.modules.update(modules)
            try:
                ns = {}
                exec(patch_openfold.SEED_NEW, ns)  # noqa: S102
                self.assertIs(ns["seed_everything"], pl.seed_everything)
                if not has_utilities_seed:
                    with self.assertRaises(ImportError):
                        exec(patch_openfold.SEED_OLD, {})  # noqa: S102 - what upstream does today
            finally:
                for name in saved:
                    sys.modules.pop(name, None)
                    if saved[name] is not None:
                        sys.modules[name] = saved[name]

    def test_usage(self):
        self.assertEqual(run().returncode, 2)
        self.assertEqual(run("bogus", "/tmp").returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
