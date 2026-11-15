#!/usr/bin/env bash
#SBATCH --job-name=fs-export
#SBATCH --partition=requeue
#SBATCH --requeue
#SBATCH --open-mode=append
#SBATCH --time=00:30:00
#SBATCH --cpus-per-task=2
#SBATCH --mem=8G
#SBATCH --output=%x-%j.out
#SBATCH --error=%x-%j.out
#
# Stage 50 -- export whatever the run produced as a FoldStudio experiment bundle.
#
# CPU only, and it runs even when earlier stages fell short: a partial run is
# worth exporting, because a bundle that honestly says `status: "partial"` is
# more useful than no record at all. export_bundle.py decides kind/status from
# the ledger and the files on disk, so this stage cannot overstate what happened.
#
# It also tars the bundle so it can be copied back to a laptop in one step.
#
# NOT YET EXECUTED ON THE MILL. Stages 20 and 30 have run there and exited 0,
# and 40 was started, but no bundle has been exported from the cluster yet, so
# nothing here has been exercised against a real ledger. The offline tests in
# hpc/tests/test_export_bundle.py cover the exporter itself. See "What has and
# has not run" in hpc/README.md.

set -o errexit
set -o nounset
set -o pipefail

HERE="${FS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
[ -d "${HERE}/hpc" ] && HERE="${HERE}/hpc"
# shellcheck source=hpc/env.sh
. "${HERE}/env.sh"
# shellcheck source=hpc/lib/common.sh
. "${HERE}/lib/common.sh"

fs_stage_begin export_bundle
fs_require_python

# Where the bundle is written. Defaults to the data/ dir of this clone.
DATA_DIR="${FS_EXPORT_DATA_DIR:-${FS_REPO}/data}"
mkdir -p "${DATA_DIR}"

EXP_ID="${FS_EXPERIMENT_ID:-hpc_${FS_RUN_ID}}"

# numpy is needed for the self-consistency RMSD. Without it the bundle is still
# written; the RMSD is simply recorded as unavailable with that reason.
python3 -c 'import numpy' 2>/dev/null \
  || fs_note "numpy is not importable here, so self-consistency RMSD will be reported as unavailable"

fs_run export python3 "${HERE}/export_bundle.py" \
  --work-dir "${FS_WORK}" \
  --data-dir "${DATA_DIR}" \
  --experiment-id "${EXP_ID}" \
  || fs_die "export_bundle.py failed or the bundle did not pass contract validation.
Log: ${FS_LOGS}/${FS_STAGE}.export.log"

BUNDLE="${DATA_DIR}/experiments/${EXP_ID}"
[ -f "${BUNDLE}/experiment.json" ] || fs_die "expected ${BUNDLE}/experiment.json to exist"

# One tarball to carry off the cluster.
TARBALL="${FS_WORK}/bundle_${EXP_ID}.tar.gz"
fs_run tar_bundle tar czf "${TARBALL}" -C "${DATA_DIR}/experiments" "${EXP_ID}" \
  || fs_log "WARNING: could not create ${TARBALL}"

fs_log "bundle written to ${BUNDLE}"
[ -f "${TARBALL}" ] && fs_log "tarball: ${TARBALL}"

python3 - "${BUNDLE}/experiment.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"  id       {d['id']}")
print(f"  kind     {d['kind']}")
print(f"  status   {d['status']}")
print(f"  model    {d['model_name']}")
print(f"  outputs  {len(d['outputs'])} file(s)")
print(f"  metrics  {len(d['metrics'])} reported, "
      f"{len(d.get('metrics_unavailable') or {})} unavailable")
if d.get("error"):
    print(f"  error    {d['error']}")
PY

fs_note "exported bundle ${EXP_ID} to ${BUNDLE}"
fs_stage_finish "$(python3 - "${EXP_ID}" <<'PY'
import json, sys
print(json.dumps([f"data/experiments/{sys.argv[1]}/experiment.json"]))
PY
)"

cat <<EOF

Copy the bundle to your machine and import it (from the repo root there):

    scp ${FS_USER}@<mill-login-host>:${TARBALL} /tmp/
    python3 scripts/hpc_import_bundle.py /tmp/bundle_${EXP_ID}.tar.gz

The import script validates the bundle, places it under data/experiments/ and
asks a running backend to index it; the backend registers the bundle's
structures itself, so there are no further calls to make.
EOF
exit 0
