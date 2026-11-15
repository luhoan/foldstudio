# Experiment bundle `hpc_20261114T131350Z`

- **kind**: `executed`  **status**: `partial`
- **model**: RFdiffusion + ProteinMPNN + ESMFold
- **version**: RFdiffusion@86507b6538f5; ProteinMPNN@8907e6671bfb; ProteinMPNN model v_48_020; esmfold_v1
- **created**: 2026-11-14T15:35:25+00:00

Executed by the FoldStudio Stream 3 pipeline (hosts: compute-12-16.mill, compute-33-08.mill, gpu-15-32.mill; Slurm job id(s) 2747129, 2747130, 2747131, 2747132). Stages: driver=ran exit=0; rfdiffusion=ran exit=0; proteinmpnn=ran exit=0; predict_esmfold=ran exit=0; export_bundle=ran exit=None Backbones are registered as source 'uploaded', not 'predicted': a designed backbone carries no pLDDT, and its B-factor column must not be read as confidence. pLDDT, PAE and pTM are the model's own confidence estimates. They are not evidence of folding, binding, affinity, efficacy, safety or biological function. FoldStudio is not a clinical tool and this bundle is not evidence for any therapeutic use. No binder or therapeutic design was performed: the design target is an unconditional monomeric scaffold with no binding partner.

## Import into FoldStudio

```bash
curl -X POST http://localhost:8000/api/experiments/reindex
# then register the structures listed in import_plan.json
```

## Files

| path | what it is |
|---|---|
| `experiment.json` | the Experiment record (matches `docs/CONTRACT.MD`) |
| `metrics.json` | every metric, its definition, and what was unavailable and why |
| `structures/` | backbone and predicted PDB files, plus PAE JSON where it exists |
| `sequences/` | ProteinMPNN FASTA output |
| `provenance/` | the append-only ledger and the per-stage summary |
| `checksums.json` | sha256 of every file above |
| `import_plan.json` | the exact API calls to register these structures |

## What this is not

pLDDT, PAE and pTM are the model's own confidence estimates. They are not evidence of folding, binding, affinity, efficacy, safety or biological function.

Self-consistency RMSD compares a designed backbone with a structure predicted from the designed sequence. It measures agreement between two computational models, not experimental validation.

FoldStudio is not a clinical tool and this bundle is not evidence for any therapeutic use.
