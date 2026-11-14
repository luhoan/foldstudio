#!/usr/bin/env bash
# Verify Stream 3 end-to-end WITHOUT a cluster, a GPU or a network.
#
#     bash scripts/hpc_dry_run.sh                  # tests + a demo bundle in a temp dir
#     bash scripts/hpc_dry_run.sh --keep           # leave the bundle on disk and print its path
#     bash scripts/hpc_dry_run.sh --data-dir data  # write the demo bundle into the repo's data/
#     bash scripts/hpc_dry_run.sh --predicted FILE # also exercise the prediction/pLDDT path
#
# What it does:
#   1. runs the stage-machinery tests (checkpoint/resume + a real SIGUSR1 preemption)
#   2. runs the bundle tests (52 assertions, incl. validation against the backend's
#      own pydantic Experiment model when backend deps are installed)
#   4. builds a bundle from the real fixtures and validates it against the contract
#   5. imports that bundle through Stream 1's real FastAPI app (skips if its deps
#      are not installed) so cross-stream drift fails loudly
#
# The bundle it builds is `kind: "demo"`: no model is executed anywhere in here.
# Requires: bash, python3 >= 3.7. numpy and pydantic are optional (tests that
# need them skip cleanly).

set -o errexit
set -o nounset
set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP=0
DATA_DIR=""
PREDICTED=""

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --data-dir) DATA_DIR="${2:?--data-dir needs a path}"; shift 2 ;;
    --predicted) PREDICTED="${2:?--predicted needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "${DATA_DIR}" ]; then
  DATA_DIR="$(mktemp -d)"
  CLEANUP="${DATA_DIR}"
else
  CLEANUP=""
fi
cleanup() { [ "${KEEP}" -eq 0 ] && [ -n "${CLEANUP}" ] && rm -rf "${CLEANUP}"; return 0; }
trap cleanup EXIT

hr() { printf '%s\n' "------------------------------------------------------------"; }
FAILED=0

hr
echo "Stream 3 offline verification"
echo "repo:     ${REPO}"
echo "python:   $(python3 -V 2>&1)"
echo "numpy:    $(python3 -c 'import numpy;print(numpy.__version__)' 2>/dev/null || echo 'not installed (RMSD will be reported unavailable)')"
echo "pydantic: $(python3 -c 'import pydantic;print(pydantic.VERSION)' 2>/dev/null || echo 'not installed (backend cross-check will skip)')"
hr

echo
echo "[1/5] fixtures"
if [ ! -f "${REPO}/hpc/tests/fixtures/proteinmpnn_5L33_example1.fa" ] \
   || [ ! -f "${REPO}/hpc/tests/fixtures/backbone_like_5L33_chainA.pdb" ]; then
  echo "  fixtures missing. Fetch them (needs network):"
  echo "    bash hpc/tests/fixtures/fetch_fixtures.sh"
  exit 1
fi
echo "  present (see hpc/tests/fixtures/PROVENANCE.md for what they are)"

echo
echo "[2/5] stage machinery: checkpoint, resume, preemption"
if bash "${REPO}/hpc/tests/test_stage_lib.sh" >/tmp/hpc_stage_tests.log 2>&1; then
  tail -2 /tmp/hpc_stage_tests.log | sed 's/^/  /'
else
  echo "  FAILED -- full output:"
  sed 's/^/    /' /tmp/hpc_stage_tests.log
  FAILED=1
fi

echo
echo "[3/5] bundle writer and contract validation"
if python3 "${REPO}/hpc/tests/test_export_bundle.py" >/tmp/hpc_bundle_tests.log 2>&1; then
  grep -E '^(Ran|OK)' /tmp/hpc_bundle_tests.log | sed 's/^/  /'
  if grep -q 'skipped' /tmp/hpc_bundle_tests.log; then
    grep -o 'skipped=[0-9]*' /tmp/hpc_bundle_tests.log | sed 's/^/  /'
  fi
else
  echo "  FAILED -- failures and errors:"
  grep -E '^(FAIL|ERROR|AssertionError)' /tmp/hpc_bundle_tests.log | sed 's/^/    /' || true
  echo "  (full log: /tmp/hpc_bundle_tests.log)"
  FAILED=1
fi

echo "  environment patches (SE3Transformer NVTX fallback)"
if python3 "${REPO}/hpc/tests/test_nvtx_patch.py" >/tmp/hpc_nvtx_tests.log 2>&1; then
  grep -E '^(Ran|OK)' /tmp/hpc_nvtx_tests.log | sed 's/^/    /'
else
  echo "    FAILED -- failures and errors:"
  grep -E '^(FAIL|ERROR|AssertionError)' /tmp/hpc_nvtx_tests.log | sed 's/^/      /' || true
  echo "    (full log: /tmp/hpc_nvtx_tests.log)"
  FAILED=1
fi

echo
echo "[4/5] building a demo bundle from the real fixtures"
EXTRA=()
[ -n "${PREDICTED}" ] && EXTRA=(--predicted "${PREDICTED}")
if python3 "${REPO}/hpc/export_bundle.py" --dry-run --data-dir "${DATA_DIR}" \
     --experiment-id "hpc_dryrun_check" "${EXTRA[@]+"${EXTRA[@]}"}" 2>&1 | sed 's/^/  /'; then
  BUNDLE="${DATA_DIR}/experiments/hpc_dryrun_check"
  echo
  echo "  --- what was measured, and what was not ---"
  python3 - "${BUNDLE}/metrics.json" <<'PY' | sed 's/^/  /'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"kind={d['kind']} status={d['status']}")
print(f"measured ({len(d['values'])}):")
for k, v in sorted(d["values"].items()):
    print(f"  {k} = {v}")
print(f"unavailable ({len(d['unavailable'])}):")
for k, v in sorted(d["unavailable"].items()):
    print(f"  {k}: {v[:110]}{'...' if len(v) > 110 else ''}")
PY
else
  echo "  FAILED to build the demo bundle"
  FAILED=1
fi

echo
echo "[5/5] cross-stream contract: does the bundle still import into Stream 1's API?"
if python3 "${REPO}/scripts/hpc_check_contract.py" >/tmp/hpc_contract.log 2>&1; then
  tail -3 /tmp/hpc_contract.log | sed 's/^/  /'
else
  echo "  FAILED -- a cross-stream assumption changed:"
  grep -E '^(  FAIL|  - )' /tmp/hpc_contract.log | sed 's/^/  /' || true
  echo "  (full log: /tmp/hpc_contract.log)"
  FAILED=1
fi

echo
hr
if [ "${FAILED}" -eq 0 ]; then
  echo "RESULT: all offline checks passed."
  [ "${KEEP}" -eq 1 ] && echo "bundle kept at: ${DATA_DIR}/experiments/hpc_dryrun_check"
  echo
  echo "This proves the bundle format, the parsers, the checkpoint/resume logic and"
  echo "the preemption handling. It proves NOTHING about RFdiffusion, ProteinMPNN or"
  echo "ESMFold running on the Mill -- none of that has been executed. See the"
  echo "'What has and has not run' section of hpc/README.md."
else
  echo "RESULT: FAILURES ABOVE."
fi
hr
exit "${FAILED}"
