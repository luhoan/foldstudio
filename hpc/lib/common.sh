#!/usr/bin/env bash
# Shared stage machinery for the FoldStudio HPC pipeline (Stream 3).
#
# Source AFTER env.sh:
#     . "${FS_REPO}/hpc/env.sh"
#     . "${FS_REPO}/hpc/lib/common.sh"
#
# What this gives every stage:
#   fs_stage_begin <name>   bracket a stage; records stage_start and installs an
#                           EXIT trap so stage_end is recorded with the REAL exit
#                           code even when the script aborts under `set -e`
#   fs_run <name> <cmd...>  run one command, timed, logged, argv recorded verbatim
#   fs_is_done / fs_mark_done   per-item checkpoints, so a requeued job resumes
#                               instead of redoing finished work
#   fs_sync_back            copy node-local scratch results into $HOME (authoritative)
#   fs_activate_env         conda / venv / apptainer activation
#   fs_collect_versions     tool versions + git hashes, recorded into the ledger
#
# Design note: /local/scratch is node-local and disappears when a preempted job
# restarts on a different node, so scratch is only ever a cache. Results are
# synced into ${FS_WORK} (in $HOME) after each item and on preemption.

# ---------------------------------------------------------------------- logging
fs_log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fs_die() { fs_log "FATAL: $*"; exit 1; }

FS_LEDGER_PY="${FS_REPO}/hpc/lib/ledger.py"
: "${FS_EVENTS:=${FS_PROV}/events.jsonl}"

# JSON-encode the arguments as an array (correct quoting for any argv).
fs_json_array() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }
fs_json_string() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

# fs_event <event> [extra ledger.py args...]
fs_event() {
  local ev="$1"; shift
  mkdir -p "$(dirname "${FS_EVENTS}")"
  python3 "${FS_LEDGER_PY}" append \
    --file "${FS_EVENTS}" \
    --run-id "${FS_RUN_ID}" \
    --stage "${FS_STAGE:-unknown}" \
    --event "${ev}" "$@" || fs_log "WARNING: could not append '${ev}' to the ledger"
}

fs_note() { fs_event note --kv message="$*"; }

# ------------------------------------------------------------------ timing util
# Seconds since the epoch, with a fractional part. BSD `date` on older macOS has
# no %N and prints a literal "N", so fall back to python there.
fs_now() {
  local t
  t="$(date -u +%s.%N 2>/dev/null || true)"
  case "${t}" in
    ""|*N) python3 -c 'import time; print("%.6f" % time.time())' ;;
    *)     printf '%s\n' "${t}" ;;
  esac
}
fs_elapsed() { python3 -c 'import sys;print(round(float(sys.argv[2])-float(sys.argv[1]),3))' "$1" "$(fs_now)"; }

# ------------------------------------------------------------------ checkpoints
# One marker file per unit of work. Markers live in $HOME (not scratch) so they
# survive a requeue onto another node.
fs_is_done() { [ -f "${FS_CKPT}/${FS_STAGE}.$1.done" ]; }

fs_mark_done() {
  local item="$1"; shift
  mkdir -p "${FS_CKPT}"
  # Record what the marker refers to, so a stale checkpoint can be audited.
  printf 'item=%s\nstage=%s\nrun_id=%s\nmarked_at=%s\nhost=%s\noutputs=%s\n' \
    "$item" "${FS_STAGE}" "${FS_RUN_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)" "$*" \
    >"${FS_CKPT}/${FS_STAGE}.${item}.done"
  fs_event item_done --kv item="$item" --kv host="$(hostname)"
}

fs_clear_done() { rm -f "${FS_CKPT}/${FS_STAGE}.$1.done"; }

# --------------------------------------------------------------- scratch -> home
# fs_sync_back [src] [dst] -- default: whole stage scratch dir into ${FS_WORK}.
fs_sync_back() {
  local src="${1:-${FS_STAGE_SCRATCH:-}}"
  local dst="${2:-${FS_WORK}}"
  [ -n "$src" ] || return 0
  [ -d "$src" ] || return 0
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --partial "$src"/ "$dst"/ || { fs_log "WARNING: rsync back failed"; return 1; }
  else
    cp -a "$src"/. "$dst"/ || { fs_log "WARNING: cp back failed"; return 1; }
  fi
  fs_event checkpoint --kv from="$src" --kv to="$dst" --kv host="$(hostname)"
  return 0
}

# ------------------------------------------------------------------- preemption
# `requeue` jobs can be preempted at any time. #SBATCH --signal=B:USR1@<sec>
# gives us a warning; we flush state and leave a truthful record. Slurm requeues
# the job itself (because of #SBATCH --requeue), and the next attempt resumes
# from the checkpoint markers.
fs_on_preempt() {
  local sig="${1:-USR1}"
  fs_log "received SIG${sig}: flushing state before preemption"
  fs_event preempted --kv signal="$sig" --kv host="$(hostname)"
  fs_sync_back || true
  # Exit non-zero on purpose: this attempt did NOT finish its work, and the
  # ledger must not suggest otherwise.
  FS_STAGE_PREEMPTED=1
  exit 99
}

# ---------------------------------------------------------------- modules
# `module` is a shell function that login shells define. A script started with
# `bash script.sh` usually inherits it, but not always, so look for the init
# files Lmod and Environment Modules install before giving up.
fs_have_module_cmd() {
  command -v module >/dev/null 2>&1 && return 0
  local f had_u=0
  case "$-" in *u*) had_u=1; set +u ;; esac
  for f in /etc/profile.d/lmod.sh /etc/profile.d/z00_lmod.sh /etc/profile.d/modules.sh \
           /usr/share/lmod/lmod/init/bash /usr/share/Modules/init/bash; do
    if [ -r "$f" ]; then
      # shellcheck source=/dev/null
      . "$f" >/dev/null 2>&1 || true
      command -v module >/dev/null 2>&1 && break
    fi
  done
  [ "${had_u}" = 1 ] && set -u
  command -v module >/dev/null 2>&1
}

# fs_module_load <name> -- 0 if the module loaded. An empty name is "do not try".
# Module scripts are not written for `set -u`, so nounset is relaxed around the call.
fs_module_load() {
  [ -n "${1:-}" ] || return 1
  fs_have_module_cmd || return 1
  local had_u=0 rc=0
  case "$-" in *u*) had_u=1; set +u ;; esac
  module load "$1" >/dev/null 2>&1 || rc=$?
  [ "${had_u}" = 1 ] && set -u
  return "${rc}"
}

# fs_ensure_conda -- make `conda` available, loading FS_CONDA_MODULE if need be.
fs_ensure_conda() {
  command -v conda >/dev/null 2>&1 && return 0
  if fs_module_load "${FS_CONDA_MODULE:-}" && command -v conda >/dev/null 2>&1; then
    fs_log "loaded module ${FS_CONDA_MODULE} (provides conda)"
    return 0
  fi
  return 1
}

fs_gcc_major() { gcc -dumpversion 2>/dev/null | cut -d. -f1; }

# fs_ensure_gcc <min-major> -- make a new enough `gcc` available, loading
# FS_GCC_MODULE if the one on PATH is too old or missing.
fs_ensure_gcc() {
  local want="$1" have
  have="$(fs_gcc_major)"
  if [ -n "${have}" ] && [ "${have}" -ge "${want}" ] 2>/dev/null; then return 0; fi
  if fs_module_load "${FS_GCC_MODULE:-}"; then
    have="$(fs_gcc_major)"
    if [ -n "${have}" ] && [ "${have}" -ge "${want}" ] 2>/dev/null; then
      fs_log "loaded module ${FS_GCC_MODULE} (gcc ${have})"
      return 0
    fi
  fi
  return 1
}

# ---------------------------------------------------------------- env / versions
# fs_activate_env [conda-env-name]  -- defaults to ${FS_CONDA_ENV}
fs_activate_env() {
  local want="${1:-${FS_CONDA_ENV}}"
  case "${FS_ENV_MODE}" in
    conda)
      # `conda activate` needs the shell hook in a non-interactive shell.
      if fs_ensure_conda; then
        # Conda's hook and an env's activate.d scripts (MKL's sets
        # MKL_INTERFACE_LAYER from an unset variable) are not written for
        # `set -u`, so relax nounset across activation only and restore it.
        local _fs_had_u=0
        case "$-" in *u*) _fs_had_u=1; set +u ;; esac
        # shellcheck source=/dev/null
        eval "$(conda shell.bash hook)" || { { [ "${_fs_had_u}" = 1 ] && set -u; }; fs_die "conda shell hook failed"; }
        conda activate "${want}" || { { [ "${_fs_had_u}" = 1 ] && set -u; }; fs_die "conda activate ${want} failed (run hpc/10_setup_env.sh first)"; }
        [ "${_fs_had_u}" = 1 ] && set -u || true
      else
        fs_die "FS_ENV_MODE=conda but 'conda' is not on PATH and module '${FS_CONDA_MODULE:-<unset>}' could not be loaded.
Find the right name with 'module avail conda' (on the Mill it is miniconda/miniconda3), then either
'module load <name>' before running this, or set FS_CONDA_MODULE=<name> in hpc/env.local.sh."
      fi
      ;;
    venv)
      [ -f "${FS_VENV_PATH}/bin/activate" ] || fs_die "no venv at ${FS_VENV_PATH} (run hpc/10_setup_env.sh first)"
      # shellcheck source=/dev/null
      . "${FS_VENV_PATH}/bin/activate"
      ;;
    apptainer)
      command -v apptainer >/dev/null 2>&1 || command -v singularity >/dev/null 2>&1 \
        || fs_die "FS_ENV_MODE=apptainer but neither apptainer nor singularity is on PATH"
      [ -f "${FS_APPTAINER_SIF}" ] || fs_die "container image not found: ${FS_APPTAINER_SIF}"
      ;;
    *) fs_die "unknown FS_ENV_MODE='${FS_ENV_MODE}' (expected conda, venv or apptainer)" ;;
  esac
}

fs_git_hash() {
  local dir="$1"
  if [ -d "$dir/.git" ] && command -v git >/dev/null 2>&1; then
    git -C "$dir" rev-parse HEAD 2>/dev/null || echo "unknown"
  else
    echo "not_a_git_checkout"
  fi
}

# Record versions + git hashes as they really are. "unknown"/"absent" is a valid
# answer; a wrong guess is not.
fs_collect_versions() {
  local py torch cuda_mod nvsmi
  py="$(python3 -V 2>&1 || echo unknown)"
  torch="$(python3 -c 'import torch;print(torch.__version__, "cuda", torch.version.cuda, "available", torch.cuda.is_available())' 2>/dev/null || echo "torch_not_importable")"
  cuda_mod="${FS_CUDA_MODULE:-unset}"
  nvsmi="$(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null | paste -sd'; ' - || echo "nvidia-smi_unavailable")"
  fs_event note \
    --kv message="tool versions collected" \
    --json-kv tool_versions="$(python3 - "$py" "$torch" "$cuda_mod" "$nvsmi" <<'PY'
import json, sys
print(json.dumps({"python": sys.argv[1], "torch": sys.argv[2],
                  "cuda_module": sys.argv[3], "nvidia_smi": sys.argv[4]}))
PY
)" \
    --json-kv git="$(python3 - "$(fs_git_hash "${FS_REPO}")" "$(fs_git_hash "${FS_RFDIFFUSION_DIR}")" "$(fs_git_hash "${FS_PROTEINMPNN_DIR}")" <<'PY'
import json, sys
print(json.dumps({"foldstudio": sys.argv[1], "rfdiffusion": sys.argv[2], "proteinmpnn": sys.argv[3]}))
PY
)"
}

# ------------------------------------------------------------------ run a command
# fs_run <name> <cmd> [args...]
# Records argv verbatim, wall time and exit status; streams output to a log file.
# Returns the command's exit status (callers decide whether it is fatal).
fs_run() {
  local name="$1"; shift
  local log="${FS_LOGS}/${FS_STAGE}.${name}.log"
  mkdir -p "${FS_LOGS}"
  local t0 rc=0
  t0="$(fs_now)"
  fs_log "run[${name}]: $*"
  {
    echo "### $(date -u +%Y-%m-%dT%H:%M:%SZ) host=$(hostname) cwd=$(pwd)"
    echo "### argv: $*"
  } >>"$log"
  "$@" >>"$log" 2>&1 || rc=$?
  local wall
  wall="$(fs_elapsed "$t0")"
  fs_event cmd \
    --kv name="$name" \
    --kv cwd="$(pwd)" \
    --kv log="${log#"${FS_WORK}"/}" \
    --kv host="$(hostname)" \
    --json-kv argv="$(fs_json_array "$@")" \
    --json-kv exit="$rc" \
    --json-kv wall_seconds="$wall"
  if [ "$rc" -ne 0 ]; then
    fs_log "run[${name}] FAILED exit=${rc} (tail of ${log}):"
    tail -n 20 "$log" >&2 || true
  fi
  return "$rc"
}

# ------------------------------------------------------------- stage bracketing
# fs_stage_begin <stage-name>
# Installs an EXIT trap that records stage_end with the real exit status, so an
# aborted stage is recorded as aborted rather than vanishing from the ledger.
fs_stage_begin() {
  FS_STAGE="$1"
  export FS_STAGE
  FS_STAGE_T0="$(fs_now)"
  FS_STAGE_PREEMPTED=0
  FS_STAGE_ENDED=0
  fs_mkdirs
  FS_STAGE_SCRATCH="${FS_SCRATCH}/${FS_STAGE}"
  export FS_STAGE_SCRATCH
  mkdir -p "${FS_STAGE_SCRATCH}" 2>/dev/null || {
    fs_log "WARNING: cannot create ${FS_STAGE_SCRATCH}; falling back to \$HOME work dir"
    FS_STAGE_SCRATCH="${FS_WORK}/scratch-fallback/${FS_STAGE}"
    mkdir -p "${FS_STAGE_SCRATCH}"
  }

  trap 'fs_on_preempt USR1' USR1
  trap 'fs_on_preempt TERM' TERM
  trap 'fs_stage_end_trap $?' EXIT

  fs_event stage_start \
    --kv host="$(hostname)" \
    --kv scratch="${FS_STAGE_SCRATCH}" \
    --json-kv slurm="$(python3 - <<'PY'
import json, os
keys = ("SLURM_JOB_ID", "SLURM_ARRAY_TASK_ID", "SLURM_JOB_PARTITION", "SLURM_JOB_ACCOUNT",
        "SLURM_JOB_NODELIST", "SLURM_RESTART_COUNT", "SLURM_CPUS_ON_NODE", "SLURM_MEM_PER_NODE",
        "SLURM_JOB_QOS", "SLURM_GPUS", "SLURM_JOB_GPUS", "CUDA_VISIBLE_DEVICES")
print(json.dumps({k: os.environ[k] for k in keys if os.environ.get(k)}))
PY
)" \
    --json-kv settings="$(python3 - <<'PY'
import json, os
keys = ("FS_CONTIG", "FS_NUM_DESIGNS", "FS_SEQS_PER_DESIGN", "FS_MPNN_TEMP", "FS_MPNN_MODEL",
        "FS_SEED", "FS_PREDICTOR", "FS_PARTITION", "FS_GPU_GRES", "FS_ENV_MODE",
        "FS_RFD_EXTRA_ARGS", "FS_MPNN_EXTRA_ARGS")
# str.removeprefix is 3.9+; slice instead so this works on Alma 8's system python3.
print(json.dumps({k[3:].lower(): os.environ[k] for k in keys if os.environ.get(k) is not None}))
PY
)" \
    --json-kv seeds="$(python3 - "${FS_SEED}" <<'PY'
import json, sys
print(json.dumps({"base": int(sys.argv[1])}))
PY
)"

  fs_log "stage '${FS_STAGE}' begin (run_id=${FS_RUN_ID}, attempt restart_count=${SLURM_RESTART_COUNT:-0})"
}

# fs_stage_finish [outputs-json]
# Record a successful stage_end ONCE, with the real output list. Use this at the
# end of a stage that knows what it produced; the EXIT trap then stays quiet so
# the ledger never contains two stage_end events for one attempt.
fs_stage_finish() {
  local outputs="${1:-[]}"
  local wall
  wall="$(fs_elapsed "${FS_STAGE_T0}")" || wall=null
  fs_sync_back || true
  fs_event stage_end \
    --kv host="$(hostname)" \
    --json-kv exit=0 \
    --json-kv wall_seconds="$wall" \
    --json-kv outputs="$outputs"
  FS_STAGE_ENDED=1
  fs_log "stage '${FS_STAGE}' finished cleanly wall=${wall}s"
}

# Called by the EXIT trap. Never let bookkeeping change the script's exit status.
fs_stage_end_trap() {
  local rc="${1:-0}"
  trap - EXIT
  if [ "${FS_STAGE_PREEMPTED:-0}" = "1" ]; then
    # fs_on_preempt already recorded the truth; do not also claim a clean end.
    return 0
  fi
  if [ "${FS_STAGE_ENDED:-0}" = "1" ]; then
    # fs_stage_finish already recorded stage_end with the real output list.
    # If we are nonetheless exiting non-zero, that happened after the work was
    # done and recorded -- say so rather than silently dropping it.
    [ "$rc" -ne 0 ] && fs_event note --kv message="non-zero exit ${rc} after stage_end was recorded"
    return 0
  fi
  local wall
  wall="$(fs_elapsed "${FS_STAGE_T0}")" || wall=null
  fs_sync_back || true
  local err_args=()
  if [ "$rc" -ne 0 ]; then
    err_args=(--kv error="stage '${FS_STAGE}' exited with status ${rc}; see ${FS_LOGS}/ for the failing command's output")
  fi
  fs_event stage_end \
    --kv host="$(hostname)" \
    --json-kv exit="$rc" \
    --json-kv wall_seconds="$wall" \
    "${err_args[@]+"${err_args[@]}"}"
  fs_log "stage '${FS_STAGE}' end exit=${rc} wall=${wall}s"
  return 0
}

# --------------------------------------------------------- partition preflight
# Convert a Slurm time string to seconds.
#   -1 = no limit (UNLIMITED/INFINITE), -2 = unparseable
# Slurm writes MaxTime as minutes, mm:ss, hh:mm:ss, d-hh, d-hh:mm or d-hh:mm:ss.
fs_time_to_seconds() {
  python3 - "${1:-}" <<'PY'
import re, sys
s = (sys.argv[1] or "").strip().upper()
if s in ("", "UNLIMITED", "INFINITE", "NONE", "N/A"):
    print(-1); raise SystemExit(0)
days = 0
if "-" in s:
    d, _, s = s.partition("-")
    if not d.isdigit():
        print(-2); raise SystemExit(0)
    days = int(d)
parts = s.split(":") if s else ["0"]
if not all(p.isdigit() for p in parts if p != ""):
    print(-2); raise SystemExit(0)
nums = [int(p) for p in parts]
if len(nums) == 1:
    # bare number: minutes without a day part, hours with one
    secs = nums[0] * 3600 if days else nums[0] * 60
elif len(nums) == 2:
    # d-hh:mm  ->  hours:minutes ; mm:ss without a day part
    secs = nums[0] * 3600 + nums[1] * 60 if days else nums[0] * 60 + nums[1]
elif len(nums) == 3:
    secs = nums[0] * 3600 + nums[1] * 60 + nums[2]
else:
    print(-2); raise SystemExit(0)
print(days * 86400 + secs)
PY
}

# fs_partition_exists <name>
fs_partition_exists() {
  command -v scontrol >/dev/null 2>&1 || return 2
  scontrol show partition "$1" >/dev/null 2>&1
}

# fs_partition_max_seconds <name> -- real MaxTime from scontrol
fs_partition_max_seconds() {
  local raw
  raw="$(scontrol show partition "$1" 2>/dev/null | tr ' ' '\n' | sed -n 's/^MaxTime=//p' | head -1)"
  fs_time_to_seconds "${raw}"
}

# fs_partition_gres <name> -- GRES advertised by this partition's nodes, or empty
fs_partition_gres() {
  command -v sinfo >/dev/null 2>&1 || return 0
  sinfo -h -p "$1" -o '%G' 2>/dev/null | sort -u | tr '\n' ' '
}

# fs_check_walltime <partition> <requested-time> <label>
# Refuse to submit a job the partition will never schedule. A job asking for more
# than MaxTime is rejected by sbatch (or sits PENDING forever), which on a short
# coursework partition is an easy and expensive mistake.
fs_check_walltime() {
  local part="$1" want="$2" label="$3"
  local maxs wants
  maxs="$(fs_partition_max_seconds "${part}")"
  wants="$(fs_time_to_seconds "${want}")"
  if [ "${maxs}" = "-2" ] || [ "${wants}" = "-2" ]; then
    fs_log "note: could not compare '${want}' against partition ${part} MaxTime; skipping the check"
    return 0
  fi
  if [ "${maxs}" = "-1" ]; then
    return 0   # no limit
  fi
  if [ "${wants}" -gt "${maxs}" ]; then
    fs_die "${label}: requested --time=${want} ($(( wants / 60 )) min) exceeds partition
'${part}' MaxTime of $(( maxs / 60 )) min. Slurm will refuse this job or leave it
pending forever. Lower it, e.g.:

    FS_TIME_GPU=$(printf '%02d:%02d:00' $(( maxs / 3600 )) $(( (maxs % 3600) / 60 )) ) \\
    FS_TIME_CPU=00:30:00 bash hpc/run_pipeline.sh submit

Every stage checkpoints and resumes, so several short jobs are fine: use
'bash hpc/run_pipeline.sh resume <RUN_ID>' to continue where a stage left off."
  fi
  return 0
}

# ------------------------------------------------------------------ misc guards
fs_require_gpu() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    fs_die "no nvidia-smi: this stage needs a GPU. Submit it with sbatch (do not run it on a login node)."
  fi
  nvidia-smi -L >/dev/null 2>&1 || fs_die "nvidia-smi found no GPU on $(hostname)"
}

# The ledger needs python >= 3.7 (PEP 563 annotations). Alma 8's /usr/bin/python3
# can be 3.6, so check loudly rather than failing with a confusing SyntaxError.
fs_require_python() {
  python3 - <<'PY' || fs_die "python3 is older than 3.7 and hpc/env.sh found no newer interpreter to use instead.
Point it at one: add  FS_PYTHON=/path/to/python3.x  to hpc/env.local.sh (on the Mill, /usr/bin/python3.11 exists)."
import sys
raise SystemExit(0 if sys.version_info >= (3, 7) else 1)
PY
}

fs_require_login_node() {
  if [ -n "${SLURM_JOB_ID:-}" ]; then
    fs_log "note: running inside Slurm job ${SLURM_JOB_ID}"
  fi
}
