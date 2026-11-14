# DISCOVERED.md -- Mill cluster capability report

**Status: NOT COLLECTED YET. This is a placeholder, not a report.**

No one has run `hpc/00_discover.sh` on the Mill. Nothing in this file is measured,
and no claim about Mill partitions, GPUs, modules or quotas should be taken from it.
The numbers below are *targets to verify*, taken from the Mill documentation and from
the Stream 3 brief -- not observations.

## How to fill this in

On a **Mill login node** (the script is read-only and cheap -- no compute, no GPU):

```bash
git clone <this repo> && cd foldstudio
bash hpc/00_discover.sh          # overwrites this file with the real report
git add hpc/DISCOVERED.md && git commit -m "hpc: real Mill discovery output"
```

The script records the verbatim stdout+stderr and exit status of:

- `sinfo`, `sinfo -s`, and GPU/limit-formatted `sinfo` queries
- `scontrol show partition` (all partitions, and `requeue` specifically)
- `sacctmgr show assoc where user=$USER`, `sshare`, QOS definitions
- `module avail` (all, plus `cuda`, `cuda-toolkit`, `apptainer`, `conda`, `python`)
- home quota, `/local/scratch` presence and free space, tool versions

It then derives a **verdict** (section 5) on the one question that decides the whole
pipeline: *does the free `requeue` partition actually advertise a GPU GRES?*

## Assumptions this file must replace

These come from the Mill docs / brief and are **unverified by us**:

| assumption | why it matters | where it is used |
|---|---|---|
| Free users get the `requeue` partition; max wall time 1 day; **jobs may be preempted at any time** | every GPU stage must checkpoint and be restartable | `hpc/20_*.sbatch`, `hpc/30_*.sbatch`, `hpc/40_*.sbatch` (`--requeue`, `--signal`) |
| `std-v100` / `std-h100` need an MOU + billing account | we cannot use them by default | `FS_PARTITION`, `FS_ACCOUNT` in `hpc/env.sh` |
| `cuda-toolkit/12.9` on V100, `cuda-toolkit/13.3` on H100 | wrong CUDA module = torch fails to see the GPU | `FS_CUDA_MODULE` in `hpc/env.sh` |
| Each node has `/local/scratch`, ~1.5 TB | fast working space, but node-local and lost on requeue | `FS_SCRATCH` in `hpc/env.sh` |
| Home directory default 50 GB | weights + results must fit, or move to group storage | `FS_HOME_BASE`, `hpc/11_fetch_weights.sh` |
| Do not run work on login nodes | only `00_discover.sh`, `10_setup_env.sh`, `11_fetch_weights.sh` run there (I/O + downloads only) | `hpc/README.md` |

## After collecting

1. Copy the **real** GRES string (e.g. `gpu:v100:1`) into `FS_GPU_GRES` in `hpc/env.sh`.
2. Copy the **real** CUDA module name into `FS_CUDA_MODULE`.
3. If the verdict says there is no GPU on `requeue`: **do not fabricate a run.**
   Use the no-GPU path in `hpc/README.md` -- the FoldStudio app is fully useful with
   `imported`/`demo` bundles, and `POST /jobs` correctly returns
   `501 {"detail":"no_runner"}` when no runner is configured.
