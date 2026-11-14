#!/usr/bin/env bash
# Stream 3 / step 2 -- download model weights into $HOME. LOGIN NODE.
#
#     bash hpc/11_fetch_weights.sh              # everything for FS_PREDICTOR
#     bash hpc/11_fetch_weights.sh rfdiffusion  # RFdiffusion .pt files only
#     bash hpc/11_fetch_weights.sh proteinmpnn  # verify in-repo weights
#     bash hpc/11_fetch_weights.sh predictor    # ESMFold or ColabFold weights
#     bash hpc/11_fetch_weights.sh checksums    # sha256 every weight file (slow)
#     bash hpc/11_fetch_weights.sh report       # what is present, change nothing
#
# WHY THE LOGIN NODE: Mill compute nodes may have no outbound network, and a job
# that dies downloading 10 GB has wasted a requeue slot. Downloading is I/O, not
# compute. Nothing here uses a GPU.
#
# WATCH YOUR QUOTA: home is ~50 GB by default.
#   RFdiffusion .pt files   ~2-4 GB (7 required + 2 optional)
#   ESMFold via torch.hub   ~3-11 GB (esmfold_v1 + its ESM-2 trunk)
#   ColabFold params        ~4-5 GB
# Run `bash hpc/11_fetch_weights.sh report` to see what you have actually used.
#
# NOT YET EXECUTED ON THE MILL -- see "What has and has not run" in hpc/README.md.

set -o errexit
set -o nounset
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpc/env.sh
. "${HERE}/env.sh"

FS_RUN_ID="setup"
FS_WORK="${FS_HOME_BASE}/setup"
FS_PROV="${FS_WORK}/provenance"
FS_LOGS="${FS_WORK}/logs"
FS_CKPT="${FS_WORK}/checkpoints"
FS_EVENTS="${FS_PROV}/events.jsonl"
export FS_RUN_ID FS_WORK FS_PROV FS_LOGS FS_CKPT FS_EVENTS

# shellcheck source=hpc/lib/common.sh
. "${HERE}/lib/common.sh"

# ------------------------------------------------------------------ RFdiffusion
# Upstream ships scripts/download_models.sh and it takes the target directory as
# its one argument (verified against the real upstream script). Calling it beats
# copying a list of URLs into this repo: if upstream re-hosts the weights, this
# keeps working and we are never serving a stale URL.
do_rfdiffusion() {
  fs_stage_begin weights_rfdiffusion
  local dl="${FS_RFDIFFUSION_DIR}/scripts/download_models.sh"
  [ -f "$dl" ] || fs_die "missing ${dl} -- run 'bash hpc/10_setup_env.sh clone' first"
  mkdir -p "${FS_RFD_MODELS}"

  # The base model is the only one this pipeline needs (unconditional monomer
  # scaffold). download_models.sh fetches the full set; that is fine and keeps us
  # aligned with upstream, but if quota is tight see the note in hpc/README.md.
  if [ -f "${FS_RFD_MODELS}/Base_ckpt.pt" ] && fs_is_done rfd_weights; then
    fs_log "RFdiffusion weights already present in ${FS_RFD_MODELS}; skipping"
  else
    command -v wget >/dev/null 2>&1 || fs_die "upstream download_models.sh needs wget, which is not on PATH"
    fs_run download_models bash "$dl" "${FS_RFD_MODELS}" \
      || fs_die "RFdiffusion weight download failed (check outbound access to files.ipd.uw.edu)"
    [ -f "${FS_RFD_MODELS}/Base_ckpt.pt" ] \
      || fs_die "download_models.sh finished but ${FS_RFD_MODELS}/Base_ckpt.pt is missing"
    fs_mark_done rfd_weights "${FS_RFD_MODELS}"
  fi
  fs_note "RFdiffusion weights: $(find "${FS_RFD_MODELS}" -name '*.pt' | wc -l) .pt files, $(du -sh "${FS_RFD_MODELS}" | cut -f1)"
}

# ------------------------------------------------------------------ ProteinMPNN
# Nothing to download: ProteinMPNN commits its weights (vanilla_model_weights/
# and soluble_model_weights/) into the repo. Verified present upstream.
do_proteinmpnn() {
  fs_stage_begin weights_proteinmpnn
  local w="${FS_PROTEINMPNN_DIR}/vanilla_model_weights/${FS_MPNN_MODEL}.pt"
  if [ -f "$w" ]; then
    fs_log "ProteinMPNN weights present: ${w} ($(du -h "$w" | cut -f1))"
    fs_note "ProteinMPNN weights ship inside the repo; no download needed. model=${FS_MPNN_MODEL}"
    fs_mark_done mpnn_weights "$w"
  else
    fs_die "missing ${w}. Either the clone is incomplete (git clone --depth 1 should still include it)
or FS_MPNN_MODEL='${FS_MPNN_MODEL}' is not one of: v_48_002 v_48_010 v_48_020 v_48_030"
  fi
}

# -------------------------------------------------------------------- predictor
do_predictor() {
  fs_stage_begin "weights_${FS_PREDICTOR}"
  mkdir -p "${FS_TORCH_HOME}" "${FS_COLABFOLD_WEIGHTS}"
  fs_activate_env "${FS_PRED_ENV}"

  case "${FS_PREDICTOR}" in
    esmfold)
      if fs_is_done esmfold_weights; then
        fs_log "ESMFold weights already fetched into ${FS_TORCH_HOME}"
      elif [ "${FS_SKIP_ESM_PREFETCH:-0}" = "1" ]; then
        fs_note "FS_SKIP_ESM_PREFETCH=1: skipped the login-node prefetch. Stage 40 will
download on first use, which only works if compute nodes have outbound network."
      else
        # esm.pretrained.esmfold_v1() downloads through torch.hub into $TORCH_HOME
        # and then CONSTRUCTS the model, which needs roughly 16 GB of RAM. That is
        # the cost of using upstream's own loader instead of hardcoding a URL that
        # could go stale. If the login node will not take it, either run this under
        # `srun --mem=32G` (compute node must then have network) or set
        # FS_SKIP_ESM_PREFETCH=1.
        fs_log "prefetching ESMFold weights into ${FS_TORCH_HOME} (several GB, needs ~16 GB RAM)"
        fs_run esmfold_prefetch env "TORCH_HOME=${FS_TORCH_HOME}" python -c '
import esm, torch
# Build on CPU: this is a download+load check on a login node, not inference.
m = esm.pretrained.esmfold_v1()
n = sum(p.numel() for p in m.parameters())
print("esmfold_v1 loaded on CPU; parameters:", n)
' || fs_die "ESMFold prefetch failed. Read the log. To proceed without it:
    FS_SKIP_ESM_PREFETCH=1 bash $0 predictor
or switch predictors:
    FS_PREDICTOR=colabfold bash hpc/10_setup_env.sh pred-env && FS_PREDICTOR=colabfold bash $0 predictor"
        fs_mark_done esmfold_weights "${FS_TORCH_HOME}"
      fi
      ;;
    colabfold)
      if fs_is_done colabfold_weights; then
        fs_log "ColabFold params already downloaded"
      else
        # Downloads the AlphaFold2 params. Read the command's own output for the
        # destination it chose; pass that path to colabfold_batch --data in
        # stage 40 (FS_COLABFOLD_WEIGHTS).
        fs_run colabfold_download python -m colabfold.download \
          || fs_die "ColabFold param download failed; see the log"
        fs_mark_done colabfold_weights "see log for destination"
        fs_note "Confirm the params directory from the colabfold_download log and set
FS_COLABFOLD_WEIGHTS to it, so stage 40 can pass --data."
      fi
      ;;
    *) fs_die "unknown FS_PREDICTOR='${FS_PREDICTOR}'" ;;
  esac
}

# -------------------------------------------------------------------- checksums
# Real sha256 of every weight file, recorded in the ledger. The exported bundle
# cites these, so "which weights produced this" is answerable later.
do_checksums() {
  fs_stage_begin weights_checksums
  command -v sha256sum >/dev/null 2>&1 || fs_die "sha256sum not on PATH"
  local out="${FS_WORK}/weight_checksums.txt"
  : >"$out"
  local n=0
  while IFS= read -r f; do
    sha256sum "$f" >>"$out"
    n=$((n+1))
  done < <(find "${FS_WEIGHTS_DIR}" "${FS_PROTEINMPNN_DIR}/vanilla_model_weights" \
             -maxdepth 3 -type f \( -name '*.pt' -o -name '*.npz' -o -name '*.pkl' \) 2>/dev/null | sort)
  fs_log "hashed ${n} weight files into ${out}"
  fs_note "weight checksums written to ${out#"${FS_HOME_BASE}"/} (${n} files)"
}

# ----------------------------------------------------------------------- report
do_report() {
  echo "--- weights report ($(hostname), $(date -u +%FT%TZ)) ---"
  printf '%-40s %s\n' "RFdiffusion models (${FS_RFD_MODELS})" \
    "$([ -d "${FS_RFD_MODELS}" ] && echo "$(find "${FS_RFD_MODELS}" -name '*.pt'|wc -l) files, $(du -sh "${FS_RFD_MODELS}"|cut -f1)" || echo MISSING)"
  printf '%-40s %s\n' "  Base_ckpt.pt (the one we use)" \
    "$([ -f "${FS_RFD_MODELS}/Base_ckpt.pt" ] && du -h "${FS_RFD_MODELS}/Base_ckpt.pt"|cut -f1 || echo MISSING)"
  printf '%-40s %s\n' "ProteinMPNN ${FS_MPNN_MODEL} (in repo)" \
    "$([ -f "${FS_PROTEINMPNN_DIR}/vanilla_model_weights/${FS_MPNN_MODEL}.pt" ] && echo PRESENT || echo MISSING)"
  printf '%-40s %s\n' "torch hub cache (${FS_TORCH_HOME})" \
    "$([ -d "${FS_TORCH_HOME}" ] && du -sh "${FS_TORCH_HOME}"|cut -f1 || echo MISSING)"
  printf '%-40s %s\n' "ColabFold params (${FS_COLABFOLD_WEIGHTS})" \
    "$([ -d "${FS_COLABFOLD_WEIGHTS}" ] && du -sh "${FS_COLABFOLD_WEIGHTS}"|cut -f1 || echo MISSING)"
  echo
  printf '$HOME usage: '; du -sh "${FS_HOME_BASE}" 2>/dev/null | cut -f1
  df -h "${HOME}" | awk 'NR==2{print "  filesystem: "$4" free of "$2}'
}

main() {
  mkdir -p "${FS_PROV}" "${FS_LOGS}" "${FS_CKPT}"
  case "${1:-all}" in
    rfdiffusion) do_rfdiffusion ;;
    proteinmpnn) do_proteinmpnn ;;
    predictor)   do_predictor ;;
    checksums)   do_checksums ;;
    report)      do_report ;;
    all)
      ( do_rfdiffusion )
      ( do_proteinmpnn )
      ( do_predictor )
      echo
      do_report
      echo
      echo "Next: bash hpc/run_pipeline.sh submit   (submits the GPU stages to Slurm)"
      ;;
    *) fs_die "usage: $0 [all|rfdiffusion|proteinmpnn|predictor|checksums|report]" ;;
  esac
}

main "${1:-all}"
