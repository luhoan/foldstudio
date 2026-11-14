#!/usr/bin/env python3
"""Import a FoldStudio HPC bundle into this checkout, so the app can show it.

    python3 scripts/hpc_import_bundle.py /tmp/bundle_hpc_20261114T115930Z.tar.gz
    python3 scripts/hpc_import_bundle.py path/to/hpc_20261114T115930Z      # a directory works too
    python3 scripts/hpc_import_bundle.py bundle.tar.gz --replace           # overwrite an earlier import

What it does, in order, stopping at the first problem:

  1. Unpacks the tarball into a scratch directory. Members that are absolute,
     contain "..", or are anything other than plain files and directories are
     refused: the tarball came off a cluster, but it is still just a file
     someone handed you.
  2. Validates the bundle with the same checks hpc/export_bundle.py applies
     when it writes one (required fields, the two integrity rules, every listed
     output present, flat metrics). An invalid bundle is not imported.
  3. Places it at <data-dir>/experiments/<id>/. An existing bundle with that id
     is left alone unless --replace is given; with --replace the old one is
     moved to <data-dir>/.replaced_experiments/ rather than deleted.
  4. Asks a running backend to reindex. The backend registers the structures
     the bundle lists by itself, so nothing else has to be called. If no
     backend is running, it says so: the bundle is picked up on the next start.

It never edits the bundle. kind / status / metrics are whatever the pipeline
recorded; if the run was partial or failed, that is what the app will show.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "hpc"))
sys.path.insert(0, os.path.join(REPO, "hpc", "lib"))

ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
MAX_FILES = 20000
MAX_BYTES = 4 * 1024 ** 3  # a bundle is PDBs and JSON; 4 GB means something is wrong


class ImportProblem(Exception):
    """A reason the bundle was not imported. The message is shown as-is."""


def safe_unpack(tar_path: str, dest: str) -> str:
    """Unpack `tar_path` under `dest` and return the bundle directory inside it."""
    try:
        tf = tarfile.open(tar_path, "r:*")
    except (tarfile.TarError, OSError) as exc:
        raise ImportProblem(f"{tar_path} is not a readable tar archive: {exc}") from exc
    with tf:
        members = tf.getmembers()
        if not members:
            raise ImportProblem("the archive is empty")
        if len(members) > MAX_FILES:
            raise ImportProblem(f"the archive has {len(members)} entries; refusing more than {MAX_FILES}")
        total = 0
        tops = set()
        for m in members:
            name = m.name
            parts = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".")]
            if name.startswith(("/", "\\")) or ".." in parts or not parts:
                raise ImportProblem(f"archive member {name!r} would escape the import directory")
            if not (m.isfile() or m.isdir()):
                raise ImportProblem(f"archive member {name!r} is a link or device, not a plain file")
            total += max(0, m.size)
            if total > MAX_BYTES:
                raise ImportProblem("the archive unpacks to more than 4 GB; refusing")
            tops.add(parts[0])
        if len(tops) != 1:
            raise ImportProblem("expected one top-level directory named after the experiment id, "
                                f"found {sorted(tops)}")
        top = next(iter(tops))
        if not ID_RE.match(top):
            raise ImportProblem(f"top-level directory {top!r} is not a legal experiment id")
        for m in members:
            parts = [p for p in m.name.replace("\\", "/").split("/") if p not in ("", ".")]
            target = os.path.join(dest, *parts)
            if m.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tf.extractfile(m)
            if src is None:
                raise ImportProblem(f"could not read archive member {m.name!r}")
            with src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
    return os.path.join(dest, top)


def locate_bundle(source: str, scratch: str) -> str:
    """Return a directory holding experiment.json, unpacking `source` if needed."""
    if os.path.isdir(source):
        if not os.path.isfile(os.path.join(source, "experiment.json")):
            raise ImportProblem(f"{source} has no experiment.json; it is not a bundle directory")
        return os.path.abspath(source)
    if not os.path.isfile(source):
        raise ImportProblem(f"no such file or directory: {source}")
    return safe_unpack(source, scratch)


def validate(bundle_dir: str) -> dict:
    """Validate with the exporter's own rules; return the parsed experiment."""
    try:
        import export_bundle as eb  # hpc/export_bundle.py
    except Exception as exc:  # pragma: no cover - only if the checkout is damaged
        raise ImportProblem(f"could not load hpc/export_bundle.py to validate with: {exc}") from exc
    problems = eb.validate_bundle(bundle_dir)
    if problems:
        raise ImportProblem("the bundle does not pass contract validation:\n  - "
                            + "\n  - ".join(problems))
    with open(os.path.join(bundle_dir, "experiment.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def place(bundle_dir: str, data_dir: str, exp_id: str, replace: bool) -> tuple[str, str | None]:
    """Copy the bundle to <data_dir>/experiments/<exp_id>. Returns (target, backup)."""
    experiments = os.path.join(data_dir, "experiments")
    os.makedirs(experiments, exist_ok=True)
    target = os.path.join(experiments, exp_id)
    backup = None
    if os.path.abspath(bundle_dir) == os.path.abspath(target):
        return target, None  # already in place: nothing to copy
    if os.path.exists(target):
        if not replace:
            raise ImportProblem(
                f"{target} already exists. Re-run with --replace to swap it; the existing "
                "bundle is moved aside, not deleted.")
        aside = os.path.join(data_dir, ".replaced_experiments")
        os.makedirs(aside, exist_ok=True)
        backup = os.path.join(aside, f"{exp_id}-{time.strftime('%Y%m%dT%H%M%S')}")
        shutil.move(target, backup)
    shutil.copytree(bundle_dir, target)
    return target, backup


def reindex(api: str, timeout: float = 20.0) -> dict | None:
    """POST /api/experiments/reindex. None means no backend answered."""
    url = api.rstrip("/") + "/api/experiments/reindex"
    req = urllib.request.Request(url, data=b"", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def summarise(exp: dict) -> str:
    metrics = exp.get("metrics") or {}
    lines = [
        f"  id       {exp.get('id')}",
        f"  kind     {exp.get('kind')}",
        f"  status   {exp.get('status')}",
        f"  model    {exp.get('model_name')}",
        f"  outputs  {len(exp.get('outputs') or [])} file(s)",
        f"  metrics  {len(metrics)} reported, {len(exp.get('metrics_unavailable') or {})} unavailable",
    ]
    for key in ("self_consistency_ca_rmsd_best", "predicted_best_mean_plddt", "mpnn_best_score"):
        if key in metrics:
            lines.append(f"           {key} = {metrics[key]}")
    if exp.get("error"):
        lines.append(f"  error    {exp['error']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Import a FoldStudio HPC bundle into data/experiments/.")
    ap.add_argument("bundle", help="bundle tarball (bundle_<id>.tar.gz) or bundle directory")
    ap.add_argument("--data-dir", default=os.path.join(REPO, "data"),
                    help="FoldStudio data directory (default: <repo>/data)")
    ap.add_argument("--api", default=os.environ.get("FOLDSTUDIO_API", "http://localhost:8000"),
                    help="backend base URL to ask for a reindex (default: http://localhost:8000)")
    ap.add_argument("--replace", action="store_true",
                    help="replace an existing bundle with the same id (the old one is moved aside)")
    ap.add_argument("--no-reindex", action="store_true", help="do not contact the backend")
    args = ap.parse_args(argv)

    scratch = tempfile.mkdtemp(prefix="fs-import-")
    try:
        bundle_dir = locate_bundle(args.bundle, scratch)
        exp = validate(bundle_dir)
        exp_id = str(exp.get("id") or os.path.basename(os.path.normpath(bundle_dir)))
        if not ID_RE.match(exp_id):
            raise ImportProblem(f"experiment id {exp_id!r} is not a legal id")
        target, backup = place(bundle_dir, args.data_dir, exp_id, args.replace)
    except ImportProblem as exc:
        print(f"NOT IMPORTED: {exc}", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    print(f"imported bundle into {target}")
    if backup:
        print(f"previous bundle moved to {backup}")
    print(summarise(exp))

    if args.no_reindex:
        print("\nnot contacting the backend (--no-reindex). It indexes data/experiments/ when it starts.")
        return 0
    result = reindex(args.api)
    if result is None:
        print(f"\nno backend answered at {args.api}. Start it (cd backend && ./run.sh): it indexes "
              "data/experiments/ and registers the bundle's structures on startup.")
        return 0
    mine = [e for e in (result.get("errors") or []) if str(e.get("path", "")).startswith(exp_id)]
    seen = exp_id in (result.get("imported") or [])
    print(f"\nbackend at {args.api} reindexed: "
          f"{'this experiment is indexed' if seen else 'THIS EXPERIMENT WAS NOT INDEXED'}; "
          f"{len(result.get('structures_registered') or [])} structure(s) newly registered.")
    for e in mine:
        print(f"  backend reported: {e.get('path')}: {e.get('error')}")
    return 0 if seen and not mine else 2


if __name__ == "__main__":
    raise SystemExit(main())
