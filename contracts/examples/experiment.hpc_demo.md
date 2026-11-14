# `experiment.hpc_demo.json` / `metrics.hpc_demo.json` — what Stream 3 emits

Added by Stream 3 (`hpc/**`). These two files are the **real, unedited output** of

```bash
python hpc/export_bundle.py --dry-run --data-dir /tmp/ex --experiment-id hpc_demo_example
```

They are not hand-written mocks. `kind` is `"demo"` because the dry run executes
no model — it builds a bundle from real public fixture files
(see `hpc/tests/fixtures/PROVENANCE.md`) to validate the format. A real cluster
run produces the same shape with `kind: "executed"`.

Build against these if you are consuming an HPC experiment. Regenerate them any
time with the command above.

## Verified against the real backend, not assumed

`scripts/hpc_check_contract.py` boots Stream 1's actual FastAPI app over a temp
data dir and imports this bundle through it. As of the last run: **24 checks,
0 failures.** Re-run it after pulling anyone's branch — it fails loudly and names
the specific assumption that broke.

Confirmed working end to end: `POST /api/experiments/reindex` picks the bundle up
by directory name; `metrics` round-trip unchanged and flat; the extra fields
below survive storage; `POST /api/structures/register` accepts the paths;
`GET /api/structures/{id}/plddt` returns **409** for a backbone; `GET .../pae`
returns **404 `pae_unavailable`** when absent; `POST /api/jobs` returns
**501 `no_runner`**.

## Fields beyond the contract

`docs/CONTRACT.MD` defines the required Experiment fields. The backend's model
sets `extra="allow"`, so Stream 3 adds four. All are optional — ignore any you
don't need.

### `workflow` — for Stream 5's WorkflowStepper

Six rows, in the stepper's own order, so the UI doesn't have to guess at our
tool names:

```json
{
  "stage": "Backbone generation",
  "ledger_stage": "rfdiffusion",
  "status": "executed",
  "status_label": "executed",
  "outputs": 4,
  "wall_seconds": 412.6,
  "preemptions": 2,
  "error": null,
  "note": null
}
```

- `stage` is exactly one of: `Structure`, `Backbone generation`,
  `Sequence design`, `Structure prediction`, `Evaluation`, `Candidate review`.
- `status` is `not_started` | `imported` | `demo` | `executed` | `failed`.
  **`demo` is not in the stepper's documented vocabulary** — it appears when the
  bundle itself is a demo. Render `status_label` directly, or treat anything
  unrecognised as *not started*.
- A stage is only `executed` when its ledger entry ran **and** its files exist.
  The stepper can never show a greener state than the record justifies.
- `Structure` is `not_started` by design: de novo design has no input structure.
  `note` says so — nothing is missing.
- `Candidate review` is always `not_started`: that stage happens in FoldStudio.
- `error` carries the real error text when a stage failed, which is what the
  stepper's "failed with error text" state needs.

### `metrics_unavailable` — why a number is absent

`{"metric_name": "the reason it could not be computed"}`. Every key absent from
`metrics` that a reader might expect appears here. No key is ever in both.

This is load-bearing for honest display: showing a blank where a metric should be
invites the reader to assume it was zero or bad. The reason strings are written
to be shown to a user. Example:

> `mpnn_mean_seq_recovery`: ProteinMPNN reported seq_recovery, but it is measured
> against the input PDB's own sequence, and an RFdiffusion backbone has no native
> sequence to recover. Reporting it would imply a comparison that was not made.

### `per_design` — per-candidate detail

One entry per predicted structure: file paths, `mean_plddt` with its
`mean_plddt_source`, `ptm`, and `scrmsd` carrying `rmsd`, `aligned_atoms`,
`aligned_residues`, `atom_type` and a `reason` when no RMSD was computed. Useful
for the Candidate Library and the comparison view.

### `stage_summary` — the folded ledger

Per ledger stage: `ran`, `completed`, `exit_status`, `attempts`, `preemptions`,
`wall_seconds`, `hosts`, `error`. Handy for a provenance panel; `commands` is
stripped out to keep the record small (the full argv list ships in the bundle's
`provenance/events.jsonl`).

## Things to rely on

- **`metrics` is flat.** Values are `number | string | null` only, matching
  `frontend/src/api/types.ts`. Nested metrics would break the typed client, and
  the checker asserts they stay flat.
- **Every metric was computed from a file in the bundle.** There are no
  placeholders. If it isn't in `metrics`, it's in `metrics_unavailable`.
- **`kind: "executed"` is never claimed from files alone**, nor from the ledger
  alone — both are required.
- **Backbones are registered `source: "uploaded"`, never `"predicted"`.** A
  designed backbone has no pLDDT, and its B-factor column must not be shown as
  confidence. `import_plan.json` in each bundle has the exact register calls.
- **Provenance does not assert where it ran.** It reports the hostnames recorded
  and whether a Slurm job id existed, so a run done on Colab says so
  (see `hpc/OFFLOAD.md`).

## Caveats the UI should keep attached

`provenance.notes` carries the integrity text verbatim — pLDDT/PAE/pTM are model
confidence and not evidence of folding, binding, affinity, efficacy or safety;
self-consistency RMSD compares two computational models; FoldStudio is not a
clinical tool; and no binder or therapeutic design was performed. `metrics.json`
repeats these under `caveats`, and `definitions` gives a one-line explanation of
every reported metric, suitable for a tooltip.
