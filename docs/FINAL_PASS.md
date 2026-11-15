# The final pass — what changed, and how to undo any of it

A record of the review pass of 14–15 November 2026, written so that someone who
did not watch it happen can see what moved, decide whether they want it, and put
any piece of it back.

Scope: the whole repository. The brief was to look over the project as it stood,
fix what needed fixing, document everything, and make every change revertible.

**Nothing in this pass ran a model.** No RFdiffusion, no ProteinMPNN, no ESMFold.
The sandbox this was done in has no GPU, no Slurm and no cluster access. Every
claim below about the Mill is either something observed in an *earlier* session
or is explicitly marked unverified. See
[`hpc/README.md`](../hpc/README.md#what-has-and-has-not-run) for that line drawn
properly.

## The safety net, first

Everything before the pass is on a branch, untouched:

```
rollback/pre-final-pass-2026-11-14   @ 89501c3
```

It is on `origin`. To look at the old state without disturbing anything:

```bash
git fetch origin
git switch --detach origin/rollback/pre-final-pass-2026-11-14
```

To abandon the whole pass and go back:

```bash
git switch main
git reset --hard origin/rollback/pre-final-pass-2026-11-14
git push --force-with-lease origin main      # only if you mean it
```

`--force-with-lease` rather than `--force` on purpose: it refuses if someone else
has pushed in the meantime.

Reverting one commit instead of all of them is usually what you actually want,
and the commits below are deliberately separable.

## What changed, commit by commit

Newest first. Each is revertible on its own with `git revert <sha>` unless the
"depends on" column says otherwise.

| commit | what it did | depends on |
|---|---|---|
| `d9bd5f4` | **Residue ranges, and two wording fixes.** A structure numbered from −1 rendered as "Residues -1-104", which reads as gibberish. Also made ProteinMPNN's `score=` field read as a field name, and gave the synthetic fixture a non-zero RMSD so it stops looking like a claim of perfect agreement. | — |
| `07264cb` | **The HPC batch.** Folded the manual Mill fixes into the scripts, and corrected every document that still said nothing had run there. Detail below. | — |
| `6b19269` | **`scripts/e2e_smoke.py`.** A real-browser check of the running app. Adds a file; changes nothing that ships. | — |
| `7bcb39e` | **Typography.** Self-hosted STIX Two Text, IBM Plex Sans and Mono, a brand mark and a favicon. Deliberately its own commit so the look can be reverted without touching behaviour. | — |
| `1cca501` | **The frontend rewrite.** Every panel now reads the shapes the backend actually returns, through one typed client. 225 tests across 25 files. The large one. | `33cdddd`, `078ad86` |
| `33cdddd` | **Viewer fixes.** Replacing the second structure in an overlay spliced the wrong slot; a panel can now choose the starting colour scheme. | — |
| `078ad86` | **Fixtures: PAE attach and rescan**, and the fixture run made to match what the exporter really produces. Also normalised `-0.0` out of alignment matrices. | `c7c3b15` |
| `c7c3b15` | **Fixtures exist at all.** `scripts/export_api_fixtures.py` captures real backend responses; the frontend tests run against those rather than against hand-written guesses. | — |

### Reverting the look but keeping the behaviour

The typefaces are isolated for exactly this reason:

```bash
git revert 7bcb39e        # the app keeps working; it just looks like it did before
```

### Reverting the frontend rewrite

`1cca501` is large and the two commits under it are part of the same arc. To go
back to the pre-rewrite frontend, revert all three, newest first:

```bash
git revert --no-commit 1cca501 33cdddd 078ad86
git commit -m "revert the frontend rewrite"
```

Reverting `c7c3b15` as well removes the fixtures, which the backend's
`test_frontend_fixtures.py` checks for drift — so revert that test with it or it
will fail looking for files that are no longer there.

## The HPC batch (`07264cb`) in more detail

This is the one with real-world consequences, because it changes what the next
person runs on the cluster.

**The fixes it absorbed.** The previous session got RFdiffusion and ProteinMPNN
to exit 0 on the Mill, but only after a long series of repairs typed by hand on
a login node. Those repairs lived nowhere. They are now in the scripts:

- `env.sh` records what discovery actually found: no `class` partition exists,
  the working GRES is `gpu:V100-SXM2-32GB:1`, the modules are
  `miniconda/miniconda3`, `gcc/12.2.0` and `cuda-toolkit/12.9`, and the login
  node's `python3` is 3.6 — so `env.sh` now shims a newer interpreter onto
  `PATH` rather than failing on f-strings.
- `10_setup_env.sh` builds ESMFold the way that worked: torch from the `cu121`
  index, OpenFold from a pinned commit with `-std=c++17` and
  `--no-build-isolation`, `deepspeed` uninstalled because it imports the removed
  `torch._six`, and `seed.py` patched to import `seed_everything` from
  `pytorch_lightning`. It skips the whole thing when the import already works.
- `patch_openfold.py` replaces sed-in-a-shell-history with a tested script that
  refuses to claim success when it recognises nothing in the file.

**The honesty pass.** Several files still carried "NOT YET EXECUTED ON THE MILL",
which had stopped being true, and `hpc/README.md`'s banner said nothing had run
at all. Each file now states its own real status — including the uncomfortable
parts: the prediction stage was started and **nobody has seen it finish**, no
bundle has ever been exported from the cluster, and `DISCOVERED.md` is still a
placeholder because the real report was read on the cluster and never copied
back.

**Reverting it** restores the old scripts, which means the next person on the
Mill re-does the ESMFold repairs by hand. If something in here is wrong, prefer
fixing that one thing to reverting the batch.

## What the next Mill session should do

The repaired setup script is newer than the environment on the cluster, so pull
first. Nothing here re-runs a finished stage.

```bash
cd ~/foldstudio && git pull

bash hpc/run_pipeline.sh status      # where did run 20261114T115930Z get to?
bash hpc/run_pipeline.sh export      # no run id: it uses the newest and says which
bash hpc/run_pipeline.sh resume      # if the prediction did not finish
```

Then on the laptop:

```bash
scp mill:/tmp/bundle_hpc_<RUN>.tar.gz /tmp/
python3 scripts/hpc_import_bundle.py /tmp/bundle_hpc_<RUN>.tar.gz
```

Before trusting any prediction number, read `pred/*.pred.json` and look at
`plddt_units` and any `unavailable` reasons. The runner writes null-with-a-reason
rather than guessing, so a missing number is visible rather than silently zero.

## How this was verified

Run against a **fresh clone**, not the working tree:

| check | result |
|---|---|
| `cd backend && python3 -m pytest -q` | 197 passed |
| `python3 scripts/export_api_fixtures.py --check` | 19 fixtures match the live backend |
| `cd frontend && npm ci && npm run typecheck && npm run lint && npm test` | clean; 225 tests in 25 files |
| `npm run build` | clean |
| `bash scripts/hpc_dry_run.sh` | all offline checks passed (61 stage-lib, 83 exporter, 10 OpenFold-patch, 45 pred-env) |
| `python3 scripts/hpc_check_contract.py` | 27 passed, 0 failed, 0 warnings |
| `python3 scripts/e2e_smoke.py --url …` | **42 passed, 0 failed, 0 skipped**, in a real browser |
| `shellcheck -S warning` on every shell script | clean |

The e2e run was against real data, not fixtures: twelve structures (ubiquitin,
crambin, GFP, a Fab–lysozyme complex, an RBD–ACE2 complex, a real AlphaFold model
with its real PAE matrix) and four experiment records covering all four
provenance kinds.

### What that does *not* cover

- **No model was run.** Every number in the UI during verification came from a
  real file or a labelled fixture, never from RFdiffusion, ProteinMPNN or ESMFold
  executing here.
- **The cluster is unverified from here.** The sandbox has no Slurm and no GPU.
  The HPC tests drive stand-in `conda`, `pip`, `git`, `gcc`, `nvcc` and `module`
  commands: they assert the *order and the flags* of the setup, not that the
  build succeeds on a real node.
- **No prediction has been seen to finish anywhere**, so the `predicted_*` and
  `self_consistency_*` half of the bundle contract is tested but unproven.

## The rules that constrained all of this

Worth restating, because they are why the numbers can be believed and they are
easy to erode by accident:

1. Never fabricate a run or a metric. A stage that did not run says so; a bundle
   is only `executed` when a science stage really ran; a number the model did not
   report is `null` with a reason.
2. Failures keep their real errors.
3. Provenance labels and the "not a clinical tool" caveats stay.
4. The refusals are features. `/plddt` answering **409** on an experimental
   structure, and `/pae` answering **404 `pae_unavailable`**, are both tested on
   purpose: experimental B-factors share pLDDT's 0–100 range and would otherwise
   be read as confidence.

If a future change makes one of these tests fail, that is the test working.
Change it deliberately or not at all.
