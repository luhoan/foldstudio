#!/usr/bin/env python3
"""Append-only provenance ledger for the FoldStudio HPC pipeline (Stream 3).

Why append-only JSONL: jobs on the Mill's `requeue` partition can be preempted at
any moment. A single short line written to a file opened in O_APPEND mode is not
torn by a concurrent writer or a kill, so a ledger built this way survives
preemption mid-run. Rewriting one aggregate JSON file would not.

Every stage appends events; `stage-summary` folds them into a per-stage record of
exactly what ran: argv, tool versions, git hashes, seeds, settings, wall time,
exit status, preemption count, and the real error text on failure.

`export_bundle.py` imports `summarize()` from here, so the rules that decide
whether a stage counts as *really executed* live in one place.

Usage (from bash):
    python3 ledger.py append --file F --run-id R --stage S --event stage_start \\
        --kv host=$(hostname) --json-kv settings='{"seed":37}'
    python3 ledger.py stage-summary --file F --stage rfdiffusion
    python3 ledger.py summary --file F
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Iterable

# Events a stage may append. Anything else is rejected at write time so typos do
# not silently create a category the summary logic ignores.
EVENTS = (
    "stage_start",     # a stage began an attempt
    "cmd",             # one command finished (records argv + exit + wall_seconds)
    "checkpoint",      # work was synced from node-local scratch back to $HOME
    "item_done",       # one unit of work (one design / one sequence) completed
    "preempted",       # SIGUSR1/SIGTERM received; state flushed, job requeued
    "note",            # free-text observation worth keeping
    "stage_end",       # a stage attempt finished (records exit)
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------- writing

def append(path: str, record: dict) -> dict:
    """Append one event as a single line. Fsynced so a kill cannot lose it."""
    if record.get("event") not in EVENTS:
        raise ValueError(f"unknown event {record.get('event')!r}; expected one of {', '.join(EVENTS)}")
    record.setdefault("ts", now_iso())
    line = json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    # O_APPEND: each write lands at the current end of file, so concurrent stage
    # writers interleave by line instead of overwriting each other.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(fd, line.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return record


# --------------------------------------------------------------------- reading

def read_events(path: str) -> list[dict]:
    """Read every well-formed event. A truncated final line (killed mid-write) is
    skipped rather than fatal -- losing the last event must not lose the run."""
    out: list[dict] = []
    if not os.path.exists(path):
        return out
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue  # torn line from a preemption; ignore
            if isinstance(obj, dict) and obj.get("event") in EVENTS:
                out.append(obj)
    return out


def _merge(dst: dict, src: Any) -> None:
    if isinstance(src, dict):
        dst.update(src)


def stage_summary(events: Iterable[dict], stage: str) -> dict:
    """Fold a stage's events into one record.

    `ran` means: the stage appended at least one stage_start, i.e. the script
    really began. `completed` means a stage_end with exit 0 was recorded.
    Neither one claims the *outputs* exist -- export_bundle.py checks the files
    on disk separately, so a ledger can never by itself produce an
    "executed" experiment.
    """
    evs = [e for e in events if e.get("stage") == stage]
    s: dict[str, Any] = {
        "stage": stage,
        "ran": False,
        "completed": False,
        "attempts": 0,
        "preemptions": 0,
        "started_at": None,
        "ended_at": None,
        "wall_seconds": None,
        "exit_status": None,
        "error": None,
        "commands": [],
        "items_done": [],
        "notes": [],
        "tool_versions": {},
        "git": {},
        "seeds": {},
        "settings": {},
        "slurm": {},
        "hosts": [],
        "outputs": [],
        "checkpoints": 0,
        "event_count": len(evs),
    }
    if not evs:
        return s

    wall_total = 0.0
    saw_wall = False
    for e in evs:
        kind = e["event"]
        for key in ("tool_versions", "git", "seeds", "settings", "slurm"):
            _merge(s[key], e.get(key))
        host = e.get("host")
        if host and host not in s["hosts"]:
            s["hosts"].append(host)

        if kind == "stage_start":
            s["ran"] = True
            s["attempts"] += 1
            if s["started_at"] is None:
                s["started_at"] = e.get("ts")
        elif kind == "cmd":
            s["commands"].append(
                {
                    "name": e.get("name"),
                    "argv": e.get("argv"),
                    "exit": e.get("exit"),
                    "wall_seconds": e.get("wall_seconds"),
                    "cwd": e.get("cwd"),
                    "log": e.get("log"),
                    "ts": e.get("ts"),
                }
            )
        elif kind == "item_done":
            item = e.get("item")
            if item is not None and item not in s["items_done"]:
                s["items_done"].append(item)
        elif kind == "preempted":
            s["preemptions"] += 1
        elif kind == "checkpoint":
            s["checkpoints"] += 1
        elif kind == "note":
            if e.get("message"):
                s["notes"].append(e["message"])
        elif kind == "stage_end":
            s["ended_at"] = e.get("ts")
            s["exit_status"] = e.get("exit")
            if e.get("error"):
                s["error"] = e["error"]
            for o in e.get("outputs") or []:
                if o not in s["outputs"]:
                    s["outputs"].append(o)
            w = e.get("wall_seconds")
            if isinstance(w, (int, float)):
                wall_total += float(w)
                saw_wall = True

    if saw_wall:
        s["wall_seconds"] = round(wall_total, 3)
    s["completed"] = s["exit_status"] == 0

    # A stage that started and never ended is unfinished. Whether it is still
    # running or died is not in the ledger -- only the scheduler knows that --
    # so record the fact and let the caller say which. `status` cross-checks
    # squeue; export_bundle runs after the jobs are gone, where unfinished does
    # mean died.
    s["unfinished"] = bool(s["ran"] and s["ended_at"] is None)
    if s["unfinished"] and s["error"] is None:
        if s["preemptions"]:
            s["error"] = (
                f"stage was preempted {s['preemptions']}x and recorded no stage_end since: "
                "the last attempt is still running, or it did not finish"
            )
        else:
            s["error"] = (
                "stage recorded a stage_start but no stage_end: it is either still "
                "running, or it died without running its exit handler (out of time, "
                "OOM-killed, or node failure)"
            )
    return s


def stages_in(events: Iterable[dict]) -> list[str]:
    seen: list[str] = []
    for e in events:
        st = e.get("stage")
        if st and st not in seen:
            seen.append(st)
    return seen


def summarize(path: str) -> dict:
    events = read_events(path)
    stages = stages_in(events)
    run_ids = []
    for e in events:
        r = e.get("run_id")
        if r and r not in run_ids:
            run_ids.append(r)
    return {
        "ledger": os.path.abspath(path),
        "run_ids": run_ids,
        "event_count": len(events),
        "stages": {st: stage_summary(events, st) for st in stages},
    }


# ------------------------------------------------------------------------ CLI

def _kv_pairs(pairs: list[str] | None, as_json: bool) -> dict:
    out: dict[str, Any] = {}
    for item in pairs or []:
        if "=" not in item:
            raise SystemExit(f"--{'json-kv' if as_json else 'kv'} expects key=value, got {item!r}")
        k, v = item.split("=", 1)
        if as_json:
            try:
                out[k] = json.loads(v)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"--json-kv {k}: value is not valid JSON ({exc})")
        else:
            out[k] = v
    return out


def pretty(path: str, running: Iterable[str] = ()) -> str:
    """Human-readable per-stage summary (used by hpc/run_pipeline.sh status).

    `running` names stages the scheduler currently reports as live. Without it
    an in-flight stage is indistinguishable from a dead one, and reporting a
    healthy running job as dead is worse than saying nothing.
    """
    live = {r for r in running}
    d = summarize(path)
    lines = [f"events: {d['event_count']}  run_ids: {', '.join(d['run_ids']) or '-'}"]
    if not d["stages"]:
        lines.append("  (no stages have recorded anything yet)")
    for name, s in d["stages"].items():
        is_live = name in live and s.get("unfinished")
        bits = [
            "ran" if s["ran"] else "NEVER RAN",
            "RUNNING NOW" if is_live else ("completed" if s["completed"] else "not completed"),
        ]
        if not is_live:
            bits.append(f"exit={s['exit_status']}")
        if s["attempts"] > 1:
            bits.append(f"attempts={s['attempts']}")
        if s["preemptions"]:
            bits.append(f"PREEMPTED x{s['preemptions']}")
        if s["wall_seconds"] is not None:
            bits.append(f"wall={s['wall_seconds']}s")
        if s["items_done"]:
            bits.append(f"items_done={len(s['items_done'])}")
        if s["hosts"]:
            bits.append(f"hosts={','.join(s['hosts'])}")
        lines.append(f"  {name:22s} " + "  ".join(bits))
        if s["error"] and not is_live:
            lines.append(f"      error: {s['error']}")
        elif is_live:
            lines.append("      (no stage_end yet -- expected, the scheduler says this job is running)")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="append-only provenance ledger")
    sub = p.add_subparsers(dest="cmd", required=True)

    pp = sub.add_parser("pretty", help="human-readable per-stage summary")
    pp.add_argument("--running", action="append", default=[],
                    help="stage the scheduler reports as live; repeatable")
    pp.add_argument("--file", required=True)

    a = sub.add_parser("append", help="append one event")
    a.add_argument("--file", required=True)
    a.add_argument("--run-id", required=True)
    a.add_argument("--stage", required=True)
    a.add_argument("--event", required=True, choices=EVENTS)
    a.add_argument("--kv", action="append", help="key=value (string)")
    a.add_argument("--json-kv", action="append", help="key=<json> (parsed)")

    for name, helptext in (("summary", "fold all stages"), ("stage-summary", "fold one stage")):
        q = sub.add_parser(name, help=helptext)
        q.add_argument("--file", required=True)
        if name == "stage-summary":
            q.add_argument("--stage", required=True)

    args = p.parse_args(argv)

    if args.cmd == "append":
        rec = {"run_id": args.run_id, "stage": args.stage, "event": args.event}
        rec.update(_kv_pairs(args.kv, as_json=False))
        rec.update(_kv_pairs(args.json_kv, as_json=True))
        try:
            append(args.file, rec)
        except ValueError as exc:
            print(f"ledger: {exc}", file=sys.stderr)
            return 2
        return 0

    if args.cmd == "pretty":
        print(pretty(args.file, args.running))
        return 0

    if args.cmd == "summary":
        print(json.dumps(summarize(args.file), indent=2, sort_keys=True))
        return 0

    print(json.dumps(stage_summary(read_events(args.file), args.stage), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
