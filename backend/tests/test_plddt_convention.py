"""One pLDDT banding, three implementations.

The profile endpoint (services/confidence.py), the explanation rules
(services/explain_rules) and the 3D viewer's colour theme
(frontend/src/viewer/plddt.ts) each bin pLDDT. They were written by different
people and disagreed at exactly 50, 70 and 90, so one residue could be coloured
"confident", counted "very high" and explained as "high" at the same time.

The convention is: lower bound inclusive.  [0,50) [50,70) [70,90) [90,100]
"""
import re
from pathlib import Path

import pytest

from app.services import confidence
from app.services.explain_rules import plddt_bin

# The rules engine calls the 70-90 band "high"; the API calls it "confident".
RULE_TO_API = {"very_high": "very_high", "high": "confident", "low": "low", "very_low": "very_low"}

GRID = [0, 0.01, 25, 49.99, 50, 50.01, 60, 69.99, 70, 70.01, 80, 89.99, 90, 90.01, 95, 100]


@pytest.mark.parametrize("value", GRID)
def test_profile_and_explanation_rules_agree(value):
    assert RULE_TO_API[plddt_bin(value)["id"]] == confidence.classify(value)


@pytest.mark.parametrize("value,expected", [
    (49.99, "very_low"), (50, "low"), (69.99, "low"), (70, "confident"),
    (89.99, "confident"), (90, "very_high"),
])
def test_boundaries_are_lower_inclusive(value, expected):
    assert confidence.classify(value) == expected


def test_viewer_source_uses_the_same_boundaries():
    """The viewer is TypeScript, so it is checked by reading its comparison chain.

    frontend/src/viewer/plddt.test.ts checks the behaviour; this guards the
    cross-language agreement from the Python side, where the convention lives.
    """
    src = Path(__file__).resolve().parents[2] / "frontend" / "src" / "viewer" / "plddt.ts"
    if not src.exists():
        pytest.skip("frontend sources are not present in this checkout")
    body = src.read_text()
    fn = body[body.index("export function plddtBin"):]
    fn = fn[: fn.index("\n}") + 2]
    comparisons = re.findall(r"score\s*(<=|<|>=|>)\s*(\d+)", fn)
    assert comparisons == [("<", "0"), ("<", "50"), ("<", "70"), ("<", "90")], (
        "viewer/plddt.ts must bin with strict '<' at 50, 70 and 90 (lower bound inclusive), "
        f"found {comparisons}")
