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

# ------------------------------------------- 5. fs_stage_finish records exactly one end
# Every stage script ends with fs_stage_finish, so a double stage_end here would
# corrupt the wall-time and exit-status of every run.
cat >"${TMP}/s_finish.sh" <<'EOS'
set -euo pipefail
. "${TMP_ENV}"
. "${FS_REPO}/hpc/env.sh"
. "${FS_REPO}/hpc/lib/common.sh"
fs_stage_begin demo_finish
fs_run noop true
fs_stage_finish '["backbones/design_0.pdb","backbones/design_1.pdb"]'
EOS
rc=$(TMP_ENV="${TMP}/stage_env.sh" run_stage "${TMP}/s_finish.sh")
check "finished stage exits 0" "$rc" "0"
check "exactly one stage_end" "$(count_ev "$LEDGER" demo_finish stage_end)" "1"
check "finished stage completed" "$(field "$LEDGER" demo_finish completed)" "True"
check "outputs recorded" "$(field "$LEDGER" demo_finish outputs)" '["backbones/design_0.pdb", "backbones/design_1.pdb"]'

# ---------------------------------------------- 6. ledger pretty renders on this python
# This rendering used to be inline python with backslashes inside f-strings,
# which is a syntax error before python 3.12. Keep it exercised.
if python3 "${REPO}/hpc/lib/ledger.py" pretty --file "$LEDGER" >"${TMP}/pretty.txt" 2>&1; then
  ok "ledger pretty runs"
  if grep -q 'PREEMPTED x1' "${TMP}/pretty.txt"; then ok "pretty reports the preemption"; else bad "pretty lost the preemption"; fi
  if grep -q 'demo_fail' "${TMP}/pretty.txt"; then ok "pretty lists the failed stage"; else bad "pretty omitted the failed stage"; fi
else
  bad "ledger pretty failed: $(cat "${TMP}/pretty.txt")"
fi

# ------------------------------- 7. Slurm wall-time parsing (guards the preflight)
# fs_check_walltime refuses to submit a job the partition will never schedule, so
# this parser has to handle every format scontrol prints for MaxTime.
#   4:00:00 is the `class` cap, 1-00:00:00 the `requeue` cap.
if ( . "${REPO}/hpc/env.sh"; . "${REPO}/hpc/lib/common.sh"
     set -e
     [ "$(fs_time_to_seconds '4:00:00')"    = "14400" ]
     [ "$(fs_time_to_seconds '1-00:00:00')" = "86400" ]
     [ "$(fs_time_to_seconds '03:45:00')"   = "13500" ]
     [ "$(fs_time_to_seconds '2-12:00:00')" = "216000" ]
     [ "$(fs_time_to_seconds '1-12')"       = "129600" ]
     [ "$(fs_time_to_seconds '1-06:30')"    = "109800" ]
     [ "$(fs_time_to_seconds '60')"         = "3600" ]
     [ "$(fs_time_to_seconds '30:00')"      = "1800" ]
     [ "$(fs_time_to_seconds 'UNLIMITED')"  = "-1" ]
     [ "$(fs_time_to_seconds 'INFINITE')"   = "-1" ]
     [ "$(fs_time_to_seconds '')"           = "-1" ]
     [ "$(fs_time_to_seconds 'garbage')"    = "-2" ] ) 2>/dev/null; then
  ok "Slurm MaxTime parsing covers every format scontrol prints"
else
  bad "Slurm MaxTime parsing is wrong -- the preflight wall-time guard cannot be trusted"
fi

# A 4-hour cap must reject our 8-hour-style request and accept the 3:45 default.
if ( . "${REPO}/hpc/env.sh"; . "${REPO}/hpc/lib/common.sh"
     set -e
     a="$(fs_time_to_seconds '08:00:00')"; b="$(fs_time_to_seconds '4:00:00')"
     [ "$a" -gt "$b" ]
     c="$(fs_time_to_seconds "${FS_TIME_GPU}")"
     [ "$c" -le "$b" ] ) 2>/dev/null; then
  ok "default FS_TIME_GPU fits inside a 4-hour partition cap"
else
  bad "default FS_TIME_GPU would be rejected by a 4-hour partition"
fi

# ------------------------------------------------------- 7b. conda activate under set -u
# Real failure on Mill 2026-11-14: `conda activate SE3nv` aborted with
#   .../activate.d/libblas_mkl_activate.sh: MKL_INTERFACE_LAYER: unbound variable
# Conda's own activate.d scripts are not written for `set -u`, so fs_activate_env
# must relax nounset across activation and restore it afterwards.
MKLDIR="$(mktemp -d)"
mkdir -p "${MKLDIR}/bin" "${MKLDIR}/activate.d"
printf '#!/usr/bin/env bash\n[ "$1" = "shell.bash" ] || exit 0\necho "conda() { [ \\"\$1\\" = activate ] && . %s/activate.d/mkl.sh; }"\n' "${MKLDIR}" >"${MKLDIR}/bin/conda"
chmod +x "${MKLDIR}/bin/conda"
printf 'export MKL_INTERFACE_LAYER="${MKL_INTERFACE_LAYER}"\n' >"${MKLDIR}/activate.d/mkl.sh"
if out="$(PATH="${MKLDIR}/bin:$PATH" bash -c '
      set -euo pipefail
      FS_ENV_MODE=conda; FS_CONDA_ENV=SE3nv
      fs_die() { echo "DIED: $*" >&2; exit 1; }
      source <(sed -n "/^fs_activate_env/,/^}/p" "'"${REPO}"'/hpc/lib/common.sh")
      fs_activate_env SE3nv
      case "$-" in *u*) echo RESTORED ;; *) echo LOST ;; esac' 2>&1)"; then
  check "conda activate survives set -u and restores nounset" "$out" "RESTORED"
else
  bad "fs_activate_env died under set -u: ${out}"
fi
rm -rf "${MKLDIR}"

# ------------------------------------------------------- 7c. sbatch job-id parsing
# Real failure on Mill 2026-11-14: `sbatch --parsable` is documented to print
# just the job id, but Mill's wrapper also prints banner lines ("Requested a
# total of 4 CPU(s)", a requeue-preemption warning, ...). The driver captured
# the whole blob as the job id and the next stage's
# --dependency=afterok:<blob> was rejected, breaking the chain after stage 20.
SBDIR="$(mktemp -d)"
{ printf '#!/usr/bin/env bash\n'
  printf 'echo "sbatch: Warning, you are submitting a job the to the requeue partition."\n'
  printf 'echo "sbatch: Requested a total of 4 CPU(s)"\n'
  printf 'echo "sbatch: GPUs requested: 1 x V100-SXM2-32GB (GPU Type)"\n'
  printf 'echo 2746971\n'; } >"${SBDIR}/sbatch"
chmod +x "${SBDIR}/sbatch"
sb_out="$(PATH="${SBDIR}:$PATH" FS_SKIP_PREFLIGHT=1 FS_HOME_BASE="${SBDIR}/home" \
          bash "${REPO}/hpc/run_pipeline.sh" submit 2>&1 || true)"
check "sbatch banner lines do not become the job id" \
      "$(printf '%s\n' "${sb_out}" | grep -c 'as job 2746971\b')" "4"
check "every stage after the first chains on a bare job id" \
      "$(printf '%s\n' "${sb_out}" | grep -c '(after 2746971)$')" "3"
rm -rf "${SBDIR}"

# ------------------------------------------------------- 7c'. resume parses ids too
# resume had its own copy of the submit loop, with the same banner bug.
RSDIR="$(mktemp -d)"
mkdir -p "${RSDIR}/bin" "${RSDIR}/home/runs/20261114T115930Z/backbones" "${RSDIR}/home/runs/20261114T115930Z/seqs"
: >"${RSDIR}/home/runs/20261114T115930Z/backbones/design_0.pdb"
: >"${RSDIR}/home/runs/20261114T115930Z/seqs/design_0.fa"
{ printf '#!/usr/bin/env bash\n'
  printf 'echo "sbatch: Warning, you are submitting a job the to the requeue partition."\n'
  printf 'echo "sbatch: Requested a total of 4 CPU(s)"\n'
  printf 'echo 2750001\n'; } >"${RSDIR}/bin/sbatch"
chmod +x "${RSDIR}/bin/sbatch"
rs_out="$(PATH="${RSDIR}/bin:$PATH" FS_SKIP_PREFLIGHT=1 FS_NUM_DESIGNS=1 FS_HOME_BASE="${RSDIR}/home" \
          bash "${REPO}/hpc/run_pipeline.sh" resume 20261114T115930Z 2>&1 || true)"
check "resume resubmits only the unfinished stages (predict + export)" \
      "$(printf '%s\n' "${rs_out}" | grep -c '^resubmitted ')" "2"
check "resume chains on a bare job id" \
      "$(printf '%s\n' "${rs_out}" | grep -c 'as job 2750001 (after 2750001)$')" "1"
rm -rf "${RSDIR}"

# ------------------------------------------------------- 7d. status finds the live run
# `status` with no run id used to mint a fresh UTC timestamp, so running it
# seconds after `submit` reported on a directory that never existed and said
# "nothing has started" about a run that was queued and fine.
STDIR="$(mktemp -d)"
mkdir -p "${STDIR}/runs/20261113T090000Z" "${STDIR}/runs/20261114T104316Z"
st_out="$(FS_HOME_BASE="${STDIR}" bash "${REPO}/hpc/run_pipeline.sh" status 2>&1 || true)"
check "status with no arg reports the newest existing run" \
      "$(printf '%s\n' "${st_out}" | sed -n 's/^run_id *//p' | head -1)" "20261114T104316Z"
st_out="$(FS_HOME_BASE="${STDIR}" bash "${REPO}/hpc/run_pipeline.sh" status 20261113T090000Z 2>&1 || true)"
check "an explicit run id still wins" \
      "$(printf '%s\n' "${st_out}" | sed -n 's/^run_id *//p' | head -1)" "20261113T090000Z"
rm -rf "${STDIR}"

# ------------------------------------------------------- 7e. running is not dead
# Mill 2026-11-14: status printed "the job died without running its exit
# handler" about fs-rfd while squeue, six lines above, showed it RUNNING. A
# stage_start with no stage_end looks the same for both; only Slurm can tell.
LVDIR="$(mktemp -d)"
mkdir -p "${LVDIR}/runs/20261114T115930Z/provenance" "${LVDIR}/bin"
printf '%s\n' '{"ts":1,"run_id":"r","stage":"rfdiffusion","event":"stage_start","host":"n1"}' \
  >"${LVDIR}/runs/20261114T115930Z/provenance/events.jsonl"
{ printf '#!/usr/bin/env bash\n'
  printf 'case "$*" in *RUNNING*) [ -n "${FAKE_RUNNING:-}" ] && echo "${FAKE_RUNNING}";; esac\nexit 0\n'; } >"${LVDIR}/bin/squeue"
chmod +x "${LVDIR}/bin/squeue"
lv_out="$(PATH="${LVDIR}/bin:$PATH" FAKE_RUNNING=fs-rfd FS_HOME_BASE="${LVDIR}" bash "${REPO}/hpc/run_pipeline.sh" status 2>&1 || true)"
check "a stage Slurm reports as running is shown as running" \
      "$(printf '%s\n' "${lv_out}" | grep -c 'RUNNING NOW')" "1"
check "and is not given an error line" \
      "$(printf '%s\n' "${lv_out}" | grep -c 'error:')" "0"
lv_out="$(PATH="${LVDIR}/bin:$PATH" FS_HOME_BASE="${LVDIR}" bash "${REPO}/hpc/run_pipeline.sh" status 2>&1 || true)"
check "the same ledger with no live job still reports the missing stage_end" \
      "$(printf '%s\n' "${lv_out}" | grep -c 'no stage_end')" "1"
rm -rf "${LVDIR}"

# ------------------------------------------------------- 8. torn ledger line survives
printf '{"event":"stage_start","stage":"tr' >>"$LEDGER"
printf '\n' >>"$LEDGER"
check "torn line ignored, ledger still readable" "$(count_ev "$LEDGER" demo_ok cmd)" "2"

echo
printf 'test_stage_lib: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
