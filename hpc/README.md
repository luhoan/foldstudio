# hpc/ — Stream 3: the design pipeline on Missouri S&T's Mill

A restartable RFdiffusion → ProteinMPNN → structure-prediction pipeline that
exports a **FoldStudio experiment bundle** the backend can import.

> ## Read this first
>
> **Nothing in this directory has been run on the Mill.** It was written and
> tested in a sandbox with no Slurm, no GPU and no access to `files.rcsb.org`
> or `alphafold.ebi.ac.uk`. What *is* verified, and how, is in
> [What has and has not run](#what-has-and-has-not-run). Please read that section
> before you trust any of it.
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

## Which partition? The two briefs disagree

Stream 3's brief said **`requeue`** (free, max 1 day, preemptible). A later
constraint note said student access is **`class`** only (max 4 hours, intended
for coursework, acceptable use to be confirmed with ITRSS). Both can't be the
operating assumption, and only discovery settles it.

Rather than pick one, the pipeline is safe under either:

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
| `lib/common.sh` + `lib/ledger.py` | `bash hpc/tests/test_stage_lib.sh` — **36/36 pass**, including a real `SIGUSR1` preemption (partial work flushed to `$HOME`, exit 99, no false `stage_end`), a resume pass that redoes **zero** finished items, and a torn ledger line that is skipped rather than fatal |
| `export_bundle.py` and its parsers | `python hpc/tests/test_export_bundle.py` — **52/52 pass** |
| **the bundle actually imports** | `python scripts/hpc_check_contract.py` — **24/24 pass**: boots Stream 1's real FastAPI app over a temp data dir, reindexes the bundle, registers its structures, and confirms `/plddt` returns **409** for a backbone, `/pae` returns **404 pae_unavailable**, and `/jobs` returns **501 no_runner** |
| bundle ↔ backend compatibility | also validated directly against **Stream 1's real pydantic `Experiment` model** |
| the wall-time guard | `fs_time_to_seconds` covers every `MaxTime` format `scontrol` prints; the guard was exercised against a simulated 4-hour `class` partition (8 h request rejected, 3:45 default accepted, no-GPU warning raised) |
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

### Never executed, anywhere

**These have never run. Their first execution will be yours.**

| never run | most likely to need a fix |
|---|---|
| `10_setup_env.sh` (clone/env creation) | the conda solve for `SE3nv`; `nvcc` availability for `SE3Transformer` |
| `11_fetch_weights.sh` (all downloads) | outbound access to `files.ipd.uw.edu`; login-node RAM for the ESMFold prefetch |
| `20_rfdiffusion.sbatch` | hydra override names if your RFdiffusion differs from current `main`; the V100/H100 issue above |
| `30_proteinmpnn.sbatch` | output path `<out>/seqs/<name>.fa` |
| `40_predict.sbatch`, `predict_esmfold.py` | **the ESMFold output-dict key names** (`mean_plddt`, `ptm`, `predicted_aligned_error`). The runner prints the keys it actually got and writes null-with-reason rather than guessing, so this is normally a one-line fix |
| `normalize_colabfold.py` | ColabFold's score-JSON keys; run it with `--list-only` first |
| `50_export.sbatch` | paths only (`export_bundle.py` itself is well tested) |
| the prediction half of the bundle | no pLDDT-bearing prediction is bundled with the repo, so `predicted_*` and `self_consistency_*` metrics have never been produced from a real prediction |

### The first things to run on the Mill, in order

```bash
# 1. discovery -- cheap, read-only, answers "is there even a GPU on requeue?"
bash hpc/00_discover.sh && sed -n '/## 5. Verdict/,$p' hpc/DISCOVERED.md

# 2. offline self-check -- no cluster resources used
bash scripts/hpc_dry_run.sh

# 3. setup, then confirm it from its own report
bash hpc/10_setup_env.sh    && bash hpc/10_setup_env.sh check
bash hpc/11_fetch_weights.sh && bash hpc/11_fetch_weights.sh report

# 4. ONE design end-to-end before committing to a full run
FS_NUM_DESIGNS=1 FS_SEQS_PER_DESIGN=2 bash hpc/run_pipeline.sh submit
bash hpc/run_pipeline.sh status

# 5. sanity-check the prediction stage's parsing before trusting its numbers
python hpc/predict_esmfold.py --fasta ~/foldstudio-hpc/runs/<RUN>/seqs/design_0.fa \
    --out-dir /tmp/p --list-only
cat ~/foldstudio-hpc/runs/<RUN>/pred/*.pred.json | head -40   # check plddt_units + unavailable

# 6. then scale up
FS_NUM_DESIGNS=8 FS_SEQS_PER_DESIGN=8 bash hpc/run_pipeline.sh submit
```

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

1. **The off-cluster path is documented but unexercised.** `OFFLOAD.md` describes
   the exact file and ledger contract, derived from what `export_bundle.py`
   actually reads (which is tested), but nobody has run RFdiffusion on Colab and
   walked a bundle through it. There is no notebook yet — deliberately, until
   discovery says whether one is needed.
2. **Apptainer is configured but not wired through.** `fs_activate_env` validates
   the image, but the stage scripts call `python` directly rather than
   `apptainer exec`. Use conda, or add the wrapper, before relying on
   `FS_ENV_MODE=apptainer`.
3. **ColabFold is the less-tested predictor.** `normalize_colabfold.py` has never
   seen real ColabFold output. ESMFold is the primary path; if ESMFold's OpenFold
   build defeats you, run `normalize_colabfold.py --list-only` first.
4. **`FS_NUM_DESIGNS` is not enforced as a completion condition.** Stage 20 exits
   0 when it produced *at least one* backbone, leaving `resume` to finish the
   rest. That is intentional on a preemptible partition, but it means "stage 20
   succeeded" does not mean "all designs exist" — check `status`.
5. **`inference.write_trajectory=False`** keeps the 50 GB home quota safe but
   discards the diffusion trajectories. Flip it in `FS_RFD_EXTRA_ARGS` if you
   want them.
6. **No TM-score.** The bundle reports CA RMSD only. `POST /api/analysis/align`
   (Stream 1) is the place to get TM-score between registered structures.
7. **Multi-chain is unhandled.** Everything assumes a single chain `A`, which is
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
