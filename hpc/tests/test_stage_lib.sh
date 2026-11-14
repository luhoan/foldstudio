#!/usr/bin/env bash
# Tests for hpc/lib/common.sh + hpc/lib/ledger.py.
#
# These run anywhere (no Slurm, no GPU): they exercise the stage bracketing,
# command recording, per-item checkpoint/resume and the preemption path by
# sending a real SIGUSR1 to a running stage.
#
#     bash hpc/tests/test_stage_lib.sh
#
# Exit status 0 = all assertions passed.

set -o errexit
set -o nounset
set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1" >&2; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: expected '$3', got '$2'"; fi; }

# Count events of a given type for a stage in the ledger.
count_ev() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
path, stage, ev = sys.argv[1], sys.argv[2], sys.argv[3]
n = 0
with open(path) as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if o.get("stage") == stage and o.get("event") == ev:
            n += 1
print(n)
PY
}

field() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, subprocess, sys
path, stage, key = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, subprocess.os.environ["LEDGER_LIB"])
import ledger
s = ledger.stage_summary(ledger.read_events(path), stage)
v = s.get(key)
print("" if v is None else (json.dumps(v) if isinstance(v, (dict, list)) else v))
PY
}
export LEDGER_LIB="${REPO}/hpc/lib"

# A stage environment pointed entirely at the temp dir.
cat >"${TMP}/stage_env.sh" <<EOF
export FS_REPO="${REPO}"
export FS_HOME_BASE="${TMP}/home"
export FS_SCRATCH_BASE="${TMP}/scratch"
export FS_RUN_ID="testrun"
export FS_SEED=37
EOF

run_stage() { # run_stage <script-body-file>  -> prints exit code
  local body="$1" rc=0
  bash "$body" >"${TMP}/stage.out" 2>&1 || rc=$?
  echo "$rc"
}

echo "test_stage_lib: ledger + stage machinery"

# ---------------------------------------------------------------- 1. happy path
cat >"${TMP}/s_ok.sh" <<'EOS'
set -euo pipefail
. "${TMP_ENV}"
. "${FS_REPO}/hpc/env.sh"
. "${FS_REPO}/hpc/lib/common.sh"
fs_require_python
fs_stage_begin demo_ok
fs_run hello echo "hello world"
fs_run truthy true
EOS
rc=$(TMP_ENV="${TMP}/stage_env.sh" run_stage "${TMP}/s_ok.sh")
LEDGER="${TMP}/home/runs/testrun/provenance/events.jsonl"
check "happy stage exits 0" "$rc" "0"
if [ -f "$LEDGER" ]; then ok "ledger created"; else bad "ledger missing at $LEDGER"; fi
check "one stage_start"  "$(count_ev "$LEDGER" demo_ok stage_start)" "1"
check "two cmd events"   "$(count_ev "$LEDGER" demo_ok cmd)" "2"
check "one stage_end"    "$(count_ev "$LEDGER" demo_ok stage_end)" "1"
check "exit_status 0"    "$(field "$LEDGER" demo_ok exit_status)" "0"
check "completed true"   "$(field "$LEDGER" demo_ok completed)" "True"
check "no error"         "$(field "$LEDGER" demo_ok error)" ""
# argv must be recorded verbatim, including the space inside the argument.
if grep -q '"hello world"' "$LEDGER"; then ok "argv recorded verbatim"; else bad "argv not recorded verbatim"; fi

# --------------------------------------------------- 2. failure is recorded truthfully
cat >"${TMP}/s_fail.sh" <<'EOS'
set -euo pipefail
. "${TMP_ENV}"
. "${FS_REPO}/hpc/env.sh"
. "${FS_REPO}/hpc/lib/common.sh"
fs_stage_begin demo_fail
fs_run boom sh -c 'echo "the real error text" >&2; exit 3' || exit 3
EOS
rc=$(TMP_ENV="${TMP}/stage_env.sh" run_stage "${TMP}/s_fail.sh")
check "failing stage propagates exit" "$rc" "3"
check "failing stage_end exit=3" "$(field "$LEDGER" demo_fail exit_status)" "3"
check "failing stage completed=false" "$(field "$LEDGER" demo_fail completed)" "False"
if [ -n "$(field "$LEDGER" demo_fail error)" ]; then ok "error text recorded"; else bad "no error recorded"; fi
if grep -q 'the real error text' "${TMP}/home/runs/testrun/logs/demo_fail.boom.log"; then
  ok "command stderr captured in log"
else bad "command stderr not captured"; fi

# ------------------------------------------------------- 3. checkpoint and resume
cat >"${TMP}/s_items.sh" <<'EOS'
set -euo pipefail
. "${TMP_ENV}"
. "${FS_REPO}/hpc/env.sh"
. "${FS_REPO}/hpc/lib/common.sh"
fs_stage_begin demo_items
for i in 0 1 2; do
  if fs_is_done "item${i}"; then
    fs_log "skip item${i}"
    continue
  fi
  echo "work ${i}" >"${FS_STAGE_SCRATCH}/out_${i}.txt"
  echo "did_item${i}" >>"${WITNESS}"
  fs_mark_done "item${i}" "out_${i}.txt"
done
EOS
: >"${TMP}/witness.txt"
rc=$(TMP_ENV="${TMP}/stage_env.sh" WITNESS="${TMP}/witness.txt" run_stage "${TMP}/s_items.sh")
check "item stage pass 1 exits 0" "$rc" "0"
check "pass 1 did 3 items" "$(grep -c did_item "${TMP}/witness.txt")" "3"
check "3 item_done events" "$(count_ev "$LEDGER" demo_items item_done)" "3"
# scratch results must have been synced into $HOME by the stage_end trap
if [ -f "${TMP}/home/runs/testrun/out_1.txt" ]; then ok "scratch synced back to \$HOME"; else bad "scratch not synced back"; fi

: >"${TMP}/witness.txt"
rc=$(TMP_ENV="${TMP}/stage_env.sh" WITNESS="${TMP}/witness.txt" run_stage "${TMP}/s_items.sh")
check "item stage pass 2 exits 0" "$rc" "0"
check "pass 2 redid 0 items (resume works)" "$(grep -c did_item "${TMP}/witness.txt" || true)" "0"

# ------------------------------------------------------------- 4. preemption path
# Start a stage that waits, then deliver SIGUSR1 the way Slurm's
# --signal=B:USR1@<sec> would, and confirm the stage flushes and exits 99.
cat >"${TMP}/s_preempt.sh" <<'EOS'
set -euo pipefail
. "${TMP_ENV}"
. "${FS_REPO}/hpc/env.sh"
. "${FS_REPO}/hpc/lib/common.sh"
fs_stage_begin demo_preempt
echo "partial result" >"${FS_STAGE_SCRATCH}/partial.txt"
touch "${READY}"
# Wait in short sleeps so the trap runs promptly when the signal arrives.
for _ in $(seq 1 100); do sleep 0.1; done
EOS
rm -f "${TMP}/ready"
TMP_ENV="${TMP}/stage_env.sh" READY="${TMP}/ready" bash "${TMP}/s_preempt.sh" >"${TMP}/pre.out" 2>&1 &
PRE_PID=$!
for _ in $(seq 1 100); do [ -f "${TMP}/ready" ] && break; sleep 0.1; done
kill -USR1 "$PRE_PID" 2>/dev/null || true
PRE_RC=0
wait "$PRE_PID" || PRE_RC=$?
check "preempted stage exits 99" "$PRE_RC" "99"
check "preempted event recorded" "$(count_ev "$LEDGER" demo_preempt preempted)" "1"
check "preempted stage wrote no stage_end" "$(count_ev "$LEDGER" demo_preempt stage_end)" "0"
check "preempted stage not 'completed'" "$(field "$LEDGER" demo_preempt completed)" "False"
if [ -f "${TMP}/home/runs/testrun/partial.txt" ]; then
  ok "partial work flushed to \$HOME before preemption"
else bad "partial work lost on preemption"; fi
# A stage that started and never ended must say so, not look like a gap.
if [ -n "$(field "$LEDGER" demo_preempt error)" ]; then
  ok "unfinished stage carries an explanatory error"
else bad "unfinished stage has no error text"; fi

# ------------------------------------------------------- 5. torn ledger line survives
printf '{"event":"stage_start","stage":"tr' >>"$LEDGER"
printf '\n' >>"$LEDGER"
check "torn line ignored, ledger still readable" "$(count_ev "$LEDGER" demo_ok cmd)" "2"

echo
printf 'test_stage_lib: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
