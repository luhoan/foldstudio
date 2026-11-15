#!/usr/bin/env bash
# Stream 3 / step 1 -- build the software environment in $HOME. LOGIN NODE.
#
#     bash hpc/10_setup_env.sh            # everything
#     bash hpc/10_setup_env.sh clone      # just clone the tools
#     bash hpc/10_setup_env.sh rfd-env    # just the RFdiffusion/SE3nv conda env
#     bash hpc/10_setup_env.sh pred-env   # just the predictor env
#     bash hpc/10_setup_env.sh check      # report what is present, change nothing
#
# This runs on a LOGIN NODE on purpose: it is git clone + conda solve + pip,
# i.e. network and I/O, not compute, and Mill compute nodes may have no outbound
# network. It does not train, infer, or touch a GPU. If your admins object to the
# conda solve on a login node, get an interactive shell instead and re-run:
#     srun --partition=requeue --time=1:00:00 --cpus-per-task=4 --pty bash
#
# Everything is idempotent: finished steps are skipped on re-run.
#
# WHAT HAS RUN ON THE MILL (2026-11-14), so you know what to trust:
#   clone, rfd-env   ran as written here, and RFdiffusion then produced a backbone.
#   pred-env         the first version of this step did NOT work. The ESMFold
#                    environment was finished by hand; every one of those hand
#                    fixes is now in do_pred_env below, each with the error that
#                    made it necessary. That rewritten step has not itself been
#                    run on the Mill. On an account where ESMFold already imports
#                    it detects that and changes nothing.
#
# Versions pinned by upstream (verified against the real upstream files):
#   RFdiffusion env/SE3nv.yml -> python=3.9, pytorch=1.9, cudatoolkit=11.1, dgl-cuda11.1
#   => that env has no sm_90 kernels, so RFdiffusion here targets V100, NOT H100.
#   ESMFold -> needs python <= 3.9 AND nvcc on PATH to build OpenFold.

set -o errexit
set -o nounset
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpc/env.sh
. "${HERE}/env.sh"

# Setup provenance is per-machine, not per-run.
FS_RUN_ID="setup"
FS_WORK="${FS_HOME_BASE}/setup"
FS_PROV="${FS_WORK}/provenance"
FS_LOGS="${FS_WORK}/logs"
FS_CKPT="${FS_WORK}/checkpoints"
FS_EVENTS="${FS_PROV}/events.jsonl"
export FS_RUN_ID FS_WORK FS_PROV FS_LOGS FS_CKPT FS_EVENTS

# shellcheck source=hpc/lib/common.sh
. "${HERE}/lib/common.sh"

RFD_URL="https://github.com/RosettaCommons/RFdiffusion.git"
MPNN_URL="https://github.com/dauparas/ProteinMPNN.git"
TOOLS="${FS_HOME_BASE}/tools"

# ------------------------------------------------------------------------ check
do_check() {
  echo "--- environment report ($(hostname), $(date -u +%FT%TZ)) ---"
  fs_print_config
  echo
  printf '%-34s %s\n' "RFdiffusion checkout"  "$([ -d "${FS_RFDIFFUSION_DIR}/.git" ] && fs_git_hash "${FS_RFDIFFUSION_DIR}" || echo MISSING)"
  printf '%-34s %s\n' "ProteinMPNN checkout"  "$([ -d "${FS_PROTEINMPNN_DIR}/.git" ] && fs_git_hash "${FS_PROTEINMPNN_DIR}" || echo MISSING)"
  printf '%-34s %s\n' "RFdiffusion weights dir" "$([ -d "${FS_RFD_MODELS}" ] && echo "${FS_RFD_MODELS} ($(find "${FS_RFD_MODELS}" -name '*.pt' 2>/dev/null | wc -l) .pt files)" || echo MISSING)"
  printf '%-34s %s\n' "ProteinMPNN weights (in-repo)" "$([ -f "${FS_PROTEINMPNN_DIR}/vanilla_model_weights/${FS_MPNN_MODEL}.pt" ] && echo PRESENT || echo MISSING)"
  printf '%-34s %s\n' "torch hub cache" "${FS_TORCH_HOME}$([ -d "${FS_TORCH_HOME}" ] && echo " (present)" || echo " (missing)")"
  echo
  if fs_ensure_conda; then
    echo "conda envs:"; conda env list | sed 's/^/  /'
  else
    echo "conda: NOT on PATH, and module '${FS_CONDA_MODULE:-<unset>}' did not load (try: module avail conda)"
  fi
  echo
  printf 'free space in $HOME: '; df -h "${HOME}" | awk 'NR==2{print $4" available of "$2}'
  echo "NOTE: home is ~50 GB by default. ESMFold weights alone are several GB;"
  echo "      RFdiffusion .pt files are ~2-4 GB total. Keep trajectories off (see 20_rfdiffusion.sbatch)."
}

# ------------------------------------------------------------------------ clone
do_clone() {
  fs_stage_begin setup_clone
  mkdir -p "${TOOLS}"
  if [ -d "${FS_RFDIFFUSION_DIR}/.git" ]; then
    fs_log "RFdiffusion already cloned at ${FS_RFDIFFUSION_DIR} ($(fs_git_hash "${FS_RFDIFFUSION_DIR}"))"
  else
    fs_run clone_rfdiffusion git clone --depth 1 "${RFD_URL}" "${FS_RFDIFFUSION_DIR}" \
      || fs_die "could not clone RFdiffusion (no outbound network from this node?)"
  fi
  if [ -d "${FS_PROTEINMPNN_DIR}/.git" ]; then
    fs_log "ProteinMPNN already cloned at ${FS_PROTEINMPNN_DIR} ($(fs_git_hash "${FS_PROTEINMPNN_DIR}"))"
  else
    fs_run clone_proteinmpnn git clone --depth 1 "${MPNN_URL}" "${FS_PROTEINMPNN_DIR}" \
      || fs_die "could not clone ProteinMPNN"
  fi
  # Record the exact commits we are pinned to; the bundle reports these.
  fs_collect_versions
  fs_note "RFdiffusion=$(fs_git_hash "${FS_RFDIFFUSION_DIR}") ProteinMPNN=$(fs_git_hash "${FS_PROTEINMPNN_DIR}")"
}

# ---------------------------------------------------------------- RFdiffusion env
do_rfd_env() {
  fs_stage_begin setup_rfd_env
  fs_ensure_conda || fs_die "conda is not on PATH and module '${FS_CONDA_MODULE:-<unset>}' could not be loaded.
Run 'module avail conda', then set FS_CONDA_MODULE=<name> in hpc/env.local.sh (on the Mill: miniconda/miniconda3)."
  [ -f "${FS_RFDIFFUSION_DIR}/env/SE3nv.yml" ] || fs_die "missing ${FS_RFDIFFUSION_DIR}/env/SE3nv.yml -- run '$0 clone' first"

  if conda env list | awk '{print $1}' | grep -qx "${FS_RFD_ENV}"; then
    fs_log "conda env '${FS_RFD_ENV}' already exists; skipping create"
  else
    # Upstream's own env file. Do not re-pin it here: RFdiffusion is sensitive to
    # its dgl/pytorch combination.
    fs_run conda_env_create conda env create -f "${FS_RFDIFFUSION_DIR}/env/SE3nv.yml" \
      || fs_die "conda env create failed; see the log. A common cause is a slow/blocked channel."
  fi

  if fs_is_done se3_installed; then
    fs_log "SE3Transformer + rfdiffusion already installed into ${FS_RFD_ENV}"
  else
    fs_activate_env "${FS_RFD_ENV}"
    # These four steps are exactly upstream's documented install sequence.
    ( cd "${FS_RFDIFFUSION_DIR}/env/SE3Transformer" \
      && fs_run se3_requirements pip install --no-cache-dir -r requirements.txt \
      && fs_run se3_setup python setup.py install ) \
      || fs_die "SE3Transformer install failed (needs nvcc/CUDA headers for some builds)"
    ( cd "${FS_RFDIFFUSION_DIR}" && fs_run rfdiffusion_pip_e pip install -e . ) \
      || fs_die "pip install -e RFdiffusion failed"
    fs_mark_done se3_installed "conda env ${FS_RFD_ENV}"
  fi

  # SE3Transformer labels its maths with NVIDIA's NVTX profiling API, imported
  # straight from torch.cuda.nvtx. A torch build without NVTX imports the name
  # fine and only raises when it is called, so this surfaces as a crash partway
  # into the first design rather than at install time. The labels are
  # instrumentation; the patch falls back to a no-op and keeps the real one
  # where NVTX works. Idempotent, and run on every rfd-env so an environment
  # built before this existed is repaired too.
  fs_activate_env "${FS_RFD_ENV}"
  se3_pkg="$(python3 -c 'import os, se3_transformer; print(os.path.dirname(se3_transformer.__file__))' 2>/dev/null || true)"
  if [ -n "${se3_pkg}" ]; then
    fs_run patch_se3_nvtx python3 "${HERE}/patch_se3_nvtx.py" "${se3_pkg}" \
      || fs_log "WARNING: could not apply the NVTX patch; stage 20 may fail on a torch build without NVTX"
  else
    fs_log "WARNING: se3_transformer not importable, skipping the NVTX patch"
  fi

  fs_activate_env "${FS_RFD_ENV}"
  fs_collect_versions
  # Import check, not a GPU check: login nodes have no GPU, so a False here is expected.
  fs_run rfd_import_check python -c \
    'import torch, rfdiffusion; print("rfdiffusion import OK; torch", torch.__version__, "cuda_build", torch.version.cuda)' \
    || fs_log "WARNING: rfdiffusion did not import cleanly -- read the log before submitting stage 20"
}

# ------------------------------------------------------------------ predictor env
# True when the ESMFold code path stage 40 uses can be imported in the active env.
# Importing esm alone proves nothing: OpenFold is only pulled in by this module.
esmfold_imports() {
  python -c 'import esm.esmfold.v1.esmfold' >/dev/null 2>&1
}

# Repairs that are cheap, idempotent and needed whether the env was just built or
# was built earlier by hand. Each is here because of an error seen on the Mill.
esmfold_repairs() {
  # fair-esm[esmfold] installs deepspeed 0.5.9. OpenFold imports deepspeed when it
  # is installed, and that release does `from torch._six import inf`, which
  # current torch no longer has:  ModuleNotFoundError: No module named 'torch._six'.
  # OpenFold only uses deepspeed for training, so removing it loses nothing here.
  if python -c 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("deepspeed") else 1)' 2>/dev/null; then
    fs_run pip_uninstall_deepspeed pip uninstall -y deepspeed \
      || fs_log "WARNING: could not uninstall deepspeed; 'import openfold' may fail with torch._six"
  fi
  # ImportError: cannot import name 'seed_everything' from pytorch_lightning.utilities.seed
  local of_pkg
  of_pkg="$(python -c 'import importlib.util as u; s = u.find_spec("openfold"); print(s.submodule_search_locations[0] if s and s.submodule_search_locations else "")' 2>/dev/null || true)"
  if [ -n "${of_pkg}" ]; then
    fs_run patch_openfold_installed python "${HERE}/patch_openfold.py" installed "${of_pkg}" \
      || fs_log "WARNING: could not patch ${of_pkg}/utils/seed.py; read the log"
  fi
}

do_pred_env() {
  fs_stage_begin setup_pred_env
  fs_ensure_conda || fs_die "conda is not on PATH and module '${FS_CONDA_MODULE:-<unset>}' could not be loaded (try: module avail conda)"

  if conda env list | awk '{print $1}' | grep -qx "${FS_PRED_ENV}"; then
    fs_log "conda env '${FS_PRED_ENV}' already exists"
  else
    # python 3.9: required by ESMFold, and fine for ColabFold.
    fs_run conda_create_pred conda create -y -n "${FS_PRED_ENV}" python=3.9 \
      || fs_die "conda create ${FS_PRED_ENV} failed"
  fi
  fs_activate_env "${FS_PRED_ENV}"

  case "${FS_PREDICTOR}" in
    esmfold)
      # An environment that already works is left exactly as it is. This matters on
      # the account where it was finished by hand: re-running setup must not
      # reinstall anything into it.
      if esmfold_imports; then
        fs_log "ESMFold already imports in '${FS_PRED_ENV}'; nothing to build"
        esmfold_repairs
        fs_mark_done esmfold_env "conda env ${FS_PRED_ENV} (found working)"
        fs_collect_versions
        return 0
      fi

      # --- toolchain for OpenFold's CUDA kernel --------------------------------
      # nvcc comes from the CUDA module.
      if ! command -v nvcc >/dev/null 2>&1; then
        fs_module_load "${FS_CUDA_MODULE}" && fs_log "loaded module ${FS_CUDA_MODULE} (provides nvcc)"
      fi
      command -v nvcc >/dev/null 2>&1 \
        || fs_die "nvcc is not on PATH and module '${FS_CUDA_MODULE}' could not be loaded.
OpenFold compiles a CUDA kernel and cannot be installed without it. Find the module
with 'module avail cuda' and set FS_CUDA_MODULE in hpc/env.local.sh."
      # The PyTorch headers need C++17. The system GCC on the Mill (8.5) is too old:
      #   error: #error C++17 or later compatible compiler is required to use PyTorch.
      fs_ensure_gcc 9 \
        || fs_die "need GCC >= 9 to build OpenFold against current PyTorch headers, but found
'$(gcc --version 2>/dev/null | head -1 || echo "no gcc")' and module '${FS_GCC_MODULE:-<unset>}' did not help.
Find one with 'module avail gcc' and set FS_GCC_MODULE in hpc/env.local.sh."
      # Without these the build picks up whichever compiler distutils remembers.
      CC="$(command -v gcc)"; CXX="$(command -v g++)"
      export CC CXX
      fs_note "OpenFold toolchain: $(gcc --version | head -1); $(nvcc --version | tail -1); CC=${CC}"

      # --- python packages --------------------------------------------------------
      # cu121 wheels, to match cuda-toolkit/12.9. With the cu118 wheels nvcc 12.9
      # and torch disagreed about the CUDA version and the kernel did not build.
      fs_run pip_torch pip install --no-cache-dir torch --index-url "${FS_PRED_TORCH_INDEX}" \
        || fs_die "could not install torch from ${FS_PRED_TORCH_INDEX}"
      fs_run pip_fair_esm pip install --no-cache-dir "fair-esm[esmfold]" \
        || fs_die "pip install fair-esm[esmfold] failed"
      fs_run pip_dllogger pip install --no-cache-dir 'dllogger @ git+https://github.com/NVIDIA/dllogger.git' \
        || fs_die "dllogger install failed"

      # --- OpenFold, from a patched local clone -------------------------------------
      # `pip install openfold @ git+...` cannot work: the source must be patched
      # before it compiles (see hpc/patch_openfold.py for the three reasons), and
      # pip's isolated build environment has no torch for its setup.py to import.
      if python -c 'import openfold' >/dev/null 2>&1; then
        fs_log "openfold already importable; not rebuilding"
      else
        if [ ! -d "${FS_OPENFOLD_DIR}/.git" ]; then
          mkdir -p "$(dirname "${FS_OPENFOLD_DIR}")"
          fs_run clone_openfold git clone https://github.com/aqlaboratory/openfold.git "${FS_OPENFOLD_DIR}" \
            || fs_die "could not clone OpenFold (no outbound network from this node?)"
        fi
        if [ "$(git -C "${FS_OPENFOLD_DIR}" rev-parse HEAD 2>/dev/null)" != "${FS_OPENFOLD_COMMIT}" ]; then
          # Local edits from an earlier patch would block the checkout; they are re-applied below.
          fs_run openfold_checkout git -C "${FS_OPENFOLD_DIR}" checkout --quiet --force "${FS_OPENFOLD_COMMIT}" \
            || fs_die "could not check out OpenFold ${FS_OPENFOLD_COMMIT}"
        fi
        fs_run patch_openfold_source python "${HERE}/patch_openfold.py" source "${FS_OPENFOLD_DIR}" \
          || fs_die "OpenFold's source is not what hpc/patch_openfold.py expects; see the log"
        # FS_OPENFOLD_CC is read by the patched setup.py: build for the GPUs the jobs
        # use (V100 = 70), whether or not this node has a GPU of its own.
        export FS_OPENFOLD_CC
        fs_run pip_openfold pip install --no-cache-dir --no-build-isolation "${FS_OPENFOLD_DIR}" \
          || fs_die "OpenFold did not build. The compiler output is in the log named above.
What it needs, all checked earlier in this step: nvcc (${FS_CUDA_MODULE}), GCC >= 9
(${FS_GCC_MODULE}), and torch from ${FS_PRED_TORCH_INDEX}.
If it keeps failing, switch predictors instead of fighting it:
    FS_PREDICTOR=colabfold bash $0 pred-env"
      fi

      esmfold_repairs

      if esmfold_imports; then
        fs_log "ESMFold imports cleanly in '${FS_PRED_ENV}'"
        fs_mark_done esmfold_env "conda env ${FS_PRED_ENV}"
      else
        # Show the real traceback rather than a summary of it.
        fs_run esmfold_import_check python -c 'import esm.esmfold.v1.esmfold' || true
        fs_die "the environment was built but 'import esm.esmfold.v1.esmfold' fails; the traceback is above.
Stage 40 cannot run until that import works."
      fi
      ;;
    colabfold)
      # Usually the more reliable install of the two, and it writes PAE JSON
      # natively (which the FoldStudio /structures/{id}/pae endpoint can serve).
      fs_run pip_colabfold pip install --no-cache-dir "colabfold[alphafold]" \
        || fs_die "pip install colabfold[alphafold] failed"
      fs_run pip_jax_cuda pip install --no-cache-dir --upgrade \
        "jax[cuda12]" \
        || fs_log "WARNING: jax[cuda12] install failed; ColabFold may fall back to CPU (slow but it still works)"
      fs_run colabfold_help colabfold_batch --help \
        || fs_log "WARNING: colabfold_batch not runnable yet; read the log"
      ;;
    *) fs_die "unknown FS_PREDICTOR='${FS_PREDICTOR}' (expected esmfold or colabfold)" ;;
  esac
  fs_collect_versions
}

# ------------------------------------------------------------------------ driver
main() {
  mkdir -p "${FS_PROV}" "${FS_LOGS}" "${FS_CKPT}"
  case "${1:-all}" in
    check)    do_check ;;
    clone)    do_clone ;;
    rfd-env)  do_rfd_env ;;
    pred-env) do_pred_env ;;
    all)
      # Subshells: each stage installs its own EXIT trap, and we want one
      # stage_end per stage rather than nested traps.
      ( do_clone )
      ( do_rfd_env )
      ( do_pred_env )
      echo
      do_check
      echo
      echo "Next: bash hpc/11_fetch_weights.sh   (still on the login node)"
      ;;
    *) fs_die "usage: $0 [all|check|clone|rfd-env|pred-env]" ;;
  esac
}

main "${1:-all}"
