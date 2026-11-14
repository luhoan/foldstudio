#!/usr/bin/env bash
#SBATCH --job-name=fs-pred
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
# Stage 40 -- predict a structure for each designed sequence.
#
# FS_PREDICTOR=esmfold   -> hpc/predict_esmfold.py (single-sequence by design)
# FS_PREDICTOR=colabfold -> colabfold_batch --msa-mode single_sequence,
#                           then hpc/normalize_colabfold.py
#
# WHY SINGLE-SEQUENCE MODE: these sequences are de novo designs. They have no
# natural homologs, so an MSA would be empty or misleading. Single-sequence
# prediction is the scientifically appropriate choice here -- and it also means
# no outbound call to the MMseqs2 API, which matters on compute nodes with no
# network.
#
# This is "does the designed sequence fold back to the designed backbone?"
# self-consistency, computed in hpc/export_bundle.py as CA RMSD. It is a
# computational check, NOT experimental validation of anything.
#
# Resume: one output set per sequence; existing outputs are skipped.
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

fs_stage_begin "predict_${FS_PREDICTOR}"
fs_require_python
fs_require_gpu
fs_activate_env "${FS_PRED_ENV}"

# ESMFold builds OpenFold CUDA kernels, so nvcc/CUDA must match the node.
if command -v module >/dev/null 2>&1; then
  module load "${FS_CUDA_MODULE}" 2>/dev/null \
    && fs_note "loaded module ${FS_CUDA_MODULE}" \
    || fs_note "could not load ${FS_CUDA_MODULE}; relying on the env's bundled CUDA runtime"
fi
fs_collect_versions

mapfile -t FASTAS < <(find "${FS_SEQS}" -maxdepth 1 -name '*.fa' -size +0 2>/dev/null | sort)
[ "${#FASTAS[@]}" -gt 0 ] || fs_die "no FASTA files in ${FS_SEQS}: stage 30 has not produced anything yet"
fs_log "predicting structures for ${#FASTAS[@]} sequence file(s) with ${FS_PREDICTOR}"

mkdir -p "${FS_PRED}"
export TORCH_HOME="${FS_TORCH_HOME}"

case "${FS_PREDICTOR}" in
  esmfold)
    # The runner itself skips finished outputs, so a requeued attempt resumes.
    # It writes <name>.pdb + <name>.pae.json + <name>.pred.json per sequence.
    fs_run esmfold python "${HERE}/predict_esmfold.py" \
      "${FASTAS[@]/#/--fasta=}" \
      --out-dir "${FS_PRED}" \
      --chunk-size "${FS_ESM_CHUNK:-128}" \
      --skip-existing \
      || fs_die "ESMFold prediction failed; full log at ${FS_LOGS}/${FS_STAGE}.esmfold.log
If OpenFold/ESMFold will not run here, switch predictors rather than forcing it:
    FS_PREDICTOR=colabfold bash hpc/10_setup_env.sh pred-env
    FS_PREDICTOR=colabfold bash hpc/11_fetch_weights.sh predictor"
    ;;

  colabfold)
    for fa in "${FASTAS[@]}"; do
      name="$(basename "${fa}" .fa)"
      item="pred_${name}"
      raw="${FS_STAGE_SCRATCH}/colabfold/${name}"

      if fs_is_done "${item}" && [ -n "$(find "${FS_PRED}" -maxdepth 1 -name "${name}_*.pdb" -size +0 2>/dev/null)" ]; then
        fs_log "skip ${item} (already complete)"
        continue
      fi
      fs_clear_done "${item}" 2>/dev/null || true
      mkdir -p "${raw}"

      data_args=()
      [ -d "${FS_COLABFOLD_WEIGHTS}" ] && data_args=(--data "${FS_COLABFOLD_WEIGHTS}")

      fs_run "${item}" colabfold_batch \
        --msa-mode single_sequence \
        --num-recycle "${FS_CF_RECYCLES:-3}" \
        --num-models "${FS_CF_MODELS:-1}" \
        "${data_args[@]+"${data_args[@]}"}" \
        "${fa}" "${raw}" \
        || fs_die "colabfold_batch failed on ${name}; log at ${FS_LOGS}/${FS_STAGE}.${item}.log"

      # ColabFold's file naming and score-JSON keys vary between versions, so
      # normalise into the same <name>.pdb / .pae.json / .pred.json contract the
      # ESMFold runner produces. The normaliser reports what it actually found
      # and never invents a missing number.
      fs_run "norm_${name}" python "${HERE}/normalize_colabfold.py" \
        --in-dir "${raw}" --out-dir "${FS_PRED}" --prefix "${name}_" --fasta "${fa}" \
        || fs_die "could not normalise ColabFold output for ${name}; see the log"

      fs_mark_done "${item}" "pred/${name}_*"
      fs_sync_back || true
    done
    ;;
  *) fs_die "unknown FS_PREDICTOR='${FS_PREDICTOR}' (expected esmfold or colabfold)" ;;
esac

have="$(find "${FS_PRED}" -maxdepth 1 -name '*.pdb' -size +0 | wc -l)"
fs_log "predicted structures: ${have}"
[ "${have}" -gt 0 ] || fs_die "no predicted structures were produced"

fs_stage_finish "$(python3 - "${FS_PRED}" <<'PY'
import json, os, sys
d = sys.argv[1]
print(json.dumps(sorted("pred/" + f for f in os.listdir(d)
                        if f.endswith((".pdb", ".pae.json", ".pred.json")))))
PY
)"
exit 0
