#!/usr/bin/env bash
#SBATCH --job-name=fs-mpnn
#SBATCH --partition=requeue
#SBATCH --requeue
#SBATCH --signal=B:USR1@120
#SBATCH --open-mode=append
#SBATCH --time=02:00:00
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.out
#
# Stage 30 -- ProteinMPNN: design sequences for each RFdiffusion backbone.
#
# DELIBERATELY CPU-ONLY. ProteinMPNN on a handful of 60-residue backbones takes
# seconds, and asking for a GPU on a preemptible partition only lowers the odds
# of the pipeline finishing. Set FS_MPNN_USE_GPU=1 (and pass --gres) if you ever
# scale this up enough to need one.
#
# Weights: ProteinMPNN ships its weights inside the repo
# (vanilla_model_weights/<model>.pt), so there is nothing to download.
#
# Resume: one invocation per backbone, with a checkpoint marker per backbone.
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

fs_stage_begin proteinmpnn
fs_require_python
fs_activate_env "${FS_MPNN_ENV}"
fs_collect_versions

MPNN_RUN="${FS_PROTEINMPNN_DIR}/protein_mpnn_run.py"
[ -f "${MPNN_RUN}" ] || fs_die "ProteinMPNN not found at ${MPNN_RUN} (run hpc/10_setup_env.sh)"
[ -f "${FS_PROTEINMPNN_DIR}/vanilla_model_weights/${FS_MPNN_MODEL}.pt" ] \
  || fs_die "missing weights vanilla_model_weights/${FS_MPNN_MODEL}.pt in ${FS_PROTEINMPNN_DIR}"

# Inputs come from stage 20's authoritative output in $HOME.
mapfile -t BACKBONES < <(find "${FS_BACKBONES}" -maxdepth 1 -name 'design_*.pdb' -size +0 2>/dev/null | sort)
[ "${#BACKBONES[@]}" -gt 0 ] || fs_die "no backbones in ${FS_BACKBONES}: stage 20 has not produced anything yet"
fs_log "designing sequences for ${#BACKBONES[@]} backbone(s)"

mkdir -p "${FS_SEQS}"
WORKOUT="${FS_STAGE_SCRATCH}/mpnn"
mkdir -p "${WORKOUT}"

idx=0
for bb in "${BACKBONES[@]}"; do
  name="$(basename "${bb}" .pdb)"
  item="seqs_${name}"
  final="${FS_SEQS}/${name}.fa"
  # Per-backbone seed, derived from the base seed and recorded. Unlike
  # RFdiffusion, ProteinMPNN has a real --seed flag (verified in its source), so
  # these sequences are exactly reproducible.
  seed=$((FS_SEED + idx))
  idx=$((idx + 1))

  if fs_is_done "${item}" && [ -s "${final}" ]; then
    fs_log "skip ${item} (already complete)"
    continue
  fi
  if fs_is_done "${item}" && [ ! -s "${final}" ]; then
    fs_log "stale checkpoint for ${item}; regenerating"
    fs_clear_done "${item}"
  fi

  out="${WORKOUT}/${name}"
  mkdir -p "${out}"

  # RFdiffusion writes its designed backbone as chain A.
  # shellcheck disable=SC2086  # FS_MPNN_EXTRA_ARGS is an intentional passthrough
  fs_run "${item}" python "${MPNN_RUN}" \
    --pdb_path "${bb}" \
    --pdb_path_chains A \
    --out_folder "${out}" \
    --num_seq_per_target "${FS_SEQS_PER_DESIGN}" \
    --sampling_temp "${FS_MPNN_TEMP}" \
    --seed "${seed}" \
    --batch_size 1 \
    --model_name "${FS_MPNN_MODEL}" \
    --save_score 1 \
    ${FS_MPNN_EXTRA_ARGS} \
    || fs_die "ProteinMPNN failed on ${name}; full log at ${FS_LOGS}/${FS_STAGE}.${item}.log"

  produced="${out}/seqs/${name}.fa"
  [ -s "${produced}" ] || fs_die "ProteinMPNN exited 0 but ${produced} is missing or empty"

  cp -f "${produced}" "${final}" || fs_die "could not copy ${produced} to ${final}"
  # Score files (.npz) carry the per-sequence scores; keep them for provenance.
  if [ -d "${out}/scores" ]; then
    mkdir -p "${FS_SEQS}/scores"
    cp -f "${out}/scores/"*.npz "${FS_SEQS}/scores/" 2>/dev/null || true
  fi

  fs_event note --kv message="ProteinMPNN seed for ${name} was ${seed}" \
    --json-kv seeds="$(python3 - "${name}" "${seed}" <<'PY'
import json, sys
print(json.dumps({sys.argv[1]: int(sys.argv[2])}))
PY
)"
  fs_mark_done "${item}" "seqs/${name}.fa"
  fs_event checkpoint --kv from="${produced}" --kv to="${final}" --kv host="$(hostname)"
done

have="$(find "${FS_SEQS}" -maxdepth 1 -name '*.fa' -size +0 | wc -l)"
fs_log "sequence files complete: ${have}/${#BACKBONES[@]}"
[ "${have}" -gt 0 ] || fs_die "no sequence files were produced"

fs_stage_finish "$(python3 - "${FS_SEQS}" <<'PY'
import json, os, sys
d = sys.argv[1]
print(json.dumps(sorted("seqs/" + f for f in os.listdir(d) if f.endswith(".fa"))))
PY
)"
exit 0
