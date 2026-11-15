#!/usr/bin/env bash
# Control-flow test for `10_setup_env.sh pred-env` (the ESMFold environment).
#
# That step cannot be run off the cluster: it needs conda, a CUDA compiler and
# several GB of downloads. What CAN be checked anywhere is that it does the right
# things in the right order and stops where it should. So every external tool
# (conda, pip, python, git, gcc, nvcc, module) is replaced by a small stand-in
# that records how it was called and keeps just enough state to behave like the
# real one: `pip install fair-esm[esmfold]` "installs" deepspeed, the OpenFold
# "build" fails unless the source was patched and the compiler was set, and
# `import esm.esmfold.v1.esmfold` succeeds only when OpenFold is installed,
# deepspeed is gone and seed.py is patched. hpc/patch_openfold.py is the real one,
# run on verbatim upstream text.
#
#     bash hpc/tests/test_setup_pred_env.sh
#
# This does not show that the real build works. It shows the script is wired
# the way the hand-run steps on the Mill were.

set -o errexit
set -o nounset
set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1" >&2; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected '$3', got '$2'"; fi; }
has()  { if grep -qF -- "$2" "$3"; then ok "$1"; else bad "$1: no line containing '$2' in $(basename "$3")"; fi; }
hasnt(){ if grep -qF -- "$2" "$3"; then bad "$1: found '$2' in $(basename "$3")"; else ok "$1"; fi; }
# line number of the first line containing $1 in the witness (0 if absent)
at()   { local n; n="$(grep -nF -- "$1" "$2" | head -1 | cut -d: -f1)"; echo "${n:-0}"; }

REAL_PY="$(command -v python3)"
PINNED="$(. "${REPO}/hpc/env.sh" >/dev/null 2>&1; echo "${FS_OPENFOLD_COMMIT}")"

# Verbatim upstream files, from the patch test's fixtures.
mkdir -p "${TMP}/upstream/openfold/utils"
"${REAL_PY}" - "${REPO}" "${TMP}/upstream" <<'PY'
import os, sys
sys.path.insert(0, os.path.join(sys.argv[1], "hpc", "tests"))
import test_openfold_patch as t
open(os.path.join(sys.argv[2], "setup.py"), "w").write(t.UPSTREAM_SETUP)
open(os.path.join(sys.argv[2], "openfold", "utils", "seed.py"), "w").write(t.UPSTREAM_SEED)
PY

# make_world <dir> -- a fresh set of stand-in tools and empty state.
make_world() {
  local W="$1"
  mkdir -p "${W}/bin" "${W}/state" "${W}/home"
  : >"${W}/witness"

  cat >"${W}/bin/conda" <<SH
#!/usr/bin/env bash
echo "conda \$*" >>"${W}/witness"
case "\$1" in
  shell.bash) echo 'conda() { if [ "\$1" = activate ]; then echo "conda activate \$2" >>"${W}/witness"; return 0; fi; command conda "\$@"; }' ;;
  env)        echo "# conda environments:"; echo "base  /opt/conda"; [ -f "${W}/state/env_exists" ] && echo "foldstudio-pred  /opt/conda/envs/foldstudio-pred" ;;
  create)     touch "${W}/state/env_exists" ;;
esac
exit 0
SH

  cat >"${W}/bin/python" <<SH
#!/usr/bin/env bash
case "\$*" in
  *"import esm.esmfold.v1.esmfold"*)
    echo "python import-esmfold" >>"${W}/witness"
    [ -f "${W}/state/openfold_installed" ] || { echo "ModuleNotFoundError: No module named 'openfold'" >&2; exit 1; }
    [ ! -f "${W}/state/deepspeed" ] || { echo "ModuleNotFoundError: No module named 'torch._six'" >&2; exit 1; }
    grep -q "^from pytorch_lightning import seed_everything" "${W}/state/site/openfold/utils/seed.py" \\
      || { echo "ImportError: cannot import name 'seed_everything'" >&2; exit 1; }
    exit 0 ;;
  *"import openfold"*)          [ -f "${W}/state/openfold_installed" ]; exit \$? ;;
  *'find_spec("deepspeed")'*)   [ -f "${W}/state/deepspeed" ]; exit \$? ;;
  *'find_spec("openfold")'*)    [ -f "${W}/state/openfold_installed" ] && echo "${W}/state/site/openfold"; exit 0 ;;
  *patch_openfold.py*)          echo "python patch_openfold \$2 \$3" >>"${W}/witness"; exec "${REAL_PY}" "\$@" ;;
esac
exec "${REAL_PY}" "\$@"
SH

  cat >"${W}/bin/pip" <<SH
#!/usr/bin/env bash
echo "pip \$*" >>"${W}/witness"
case "\$*" in
  *"fair-esm[esmfold]"*)   touch "${W}/state/deepspeed" ;;
  "uninstall -y deepspeed") rm -f "${W}/state/deepspeed" ;;
  *"--no-build-isolation"*)
    src="\${@: -1}"
    echo "build: CC=\${CC:-unset} CXX=\${CXX:-unset} FS_OPENFOLD_CC=\${FS_OPENFOLD_CC:-unset}" >>"${W}/witness"
    grep -q "'-std=c++17'" "\${src}/setup.py" || { echo "error: #error C++17 or later compatible compiler is required to use PyTorch." >&2; exit 1; }
    grep -q "FS_OPENFOLD_CC" "\${src}/setup.py" || { echo "nvcc fatal: Unsupported gpu architecture 'compute_37'" >&2; exit 1; }
    [ -n "\${CC:-}" ] && [ -n "\${CXX:-}" ] || { echo "error: compiler not set" >&2; exit 1; }
    [ "\${FS_OPENFOLD_CC:-}" = "70" ] || { echo "error: FS_OPENFOLD_CC not exported" >&2; exit 1; }
    mkdir -p "${W}/state/site/openfold/utils"
    cp "\${src}/openfold/utils/seed.py" "${W}/state/site/openfold/utils/seed.py"
    touch "${W}/state/openfold_installed" ;;
esac
exit 0
SH

  cat >"${W}/bin/git" <<SH
#!/usr/bin/env bash
if [ "\$1" = clone ] && [ "\$2" = "https://github.com/aqlaboratory/openfold.git" ]; then
  echo "git \$*" >>"${W}/witness"
  mkdir -p "\$3/.git" "\$3/openfold/utils"
  cp "${TMP}/upstream/setup.py" "\$3/setup.py"
  cp "${TMP}/upstream/openfold/utils/seed.py" "\$3/openfold/utils/seed.py"
  echo "0000000000000000000000000000000000000000" >"\$3/.git/FAKE_HEAD"
  exit 0
fi
if [ "\$1" = -C ] && [ -f "\$2/.git/FAKE_HEAD" ]; then
  case "\$3" in
    rev-parse) cat "\$2/.git/FAKE_HEAD"; exit 0 ;;
    checkout)  echo "git \$*" >>"${W}/witness"; echo "\${@: -1}" >"\$2/.git/FAKE_HEAD"; exit 0 ;;
  esac
fi
exec /usr/bin/env -u GIT_DIR "$(command -v git)" "\$@"
SH

  printf '#!/usr/bin/env bash\necho "nvcc: NVIDIA (R) Cuda compiler driver"; echo "Build cuda_12.9.r12.9/compiler"\n' >"${W}/bin/nvcc"
  cat >"${W}/bin/gcc" <<SH
#!/usr/bin/env bash
v="\$(cat "${W}/state/gcc_version" 2>/dev/null || echo 12.2.0)"
case "\$1" in -dumpversion) echo "\$v" ;; *) echo "gcc (GCC) \$v" ;; esac
SH
  cp "${W}/bin/gcc" "${W}/bin/g++"
  chmod +x "${W}/bin/"*
}

# run_pred_env <world> [VAR=value ...] -- runs the step, prints its exit status.
run_pred_env() {
  local W="$1"; shift
  local rc=0
  env "$@" \
    HOME="${W}/home" FS_HOME_BASE="${W}/home/foldstudio-hpc" FS_SCRATCH_BASE="${W}/scratch" \
    FS_PREDICTOR=esmfold FS_CONDA_MODULE="" FS_GCC_MODULE="" \
    PATH="${W}/bin:${PATH}" \
    bash "${REPO}/hpc/10_setup_env.sh" pred-env >"${W}/out.txt" 2>&1 || rc=$?
  echo "${rc}"
}

# ------------------------------------------------------------- 1. a fresh account
echo "1. fresh account: build the ESMFold environment"
W="${TMP}/fresh"; make_world "${W}"
rc="$(run_pred_env "${W}")"
check "the step succeeds" "${rc}" "0"
[ "${rc}" = "0" ] || sed 's/^/      /' "${W}/out.txt" >&2
WIT="${W}/witness"
has "creates the conda env with python 3.9" "conda create -y -n foldstudio-pred python=3.9" "${WIT}"
has "activates it" "conda activate foldstudio-pred" "${WIT}"
has "installs torch from the cu121 index" "pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu121" "${WIT}"
hasnt "does not use the cu118 index that did not build" "cu118" "${WIT}"
has "clones OpenFold" "git clone https://github.com/aqlaboratory/openfold.git" "${WIT}"
has "checks out the pinned commit" "checkout --quiet --force ${PINNED}" "${WIT}"
has "patches the source" "python patch_openfold source" "${WIT}"
has "builds without build isolation, from the local clone" "pip install --no-cache-dir --no-build-isolation ${W}/home/foldstudio-hpc/tools/openfold" "${WIT}"
has "builds with the compiler pinned" "build: CC=${W}/bin/gcc CXX=${W}/bin/g++ FS_OPENFOLD_CC=70" "${WIT}"
hasnt "never asks pip to fetch openfold itself" "openfold @ git+" "${WIT}"
has "removes deepspeed" "pip uninstall -y deepspeed" "${WIT}"
has "patches the installed copy" "python patch_openfold installed ${W}/state/site/openfold" "${WIT}"
# order: the source is patched before the build, deepspeed goes after fair-esm, and
# the import check comes last.
if [ "$(at "python patch_openfold source" "${WIT}")" -lt "$(at "--no-build-isolation" "${WIT}")" ]; then ok "patches before building"; else bad "patch must precede the build"; fi
if [ "$(at "fair-esm[esmfold]" "${WIT}")" -lt "$(at "pip uninstall -y deepspeed" "${WIT}")" ]; then ok "uninstalls deepspeed after fair-esm pulled it in"; else bad "deepspeed uninstalled too early"; fi
last_import="$(grep -n "python import-esmfold" "${WIT}" | tail -1 | cut -d: -f1)"
if [ "${last_import:-0}" -gt "$(at "pip uninstall -y deepspeed" "${WIT}")" ]; then ok "verifies the import after the repairs"; else bad "no import check after the repairs"; fi
has "reports success" "ESMFold imports cleanly" "${W}/out.txt"
has "the built source really is C++17" "'-std=c++17'" "${W}/home/foldstudio-hpc/tools/openfold/setup.py"

# -------------------------------------------------- 2. running it again changes nothing
echo "2. second run on the same account"
: >"${WIT}"
rc="$(run_pred_env "${W}")"
check "the second run succeeds" "${rc}" "0"
has "finds the environment working" "ESMFold already imports" "${W}/out.txt"
hasnt "installs nothing" "pip install" "${WIT}"
hasnt "does not rebuild OpenFold" "--no-build-isolation" "${WIT}"
hasnt "does not recreate the env" "conda create" "${WIT}"

# ------------------------------------- 3. an environment that was finished by hand
echo "3. an environment built by hand, as on the Mill"
W="${TMP}/hand"; make_world "${W}"
touch "${W}/state/env_exists" "${W}/state/openfold_installed"
mkdir -p "${W}/state/site/openfold/utils"
sed 's/^from pytorch_lightning.utilities.seed import/from pytorch_lightning import/' \
  "${TMP}/upstream/openfold/utils/seed.py" >"${W}/state/site/openfold/utils/seed.py"
rc="$(run_pred_env "${W}")"
check "succeeds" "${rc}" "0"
hasnt "installs nothing into it" "pip install" "${W}/witness"
hasnt "does not clone or build" "git clone" "${W}/witness"
has "says it found it working" "ESMFold already imports" "${W}/out.txt"

# ---------------------------- 4. half-repaired by hand: deepspeed back, seed unpatched
echo "4. OpenFold installed but not yet repaired"
W="${TMP}/half"; make_world "${W}"
touch "${W}/state/env_exists" "${W}/state/openfold_installed" "${W}/state/deepspeed"
mkdir -p "${W}/state/site/openfold/utils"
cp "${TMP}/upstream/openfold/utils/seed.py" "${W}/state/site/openfold/utils/seed.py"
rc="$(run_pred_env "${W}")"
check "succeeds" "${rc}" "0"
hasnt "does not rebuild an importable OpenFold" "--no-build-isolation" "${W}/witness"
has "removes deepspeed" "pip uninstall -y deepspeed" "${W}/witness"
has "patches seed.py in place" "from pytorch_lightning import seed_everything" "${W}/state/site/openfold/utils/seed.py"
has "ends with a working import" "ESMFold imports cleanly" "${W}/out.txt"

# ------------------------------------------------------------ 5. compiler too old
echo "5. GCC too old and no module to fix it"
W="${TMP}/oldgcc"; make_world "${W}"
echo "8.5.0" >"${W}/state/gcc_version"
rc="$(run_pred_env "${W}")"
check "stops with a failure" "${rc}" "1"
has "says what it needs" "need GCC >= 9" "${W}/out.txt"
has "shows the compiler it found" "gcc (GCC) 8.5.0" "${W}/out.txt"
hasnt "does not start a build that cannot succeed" "--no-build-isolation" "${W}/witness"
hasnt "has not installed anything yet" "pip install" "${W}/witness"

# ------------------------------------- 6. the module that provides a newer compiler
echo "6. GCC too old, but FS_GCC_MODULE provides a new one"
W="${TMP}/modgcc"; make_world "${W}"
echo "8.5.0" >"${W}/state/gcc_version"
cat >"${W}/modfn.sh" <<SH
module() {
  echo "module \$*" >>"${W}/witness"
  if [ "\$1" = load ] && [ "\$2" = "gcc/12.2.0" ]; then echo "12.2.0" >"${W}/state/gcc_version"; return 0; fi
  return 1
}
export -f module
SH
rc=0
( . "${W}/modfn.sh"
  env HOME="${W}/home" FS_HOME_BASE="${W}/home/foldstudio-hpc" FS_SCRATCH_BASE="${W}/scratch" \
      FS_PREDICTOR=esmfold FS_CONDA_MODULE="" FS_GCC_MODULE="gcc/12.2.0" PATH="${W}/bin:${PATH}" \
      bash "${REPO}/hpc/10_setup_env.sh" pred-env >"${W}/out.txt" 2>&1 ) || rc=$?
check "succeeds" "${rc}" "0"
[ "${rc}" = "0" ] || sed 's/^/      /' "${W}/out.txt" >&2
has "loads the module" "module load gcc/12.2.0" "${W}/witness"
has "then builds" "--no-build-isolation" "${W}/witness"

# ------------------------------------------- 7. conda only available through a module
echo "7. conda comes from FS_CONDA_MODULE"
W="${TMP}/modconda"; make_world "${W}"
mkdir -p "${W}/condabin"; mv "${W}/bin/conda" "${W}/condabin/conda"
cat >"${W}/modfn.sh" <<SH
module() {
  echo "module \$*" >>"${W}/witness"
  if [ "\$1" = load ] && [ "\$2" = "miniconda/miniconda3" ]; then PATH="${W}/condabin:\${PATH}"; export PATH; return 0; fi
  return 1
}
export -f module
SH
# A PATH with no real conda on it, so the module is the only way to get one.
CLEAN_PATH="$(printf '%s' "${PATH}" | tr ':' '\n' | while read -r d; do [ -x "${d}/conda" ] || printf '%s:' "${d}"; done)"
rc=0
( . "${W}/modfn.sh"
  env HOME="${W}/home" FS_HOME_BASE="${W}/home/foldstudio-hpc" FS_SCRATCH_BASE="${W}/scratch" \
      FS_PREDICTOR=esmfold FS_CONDA_MODULE="miniconda/miniconda3" FS_GCC_MODULE="" PATH="${W}/bin:${CLEAN_PATH%:}" \
      bash "${REPO}/hpc/10_setup_env.sh" pred-env >"${W}/out.txt" 2>&1 ) || rc=$?
check "succeeds" "${rc}" "0"
[ "${rc}" = "0" ] || sed 's/^/      /' "${W}/out.txt" >&2
has "loads the conda module itself" "module load miniconda/miniconda3" "${W}/witness"
has "and goes on to build" "ESMFold imports cleanly" "${W}/out.txt"

# ------------------------------------------------------------- 8. no conda at all
echo "8. no conda and no module for it"
W="${TMP}/noconda"; make_world "${W}"
rm "${W}/bin/conda"
rc=0
env HOME="${W}/home" FS_HOME_BASE="${W}/home/foldstudio-hpc" FS_SCRATCH_BASE="${W}/scratch" \
    FS_PREDICTOR=esmfold FS_CONDA_MODULE="" FS_GCC_MODULE="" PATH="${W}/bin:${CLEAN_PATH%:}" \
    bash "${REPO}/hpc/10_setup_env.sh" pred-env >"${W}/out.txt" 2>&1 || rc=$?
check "stops with a failure" "${rc}" "1"
has "says conda is missing" "conda is not on PATH" "${W}/out.txt"

echo
echo "passed ${PASS}, failed ${FAIL}"
[ "${FAIL}" -eq 0 ]
