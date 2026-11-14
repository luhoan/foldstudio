#!/usr/bin/env bash
# FoldStudio / Stream 3 -- central configuration for the Missouri S&T "Mill" cluster.
#
# Source this from every script:  . "$(dirname "$0")/env.sh"
# Override anything by exporting it first, or by editing hpc/env.local.sh (git-ignored).
#
# NOTHING in this file runs compute. It only sets variables and creates directories.

# ----------------------------------------------------------------- strict mode
# Scripts that source this file get consistent error handling.
set -o errexit
set -o nounset
set -o pipefail

# ------------------------------------------------------------------- identity
: "${FS_USER:=${USER:-$(id -un)}}"

# Repo root = parent of hpc/ (resolved, so scripts work from any cwd).
_FS_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${FS_REPO:=$(cd "${_FS_ENV_DIR}/.." && pwd)}"
export FS_REPO

# ------------------------------------------------------------------- Slurm
# Free/unbilled users on the Mill get the `requeue` partition: max wall time
# 1 day, and jobs MAY BE PREEMPTED AT ANY TIME. std-v100 / std-h100 require an
# MOU and a billing account, so they are opt-in only.
: "${FS_PARTITION:=requeue}"
: "${FS_ACCOUNT:=}"            # leave empty on requeue; set for std-v100/std-h100
: "${FS_GPU_GRES:=gpu:1}"      # e.g. gpu:v100:1 or gpu:h100:1 once discovery confirms names
: "${FS_TIME_GPU:=08:00:00}"   # <= 1-00:00:00 on requeue
: "${FS_TIME_CPU:=02:00:00}"
: "${FS_CPUS:=4}"
: "${FS_MEM:=48G}"
# Minutes of warning Slurm gives us before preemption/time limit (checkpoint window).
: "${FS_SIGNAL_SEC:=120}"

# CUDA module: the Mill docs specify cuda-toolkit/12.9 on V100 nodes and
# cuda-toolkit/13.3 on H100 nodes. Discovery (00_discover.sh) records what is
# actually installed; override FS_CUDA_MODULE if your node type differs.
: "${FS_CUDA_MODULE:=cuda-toolkit/12.9}"
: "${FS_CUDA_MODULE_H100:=cuda-toolkit/13.3}"

# ------------------------------------------------------------------- storage
# Home is ~50 GB by default: authoritative state and results live here.
: "${FS_HOME_BASE:=${HOME}/foldstudio-hpc}"
# Node-local scratch is ~1.5 TB and FAST, but it is NODE-LOCAL and is lost when a
# requeued job restarts on another node. Treat it as a cache, never as the source
# of truth. Every stage syncs its results back to ${FS_WORK} before exiting.
: "${FS_SCRATCH_BASE:=/local/scratch/${FS_USER}}"

: "${FS_ENV_DIR:=${FS_HOME_BASE}/env}"         # conda/venv or apptainer images
: "${FS_WEIGHTS_DIR:=${FS_HOME_BASE}/weights}" # model weights (downloaded on login node)
: "${FS_RUNS_DIR:=${FS_HOME_BASE}/runs}"       # one directory per RUN_ID

# RUN_ID identifies one end-to-end pipeline execution. The driver sets it; stages
# inherit it. Default is time-based so an accidental re-run never overwrites data.
: "${FS_RUN_ID:=$(date -u +%Y%m%dT%H%M%SZ)}"
: "${FS_WORK:=${FS_RUNS_DIR}/${FS_RUN_ID}}"
: "${FS_SCRATCH:=${FS_SCRATCH_BASE}/${FS_RUN_ID}}"

# Per-run layout under ${FS_WORK} (authoritative, in $HOME):
#   backbones/    RFdiffusion output PDBs            (stage 20)
#   seqs/         ProteinMPNN output FASTA           (stage 30)
#   pred/         prediction PDB + PAE + sidecars    (stage 40)
#   provenance/   events.jsonl + <stage>.json        (all stages)
#   logs/         Slurm stdout/stderr
#   checkpoints/  per-item .done markers for resume
: "${FS_BACKBONES:=${FS_WORK}/backbones}"
: "${FS_SEQS:=${FS_WORK}/seqs}"
: "${FS_PRED:=${FS_WORK}/pred}"
: "${FS_PROV:=${FS_WORK}/provenance}"
: "${FS_LOGS:=${FS_WORK}/logs}"
: "${FS_CKPT:=${FS_WORK}/checkpoints}"

# ------------------------------------------------------------------- tools
# Set these to wherever 10_setup_env.sh cloned/installed the tools.
: "${FS_RFDIFFUSION_DIR:=${FS_HOME_BASE}/tools/RFdiffusion}"
: "${FS_PROTEINMPNN_DIR:=${FS_HOME_BASE}/tools/ProteinMPNN}"
: "${FS_APPTAINER_SIF:=${FS_ENV_DIR}/rfdiffusion.sif}"

# How to activate the Python environment. "conda", "venv" or "apptainer".
: "${FS_ENV_MODE:=conda}"
: "${FS_VENV_PATH:=${FS_ENV_DIR}/venv}"

# One conda env per tool: their pins genuinely conflict.
#   SE3nv  -- created by RFdiffusion's own env/SE3nv.yml. It pins python=3.9,
#             pytorch=1.9, cudatoolkit=11.1, dgl-cuda11.1 (verified in upstream
#             env/SE3nv.yml). IMPORTANT: pytorch 1.9 / cu11.1 has no sm_90
#             kernels, so this env CANNOT run on H100. Target V100.
#   ProteinMPNN needs only torch+numpy, so it reuses SE3nv by default.
#   The predictor needs its own env (ESMFold requires python <= 3.9 and nvcc;
#   ColabFold wants a recent jax), so never mix it with SE3nv.
: "${FS_RFD_ENV:=SE3nv}"
: "${FS_MPNN_ENV:=${FS_RFD_ENV}}"
: "${FS_PRED_ENV:=foldstudio-pred}"
# Generic default for fs_activate_env when a stage does not name an env.
: "${FS_CONDA_ENV:=${FS_RFD_ENV}}"

# Model weights live in $HOME (compute nodes may have no outbound network, and
# the weights must be downloaded on the login node -- see hpc/11_fetch_weights.sh).
: "${FS_RFD_MODELS:=${FS_WEIGHTS_DIR}/rfdiffusion}"
# torch.hub cache: ESMFold pulls esmfold_v1 (several GB) through torch.hub.
: "${FS_TORCH_HOME:=${FS_WEIGHTS_DIR}/torch}"
export TORCH_HOME="${FS_TORCH_HOME}"
: "${FS_COLABFOLD_WEIGHTS:=${FS_WEIGHTS_DIR}/colabfold}"

# Structure predictor: "esmfold" or "colabfold". Pick whichever installed
# cleanly (see hpc/README.md); the stage script dispatches on this.
: "${FS_PREDICTOR:=esmfold}"

# ------------------------------------------------------------- design settings
# A small, benign, de novo monomeric scaffold. No binder/therapeutic target.
: "${FS_CONTIG:=60-60}"        # unconditional monomer, 60 residues
: "${FS_NUM_DESIGNS:=4}"       # RFdiffusion backbones
: "${FS_SEQS_PER_DESIGN:=4}"   # ProteinMPNN sequences per backbone
: "${FS_MPNN_TEMP:=0.1}"
: "${FS_MPNN_MODEL:=v_48_020}"
: "${FS_SEED:=37}"             # base seed; stage scripts derive per-item seeds

# Extra args passed straight through, for flags that differ between tool versions.
: "${FS_RFD_EXTRA_ARGS:=}"
: "${FS_MPNN_EXTRA_ARGS:=}"

# ------------------------------------------------------------- local overrides
# shellcheck source=/dev/null
[ -f "${_FS_ENV_DIR}/env.local.sh" ] && . "${_FS_ENV_DIR}/env.local.sh"

# ------------------------------------------------------------------- helpers
fs_mkdirs() {
  mkdir -p "${FS_BACKBONES}" "${FS_SEQS}" "${FS_PRED}" "${FS_PROV}" "${FS_LOGS}" "${FS_CKPT}"
}

fs_print_config() {
  cat <<EOF
run_id      ${FS_RUN_ID}
work        ${FS_WORK}
scratch     ${FS_SCRATCH}
partition   ${FS_PARTITION}${FS_ACCOUNT:+  account=${FS_ACCOUNT}}
gres        ${FS_GPU_GRES}
predictor   ${FS_PREDICTOR}
contig      ${FS_CONTIG}   designs=${FS_NUM_DESIGNS}  seqs/design=${FS_SEQS_PER_DESIGN}
seed        ${FS_SEED}
env_mode    ${FS_ENV_MODE}
EOF
}
