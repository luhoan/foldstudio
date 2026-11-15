# contracts/examples/

Shared, hand-written examples of the JSON shapes the streams exchange. They
exist so a stream blocked on another can code against something concrete
instead of guessing.

**These are illustrative, not captured.** Anything here named `*.mock.json` was
written by hand. The `hpc_demo` files came from a real `export_bundle.py
--dry-run`, which means the *shape* is genuine but the *numbers* are a dry run's
numbers, not a design job's.

None of this is data about a real protein, and nothing here should ever be
presented in the UI as a result.

## If you want the real shapes

Prefer [`frontend/src/api/__fixtures__/`](../../frontend/src/api/__fixtures__).
Those nineteen files are captured from the running backend rather than written
by hand, so they cannot drift away from what the API actually returns:

```bash
python3 scripts/export_api_fixtures.py            # regenerate
python3 scripts/export_api_fixtures.py --check    # fail if they have drifted
```

`backend/tests/test_frontend_fixtures.py` runs that check too, so a change to
the API that forgets the fixtures fails the backend suite.

## Rules for this directory

It is shared, which makes it easy to break for everyone at once.

- **Add fields; never remove or rename one.** Another stream is reading it.
- **Keep the integrity labels.** `kind`, `status`, `provenance`, and the
  `metrics_unavailable` reasons are part of the shape, not decoration.
- **Do not invent a metric to fill out an example.** If a run could not measure
  something, the example should show it in `metrics_unavailable` with a reason —
  that path needs an example as much as the happy one does.
- **Changing a shape here means changing `docs/CONTRACT.MD`** (see its addendum)
  and, if the backend now returns something different,
  `scripts/hpc_check_contract.py`.

## What is here

| file | what it illustrates |
|---|---|
| `structure.mock.json` | a `Structure` record |
| `residues.mock.json` | the per-residue listing |
| `plddt.mock.json` | a pLDDT response for a predicted model |
| `pae.mock.json` | a PAE matrix response |
| `explain.mock.json` | an `/explain` response: numbers first, then sentences built only from them |
| `experiment.mock.json` | an `Experiment` record |
| `comparison.mock.json` | `POST /experiments/compare` output |
| `experiment.hpc_demo.json` | a real `--dry-run` bundle's experiment record |
| `experiment.hpc_demo.md` | the same, as the report renders it |
| `metrics.hpc_demo.json` | that bundle's metrics with their definitions |
