#!/usr/bin/env bash
# Stream 3 / step 0 -- discover what this cluster actually offers.
#
# Run this ON A MILL LOGIN NODE (it is read-only and cheap: no compute, no GPU):
#
#     bash hpc/00_discover.sh
#
# It records sinfo / scontrol show partition / sacctmgr show assoc / module avail
# into hpc/DISCOVERED.md so we can tell -- from evidence, not assumption -- whether
# GPUs are reachable on the free `requeue` partition, which CUDA modules exist,
# and which account (if any) we are allowed to charge.
#
# Every command's real stdout+stderr and exit status is recorded. If a command is
# missing or fails, that is written down as-is; nothing is invented.

set -o errexit
set -o nounset
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-${HERE}/DISCOVERED.md}"

# Make `module` usable in a non-interactive shell (Lmod or environment-modules).
if ! command -v module >/dev/null 2>&1; then
  for f in /etc/profile.d/lmod.sh /etc/profile.d/modules.sh /usr/share/lmod/lmod/init/bash; do
    # shellcheck source=/dev/null
    [ -r "$f" ] && . "$f" && break
  done
fi

WHO="$(id -un)"
HOSTN="$(hostname -f 2>/dev/null || hostname)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# run_block <heading> <command...> -- append a fenced block with the real output.
run_block() {
  local heading="$1"; shift
  local cmd=("$@")
  {
    echo
    echo "### ${heading}"
    echo
    echo '```console'
    echo "\$ ${cmd[*]}"
  } >>"$OUT"
  local rc=0
  if ! command -v "${cmd[0]}" >/dev/null 2>&1 && ! typeset -f "${cmd[0]}" >/dev/null 2>&1; then
    echo "[not found on PATH: ${cmd[0]}]" >>"$OUT"
    rc=127
  else
    # Capture stdout+stderr together; `module` and sacctmgr both write to stderr.
    "${cmd[@]}" >>"$OUT" 2>&1 || rc=$?
  fi
  {
    echo "[exit status: ${rc}]"
    echo '```'
  } >>"$OUT"
  return 0
}

# ------------------------------------------------------------------ header
cat >"$OUT" <<EOF
# DISCOVERED.md -- Mill cluster capability report

**Status: COLLECTED FROM A REAL RUN.**

| field | value |
|---|---|
| collected_at (UTC) | ${NOW} |
| user | ${WHO} |
| host | ${HOSTN} |
| script | hpc/00_discover.sh |

Every block below is the verbatim stdout+stderr of the command shown, with its exit
status. Nothing here is edited or inferred. If a block is empty or shows a non-zero
exit status, that is the real result and should be treated as "unknown", not as "no".
EOF

# ------------------------------------------------------------------ Slurm
{
  echo
  echo '## 1. Partitions and nodes'
} >>"$OUT"

run_block "sinfo (summary)" sinfo
run_block "sinfo -s (per-partition node states)" sinfo -s
run_block "GPU inventory: sinfo -o '%20P %10G %8D %14F %N'" \
  sinfo -o '%20P %10G %8D %14F %N'
run_block "Partition limits: sinfo -o '%20P %10l %10L %8D %12m %10c %G'" \
  sinfo -o '%20P %10l %10L %8D %12m %10c %G'
run_block "scontrol show partition (all partitions, full detail)" scontrol show partition
run_block "scontrol show partition requeue" scontrol show partition requeue

{
  echo
  echo '## 2. Our account / association limits'
} >>"$OUT"

run_block "sacctmgr show assoc (this user)" \
  sacctmgr -p show assoc where user="${WHO}" format=Cluster,Account,User,Partition,QOS,MaxJobs,MaxSubmit,MaxWall,GrpTRES,MaxTRES
run_block "sacctmgr show assoc (raw, unformatted)" \
  sacctmgr show assoc where user="${WHO}"
run_block "sshare (fairshare / usage)" sshare -U -u "${WHO}"
run_block "QOS definitions" sacctmgr -p show qos format=Name,MaxWall,MaxTRES,Priority,Preempt,PreemptMode,Flags

{
  echo
  echo '## 3. Modules'
} >>"$OUT"

run_block "module avail (everything)" module avail
run_block "module avail cuda" module avail cuda
run_block "module avail cuda-toolkit" module avail cuda-toolkit
run_block "module avail apptainer / singularity" module avail apptainer
run_block "module avail conda / mamba / miniconda" module avail conda
run_block "module avail python" module avail python

{
  echo
  echo '## 4. Storage and tooling on this login node'
} >>"$OUT"

run_block "Home quota (df -h \$HOME)" df -h "${HOME}"
run_block "Node-local scratch (ls -ld /local/scratch)" ls -ld /local/scratch
run_block "Scratch free space (df -h /local/scratch)" df -h /local/scratch
run_block "quota -s" quota -s
run_block "apptainer version" apptainer --version
run_block "singularity version" singularity --version
run_block "conda version" conda --version
run_block "python3 version" python3 -V
run_block "git version" git --version
run_block "nvidia-smi (expected to be ABSENT on a login node)" nvidia-smi -L

# ------------------------------------------------- machine-readable GPU verdict
# The question that decides the whole pipeline: can we get a GPU on `requeue`?
# Answer it from sinfo's own output rather than from assumption.
{
  echo
  echo '## 5. Verdict: are GPUs reachable on `requeue`?'
  echo
  echo 'Derived mechanically from `sinfo` above (see the commands for provenance).'
  echo
  echo '```console'
} >>"$OUT"

if command -v sinfo >/dev/null 2>&1; then
  # Partitions whose nodes advertise a gpu GRES.
  GPU_PARTS="$(sinfo -h -o '%P %G' 2>/dev/null | awk '$2 ~ /gpu/ {gsub(/\*/,"",$1); print $1}' | sort -u | tr '\n' ' ' || true)"
  REQUEUE_GRES="$(sinfo -h -p requeue -o '%G' 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  REQUEUE_NODES="$(sinfo -h -p requeue -o '%D' 2>/dev/null | paste -sd+ - | bc 2>/dev/null || echo '?')"
  {
    echo "partitions advertising a gpu GRES : ${GPU_PARTS:-<none found>}"
    echo "GRES visible on 'requeue'         : ${REQUEUE_GRES:-<none found>}"
    echo "node count on 'requeue'           : ${REQUEUE_NODES:-?}"
    if printf '%s' "${REQUEUE_GRES}" | grep -qi 'gpu'; then
      echo "VERDICT: requeue advertises a GPU GRES -> GPU stages can target requeue."
      echo "         Confirm the exact type string (e.g. gpu:v100:1) and set FS_GPU_GRES in hpc/env.sh."
    else
      echo "VERDICT: no GPU GRES seen on requeue in this output."
      echo "         Either request an MOU/billing account for std-v100/std-h100 and set"
      echo "         FS_PARTITION + FS_ACCOUNT, or run the CPU-only path:"
      echo "         the FoldStudio app stays fully useful with imported/demo data and no GPU."
    fi
  } >>"$OUT"
else
  echo "sinfo not found on PATH -- this does not look like a Slurm login node, so no verdict." >>"$OUT"
fi

{
  echo '```'
  echo
  echo '## 6. What to do with this file'
  echo
  echo '1. Commit it: it is the evidence behind every scheduling choice in `hpc/`.'
  echo '2. Copy the real GRES string into `FS_GPU_GRES` and the real CUDA module into'
  echo '   `FS_CUDA_MODULE` in `hpc/env.sh` (or `hpc/env.local.sh`).'
  echo '3. If section 5 says no GPU on `requeue`, do not fake a run: export an'
  echo '   `imported`/`demo` bundle instead (see `hpc/README.md`, "No-GPU path").'
} >>"$OUT"

echo "Wrote ${OUT}"
echo "Review section 5 ('Verdict') first, then update FS_GPU_GRES / FS_CUDA_MODULE in hpc/env.sh."
