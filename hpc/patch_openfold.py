#!/usr/bin/env python3
"""Make the OpenFold commit that ESMFold needs build and import on a current toolchain.

    python3 hpc/patch_openfold.py source    <openfold checkout>
    python3 hpc/patch_openfold.py installed <site-packages/openfold directory>

ESMFold depends on OpenFold at one specific 2022 commit. Three things in it no
longer hold, and each was hit, by hand, building the predictor environment on
the Mill (2026-11-14):

1. setup.py compiles its CUDA kernel with ``-std=c++14``. The headers of the
   PyTorch that gets installed today need C++17, so the build stops in torch's
   own headers. Fix: ``-std=c++17``.

2. setup.py decides which GPU architectures to compile for by asking the GPU of
   the machine it is built on. With no GPU there (a login node) it falls back to
   a list that starts with sm_37, which CUDA 12's nvcc refuses outright. Fix: an
   explicit list from the FS_OPENFOLD_CC environment variable, when it is set,
   so the build is the same wherever it runs.

3. openfold/utils/seed.py imports ``seed_everything`` from
   ``pytorch_lightning.utilities.seed``, a module newer pytorch-lightning
   releases removed. Fix: import it from ``pytorch_lightning``, where it has
   always also been exported.

``source`` applies all three to a checkout before it is built. ``installed``
applies only the third, to a copy that is already installed (the other two are
build-time and no longer matter once it is built).

Every edit is idempotent: running this twice changes nothing the second time. If
the text to patch is not there and neither is the patched form, the file is not
what this script was written against and it stops with exit status 1 rather than
guessing.
"""
from __future__ import annotations

import os
import sys

STD_OLD = "'-std=c++14'"
STD_NEW = "'-std=c++17'"

# The block that picks compute capabilities ends with these upstream lines; the
# override is inserted directly after them.
CC_ANCHOR = (
    "compute_capability, _ = get_nvidia_cc()\n"
    "if compute_capability is not None:\n"
    "    compute_capabilities = set([compute_capability])\n"
)
CC_MARKER = "# FoldStudio: explicit compute capabilities"
CC_OVERRIDE = (
    "\n"
    f"{CC_MARKER} (hpc/patch_openfold.py). FS_OPENFOLD_CC is a list such\n"
    "# as \"70\" or \"70 80\": major and minor digit of each architecture to build for.\n"
    "_fs_cc = os.environ.get(\"FS_OPENFOLD_CC\", \"\").replace(\",\", \" \").split()\n"
    "if _fs_cc:\n"
    "    compute_capabilities = set((int(c[:-1]), int(c[-1])) for c in _fs_cc)\n"
)

SEED_OLD = "from pytorch_lightning.utilities.seed import seed_everything"
SEED_NEW = "from pytorch_lightning import seed_everything"


class PatchError(Exception):
    pass


def patch_std(text: str) -> tuple[str, str]:
    if STD_NEW in text:
        return text, "already -std=c++17"
    if STD_OLD not in text:
        raise PatchError("setup.py has neither '-std=c++14' nor '-std=c++17' in its CUDA flags")
    return text.replace(STD_OLD, STD_NEW), "-std=c++14 -> -std=c++17"


def patch_compute_capabilities(text: str) -> tuple[str, str]:
    if CC_MARKER in text:
        return text, "compute-capability override already present"
    if CC_ANCHOR not in text:
        raise PatchError("setup.py does not contain the compute-capability block this patch follows")
    return text.replace(CC_ANCHOR, CC_ANCHOR + CC_OVERRIDE, 1), "added FS_OPENFOLD_CC override"


def patch_seed(text: str) -> tuple[str, str]:
    # SEED_NEW is not a substring of SEED_OLD, so this test cannot misfire on an unpatched file.
    if SEED_NEW in text:
        return text, "seed_everything import already current"
    if SEED_OLD not in text:
        raise PatchError("seed.py does not import seed_everything in either the old or the new way")
    return text.replace(SEED_OLD, SEED_NEW), "seed_everything import updated"


def apply(path: str, *patches) -> list[str]:
    """Apply patches to one file in place. Returns one line per patch saying what happened."""
    if not os.path.isfile(path):
        raise PatchError(f"{path} does not exist")
    with open(path, encoding="utf-8") as fh:
        original = fh.read()
    text, notes = original, []
    for patch in patches:
        text, note = patch(text)
        notes.append(f"{os.path.basename(path)}: {note}")
    if text != original:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    return notes


def patch_source(checkout: str) -> list[str]:
    return (apply(os.path.join(checkout, "setup.py"), patch_std, patch_compute_capabilities)
            + apply(os.path.join(checkout, "openfold", "utils", "seed.py"), patch_seed))


def patch_installed(package_dir: str) -> list[str]:
    return apply(os.path.join(package_dir, "utils", "seed.py"), patch_seed)


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in ("source", "installed"):
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    try:
        notes = patch_source(argv[2]) if argv[1] == "source" else patch_installed(argv[2])
    except PatchError as e:
        print(f"patch_openfold: {e}. Nothing in that file was changed.", file=sys.stderr)
        return 1
    for note in notes:
        print(f"patch_openfold: {note}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
