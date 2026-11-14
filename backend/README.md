# FoldStudio backend (Stream 1)

FastAPI service for structure import/validation, pLDDT/PAE, alignment (RMSD, TM-score), the experiment registry, and report export. SQLite + files under `data/`. No GPU needed.

## Run

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
./run.sh                  # http://localhost:8000  (interactive docs: /docs)
python -m pytest          # run the test suite
```

Environment variables: `FOLDSTUDIO_DATA_DIR` (default `<repo>/data`), `FOLDSTUDIO_RUNNERS=precomputed` (opt-in job runner), `FOLDSTUDIO_USALIGN=/path/to/USalign` (optional TM-score binary).

## Endpoints (all under `/api`)

| Method | Path | Notes |
|---|---|---|
| POST | `/structures/upload` | multipart `file`, optional `label`, `source` (`uploaded`/`experimental`/`predicted`). PDB, mmCIF, FASTA |
| POST | `/structures/fetch` | `{source: "rcsb"\|"afdb", id}`; AFDB also stores PAE when available |
| POST | `/structures/register` | register a file already under `data/structures/` (for the data-fetch script) |
| GET | `/structures`, `/structures/{id}`, `/structures/{id}/file`, `/residues`, `/plddt`, `/pae` | `/plddt` only for `source=predicted`; `/pae` 404 `pae_unavailable` if none |
| POST | `/structures/{id}/pae` | attach PAE JSON (size must match residue count) |
| POST | `/analysis/align` | `{mobile_id, reference_id, selection{mobile_chain, reference_chain, mobile_range, reference_range, method: sequence\|resnum}}` |
| GET/POST | `/experiments`, `/experiments/{id}`, `/experiments/compare`, `/experiments/reindex` | bundles in `data/experiments/<id>/experiment.json` are loaded at startup and on reindex |
| GET | `/reports?ids=a,b&format=html\|markdown\|json` | |
| POST | `/jobs` | 501 `no_runner` unless a runner is registered |

Errors are `{"detail": "<code>: <message>"}`.

## Scientific conventions

- **pLDDT** is read from the B-factor column only for structures with `source=predicted`; values outside 0-100 are refused. Bins, lower bound inclusive: `>=90` very_high, `70 to <90` confident, `50 to <70` low, `<50` very_low. The explanation rules and the 3D viewer use the same boundaries (`tests/test_plddt_convention.py`).
- **Alignment** uses CA atoms over explicitly matched residues (sequence alignment with BLOSUM62, or residue number). The response lists every pair, `aligned_atoms`, `atom_type`, chains and the 4x4 matrix (column vectors, mobile -> reference frame). RMSD is one optimal rigid superposition, no outlier rejection.
- **TM-score** always comes with `tm_score_method`. With `USalign` on PATH it is sequence-independent USalign output; otherwise a built-in fixed-correspondence heuristic (may slightly underestimate official values).
- Experiments: `executed`+`ok` must list outputs; `failed` must carry the real error. `PrecomputedRunner` never reports a run as executed.

## Known limits

- RCSB/AlphaFold DB fetch code is tested only against mocked HTTP (no network in the build environment); verify once with a real ID.
- USalign output parsing is tested only on a sample string, not a real binary.
- Chains are read from the first model only; nucleic-acid and ligand content is ignored.
