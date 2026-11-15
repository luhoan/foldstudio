# FoldStudio

A workbench for looking at protein structures and, optionally, for running a
small de novo design pipeline on an HPC cluster and importing the result.

Three parts, each usable without the others:

| part | what it is | needs |
|---|---|---|
| `backend/` | a FastAPI service over a directory of structures: confidence, alignment, interfaces, experiment bundles | Python 3.10+ |
| `frontend/` | a React + Mol\* app that reads that API | Node 20+ |
| `hpc/` | RFdiffusion → ProteinMPNN → ESMFold on Slurm, exporting a bundle the backend imports | a cluster, a GPU |

**The app does not need the pipeline.** With no GPU anywhere in sight,
`POST /api/jobs` answers `501 {"detail": "no_runner"}` on purpose, and the
imported and demo bundles drive every screen. `hpc/` is the optional "we really
did run a design job" path, and most of it is still unproven — read
[What has and has not run](hpc/README.md#what-has-and-has-not-run) before
trusting it.

## What the numbers mean, and what they do not

pLDDT, PAE and pTM are a model's own confidence in its own output. The one
quality number the pipeline computes is **self-consistency CA RMSD**: whether a
designed sequence folds back to the backbone it was designed for, according to a
predictor. That is agreement between two computational models.

None of it is evidence of folding, binding, affinity, efficacy, safety or
function, and none of it is experimental validation. **FoldStudio is not a
clinical tool.** The UI carries that caveat and labels where every number came
from; please do not strip either.

## Quick start

Two terminals. The frontend proxies `/api` to port 8000, so start the backend
first.

```bash
# terminal 1 -- backend on :8000
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python3 -m uvicorn app.main:create_app --factory --reload --port 8000

# terminal 2 -- frontend on :5173
cd frontend
npm ci
npm run dev
```

Then open <http://localhost:5173>.

A fresh checkout has no structures in it, so the app will be empty and honest
about it. To fill it with real public ones:

```bash
python3 scripts/fetch_demo_data.py      # verified RCSB/AFDB entries -> data/
```

Every candidate is checked against its source API before it is included, and
anything unverifiable is dropped and listed in `data/fetch_report.json`.
Citations are copied from the entry's own metadata; nothing is invented. If your
network cannot reach `files.rcsb.org` or `alphafold.ebi.ac.uk`, drag a `.pdb` or
`.cif` into the app instead — upload works offline.

Where the data lives is `FOLDSTUDIO_DATA_DIR` (default `./data`):

```bash
FOLDSTUDIO_DATA_DIR=/tmp/fsdata python3 -m uvicorn app.main:create_app --factory --port 8000
```

### Without a backend

The frontend can run against recorded fixtures — the actual captured responses
of the real API, not hand-written ones:

```bash
cd frontend && echo 'VITE_USE_MOCKS=true' > .env.local && npm run dev
```

Refresh them after an API change with `python3 scripts/export_api_fixtures.py`,
and check them for drift in CI with `--check`.

## The API

Everything is under `/api`. Interactive docs at
<http://localhost:8000/docs> once it is running.

| | |
|---|---|
| structures | `GET /structures`, `GET /structures/{sid}`, `/file`, `/residues`, `/plddt`, `/pae`, `/structures/{sid}/interfaces` |
| getting them in | `POST /structures/upload`, `POST /structures/fetch`, `POST /structures/register`, `POST /structures/reindex` |
| analysis | `POST /analysis/align`, `POST /experiments/compare`, `GET /explain` |
| experiments | `GET /experiments`, `POST /experiments`, `GET /experiments/{exp_id}`, `POST /experiments/reindex` |
| reports | `GET /reports?ids=a,b&format=html\|markdown\|json` |
| jobs | `POST /jobs` → `501 no_runner`; `GET /jobs/{job_id}` |

Two refusals are deliberate and worth knowing, because they are the shape of the
whole project: `/plddt` on an experimental structure answers **409**, not a
number, because experimental B-factors occupy the same 0–100 range as pLDDT and
would otherwise be read as confidence. `/pae` with no PAE on file answers **404
`pae_unavailable`** rather than a plausible-looking matrix.

The full contract, including every error code and who owns which field, is
[`docs/CONTRACT.MD`](docs/CONTRACT.MD).

## Tests

```bash
cd backend && python3 -m pytest -q          # the API, the maths, the refusals
python3 scripts/export_api_fixtures.py --check   # fixtures still match the API

cd frontend && npm run typecheck && npm run lint && npm test && npm run build

bash scripts/hpc_dry_run.sh                 # the whole pipeline, offline, ~1 s
python3 scripts/hpc_check_contract.py       # does a bundle still import?
```

`scripts/e2e_smoke.py` drives a real browser over a running app and checks what
is actually on screen. It needs Playwright and both servers up, and exits 2 if
Playwright is missing rather than pretending to pass.

## Running a design job

See [`hpc/README.md`](hpc/README.md), which is blunt about what has and has not
been executed on a cluster. The short version, on the Mill:

```bash
bash hpc/00_discover.sh      # read-only; what does this cluster actually offer?
bash scripts/hpc_dry_run.sh  # offline self-check, no cluster resources
bash hpc/10_setup_env.sh && bash hpc/11_fetch_weights.sh
FS_NUM_DESIGNS=1 FS_SEQS_PER_DESIGN=2 bash hpc/run_pipeline.sh submit
bash hpc/run_pipeline.sh status
bash hpc/run_pipeline.sh export      # newest run, if you give no id
```

Then on the laptop:

```bash
scp mill:/tmp/bundle_hpc_<RUN>.tar.gz /tmp/
python3 scripts/hpc_import_bundle.py /tmp/bundle_hpc_<RUN>.tar.gz
```

The importer decides `kind` and `status` from the ledger and the files on disk,
so a half-finished run arrives labelled `partial` instead of being rounded up.

## Ground rules for changing this

These are not style preferences; they are why the numbers in the UI can be
believed.

1. **Never fabricate a run or a metric.** If a stage did not run, the ledger says
   so and the bundle is not `executed`. A number the model did not report is
   written as `null` with a reason, never filled in with something plausible.
2. **A failure keeps its real error.** No swallowing, no friendly replacement.
3. **Keep provenance labels and the "not a clinical tool" caveats** wherever they
   appear.
4. **Refusals are features.** The 409 and the 404 above are tested. If you change
   them, change the tests on purpose.

## Where things are

```
backend/app/routers/     the HTTP surface
backend/app/services/    confidence, alignment, interfaces, bundles
frontend/src/api/        typed client, generated-from-real-responses fixtures
frontend/src/panels/     one file per panel; shared store in panels/library.ts
frontend/src/viewer/     the Mol* adapter (the only place that talks to Mol*)
hpc/                     the Slurm pipeline, its ledger and its exporter
scripts/                 demo data, fixtures, bundle import, smoke tests
docs/CONTRACT.MD         the cross-stream contract
docs/FINAL_PASS.md       what the last full pass changed, and how to undo it
```
