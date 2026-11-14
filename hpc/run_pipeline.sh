#!/usr/bin/env bash
# Stream 3 driver -- submit, watch, resume and export one pipeline run.
#
#     bash hpc/run_pipeline.sh preflight     # does this partition allow what we ask for?
#     bash hpc/run_pipeline.sh submit        # submit stages 20->30->40->50
#     bash hpc/run_pipeline.sh status        # squeue + per-stage ledger summary
#     bash hpc/run_pipeline.sh resume <RUN>  # resubmit only the unfinished stages
#     bash hpc/run_pipeline.sh export <RUN>  # build the bundle from a finished run
#     bash hpc/run_pipeline.sh dry-run       # offline bundle-format check, no Slurm
#     bash hpc/run_pipeline.sh plan          # print the exact sbatch commands, submit nothing
#
# Stages are chained with --dependency=afterok, so a failed stage stops the ones
# after it instead of exporting half a run as if it were whole. Every sbatch
# command, job id, tool version, git hash, seed and setting is written to the
# run's append-only ledger, which the exported bundle carries.
#
# Run this from a LOGIN NODE. It only calls sbatch/squeue; the work happens in
# the jobs.
#
# NOT YET EXECUTED ON THE MILL -- see "What has and has not run" in hpc/README.md.

set -o errexit
set -o nounset
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpc/env.sh
. "${HERE}/env.sh"
# shellcheck source=hpc/lib/common.sh
. "${HERE}/lib/common.sh"

# sbatch options assembled from env.sh, because #SBATCH directives inside the
# stage files cannot read shell variables.
common_sbatch_args() {
  local logname="$1"
  local -a a=(
    --partition="${FS_PARTITION}"
    --requeue
    --open-mode=append
    --signal="B:USR1@${FS_SIGNAL_SEC}"
    --output="${FS_LOGS}/${logname}-%j.out"
    --error="${FS_LOGS}/${logname}-%j.out"
    --export="ALL,FS_RUN_ID=${FS_RUN_ID},FS_REPO=${FS_REPO}"
    --job-name="${logname}"
  )
  [ -n "${FS_ACCOUNT}" ] && a+=(--account="${FS_ACCOUNT}")
  printf '%s\n' "${a[@]}"
}

gpu_sbatch_args() {
  printf '%s\n' --gres="${FS_GPU_GRES}" --time="${FS_TIME_GPU}" \
    --cpus-per-task="${FS_CPUS}" --mem="${FS_MEM}"
}

cpu_sbatch_args() {
  printf '%s\n' --time="${FS_TIME_CPU}" --cpus-per-task="${FS_CPUS}" --mem=16G
}

# build_cmd <stage-file> <logname> <gpu|cpu> [dependency-jobid]
build_cmd() {
  local file="$1" logname="$2" kind="$3" dep="${4:-}"
  local -a cmd=(sbatch)
  mapfile -t base < <(common_sbatch_args "${logname}")
  cmd+=("${base[@]}")
  if [ "${kind}" = "gpu" ]; then
    mapfile -t extra < <(gpu_sbatch_args)
  else
    mapfile -t extra < <(cpu_sbatch_args)
  fi
  cmd+=("${extra[@]}")
  [ -n "${dep}" ] && cmd+=(--dependency="afterok:${dep}")
  cmd+=(--parsable "${HERE}/${file}")
  printf '%s\n' "${cmd[@]}"
}

# Stage table: file | log name | gpu/cpu
STAGES=(
  "20_rfdiffusion.sbatch|fs-rfd|gpu"
  "30_proteinmpnn.sbatch|fs-mpnn|cpu"
  "40_predict.sbatch|fs-pred|gpu"
  "50_export.sbatch|fs-export|cpu"
)

need_sbatch() {
  command -v sbatch >/dev/null 2>&1 \
    || fs_die "sbatch is not on PATH. Run this on a Mill login node, or use 'dry-run' to check the bundle format offline."
}

do_plan() {
  fs_print_config
  echo
  echo "These are the exact commands 'submit' would run (dependencies chain afterok):"
  # PREV_JOBID stands in for the id Slurm returns for the stage before this one.
  local dep="PREV_JOBID"
  for row in "${STAGES[@]}"; do
    IFS='|' read -r file logname kind <<<"${row}"
    echo
    mapfile -t planned < <(build_cmd "${file}" "${logname}" "${kind}" "${dep}")
    printf '  %s' "${planned[0]}"
    printf ' \\\n      %s' "${planned[@]:1}"
    echo
  done
  echo
  echo "(the first stage is submitted without --dependency)"
}

# Check the partition can actually run what we are about to ask for, BEFORE
# submitting anything. A job over MaxTime is rejected or pends forever, and on a
# 4-hour coursework partition that is an easy mistake to make.
#   walltime over the cap -> hard failure (scontrol's MaxTime is reliable)
#   no GPU GRES visible   -> loud warning (sinfo's %G is not always populated)
# Set FS_SKIP_PREFLIGHT=1 to bypass.
do_preflight() {
  local want_gpu="${1:-yes}"
  if [ "${FS_SKIP_PREFLIGHT:-0}" = "1" ]; then
    fs_log "FS_SKIP_PREFLIGHT=1: skipping partition preflight"
    return 0
  fi
  command -v scontrol >/dev/null 2>&1 || {
    fs_log "note: scontrol not available, skipping partition preflight"
    return 0
  }

  echo "--- preflight: partition '${FS_PARTITION}' ---"
  if ! fs_partition_exists "${FS_PARTITION}"; then
    fs_die "partition '${FS_PARTITION}' does not exist on this cluster.
Run 'bash hpc/00_discover.sh' and set FS_PARTITION to one you are allowed to use
(its section 2 lists your associations)."
  fi

  local maxs gres
  maxs="$(fs_partition_max_seconds "${FS_PARTITION}")"
  gres="$(fs_partition_gres "${FS_PARTITION}")"
  if [ "${maxs}" = "-1" ]; then
    echo "  MaxTime : unlimited"
  elif [ "${maxs}" = "-2" ]; then
    echo "  MaxTime : could not be parsed (skipping the wall-time check)"
  else
    printf '  MaxTime : %s min\n' "$(( maxs / 60 ))"
  fi
  echo "  GRES    : ${gres:-<none advertised>}"

  fs_check_walltime "${FS_PARTITION}" "${FS_TIME_GPU}" "GPU stages (20, 40)"
  fs_check_walltime "${FS_PARTITION}" "${FS_TIME_CPU}" "CPU stages (30, 50)"

  if [ "${want_gpu}" = "yes" ] && ! printf '%s' "${gres}" | grep -qi 'gpu'; then
    cat >&2 <<EOF

  WARNING: partition '${FS_PARTITION}' advertises no GPU GRES in sinfo output.
  Stages 20 (RFdiffusion) and 40 (prediction) need a GPU and will fail or pend.
  Options, in order of preference:
    1. set FS_PARTITION to one that has GPUs (see hpc/DISCOVERED.md section 5);
    2. run the two GPU stages off-cluster and bring the files back --
       hpc/OFFLOAD.md gives the exact file contract;
    3. skip Stream 3. The app is complete without it, and nothing gets
       labelled "Executed".
  sinfo's GRES column is not always populated, so this is a warning, not a stop.
  Override with FS_SKIP_PREFLIGHT=1 if you know the partition really has GPUs.

EOF
  fi
  echo "  walltime: OK for both GPU and CPU stages"
  echo
  return 0
}

do_submit() {
  need_sbatch
  do_preflight yes
  fs_mkdirs
  FS_STAGE="driver"
  export FS_STAGE

  fs_event stage_start --kv host="$(hostname)" --kv role="driver" \
    --json-kv settings="$(python3 - <<'PY'
import json, os
keys = ("FS_PARTITION", "FS_ACCOUNT", "FS_GPU_GRES", "FS_TIME_GPU", "FS_TIME_CPU", "FS_CPUS",
        "FS_MEM", "FS_CONTIG", "FS_NUM_DESIGNS", "FS_SEQS_PER_DESIGN", "FS_MPNN_TEMP",
        "FS_MPNN_MODEL", "FS_SEED", "FS_PREDICTOR", "FS_ENV_MODE", "FS_SIGNAL_SEC")
print(json.dumps({k[3:].lower(): os.environ.get(k, "") for k in keys}))
PY
)"
  fs_collect_versions

  echo "run_id   ${FS_RUN_ID}"
  echo "work dir ${FS_WORK}"
  echo

  local dep=""
  local -a submitted=()
  for row in "${STAGES[@]}"; do
    IFS='|' read -r file logname kind <<<"${row}"
    mapfile -t cmd < <(build_cmd "${file}" "${logname}" "${kind}" "${dep}")

    # Mill's sbatch prints banner lines ("sbatch: Requested a total of 4 CPU(s)",
    # a requeue-preemption warning, ...) around the id that --parsable emits, so
    # the output cannot be used as the job id wholesale: keep stderr separate and
    # take the last bare "<jobid>" or "<jobid>;<cluster>" line from stdout.
    local jid rc=0 raw err
    err="$(mktemp)"
    raw="$("${cmd[@]}" 2>"${err}")" || rc=$?
    jid="$(printf '%s\n' "${raw}" | sed -n 's/^\([0-9][0-9]*\)\(;.*\)\?$/\1/p' | tail -1)"
    if [ "${rc}" -ne 0 ] || [ -z "${jid}" ]; then
      raw="${raw}$(printf '\n--- stderr ---\n')$(cat "${err}")"
      rm -f "${err}"
      jid="${raw}"
      fs_event cmd --kv name="submit_${logname}" --kv host="$(hostname)" \
        --json-kv argv="$(fs_json_array "${cmd[@]}")" --json-kv exit="${rc:-1}" \
        --kv error="sbatch output: ${jid}"
      fs_die "sbatch failed for ${file}: ${jid}
Already-submitted jobs: ${submitted[*]:-none}. Cancel them with: scancel ${submitted[*]:-}"
    fi
    rm -f "${err}"
    submitted+=("${jid}")
    echo "submitted ${file} as job ${jid}${dep:+ (after ${dep})}"

    # The exact submit command and the job id it produced, recorded verbatim.
    fs_event cmd --kv name="submit_${logname}" --kv host="$(hostname)" \
      --json-kv argv="$(fs_json_array "${cmd[@]}")" --json-kv exit=0 \
      --json-kv slurm="$(python3 - "${logname}" "${jid}" <<'PY'
import json, sys
print(json.dumps({f"submitted_{sys.argv[1]}": sys.argv[2]}))
PY
)"
    dep="${jid}"
  done

  fs_event note --kv message="driver submitted ${#submitted[@]} jobs: ${submitted[*]}"
  echo
  echo "watch it with:   bash hpc/run_pipeline.sh status"
  echo "cancel it with:  scancel ${submitted[*]}"
  echo
  echo "NOTE: on the '${FS_PARTITION}' partition these jobs can be preempted at any"
  echo "      time. They are submitted with --requeue and resume from checkpoints,"
  echo "      so preemption shows up as extra attempts in the ledger, not lost work."
}

do_status() {
  echo "run_id   ${FS_RUN_ID}"
  echo "work dir ${FS_WORK}"
  echo
  if command -v squeue >/dev/null 2>&1; then
    echo "--- squeue ---"
    squeue -u "${FS_USER}" -o '%.10i %.12P %.14j %.8T %.10M %.6D %R' || true
  else
    echo "(squeue not available here)"
  fi
  echo
  echo "--- files produced so far ---"
  printf '  backbones : %s\n' "$(find "${FS_BACKBONES}" -maxdepth 1 -name '*.pdb' 2>/dev/null | wc -l)"
  printf '  sequences : %s\n' "$(find "${FS_SEQS}" -maxdepth 1 -name '*.fa' 2>/dev/null | wc -l)"
  printf '  predicted : %s\n' "$(find "${FS_PRED}" -maxdepth 1 -name '*.pdb' 2>/dev/null | wc -l)"
  echo
  if [ -f "${FS_EVENTS}" ]; then
    echo "--- ledger summary ---"
    # Rendering lives in ledger.py: inline python here would need backslashes
    # inside f-strings, which is a syntax error before python 3.12.
    python3 "${FS_LEDGER_PY}" pretty --file "${FS_EVENTS}"
  else
    echo "no ledger yet at ${FS_EVENTS} (nothing has started)"
  fi
}

# Resubmit only what is not finished, reusing the same RUN_ID so checkpoints apply.
do_resume() {
  need_sbatch
  do_preflight yes
  [ -d "${FS_WORK}" ] || fs_die "no such run directory: ${FS_WORK}
Pass the run id:  bash hpc/run_pipeline.sh resume <RUN_ID>"
  fs_mkdirs
  FS_STAGE="driver"
  export FS_STAGE

  local have_bb have_seq have_pred
  have_bb="$(find "${FS_BACKBONES}" -maxdepth 1 -name '*.pdb' 2>/dev/null | wc -l)"
  have_seq="$(find "${FS_SEQS}" -maxdepth 1 -name '*.fa' 2>/dev/null | wc -l)"
  have_pred="$(find "${FS_PRED}" -maxdepth 1 -name '*.pdb' 2>/dev/null | wc -l)"

  # A stage is "done" only when it produced the number of outputs we asked for.
  local -a todo=()
  [ "${have_bb}" -ge "${FS_NUM_DESIGNS}" ] || todo+=("20_rfdiffusion.sbatch|fs-rfd|gpu")
  [ "${have_seq}" -ge "${have_bb}" ] && [ "${have_seq}" -gt 0 ] || todo+=("30_proteinmpnn.sbatch|fs-mpnn|cpu")
  [ "${have_pred}" -gt 0 ] || todo+=("40_predict.sbatch|fs-pred|gpu")
  todo+=("50_export.sbatch|fs-export|cpu")

  echo "run_id ${FS_RUN_ID}: backbones=${have_bb}/${FS_NUM_DESIGNS} seqs=${have_seq} pred=${have_pred}"
  echo "resubmitting ${#todo[@]} stage(s). Finished items are skipped by their checkpoints."
  echo

  local dep=""
  for row in "${todo[@]}"; do
    IFS='|' read -r file logname kind <<<"${row}"
    mapfile -t cmd < <(build_cmd "${file}" "${logname}" "${kind}" "${dep}")
    local jid rc=0
    jid="$("${cmd[@]}" 2>&1)" || rc=$?
    [ "${rc}" -eq 0 ] && [ -n "${jid//[!0-9]/}" ] || fs_die "sbatch failed for ${file}: ${jid}"
    jid="${jid%%;*}"
    echo "resubmitted ${file} as job ${jid}${dep:+ (after ${dep})}"
    fs_event cmd --kv name="resubmit_${logname}" --kv host="$(hostname)" \
      --json-kv argv="$(fs_json_array "${cmd[@]}")" --json-kv exit=0
    dep="${jid}"
  done
}

do_export() {
  [ -d "${FS_WORK}" ] || fs_die "no such run directory: ${FS_WORK}"
  python3 "${HERE}/export_bundle.py" --work-dir "${FS_WORK}" --data-dir "${FS_REPO}/data" "$@"
}

do_dry_run() {
  local out="${FS_DRY_DATA_DIR:-${FS_REPO}/data}"
  echo "dry run: building a 'demo' bundle from the real fixtures into ${out}/experiments/"
  python3 "${HERE}/export_bundle.py" --dry-run --data-dir "${out}" "$@"
}

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

subcmd="${1:-}"
shift || true
case "${subcmd}" in
  submit)  do_submit ;;
  status)
    [ -n "${1:-}" ] && fs_set_run_id "$1"
    do_status ;;
  resume)
    [ -n "${1:-}" ] || fs_die "resume needs a run id: bash hpc/run_pipeline.sh resume <RUN_ID>"
    fs_set_run_id "$1"; shift
    do_resume ;;
  export)
    [ -n "${1:-}" ] || fs_die "export needs a run id: bash hpc/run_pipeline.sh export <RUN_ID>"
    fs_set_run_id "$1"; shift
    do_export "$@" ;;
  dry-run)   do_dry_run "$@" ;;
  plan)      do_plan ;;
  preflight) do_preflight "${1:-yes}" ;;
  ""|-h|--help|help) usage ;;
  *) fs_die "unknown command '${subcmd}'. Try: preflight | submit | status | resume | export | dry-run | plan" ;;
esac
