#!/usr/bin/env bash
#SBATCH --job-name=fs-rfd
#SBATCH --partition=requeue
#SBATCH --requeue
#SBATCH --signal=B:USR1@120
#SBATCH --open-mode=append
#SBATCH --time=08:00:00
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=48G
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.out
#
# Stage 20 -- RFdiffusion: generate small de novo monomer backbones.
#
# The #SBATCH values above are defaults/documentation. hpc/run_pipeline.sh
# overrides partition, GRES, time, account and --output from hpc/env.sh, because
# sbatch directives cannot read shell variables.
#
# Submit via the driver (recommended):   bash hpc/run_pipeline.sh submit
# Or directly:                           sbatch --export=ALL,FS_RUN_ID=$(date -u +%Y%m%dT%H%M%SZ) hpc/20_rfdiffusion.sbatch
#
# PREEMPTION: this runs on `requeue`, where jobs die at any moment. Protections:
#   * --requeue + --signal=B:USR1@120: we get ~2 min warning, flush, and Slurm
#     restarts the job.
#   * one design per invocation (inference.design_startnum), so a kill loses at
#     most the design in flight, never finished ones.
#   * finished designs are recorded as checkpoint markers in $HOME and skipped.
#   * --open-mode=append so a requeued attempt does not truncate the Slurm log.
#
# WHAT THIS DESIGNS: an unconditional monomeric scaffold of FS_CONTIG residues
# (default 60-60). This deliberately does NOT use RFdiffusion's binder-design
# path (no ppi.hotspot_res, no target_pdb): FoldStudio's scientific-integrity
# rules forbid novel therapeutic binder generation, so no target is involved.
#
# NOT YET EXECUTED ON THE MILL -- see "What has and has not run" in hpc/README.md.

set -o errexit
set -o nounset
set -o pipefail

HERE="${FS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
[ -d "${HERE}/hpc" ] && HERE="${HERE}/hpc"
# shellcheck source=hpc/env.sh
. "${HERE}/env.sh"
# shellcheck source=hpc/lib/common.sh
. "${HERE}/lib/common.sh"

fs_stage_begin rfdiffusion
fs_require_python
fs_require_gpu
fs_activate_env "${FS_RFD_ENV}"

# The CUDA module matters for nvcc-built extensions. SE3nv brings its own
# cudatoolkit=11.1 runtime for pytorch, so loading a system CUDA is optional
# here; we record what happened either way.
if [ "${FS_LOAD_CUDA_MODULE:-0}" = "1" ] && command -v module >/dev/null 2>&1; then
  module load "${FS_CUDA_MODULE}" 2>/dev/null \
    && fs_note "loaded module ${FS_CUDA_MODULE}" \
    || fs_note "could not load module ${FS_CUDA_MODULE}; using the env's bundled CUDA runtime"
fi

fs_collect_versions

[ -d "${FS_RFDIFFUSION_DIR}" ] || fs_die "RFdiffusion not found at ${FS_RFDIFFUSION_DIR} (run hpc/10_setup_env.sh)"
[ -f "${FS_RFD_MODELS}/Base_ckpt.pt" ] || fs_die "RFdiffusion weights missing at ${FS_RFD_MODELS}/Base_ckpt.pt (run hpc/11_fetch_weights.sh)"

OUTDIR="${FS_STAGE_SCRATCH}/out"
mkdir -p "${OUTDIR}"

# Resume: copy already-finished designs from $HOME into scratch so RFdiffusion's
# own `cautious` mode and our checkpoints agree about what exists.
if [ -d "${FS_BACKBONES}" ]; then
  cp -n "${FS_BACKBONES}"/*.pdb "${OUTDIR}/" 2>/dev/null || true
fi

PREFIX="${OUTDIR}/design"
N="${FS_NUM_DESIGNS}"

# Reproducibility, stated honestly:
#   RFdiffusion's stock config (config/inference/base.yaml, verified upstream)
#   exposes inference.deterministic but NO inference.seed. So we set
#   deterministic=True and record it. Consequence worth knowing: because each
#   invocation re-seeds and generates exactly one design, a design regenerated
#   after a preemption is produced from the same starting state as a fresh run of
#   that same index -- but it is NOT guaranteed bit-identical to the design that
#   the same index would have had inside one long uninterrupted multi-design run,
#   where RNG state carries across designs. The ledger records which designs were
#   produced in which attempt so this is auditable rather than hidden.
fs_event note --kv message="RFdiffusion seeding: inference.deterministic=True; upstream config has no inference.seed" \
  --json-kv seeds="$(python3 - "${FS_SEED}" <<'PY'
import json, sys
print(json.dumps({"base": int(sys.argv[1]), "rfdiffusion_mechanism": "inference.deterministic=True",
                  "per_design_seed_flag": None}))
PY
)"

made=0
for i in $(seq 0 $((N - 1))); do
  item="design_${i}"
  target="${OUTDIR}/design_${i}.pdb"

  if fs_is_done "${item}" && [ -s "${target}" ]; then
    fs_log "skip ${item} (already complete)"
    continue
  fi
  # A checkpoint without its file is a stale marker: drop it and redo the design.
  if fs_is_done "${item}" && [ ! -s "${target}" ]; then
    fs_log "stale checkpoint for ${item} (file missing); clearing and regenerating"
    fs_clear_done "${item}"
  fi

  # One design per invocation: design_startnum fixes the output index, so a
  # preempted job never has to redo completed designs.
  (
    cd "${FS_RFDIFFUSION_DIR}" || exit 1
    # shellcheck disable=SC2086  # FS_RFD_EXTRA_ARGS is an intentional word-split passthrough
    fs_run "${item}" python "${FS_RFDIFFUSION_DIR}/scripts/run_inference.py" \
      "inference.output_prefix=${PREFIX}" \
      "contigmap.contigs=[${FS_CONTIG}]" \
      "inference.num_designs=1" \
      "inference.design_startnum=${i}" \
      "inference.model_directory_path=${FS_RFD_MODELS}" \
      "inference.deterministic=True" \
      "inference.write_trajectory=False" \
      ${FS_RFD_EXTRA_ARGS}
  ) || fs_die "RFdiffusion failed on ${item}. The log tail is above; the full log is
${FS_LOGS}/${FS_STAGE}.${item}.log
Common causes: wrong CUDA/dgl pairing for this node type (SE3nv is pytorch 1.9 /
cu11.1 and has NO sm_90 kernels, so it cannot run on H100 -- request V100), or
the weights path ${FS_RFD_MODELS} being wrong."

  [ -s "${target}" ] || fs_die "RFdiffusion exited 0 but ${target} is missing or empty"

  fs_mark_done "${item}" "backbones/design_${i}.pdb"
  made=$((made + 1))
  # Sync after every design: on `requeue` the next second is never guaranteed.
  mkdir -p "${FS_BACKBONES}"
  cp -f "${target}" "${FS_BACKBONES}/" || fs_die "could not copy ${target} into ${FS_BACKBONES}"
  # .trb files hold the design metadata RFdiffusion writes alongside each PDB.
  cp -f "${OUTDIR}/design_${i}.trb" "${FS_BACKBONES}/" 2>/dev/null || true
  fs_event checkpoint --kv from="${target}" --kv to="${FS_BACKBONES}" --kv host="$(hostname)"
done

have="$(find "${FS_BACKBONES}" -maxdepth 1 -name 'design_*.pdb' -size +0 2>/dev/null | wc -l)"
fs_log "backbones complete: ${have}/${N} (this attempt produced ${made})"
fs_note "backbones present: ${have}/${N}"

[ "${have}" -gt 0 ] || fs_die "no backbones were produced"
if [ "${have}" -lt "${N}" ]; then
  # Not a failure: the next requeued attempt resumes. Recorded as partial.
  fs_log "NOTE: ${have} of ${N} designs done; a requeued attempt will finish the rest"
fi

fs_stage_finish "$(python3 - "${FS_BACKBONES}" <<'PY'
import json, os, sys
d = sys.argv[1]
print(json.dumps(sorted("backbones/" + f for f in os.listdir(d) if f.endswith(".pdb"))))
PY
)"
exit 0
