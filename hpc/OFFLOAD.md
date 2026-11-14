# Running the GPU stages off the Mill

Use this when `hpc/DISCOVERED.md` says your partition has **no GPUs** (likely if
student access is the 4-hour `class` partition), or when ITRSS says a design
pipeline is not acceptable use for a coursework partition.

The two GPU stages — **20 RFdiffusion** and **40 prediction** — move to Colab,
Kaggle, Princeton Adroit, or any machine with an NVIDIA GPU. The CPU stages
(**30 ProteinMPNN**, **50 export**) stay wherever you like, including a laptop.

Nothing about the bundle changes. `export_bundle.py` does not care which machine
produced the files; it cares that the ledger and the files agree. What it will
**not** do is claim the work happened on the Mill — provenance reports the
hostnames actually recorded and whether a Slurm job id existed, so a Colab run is
labelled as a Colab run.

> Status: **this path has never been exercised.** The file contract below is
> derived from what `export_bundle.py` reads (which *is* tested), but no one has
> run RFdiffusion on Colab and walked a bundle through it. Expect to debug.

## The file contract

Everything is relative to one run directory. On the Mill that is
`$HOME/foldstudio-hpc/runs/<RUN_ID>`; off-cluster it can be any directory, as
long as the layout matches and you pass it as `--work-dir`.

```
<WORK>/
├── backbones/
│   ├── design_0.pdb          <- stage 20 output. One per design, numbered from 0.
│   ├── design_0.trb          <- optional; RFdiffusion's own metadata sidecar
│   └── design_1.pdb
├── seqs/
│   └── design_0.fa           <- stage 30 output. ProteinMPNN's FASTA, UNEDITED.
├── pred/
│   ├── design_0_s1.pdb       <- stage 40 output. pLDDT in the B-factor column.
│   ├── design_0_s1.pae.json  <- optional: {"predicted_aligned_error": [[...]], ...}
│   └── design_0_s1.pred.json <- optional sidecar: mean_plddt, ptm, plddt_units
└── provenance/
    └── events.jsonl          <- the ledger. Without it, kind can never be "executed".
```

Rules that matter:

- **Names pair the stages up.** A prediction is matched to its backbone by name
  prefix: `design_0_s1.pdb` → `design_0.pdb`. Break that and the
  self-consistency RMSD is reported as unavailable rather than guessed.
- **Do not reformat the ProteinMPNN FASTA.** Its headers carry the real
  `score`, `global_score`, `seq_recovery`, `model_name` and `seed`, and those
  headers are where every sequence metric comes from. Hand-editing them is
  fabricating data.
- **pLDDT must be in the B-factor column on a 0–100 scale.** If your predictor
  writes 0–1, `predict_esmfold.py` / `normalize_colabfold.py` normalise it and
  record that they did. If you produce the PDB some other way, say so in the
  sidecar's `plddt_units` rather than silently rescaling.
- **`pred/*.pdb` is only ever a real prediction.** Anything else in that
  directory will be registered as `source: "predicted"` and its B-factors read
  as confidence.

## Recording that it really ran, honestly

`kind: "executed"` requires a ledger entry **and** the files. If the GPU work
happened on Colab, record it from wherever you assemble the run directory:

```bash
RUN=offload_$(date -u +%Y%m%dT%H%M%SZ)
WORK=$PWD/runs/$RUN
L=$WORK/provenance/events.jsonl
mkdir -p "$WORK"/{backbones,seqs,pred,provenance}

# one stage_start / stage_end pair per stage that actually ran
python3 hpc/lib/ledger.py append --file "$L" --run-id "$RUN" \
    --stage rfdiffusion --event stage_start --kv host="colab-gpu-t4"
python3 hpc/lib/ledger.py append --file "$L" --run-id "$RUN" \
    --stage rfdiffusion --event cmd --kv name=design_0 \
    --json-kv argv='["python","scripts/run_inference.py","contigmap.contigs=[60-60]","inference.num_designs=1","inference.design_startnum=0","inference.deterministic=True"]' \
    --json-kv exit=0 --json-kv wall_seconds=96.4
python3 hpc/lib/ledger.py append --file "$L" --run-id "$RUN" \
    --stage rfdiffusion --event stage_end --json-kv exit=0 --json-kv wall_seconds=96.4 \
    --json-kv 'git={"rfdiffusion":"<the commit you actually ran>"}'
```

Repeat for `proteinmpnn` and `predict_esmfold`. Then export:

```bash
FS_SITE="Google Colab (T4)" python3 hpc/export_bundle.py \
    --work-dir "$WORK" --data-dir data --experiment-id "hpc_$RUN"
```

`FS_SITE` is free text that lands in `provenance.source`. Use it. A bundle that
says *Google Colab (T4)* is honest; one that silently implies the Mill is not.

Two things to be straight about when you do this:

- **Record the real argv and the real commit.** Those fields exist so someone
  can reproduce the run. Typing in plausible-looking values defeats the entire
  point of the ledger, and is exactly the kind of thing the integrity rules
  forbid. If you did not record a number, leave it out — every metric is
  optional and the bundle states what is missing and why.
- **No Slurm job id will be recorded**, so the bundle will say so explicitly:
  *"no Slurm job id was recorded, so at least one stage ran outside a Slurm batch
  job."* That sentence is correct and should stay.

## Verifying before you trust it

```bash
# does the assembled directory produce a valid bundle?
python3 hpc/export_bundle.py --work-dir "$WORK" --data-dir /tmp/check
python3 hpc/export_bundle.py --validate-only /tmp/check/experiments/hpc_$RUN

# does it import into the real backend, and does the pLDDT lock still hold?
python3 scripts/hpc_check_contract.py -v
```

Check the exported `metrics.json`: `values` should contain only things measured
from your files, and `unavailable` should explain every gap. If a number you
expected is missing, the reason is written there — that is the design, not a bug.

## What to run where

| stage | needs GPU | off-cluster notes |
|---|---|---|
| 20 RFdiffusion | yes | heaviest install (`SE3nv`: pytorch 1.9 / cu11.1, so **no H100**). Colab's T4/L4 are fine. |
| 30 ProteinMPNN | no | seconds on CPU for 60-residue backbones; weights ship in the repo. Run it anywhere. |
| 40 prediction | yes | ESMFold needs python ≤ 3.9 and `nvcc`; ColabFold is usually the easier install off-cluster. Use single-sequence mode either way. |
| 50 export | no | pure python + numpy. A laptop is the natural place for it. |

If only stage 20 is blocked, you can still run 30 and 50 on the Mill: copy
`backbones/` over, and the ledger will show the stages running on different
hosts, which is exactly what the `hosts` field is for.
