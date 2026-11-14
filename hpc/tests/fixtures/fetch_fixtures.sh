#!/usr/bin/env bash
# Re-download the test fixtures from their real upstream sources.
# Run from anywhere:  bash hpc/tests/fixtures/fetch_fixtures.sh
#
# Needs outbound access to raw.githubusercontent.com. See PROVENANCE.md for what
# each file is (and, importantly, what it is not).

set -o errexit
set -o nounset
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW="https://raw.githubusercontent.com"
MPNN_SEQS="${RAW}/dauparas/ProteinMPNN/main/outputs/example_1_outputs/seqs/5L33.fa"
MPNN_PDB="${RAW}/dauparas/ProteinMPNN/main/inputs/PDB_monomers/pdbs/5L33.pdb"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "fetching a genuine ProteinMPNN output..."
curl -fsSL "${MPNN_SEQS}" -o "${HERE}/proteinmpnn_5L33_example1.fa"
grep -q 'global_score=' "${HERE}/proteinmpnn_5L33_example1.fa" \
  || { echo "ERROR: downloaded FASTA has no ProteinMPNN score headers" >&2; exit 1; }

echo "fetching 5L33 and extracting a real backbone-only excerpt..."
curl -fsSL "${MPNN_PDB}" -o "${TMP}/5L33.pdb"

python3 -I - "${TMP}/5L33.pdb" "${HERE}/backbone_like_5L33_chainA.pdb" <<'PY'
import sys
src_path, dst_path = sys.argv[1], sys.argv[2]
keep = {"N", "CA", "C", "O"}
out = []
for line in open(src_path).read().splitlines():
    if line.startswith("ENDMDL"):
        break
    # chain A, primary altloc, backbone atoms only -- this is what an
    # RFdiffusion backbone looks like structurally.
    if (line.startswith("ATOM  ") and line[21] == "A"
            and line[16] in (" ", "A") and line[12:16].strip() in keep):
        out.append(line)
if not out:
    raise SystemExit("ERROR: extracted no atoms; upstream 5L33.pdb layout changed")
header = [
    "REMARK   1 REAL COORDINATE EXCERPT -- NOT A MODEL OUTPUT.",
    "REMARK   1 Source: chain A of PDB entry 5L33, backbone atoms (N, CA, C, O) only,",
    "REMARK   1 taken verbatim from the ProteinMPNN repository's own example input at",
    "REMARK   1 raw.githubusercontent.com/dauparas/ProteinMPNN/main/inputs/PDB_monomers/pdbs/5L33.pdb",
    "REMARK   1 Used by hpc/tests as a FORMAT stand-in for an RFdiffusion backbone.",
    "REMARK   1 The B-factor column here holds EXPERIMENTAL B-factors. They are NOT pLDDT",
    "REMARK   1 and must never be reported as model confidence.",
]
open(dst_path, "w").write("\n".join(header + out) + "\nTER\nEND\n")
residues = len({line[22:27] for line in out})
print(f"  wrote {dst_path}: {len(out)} atoms, {residues} residues")
PY

echo
echo "fixtures refreshed. See PROVENANCE.md."
