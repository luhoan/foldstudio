#!/usr/bin/env bash
# Stream 3 driver -- submit, watch, resume and export one pipeline run.
#
#     bash hpc/run_pipeline.sh preflight     # does this partition allow what we ask for?
#     bash hpc/run_pipeline.sh submit        # submit stages 20->30->40->50
#     bash hpc/run_pipeline.sh status        # squeue + per-stage ledger summary
#     bash hpc/run_pipeline.sh resume [RUN]  # resubmit only the unfinished stages
#     bash hpc/run_pipeline.sh export [RUN]  # build the bundle from a finished run
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
# `status`, `resume` and `export` take the newest run when no run id is given.
#
# Ran on the Mill on 2026-11-14 (preflight, plan, submit, status, resume); what
# that run did and did not show is in "What has and has not run" in hpc/README.md.
#
# Written for bash 3.2 and BSD tools as well as the cluster's, because
# hpc/tests/test_stage_lib.sh drives it on a laptop: no mapfile, no GNU-only
# sed/find/grep options.

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
# Prints the sbatch command, one argument per line.
build_cmd() {
  local file="$1" logname="$2" kind="$3" dep="${4:-}"
  echo sbatch
  common_sbatch_args "${logname}"
  if [ "${kind}" = "gpu" ]; then gpu_sbatch_args; else cpu_sbatch_args; fi
  [ -n "${dep}" ] && echo "--dependency=afterok:${dep}"
  echo --parsable
  echo "${HERE}/${file}"
}

# read_cmd <stage-file> <logname> <gpu|cpu> [dependency-jobid]
# Fills the global array CMD with that command (bash 3.2 has no mapfile).
read_cmd() {
  local line
  CMD=()
  while IFS= read -r line; do CMD+=("${line}"); done < <(build_cmd "$@")
}

# Stage table: file | log name | gpu/cpu
STAGES=(
  "20_rfdiffusion.sbatch|fs-rfd|gpu"
  "30_proteinmpnn.sbatch|fs-mpnn|cpu"
  "40_predict.sbatch|fs-pred|gpu"
  "50_export.sbatch|fs-export|cpu"
)

# Slurm job name -> the stage name that script writes into the ledger, so
# `status` can tell a stage that is running from one that died. The ledger
# cannot know the difference; only the scheduler can.
fs_stage_for_jobname() {
  case "$1" in
    fs-rfd)    echo "rfdiffusion" ;;
    fs-mpnn)   echo "proteinmpnn" ;;
    fs-pred)   echo "predict_${FS_PREDICTOR}" ;;
    fs-export) echo "export_bundle" ;;
    *)         echo "" ;;
  esac
}

# fs_sbatch_jobid <sbatch argv...> -- submit, print ONLY the job id on stdout.
# Mill's sbatch prints banner lines around the id that --parsable emits (a
# requeue-preemption warning, "Requested a total of 4 CPU(s)", ...), so the id
# is the last bare "<jobid>" or "<jobid>;<cluster>" line. On failure, prints
# everything sbatch said to stderr and returns non-zero.
fs_sbatch_jobid() {
  local raw err rc=0 jid
  err="$(mktemp)"
  raw="$("$@" 2>"${err}")" || rc=$?
  jid="$(printf '%s\n' "${raw}" | sed -n -E 's/^([0-9]+)(;.*)?$/\1/p' | tail -1)"
  if [ "${rc}" -ne 0 ] || [ -z "${jid}" ]; then
    { printf '%s\n' "${raw}"; cat "${err}"; } >&2
    rm -f "${err}"
    return 1
  fi
  rm -f "${err}"
  printf '%s\n' "${jid}"
}

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
    read_cmd "${file}" "${logname}" "${kind}" "${dep}"
    printf '  %s' "${CMD[0]}"
    printf ' \\\n      %s' "${CMD[@]:1}"
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
  # A typed request ("gpu:V100-SXM2-32GB:1") names a GPU model. If the partition
  # advertises GPUs but not that model, the job pends forever with
  # "ReqNodeNotAvail" or is rejected. A bare "gpu:1" is the opposite risk.
  local gres_type=""
  case "${FS_GPU_GRES}" in
    gpu:*:*) gres_type="${FS_GPU_GRES#gpu:}"; gres_type="${gres_type%:*}" ;;
  esac
  if [ "${want_gpu}" = "yes" ] && printf '%s' "${gres}" | grep -qi 'gpu'; then
    if [ -n "${gres_type}" ]; then
      if printf '%s' "${gres}" | grep -qiF "gpu:${gres_type}:"; then
        echo "  GPU type: ${gres_type} is offered by this partition"
      else
        cat >&2 <<EOF

  WARNING: FS_GPU_GRES asks for GPU type '${gres_type}', which partition
  '${FS_PARTITION}' does not advertise (it lists: ${gres}).
  The GPU stages would be rejected or pend forever. Copy the exact type from
      sinfo -p ${FS_PARTITION} -o '%G'
  into FS_GPU_GRES in hpc/env.local.sh.

EOF
      fi
    else
      cat >&2 <<EOF

  NOTE: FS_GPU_GRES='${FS_GPU_GRES}' names no GPU type, so Slurm may hand out any
  GPU this partition has (${gres}). RFdiffusion's environment cannot run on an
  H100; name a V100 type in FS_GPU_GRES to be safe.

EOF
    fi
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
    read_cmd "${file}" "${logname}" "${kind}" "${dep}"

    local jid rc=0 errtxt
    errtxt="$(mktemp)"
    jid="$(fs_sbatch_jobid "${CMD[@]}" 2>"${errtxt}")" || rc=$?
    if [ "${rc}" -ne 0 ]; then
      fs_event cmd --kv name="submit_${logname}" --kv host="$(hostname)" \
        --json-kv argv="$(fs_json_array "${CMD[@]}")" --json-kv exit="${rc}" \
        --kv error="sbatch output: $(cat "${errtxt}")"
      fs_die "sbatch failed for ${file}: $(cat "${errtxt}")
Already-submitted jobs: ${submitted[*]:-none}. Cancel them with: scancel ${submitted[*]:-}"
    fi
    rm -f "${errtxt}"
    submitted+=("${jid}")
    echo "submitted ${file} as job ${jid}${dep:+ (after ${dep})}"

    # The exact submit command and the job id it produced, recorded verbatim.
    fs_event cmd --kv name="submit_${logname}" --kv host="$(hostname)" \
      --json-kv argv="$(fs_json_array "${CMD[@]}")" --json-kv exit=0 \
      --json-kv slurm="$(python3 - "${logname}" "${jid}" <<'PY'
import json, sys
print(json.dumps({f"submitted_{sys.argv[1]}": sys.argv[2]}))
PY
)"
    dep="${jid}"
  done

  fs_event note --kv message="driver submitted ${#submitted[@]} jobs: ${submitted[*]}"

  # The driver's work is submitting, and it is now done. Without this stage_end
  # the ledger reads the missing one as "the job died without running its exit
  # handler", and export_bundle.py folds that phantom error into the bundle --
  # downgrading a wholly successful run from "ok" to "partial".
  fs_event stage_end --kv host="$(hostname)" --json-kv exit=0 \
    --json-kv outputs="$(fs_json_array "${submitted[@]}")"
  echo
  echo "watch it with:   bash hpc/run_pipeline.sh status"
  echo "cancel it with:  scancel ${submitted[*]}"
  echo
  echo "NOTE: on the '${FS_PARTITION}' partition these jobs can be preempted at any"
  echo "      time. They are submitted with --requeue and resume from checkpoints,"
  echo "      so preemption shows up as extra attempts in the ledger, not lost work."
}

# fs_latest_run_id -- newest run directory under ${FS_RUNS_DIR}, or empty.
# Run ids are UTC timestamps, so lexical order is chronological order.
fs_latest_run_id() {
  [ -d "${FS_RUNS_DIR}" ] || return 0
  local d name latest=""
  for d in "${FS_RUNS_DIR}"/*/; do
    [ -d "${d}" ] || continue
    name="${d%/}"; name="${name##*/}"
    if [ -z "${latest}" ] || [[ "${name}" > "${latest}" ]]; then latest="${name}"; fi
  done
  [ -n "${latest}" ] && printf '%s\n' "${latest}"
  return 0
}

# fs_count <dir> <glob> -- number of matching files directly in a directory.
# (`wc -l` pads its output on BSD, so the count is taken in the shell.)
fs_count() {
  local n=0 f
  for f in "$1"/$2; do [ -e "${f}" ] && n=$((n + 1)); done
  echo "${n}"
}

# fs_use_run_arg [arg] -- point the driver at the run named by `arg`, or at the
# newest run when `arg` is empty or is an option. Prints nothing; returns 0 when
# the argument was a run id (so the caller can shift it away), 1 otherwise.
fs_use_run_arg() {
  case "${1:-}" in
    ""|-*)
      local latest
      latest="$(fs_latest_run_id)"
      [ -n "${latest}" ] || fs_die "no runs found under ${FS_RUNS_DIR}. Submit one with: bash hpc/run_pipeline.sh submit"
      fs_set_run_id "${latest}"
      echo "(no run id given: using the newest run, ${latest})" >&2
      return 1 ;;
    *)
      fs_set_run_id "$1"
      return 0 ;;
  esac
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
  printf '  backbones : %s\n' "$(fs_count "${FS_BACKBONES}" '*.pdb')"
  printf '  sequences : %s\n' "$(fs_count "${FS_SEQS}" '*.fa')"
  printf '  predicted : %s\n' "$(fs_count "${FS_PRED}" '*.pdb')"
  echo
  if [ -f "${FS_EVENTS}" ]; then
    echo "--- ledger summary ---"
    # Rendering lives in ledger.py: inline python here would need backslashes
    # inside f-strings, which is a syntax error before python 3.12.
    # Tell the renderer which stages Slurm says are live right now.
    running_args=()
    if command -v squeue >/dev/null 2>&1; then
      while read -r jname; do
        [ -n "${jname}" ] || continue
        sname="$(fs_stage_for_jobname "${jname}")"
        [ -n "${sname}" ] && running_args+=(--running "${sname}")
      done < <(squeue -u "${FS_USER}" -h -t RUNNING -o '%j' 2>/dev/null || true)
    fi
    python3 "${FS_LEDGER_PY}" pretty --file "${FS_EVENTS}" ${running_args+"${running_args[@]}"}
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
  have_bb="$(fs_count "${FS_BACKBONES}" '*.pdb')"
  have_seq="$(fs_count "${FS_SEQS}" '*.fa')"
  have_pred="$(fs_count "${FS_PRED}" '*.pdb')"

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
    read_cmd "${file}" "${logname}" "${kind}" "${dep}"
    local jid
    jid="$(fs_sbatch_jobid "${CMD[@]}")" || fs_die "sbatch failed for ${file} (sbatch's output is above)"
    echo "resubmitted ${file} as job ${jid}${dep:+ (after ${dep})}"
    fs_event cmd --kv name="resubmit_${logname}" --kv host="$(hostname)" \
      --json-kv argv="$(fs_json_array "${CMD[@]}")" --json-kv exit=0
    dep="${jid}"
  done
}

do_export() {
  [ -d "${FS_WORK}" ] || fs_die "no such run directory: ${FS_WORK}"
  local exp_id="${FS_EXPERIMENT_ID:-hpc_${FS_RUN_ID}}" data_dir="${FS_EXPORT_DATA_DIR:-${FS_REPO}/data}"
  # An explicit --experiment-id on the command line wins, and the tarball below
  # has to be named after whichever id the exporter actually used.
  local prev="" arg
  for arg in "$@"; do
    case "${arg}" in --experiment-id=*) exp_id="${arg#--experiment-id=}" ;; esac
    [ "${prev}" = "--experiment-id" ] && exp_id="${arg}"
    prev="${arg}"
  done
  python3 "${HERE}/export_bundle.py" --work-dir "${FS_WORK}" --data-dir "${data_dir}" \
    --experiment-id "${exp_id}" "$@"
  # Same tarball the export stage makes, so a re-export on a login node leaves
  # one obvious file to copy off the cluster.
  local tarball="${FS_WORK}/bundle_${exp_id}.tar.gz"
  if tar czf "${tarball}" -C "${data_dir}/experiments" "${exp_id}" 2>/dev/null; then
    echo
    echo "tarball: ${tarball}"
    echo "on your own machine, from the repo root:"
    echo "  scp ${FS_USER}@<mill-login-host>:${tarball} /tmp/"
    echo "  python3 scripts/hpc_import_bundle.py /tmp/$(basename "${tarball}")"
  fi
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
    # With no run id, report on the newest run rather than minting a fresh
    # timestamp -- that used to make `status` straight after `submit` look at a
    # directory a few seconds newer than the run and announce "nothing started".
    if [ -n "${1:-}" ]; then
      fs_set_run_id "$1"
    else
      latest="$(fs_latest_run_id)"
      if [ -n "${latest}" ]; then
        fs_set_run_id "${latest}"
      else
        echo "(no runs found under ${FS_RUNS_DIR})"
      fi
    fi
    do_status ;;
  resume)
    if fs_use_run_arg "${1:-}"; then shift; fi
    do_resume ;;
  export)
    if fs_use_run_arg "${1:-}"; then shift; fi
    do_export "$@" ;;
  dry-run)   do_dry_run "$@" ;;
  plan)      do_plan ;;
  preflight) do_preflight "${1:-yes}" ;;
  ""|-h|--help|help) usage ;;
  *) fs_die "unknown command '${subcmd}'. Try: preflight | submit | status | resume | export | dry-run | plan" ;;
esac
