"""Make SE3Transformer's NVTX profiling labels optional.

NVIDIA's SE3Transformer wraps its maths in `nvtx_range(...)`, NVIDIA's
profiling annotation API, imported straight from torch.cuda.nvtx. A PyTorch
build without NVTX imports that name fine and only raises when it is called:

  RuntimeError: NVTX functions not installed. Are you sure you have a CUDA build?

which is what killed stage 20 on the Mill 19s into the first design. The labels
are instrumentation and carry no numerics, so falling back to a no-op changes
nothing about the result. Probing at import time (rather than guarding the
import) is the point: the import is not what fails.
"""
import pathlib
import sys

NEEDLE = "from torch.cuda.nvtx import range as nvtx_range"
SHIM = '''import contextlib as _fs_contextlib

def _fs_nvtx_range():
    """Return torch's nvtx range if this build actually has NVTX, else a no-op."""
    try:
        from torch.cuda.nvtx import range as _r
        with _r("foldstudio_nvtx_probe"):
            pass
        return _r
    except Exception:
        @_fs_contextlib.contextmanager
        def _noop(*_a, **_k):
            yield
        return _noop

nvtx_range = _fs_nvtx_range()  # patched by FoldStudio hpc/10_setup_env.sh'''


def main(root: str) -> int:
    base = pathlib.Path(root)
    if not base.is_dir():
        print(f"nvtx patch: {base} is not a directory; nothing to do")
        return 0
    patched, already = [], []
    for f in sorted(base.rglob("*.py")):
        text = f.read_text()
        if "_fs_nvtx_range" in text:
            already.append(f.name)
            continue
        if NEEDLE not in text:
            continue
        f.write_text(text.replace(NEEDLE, SHIM))
        patched.append(f.name)
    print(f"nvtx patch: patched {patched or 'nothing'}; already patched {already or 'nothing'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
