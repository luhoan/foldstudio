# FoldStudio Stream 5 implementation

This patch is scoped to `frontend/src/api/**`, `frontend/src/panels/**`, and the shared
`contracts/examples/**` directory. It does not edit Stream 2's layout, viewer, or `main.tsx`.

## Apply

Extract this archive at the repository root, preserving directory paths. Review the shared
JSON examples before committing. The fixtures are synthetic and explicitly marked `demo`.

## Mock mode

The real backend is the default. To use synthetic UI fixtures locally, create
`frontend/.env.local`:

```dotenv
VITE_USE_MOCKS=true
```

To use the real backend, omit that variable or set it to `false`. The existing Vite proxy
for `/api` targets `http://127.0.0.1:8000`.

## Mounting

The repository's existing `frontend/src/layout/registerPanels.ts` auto-loads
`frontend/src/panels/**/register.{ts,tsx}`. The included `register.ts` registers:
- right sidebar stack in `right`
- PAE heatmap in `explorer.below`
- comparison in `analysis.main` and `comparison.main`
- history in `history.main`
- workflow in `design.main`
- curated candidate library in `library.main`

`CandidateLibrary` also exports an `adapter?: ViewerAdapter` prop. The auto-registered
instance has no adapter until Stream 2 supplies it through the viewer integration. Do not
import Mol* into Stream 5.

For residue click integration, call `selectFromViewer(structureId, event)` from the
unsubscribe-managed callback registered with `adapter.onResidueClick(...)`. The
`ViewerAdapter` callback type is in `frontend/src/viewer/adapter.ts`.

## Test / build

From `frontend/`:

```bash
npx vitest run
npm run build
```

The current `package.json` has no `test` script, so use `npx vitest run` unless the team
adds a script outside Stream 5 ownership. These commands have NOT been run in this
environment because the ZIP is an overlay, not a complete frontend checkout with dependencies.
Run them after applying the patch and resolve any integration mismatches.

## Contract assumptions requiring backend confirmation

The repository's contract document specifies endpoint paths and core Structure/Experiment
fields, but does not spell out all nested response shapes. This implementation assumes:
- `/structures/{id}/residues` -> `{ structure_id, residues: [...] }`
- `/structures/{id}/plddt` -> `{ structure_id, residues: [{ chain, seq_id, plddt }] }`
- `/structures/{id}/pae` -> `{ structure_id, matrix, residue_indices?, chains? }`
- `/explain` -> `{ structure_id, chain, start, end, summary, numbers_used, limitations? }`
- `/experiments/compare` accepts `{ experiment_ids: string[] }`
- imported candidate experiment settings may document `candidate_chain`, `partner_chain`,
  and `interface_ranges: [{ start, end }]`.
- workflow stage is recorded as `settings.workflow_stage` (or `settings.stage`).

Confirm these with Stream 1 before integration. The UI deliberately does not infer chain
roles, interface residues, or missing metrics.

## Scientific-integrity safeguards

- All fixture records are `demo` and clearly labelled synthetic.
- pLDDT and PAE are described as model-confidence estimates only.
- Alignment output displays RMSD, TM-score, aligned atom count, aligned residue count,
  and atom type exactly as returned by the backend.
- Candidate library only lists imported experimental structures and only highlights
  explicitly documented candidate-chain interface ranges.
- No novel binder/antibody generation or clinical claims are implemented.

## Follow-up hardening

The continuation revision clears prior heatmap and sidebar detail results when the selected
structure changes, prevents stale residue selection from carrying between structures,
keeps independent confidence and residue data visible if the explanation endpoint fails,
and fixes candidate selection/loading behavior. An additional regression test covers the
partial sidebar response case. GitHub branch creation was retried and is still blocked
with HTTP 403 (`Resource not accessible by integration`). No repository writes occurred.
