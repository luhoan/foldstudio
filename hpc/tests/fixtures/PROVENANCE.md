# Test fixtures -- what each file is, and what it is not

These are **real files from real public sources**, used to test the bundle writer
and the parsers offline. Regenerate them with `bash fetch_fixtures.sh`.

Nothing here is a model output produced by us, and nothing here is evidence about
any designed protein. The dry-run bundle built from these files is therefore
labelled `kind: "demo"`, never `"executed"`.

| file | what it really is | retrieved from | role in tests |
|---|---|---|---|
| `proteinmpnn_5L33_example1.fa` | **A genuine ProteinMPNN output**, committed by the ProteinMPNN authors. Headers carry their real `score`, `global_score`, `seq_recovery`, `model_name=v_48_020`, `git_hash=015ff820...`, `seed=37`. | `raw.githubusercontent.com/dauparas/ProteinMPNN/main/outputs/example_1_outputs/seqs/5L33.fa` (retrieved 2026-11-14) | exercises the real ProteinMPNN FASTA/score-header parser. The scores are upstream's, measured by them on 5L33 -- **not ours, and not about any FoldStudio design.** |
| `backbone_like_5L33_chainA.pdb` | A **real coordinate excerpt**: chain A of PDB entry 5L33, backbone atoms (N, CA, C, O) only, copied verbatim out of ProteinMPNN's own example input. 424 atoms, 106 residues. | derived from `raw.githubusercontent.com/dauparas/ProteinMPNN/main/inputs/PDB_monomers/pdbs/5L33.pdb` (retrieved 2026-11-14) | a **format** stand-in for an RFdiffusion backbone (backbone-only PDB, chain A). It is an experimental structure, **not a designed backbone.** |

## Why the B-factor column of the PDB fixture matters

`backbone_like_5L33_chainA.pdb` has **experimental B-factors** ranging about
11-83. Those numbers sit inside the 0-100 window that pLDDT also occupies, so a
naive reader would happily mislabel them as "confidence" and report a mean
"pLDDT" of around 30 for a crystal structure.

That is exactly the trap this pipeline is built to avoid, in two independent places:

1. The FoldStudio backend only reads pLDDT from structures whose `source` is
   `predicted`; for anything else `GET /structures/{id}/plddt` returns 409.
2. `hpc/export_bundle.py` registers RFdiffusion backbones as `source: "uploaded"`,
   never `"predicted"`, and emits no pLDDT metric for them -- a designed backbone
   has no confidence estimate attached to it at all.

## What is deliberately missing

There is **no predicted-structure fixture with real pLDDT**. A genuine one would
have to come from AlphaFold DB, ESMFold or ColabFold output, and the sandbox this
code was written in has no route to `alphafold.ebi.ac.uk` or `files.rcsb.org`
(both are blocked by policy there). Rather than hand-write B-factors and call
them pLDDT, the dry run reports every prediction-derived metric as unavailable
with that reason recorded in `metrics.json`.

To exercise the prediction path against real data, point the dry run at a real
predicted model you already have:

```bash
python hpc/export_bundle.py --dry-run --predicted /path/to/AF-P42212-F1-model_v4.pdb ...
```

`python scripts/fetch_demo_data.py` (Stream 4) downloads real AlphaFold DB models
and is the easiest source of one.
