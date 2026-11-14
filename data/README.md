# data/ (Stream 4)

Real public structures only. Everything here is labelled `imported` (see each `experiments/*/experiment.json`).

Regenerate (needs internet; stdlib only):

    python scripts/fetch_demo_data.py          # writes data/structures/, data/experiments/, data/manifest.json, data/fetch_report.json
    python scripts/fetch_demo_data.py --only crambin gfp_predicted

Any candidate ID that cannot be verified against RCSB / AlphaFold DB is dropped and listed in `data/fetch_report.json`.
Offline tests: `python -m unittest scripts/fetch_demo_data_test.py`
