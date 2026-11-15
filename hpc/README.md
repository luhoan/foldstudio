# hpc/ — Stream 3: the design pipeline on Missouri S&T's Mill

A restartable RFdiffusion → ProteinMPNN → structure-prediction pipeline that
exports a **FoldStudio experiment bundle** the backend can import.

> ## Read this first
>
> **Part of this has now run on the Mill; most of it still has not.** One real
> run exists (`20261114T115930Z`): discovery, both environment builds, the
> RFdiffusion stage and the ProteinMPNN stage all succeeded on a V100 node of
> `requeue`. The prediction stage was started and **its outcome has never been
> seen**; nothing has been exported from the cluster. Everything else was written
> and tested in a sandbox with no Slurm, no GPU and no access to `files.rcsb.org`
> or `alphafold.ebi.ac.uk`. Exactly what ran, and what is merely tested offline,
> is in [What has and has not run](#what-has-and-has-not-run). Please read that
> section before you trust any of it.
>
> The app does not need this pipeline. FoldStudio is fully useful with no GPU:
> `POST /jobs` returns `501 {"detail":"no_runner"}` by design, and the
> `imported`/`demo` bundles from Stream 4 drive the whole UI. Treat this as the
> optional "we really did run a design job" path.

---

## What it designs, and what that does not mean

A **small de novo monomeric scaffold**: an unconditional 60-residue backbone,
sequences designed onto it, then a structure predicted back from each sequence.

- There is **no binding target**. RFdiffusion's binder-design path
  (`ppi.hotspot_res`, `scaffoldguided.target_pdb`) is deliberately not used.
- The one quality number the pipeline computes is **self-consistency CA RMSD**:
  does the designed sequence fold back to the designed backbone, according to a
  predictor? That is agreement between two computational models.
- **pLDDT, PAE and pTM are model confidence.** They are not evidence of folding,
  binding, affinity, efficacy, safety or function. Nothing here is experimental
  validation, and FoldStudio is not a clinical tool.

---

## Quick start

```bash
# 0. on a Mill LOGIN NODE: find out what we can actually get
bash hpc/00_discover.sh            # writes hpc/DISCOVERED.md -- read section 5 first
#    then copy the real GRES string and CUDA module into hpc/env.sh

# 1. still on the login node: build the environments (git clone + conda + pip)
bash hpc/10_setup_env.sh           # or: 10_setup_env.sh check  (read-only report)

# 2. still on the login node: download weights (compute nodes may have no network)
bash hpc/11_fetch_weights.sh       # or: 11_fetch_weights.sh report

# 3. submit the chain of jobs
bash hpc/run_pipeline.sh preflight # does this partition allow what we're asking for?
bash hpc/run_pipeline.sh plan      # print the exact sbatch commands, submit nothing
bash hpc/run_pipeline.sh submit    # stages 20 -> 30 -> 40 -> 50, chained afterok

# 4. watch it
bash hpc/run_pipeline.sh status
bash hpc/run_pipeline.sh status <RUN_ID>

# 5. if preemption left it unfinished, resubmit only what is missing
bash hpc/run_pipeline.sh resume <RUN_ID>

# 6. export the bundle (stage 50 also does this automatically)
bash hpc/run_pipeline.sh export <RUN_ID>
```

Verify the whole thing offline first, on any machine, in about a second:

```bash
bash scripts/hpc_dry_run.sh           # tests + a demo bundle
python scripts/hpc_check_contract.py  # does the bundle still import into Stream 1's API?
```

## Which partition? Settled: `requeue`

Stream 3's brief said **`requeue`** (free, max 1 day, preemptible). A later
constraint note said student access is **`class`** only (max 4 hours, intended
for coursework). Discovery on the cluster settled it: **there is no `class`
partition on the Mill** — `sbatch` rejects it with "invalid partition" — and
`requeue` is what we have. GPU jobs have since run there successfully, so this
is observed rather than assumed.

The pipeline is nonetheless still safe under a short-wall-time partition, which
is worth keeping: `requeue` preempts, so every stage has to survive a short life
anyway.

- `FS_TIME_GPU` defaults to **03:45:00**, which is valid on a 4-hour cap *and* on
  `requeue`. Every stage checkpoints, so short jobs cost only an extra `resume`.
- `bash hpc/run_pipeline.sh preflight` reads the partition's **real** `MaxTime`
  from `scontrol` and **refuses to submit** a job that exceeds it, instead of
  letting it sit `PENDING` forever. It also warns when the partition advertises
  no GPU GRES.
- If the partition has no GPUs, the two GPU stages move off-cluster — see
  [`OFFLOAD.md`](OFFLOAD.md).

Worth saying plainly: running a protein-design pipeline on a partition *intended
for coursework* is a policy question, not a technical one. **Send the ITRSS email
before investing in this path.** If they say no, that is the answer for Stream 3
regardless of what the GRES column says.

## Files

| file | what it does | GPU? | where to run |
|---|---|---|---|
| `env.sh` | all configuration; override via env vars or `hpc/env.local.sh` | – | sourced |
| `00_discover.sh` | records real `sinfo`/`scontrol`/`sacctmgr`/`module avail` output into `DISCOVERED.md` | no | login node |
| `10_setup_env.sh` | clone RFdiffusion + ProteinMPNN, create conda envs | no | login node |
| `11_fetch_weights.sh` | download model weights into `$HOME` | no | login node |
| `20_rfdiffusion.sbatch` | generate backbones | **yes** | sbatch |
| `30_proteinmpnn.sbatch` | design sequences | no (CPU on purpose) | sbatch |
| `40_predict.sbatch` | ESMFold or ColabFold | **yes** | sbatch |
| `50_export.sbatch` | build + tar the bundle | no | sbatch |
| `run_pipeline.sh` | preflight / submit / status / resume / export / plan / dry-run | no | login node |
| `OFFLOAD.md` | file contract for running the GPU stages off-cluster (Colab/Kaggle/Adroit) | – | docs |
| `../scripts/hpc_check_contract.py` | imports a bundle through Stream 1's **real** API and fails if a cross-stream assumption broke | no | anywhere |
| `export_bundle.py` | write `data/experiments/<id>/` | no | anywhere |
| `predict_esmfold.py` | ESMFold runner (PDB + PAE + real metrics sidecar) | yes | called by stage 40 |
| `normalize_colabfold.py` | fold ColabFold output into the same contract | no | called by stage 40 |
| `lib/ledger.py` | append-only provenance ledger | no | – |
| `lib/common.sh` | stage bracketing, checkpoints, preemption handling | no | – |

## Where things live

```
$HOME/foldstudio-hpc/            # FS_HOME_BASE; home is ~50 GB, watch the quota
├── tools/{RFdiffusion,ProteinMPNN}
├── weights/{rfdiffusion,torch,colabfold}
└── runs/<RUN_ID>/               # FS_WORK -- authoritative, survives preemption
    ├── backbones/ seqs/ pred/
    ├── checkpoints/             # one .done marker per finished item
    ├── provenance/events.jsonl  # append-only ledger
    └── logs/

/local/scratch/$USER/<RUN_ID>/   # fast, ~1.5 TB, NODE-LOCAL -- a cache only
```

`/local/scratch` is node-local, so a requeued job can land on a different node
and find it empty. Every stage therefore syncs results back into `$HOME` after
**each item**, and treats `$HOME` as the source of truth. That is the single most
important design decision in here.

---

## Setup details

### Environments (conda)

`10_setup_env.sh` builds **two** conda envs, because their pins genuinely conflict:

- **`SE3nv`** — created from RFdiffusion's own `env/SE3nv.yml`, then its documented
  install sequence (`SE3Transformer` requirements → `setup.py install` →
  `pip install -e .`). ProteinMPNN reuses this env; it only needs torch + numpy.
- **`foldstudio-pred`** — python 3.9 plus either ESMFold or ColabFold.

> **RFdiffusion cannot run on H100 with the stock env.** Upstream `env/SE3nv.yml`
> pins `python=3.9, pytorch=1.9, cudatoolkit=11.1, dgl-cuda11.1`. PyTorch 1.9/cu11.1
> ships no `sm_90` kernels, so an H100 fails with *"no kernel image is available
> for execution on the device"*. **Target V100.** If you must use H100, use the
> official container (`FS_ENV_MODE=apptainer`, see below) or a newer fork.

`FS_ENV_MODE=venv` and `FS_ENV_MODE=apptainer` are also supported by
`fs_activate_env`. For apptainer, build from the Rosetta Commons image and point
`FS_APPTAINER_SIF` at it; the stage scripts will then need their `python` calls
wrapped in `apptainer exec`, which is **not yet wired up** — see
[Known gaps](#known-gaps-and-risks).

### Weights

| model | how | size |
|---|---|---|
| RFdiffusion | upstream's own `scripts/download_models.sh <dir>` | ~2–4 GB |
| ProteinMPNN | **nothing to download** — weights are committed in the repo (`vanilla_model_weights/`) | – |
| ESMFold | `esm.pretrained.esmfold_v1()` via `torch.hub` into `$TORCH_HOME` | ~3–11 GB |
| ColabFold | `python -m colabfold.download` | ~4–5 GB |

**Download on the login node.** Mill compute nodes may have no outbound network,
and a job that dies 10 GB into a download has burned a requeue slot for nothing.
Downloading is I/O, not compute.

The ESMFold prefetch calls upstream's own loader, which also *constructs* the
model and so needs ~16 GB RAM. If that is too much for a login node:

```bash
FS_SKIP_ESM_PREFETCH=1 bash hpc/11_fetch_weights.sh predictor   # download lazily in the job
```

Record what you actually got: `bash hpc/11_fetch_weights.sh checksums` writes the
real sha256 of every weight file into the ledger.

---

## Surviving the `requeue` partition

Free users get `requeue`: max 1 day, **preemptible at any moment**. Every GPU
stage is submitted with:

```
--partition=requeue --requeue --signal=B:USR1@120 --open-mode=append
```

and on `SIGUSR1` the stage flushes scratch to `$HOME`, appends a `preempted`
event, and exits 99 without writing a `stage_end` — so the ledger never claims
an interrupted attempt finished. Slurm requeues it, and the next attempt skips
finished items via their checkpoint markers.

Granularity is **one item per invocation**:

- stage 20 runs RFdiffusion once per design, using `inference.design_startnum=<i>`
  so the output index is fixed and finished designs are never regenerated;
- stage 30 runs ProteinMPNN once per backbone;
- stage 40 skips sequences whose output already exists.

So a preemption costs at most the single item in flight. Preemptions are not
hidden: they appear in `run_pipeline.sh status` and as a
`stage_<name>_preemptions` metric in the exported bundle.

### Reproducibility, stated honestly

| tool | seed control | reproducible? |
|---|---|---|
| ProteinMPNN | real `--seed` flag; stage 30 uses `FS_SEED + <backbone index>` | yes, exactly |
| RFdiffusion | `inference.deterministic=True` only — **upstream's config has no `inference.seed`** (checked in `config/inference/base.yaml`) | per-index, with the caveat below |
| ESMFold | deterministic given the sequence | yes |

The RFdiffusion caveat: because each invocation generates exactly one design, a
design regenerated after a preemption starts from the same state as a fresh run
of that index — but it is **not guaranteed bit-identical** to what that index
would have produced inside one long uninterrupted multi-design run, where RNG
state carries across designs. The bundle records this in `settings`, and the
ledger records which designs came from which attempt, so it is auditable rather
than hidden.

---

## The exported bundle

`export_bundle.py` writes `data/experiments/<id>/`:

```
experiment.json    the Experiment record (docs/CONTRACT.MD)
metrics.json       values + unavailable (with reasons) + definitions + per-design detail
structures/        backbone and predicted PDBs, plus PAE JSON where it exists
sequences/         ProteinMPNN FASTA
provenance/        events.jsonl (verbatim) + stages.json (folded)
checksums.json     sha256 of every file above
import_plan.json   the exact API calls to register these structures
README.md          what this bundle is and is not
```

Import it:

```bash
curl -X POST http://localhost:8000/api/experiments/reindex     # reads experiment.json
# then POST /api/structures/register for each entry in import_plan.json
```

### The rules it enforces

1. **`kind: "executed"` requires both** a ledger showing the stage ran **and** the
   output files present on disk. Files alone are not enough; a ledger alone is
   not enough. A dry run is always `"demo"`.
2. **`status`** is derived from what exists: `ok` / `partial` / `failed`. A
   `failed` bundle carries the **real** error text from the ledger. If nothing
   was recorded, it says exactly that instead of inventing a cause.
3. **No placeholder metrics, ever.** Every value in `metrics` is computed from a
   file in the bundle. Anything that could not be computed is absent from
   `metrics` and listed in `metrics.json["unavailable"]` with the reason.
4. **Backbones register as `source: "uploaded"`, never `"predicted"`.** A designed
   backbone has no pLDDT; labelling it `predicted` would make the app report
   confidence that does not exist. (The backend independently refuses pLDDT for
   non-`predicted` structures — two locks on the same door.)
5. **RMSD is never reported without its selection** (`atom_type: "CA"` plus the
   atom count), and a mismatched residue count produces *no* RMSD rather than a
   silent partial alignment.

Two subtleties worth knowing about, both deliberate:

- **`seq_recovery` is suppressed for RFdiffusion backbones.** ProteinMPNN reports
  recovery against the *input PDB's own sequence*; an RFdiffusion backbone has no
  native sequence, so the number would describe a comparison nobody made. It is
  recorded as unavailable with that reason.
- **The pLDDT scale is measured, not assumed.** Different ESMFold/ColabFold
  versions have written B-factors on 0–1 and on 0–100. The runners detect the
  range, normalise only when the evidence says to, and record which branch they
  took. Out-of-range values are left alone and explicitly *not* called pLDDT.

### No-GPU path

If `DISCOVERED.md` section 5 says there is no GPU on `requeue` and you have no
MOU for `std-v100`/`std-h100`: **do not fake a run.** The honest options are an
`imported` bundle (Stream 4's `scripts/fetch_demo_data.py` fetches real public
structures) or a `demo` bundle from `scripts/hpc_dry_run.sh`. Both are labelled
as such everywhere in the UI.

---

## What has and has not run

### Verified, by running it here

| what | how |
|---|---|
| `lib/common.sh` + `lib/ledger.py` | `bash hpc/tests/test_stage_lib.sh` — **61/61 pass**, including a real `SIGUSR1` preemption (partial work flushed to `$HOME`, exit 99, no false `stage_end`), a resume pass that redoes **zero** finished items, and a torn ledger line that is skipped rather than fatal |
| `export_bundle.py` and its parsers | `python hpc/tests/test_export_bundle.py` — **83/83 pass** |
| the OpenFold source patch | `python hpc/tests/test_openfold_patch.py` — **10/10 pass**, against fixtures copied verbatim from the pinned upstream commit |
| the ESMFold env build | `bash hpc/tests/test_setup_pred_env.sh` — **45/45 checks pass**, driving `do_pred_env` against stand-in `conda`/`pip`/`git`/`gcc`/`nvcc`/`module` so the order and the flags are asserted without a GPU |
| **the bundle actually imports** | `python scripts/hpc_check_contract.py` — **27/27 pass, 0 warnings**: boots Stream 1's real FastAPI app over a temp data dir, reindexes the bundle, registers its structures, and confirms `/plddt` returns **409** for a backbone, `/pae` returns **404 pae_unavailable**, and `/jobs` returns **501 no_runner** |
| bundle ↔ backend compatibility | also validated directly against **Stream 1's real pydantic `Experiment` model** |
| the wall-time guard | `fs_time_to_seconds` covers every `MaxTime` format `scontrol` prints; the guard was exercised against a simulated 4-hour partition (8 h request rejected, 3:45 default accepted, no-GPU warning raised) — a cap that no real Mill partition turned out to have, but the guard is what proved that cheaply |
| the GPU-type preflight | `run_pipeline.sh preflight` compares the GRES we ask for against the types the partition actually offers, and says so when the partition advertises none |
| RMSD arithmetic | checked on real coordinates under known rigid transforms (rotation + translation → 0; alternating displacement → the right magnitude) |
| the validator itself | 10 tests mutate a good bundle and confirm each violation is caught |
| ProteinMPNN output parsing | against a **genuine ProteinMPNN output** committed upstream; parsed scores match its own headers (0.8221 / 0.8356 → mean 0.8289) |
| `00_discover.sh`, `10_setup_env.sh check`, `11_fetch_weights.sh report`, `run_pipeline.sh plan`/`status` | executed here; they degrade honestly when Slurm/conda/GPU are absent |
| all shell scripts | `shellcheck -S warning` clean |
| fixtures | re-download byte-identically from upstream (`fetch_fixtures.sh`) |

Install commands and flags were taken from the **real upstream sources**, fetched
and read rather than recalled: RFdiffusion's `env/SE3nv.yml`,
`config/inference/base.yaml` and `scripts/download_models.sh`; ProteinMPNN's
`protein_mpnn_run.py` argument list; the ESM README's ESMFold install block.

### What has actually run on the Mill

One real run exists: **`20261114T115930Z`**, `FS_NUM_DESIGNS=1`, on a
`V100-SXM2-32GB` node of `requeue`.

| stage | on the Mill |
|---|---|
| `00_discover.sh` | ran; its findings are what fixed `FS_GPU_GRES`, the module names and the `class`-partition question above |
| `10_setup_env.sh` | ran, for both environments. The ESMFold half needed real repairs, which are now **in the script** rather than in someone's shell history: torch from the `cu121` index, OpenFold built from a pinned commit with `-std=c++17` and `--no-build-isolation`, `deepspeed` uninstalled (it imports the removed `torch._six`), and `seed.py` patched to import `seed_everything` from `pytorch_lightning` |
| `11_fetch_weights.sh` | ran for RFdiffusion. The ESMFold prefetch was skipped on purpose (`FS_SKIP_ESM_PREFETCH=1`); ColabFold params were never fetched |
| `20_rfdiffusion.sbatch` | **exit 0**, ~70 s, one backbone |
| `30_proteinmpnn.sbatch` | **exit 0**, ~4 s |
| `40_predict.sbatch` (esmfold) | **started, outcome unverified.** It was still running when this session lost its view of the cluster. Nobody has seen it finish, and none of its output has been inspected |
| `50_export.sbatch` | **never run there.** No bundle has been exported from the cluster |

So the pipeline is no longer hypothetical through stage 30, and the prediction
stage at least gets as far as loading a repaired ESMFold. Everything past that
is still unproven.

### Still never executed, anywhere

| never run | most likely to need a fix |
|---|---|
| `predict_esmfold.py` **to completion** | **the ESMFold output-dict key names** (`mean_plddt`, `ptm`, `predicted_aligned_error`). The runner prints the keys it actually got and writes null-with-reason rather than guessing, so this is normally a one-line fix |
| `normalize_colabfold.py`, and the whole `FS_PREDICTOR=colabfold` path | ColabFold's score-JSON keys; run it with `--list-only` first |
| `50_export.sbatch` against a real ledger | paths only (`export_bundle.py` itself is well tested offline) |
| `scripts/hpc_import_bundle.py` against a real bundle | it has only ever imported bundles made by `--dry-run` |
| the prediction half of the bundle | no pLDDT-bearing prediction has been produced by this pipeline, so `predicted_*` and `self_consistency_*` metrics have never come from a real prediction of ours |
| the off-cluster path (`OFFLOAD.md`) | documented from what the exporter actually reads, but never walked end to end |

### Next time you are on the Mill, in order

The repaired setup script is newer than the environment on the cluster, so pull
first. Nothing below re-runs a finished stage.

```bash
# 1. get the fixes that came out of the last session
cd ~/foldstudio && git pull

# 2. where did run 20261114T115930Z actually get to?
bash hpc/run_pipeline.sh status

# 3. if the prediction finished: export it. `export` with no run id now
#    defaults to the newest run and says which one it picked.
bash hpc/run_pipeline.sh export

# 3b. if it did not finish, resume -- finished stages are skipped
bash hpc/run_pipeline.sh resume

# 4. before trusting any prediction number, look at what the model really keyed
cat ~/foldstudio-hpc/runs/20261114T115930Z/pred/*.pred.json | head -40
#    plddt_units and any `unavailable` reasons are the things to read

# 5. only then scale up
FS_NUM_DESIGNS=8 FS_SEQS_PER_DESIGN=8 bash hpc/run_pipeline.sh submit
```

Then copy the bundle back and import it on the laptop:

```bash
scp mill:/tmp/bundle_hpc_<RUN>.tar.gz /tmp/
python3 scripts/hpc_import_bundle.py /tmp/bundle_hpc_<RUN>.tar.gz
```

On a cluster where none of this has run yet, start one step earlier:
`bash hpc/00_discover.sh`, then `bash scripts/hpc_dry_run.sh`, then
`bash hpc/10_setup_env.sh && bash hpc/10_setup_env.sh check`, then
`bash hpc/11_fetch_weights.sh`, then a single-design
`FS_NUM_DESIGNS=1 FS_SEQS_PER_DESIGN=2 bash hpc/run_pipeline.sh submit`.

Exercise the prediction half of the bundle with a real predicted model you
already have (Stream 4's `scripts/fetch_demo_data.py` downloads AlphaFold DB
models):

```bash
python hpc/export_bundle.py --dry-run --data-dir /tmp/d \
    --predicted data/structures/<some real predicted model>.pdb
```

`--predicted` refuses files that announce they are not predictions (our own
fixtures, and anything carrying `EXPDTA X-RAY DIFFRACTION` or a resolution
remark), because experimental B-factors sit in the same 0–100 window as pLDDT
and would otherwise be reported as confidence.

## Known gaps and risks

1. **No prediction has ever been seen to finish, so no bundle has ever carried a
   real pLDDT.** The prediction stage ran on the Mill but its result was never
   observed, and `50_export.sbatch` has never run there. Until a bundle comes off
   the cluster and imports cleanly, treat the `predicted_*` and
   `self_consistency_*` half of the contract as tested-but-unproven.
2. **The off-cluster path is documented but unexercised.** `OFFLOAD.md` describes
   the exact file and ledger contract, derived from what `export_bundle.py`
   actually reads (which is tested), but nobody has run RFdiffusion on Colab and
   walked a bundle through it. There is no notebook yet — deliberately, until
   discovery says whether one is needed.
3. **Apptainer is configured but not wired through.** `fs_activate_env` validates
   the image, but the stage scripts call `python` directly rather than
   `apptainer exec`. Use conda, or add the wrapper, before relying on
   `FS_ENV_MODE=apptainer`.
4. **ColabFold is the less-tested predictor.** `normalize_colabfold.py` has never
   seen real ColabFold output. ESMFold is the primary path; if ESMFold's OpenFold
   build defeats you, run `normalize_colabfold.py --list-only` first.
5. **`FS_NUM_DESIGNS` is not enforced as a completion condition.** Stage 20 exits
   0 when it produced *at least one* backbone, leaving `resume` to finish the
   rest. That is intentional on a preemptible partition, but it means "stage 20
   succeeded" does not mean "all designs exist" — check `status`.
6. **`inference.write_trajectory=False`** keeps the 50 GB home quota safe but
   discards the diffusion trajectories. Flip it in `FS_RFD_EXTRA_ARGS` if you
   want them.
7. **No TM-score.** The bundle reports CA RMSD only. `POST /api/analysis/align`
   (Stream 1) is the place to get TM-score between registered structures.
8. **Multi-chain is unhandled.** Everything assumes a single chain `A`, which is
   what an unconditional monomer design produces.

## Configuration

Everything lives in `hpc/env.sh`. Override per-run on the command line, or
permanently in `hpc/env.local.sh` (sourced if present, and git-ignored):

```bash
FS_PARTITION=std-v100 FS_ACCOUNT=my-mou-account \
FS_GPU_GRES=gpu:v100:1 FS_CONTIG=80-80 FS_NUM_DESIGNS=8 \
  bash hpc/run_pipeline.sh submit
```

The settings that matter most: `FS_PARTITION`, `FS_ACCOUNT`, `FS_GPU_GRES`,
`FS_CUDA_MODULE`, `FS_PREDICTOR`, `FS_CONTIG`, `FS_NUM_DESIGNS`,
`FS_SEQS_PER_DESIGN`, `FS_SEED`, `FS_ENV_MODE`.
