#!/usr/bin/env python3
"""Check Stream 3's assumptions against the other streams' ACTUAL code.

    python scripts/hpc_check_contract.py            # run the checks
    python scripts/hpc_check_contract.py --strict    # missing backend deps = failure
    python scripts/hpc_check_contract.py -v          # show every passing check

Why this exists
---------------
`hpc/export_bundle.py` writes a bundle that Stream 1's backend imports and
Stream 5's panels display. It therefore depends on behaviour *other people own
and are still changing*:

  * `POST /api/experiments/reindex` scanning `data/experiments/*/experiment.json`
  * the directory name becoming the experiment id
  * `POST /api/structures/register` taking a path relative to `data/structures/`
  * `GET /structures/{id}/plddt` REFUSING non-`predicted` structures -- the lock
    that makes it safe for us to register designed backbones as `uploaded`
  * the Experiment model allowing extra fields, so `workflow`, `per_design` and
    `metrics_unavailable` survive the round trip
  * `metrics` staying flat scalars, which is what Stream 5's `types.ts` declares

If any of those change, the bundle breaks **silently**: it still validates
locally, it just stops importing or stops displaying. This script boots the real
FastAPI app over a temp data dir, imports a real bundle through it, and fails
loudly with the specific assumption that broke.

It is read-only with respect to other streams: it imports their code and calls
their API, and writes only into a temporary directory.

Run it after pulling teammates' branches.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HPC = os.path.join(REPO, "hpc")
BACKEND = os.path.join(REPO, "backend")
sys.path.insert(0, HPC)
sys.path.insert(0, os.path.join(HPC, "lib"))

import export_bundle as eb  # noqa: E402

PASS = 0
FAIL = 0
WARN = 0
VERBOSE = False
FAILURES: list[str] = []


def ok(name: str, detail: str = "") -> None:
    global PASS
    PASS += 1
    if VERBOSE:
        print(f"  ok    {name}" + (f" ({detail})" if detail else ""))


def bad(name: str, detail: str) -> None:
    global FAIL
    FAIL += 1
    FAILURES.append(f"{name}: {detail}")
    print(f"  FAIL  {name}\n          {detail}")


def warn(name: str, detail: str) -> None:
    global WARN
    WARN += 1
    print(f"  warn  {name}\n          {detail}")


def check(name: str, condition: bool, detail: str) -> bool:
    if condition:
        ok(name)
    else:
        bad(name, detail)
    return condition


# ---------------------------------------------------------------- the bundle

class Args:
    def __init__(self, data_dir, experiment_id):
        self.work_dir = None
        self.data_dir = data_dir
        self.experiment_id = experiment_id
        self.dry_run = True
        self.predicted = None
        self.no_copy_structures = False
        self.validate_only = None


def make_bundle(data_dir: str, exp_id: str) -> dict:
    args = Args(data_dir, exp_id)
    b, exp, run = eb.build(args)
    eb.write_bundle(b, exp, run, copy_to_structures=True)
    problems = eb.validate_bundle(b.dir)
    check("bundle passes our own validator", not problems, f"problems: {problems}")
    return {"dir": b.dir, "experiment": exp}


# ------------------------------------------------------- Stream 1: the backend

def check_backend(data_dir: str, exp_id: str, bundle: dict, strict: bool) -> None:
    try:
        sys.path.insert(0, BACKEND)
        from fastapi.testclient import TestClient
        from app.main import create_app
    except Exception as exc:
        msg = (f"cannot import Stream 1's backend ({type(exc).__name__}: {exc}).\n"
               f"          Install its deps to enable these checks:  "
               f"pip install -r backend/requirements.txt")
        if strict:
            bad("backend importable", msg)
        else:
            warn("backend checks SKIPPED", msg)
        return

    app = create_app(data_dir)
    client = TestClient(app)

    r = client.get("/api/health")
    if not check("GET /api/health responds 200", r.status_code == 200, f"got {r.status_code}"):
        return

    # A1: create_app() reindexes at startup, so the bundle should already be there.
    r = client.get(f"/api/experiments/{exp_id}")
    check("the bundle is picked up automatically at startup",
          r.status_code == 200,
          f"GET /api/experiments/{exp_id} returned {r.status_code}: {r.text[:200]}. "
          "create_app() used to call experiments.reindex() -- has that changed?")

    # A2: explicit reindex still finds it, keyed by directory name.
    r = client.post("/api/experiments/reindex")
    if check("POST /api/experiments/reindex responds 200", r.status_code == 200,
             f"got {r.status_code}: {r.text[:200]}"):
        body = r.json()
        check("reindex imports our bundle by directory name",
              exp_id in (body.get("imported") or []),
              f"'{exp_id}' not in imported={body.get('imported')}; errors={body.get('errors')}. "
              "Either the scan path or the id-from-directory-name rule changed.")
        check("reindex reports no errors for our bundle",
              not [e for e in (body.get("errors") or []) if exp_id in json.dumps(e)],
              f"errors mentioning our bundle: {body.get('errors')}")

    stored = client.get(f"/api/experiments/{exp_id}")
    if stored.status_code == 200:
        got = stored.json()
        ours = bundle["experiment"]

        check("kind survives the round trip", got.get("kind") == ours["kind"],
              f"we wrote {ours['kind']!r}, backend returned {got.get('kind')!r}")
        check("status survives the round trip", got.get("status") == ours["status"],
              f"we wrote {ours['status']!r}, backend returned {got.get('status')!r}")

        # A3: metrics must come back unchanged AND flat (Stream 5's types.ts says
        # Record<string, number | string | null>).
        check("metrics survive the round trip unchanged",
              got.get("metrics") == ours["metrics"],
              f"metrics changed in storage: ours={ours['metrics']} theirs={got.get('metrics')}")
        nonflat = {k: type(v).__name__ for k, v in (got.get("metrics") or {}).items()
                   if not isinstance(v, (int, float, str, bool)) and v is not None}
        check("metrics are flat scalars after the round trip", not nonflat,
              f"non-scalar metrics would break Stream 5's typed client: {nonflat}")

        # A4: extra fields must survive, or the WorkflowStepper mapping disappears.
        for field in ("workflow", "per_design", "metrics_unavailable"):
            check(f"extra field '{field}' survives storage",
                  field in got,
                  f"'{field}' was dropped. The Experiment model used to set "
                  "extra='allow'; if that became 'ignore'/'forbid', Stream 5 loses "
                  "the workflow mapping and the reasons metrics are unavailable.")

        wf = got.get("workflow") or []
        check("workflow lists all six WorkflowStepper stages", len(wf) == 6,
              f"expected 6 stages, got {len(wf)}")
        expected_stages = [s for s, _ in eb.UI_WORKFLOW]
        check("workflow stage names match Stream 5's stepper",
              [w.get("stage") for w in wf] == expected_stages,
              f"ours={[w.get('stage') for w in wf]} expected={expected_stages}")

    # A5: the integrity rules we rely on must still be enforced upstream.
    bad_failed = dict(bundle["experiment"], id="probe_failed_no_error",
                      status="failed", error=None)
    r = client.post("/api/experiments", json=bad_failed)
    check("backend still rejects status=failed with no error", r.status_code == 422,
          f"expected 422, got {r.status_code}. This rule is load-bearing: it is "
          "why a failed run cannot be recorded without its real error text.")

    bad_exec = dict(bundle["experiment"], id="probe_exec_no_outputs",
                    kind="executed", status="ok", outputs=[])
    r = client.post("/api/experiments", json=bad_exec)
    check("backend still rejects executed+ok with no outputs", r.status_code == 422,
          f"expected 422, got {r.status_code}. This is why 'executed' cannot be "
          "claimed without output files.")

    # A6: structure registration, and the pLDDT lock that makes 'uploaded' safe.
    plan_path = os.path.join(bundle["dir"], "import_plan.json")
    with open(plan_path, "r", encoding="utf-8") as fh:
        plan = json.load(fh)
    calls = plan["steps"][1]["calls"]
    check("import_plan.json lists at least one structure to register", bool(calls),
          "no register calls were generated")

    registered: list[dict] = []
    for call in calls:
        r = client.post("/api/structures/register", json=call["body"])
        if r.status_code != 201:
            bad("POST /api/structures/register accepts our bundle's paths",
                f"{r.status_code} for path={call['body']['path']!r}: {r.text[:240]}. "
                "The endpoint requires the file to already sit under data/structures/; "
                "export_bundle.py copies it there. Has that contract changed?")
            continue
        ok("POST /api/structures/register accepts our bundle's paths")
        registered.append({"body": call["body"], "row": r.json()})

    for item in registered:
        sid = item["row"]["id"]
        src = item["body"]["source"]
        r = client.get(f"/api/structures/{sid}/plddt")
        if src == "uploaded":
            # THE important one. We register designed backbones as 'uploaded'
            # precisely so this returns 409 instead of reporting B-factors as
            # confidence. If this ever returns 200, our labelling is no longer
            # protected and experimental B-factors could be shown as pLDDT.
            check("GET /plddt REFUSES a structure registered as 'uploaded'",
                  r.status_code == 409,
                  f"expected 409, got {r.status_code}: {r.text[:200]}. "
                  "Stream 3 relies on this: designed backbones carry no pLDDT, and "
                  "their B-factor column must never be reported as model confidence.")
        r = client.get(f"/api/structures/{sid}/residues")
        check("GET /residues works for a registered structure", r.status_code == 200,
              f"got {r.status_code}: {r.text[:160]}")
        if r.status_code == 200:
            n = len(r.json().get("residues", []))
            expected = bundle["experiment"]["metrics"].get("backbone_n_residues_max")
            if src == "uploaded" and expected:
                check("backend residue count agrees with our metric",
                      n == expected,
                      f"backend counted {n} residues, our metric says {expected}")
        r = client.get(f"/api/structures/{sid}/pae")
        if not item["body"].get("pae_path"):
            check("GET /pae returns 404 pae_unavailable when there is no PAE",
                  r.status_code == 404 and r.json().get("detail") == "pae_unavailable",
                  f"got {r.status_code} {r.text[:160]}; Stream 5 renders a specific "
                  "message for detail=='pae_unavailable'")

    # A7: no runner by default, so the app stays useful with no GPU.
    r = client.post("/api/jobs", json={"spec": {}})
    check("POST /api/jobs returns 501 no_runner by default",
          r.status_code == 501 and r.json().get("detail") == "no_runner",
          f"got {r.status_code} {r.text[:160]}")


# --------------------------------------------- Stream 5: informational only

def check_stream5_types() -> None:
    """Read Stream 5's types.ts if present and report drift that affects us.

    Informational: Stream 5 owns this file. We only care whether the shapes our
    bundle fills still match what their client expects.
    """
    path = os.path.join(REPO, "frontend", "src", "api", "types.ts")
    if not os.path.exists(path):
        warn("Stream 5 types.ts not on this branch",
             f"{os.path.relpath(path, REPO)} is absent -- their work is on another "
             "branch. Run: git fetch origin && git checkout origin/<their-branch> -- "
             "frontend/src/api/types.ts")
        return
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()
    if "metrics: Record<string, number | string | null>" in src.replace("\n", " "):
        ok("Stream 5 still declares metrics as flat scalars")
    else:
        warn("Stream 5's metrics type may have changed",
             "could not find `metrics: Record<string, number | string | null>` in "
             "types.ts. If it now expects nested metrics, export_bundle.py should "
             "be revisited.")
    for field in ("ExperimentKind", "ExperimentStatus"):
        if field in src:
            ok(f"Stream 5 still defines {field}")
        else:
            warn(f"Stream 5 no longer defines {field}", "their experiment typing changed")


def main(argv: list[str] | None = None) -> int:
    global VERBOSE
    ap = argparse.ArgumentParser(description="check Stream 3's cross-stream assumptions")
    ap.add_argument("--strict", action="store_true",
                    help="treat missing backend dependencies as a failure")
    ap.add_argument("-v", "--verbose", action="store_true", help="show passing checks too")
    args = ap.parse_args(argv)
    VERBOSE = args.verbose

    tmp = tempfile.mkdtemp(prefix="fs-contract-")
    exp_id = "hpc_contract_probe"
    try:
        print("Stream 3 cross-stream contract check")
        print(f"  repo: {REPO}")
        print()
        print("[1/3] building a bundle from the real fixtures")
        bundle = make_bundle(tmp, exp_id)
        print(f"  built {os.path.relpath(bundle['dir'], tmp)}")

        print()
        print("[2/3] importing it through Stream 1's real FastAPI app")
        check_backend(tmp, exp_id, bundle, strict=args.strict)

        print()
        print("[3/3] Stream 5 typed-client expectations (informational)")
        check_stream5_types()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    print("-" * 60)
    print(f"{PASS} passed, {FAIL} failed, {WARN} warning(s)")
    if FAILURES:
        print()
        print("A cross-stream assumption Stream 3 depends on has changed:")
        for f in FAILURES:
            print(f"  - {f}")
        print()
        print("Fix hpc/export_bundle.py to match, or raise it with the stream's owner.")
    print("-" * 60)
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
