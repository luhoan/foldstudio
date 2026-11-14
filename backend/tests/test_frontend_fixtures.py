"""The frontend's API fixtures must be what this backend actually returns.

frontend/src/api/__fixtures__/*.json are captured from the real app by
scripts/export_api_fixtures.py and are what the frontend's tests (and its mock
mode) run against. If a response changes shape here, this test fails until the
fixtures are regenerated -- and regenerating them makes the frontend's own
tests show what the UI has to change. That is the whole mechanism: the two
sides can no longer drift apart with every test still green on both.
"""
import importlib.util
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "export_api_fixtures.py"
FIXTURES = REPO / "frontend" / "src" / "api" / "__fixtures__"


def _load():
    spec = importlib.util.spec_from_file_location("export_api_fixtures", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.skipif(not FIXTURES.is_dir(), reason="frontend sources are not present in this checkout")
def test_committed_fixtures_match_the_live_backend(capsys):
    code = _load().main(["--check"])
    out = capsys.readouterr().out
    assert code == 0, (
        "The backend's responses no longer match frontend/src/api/__fixtures__/.\n" + out)


@pytest.mark.skipif(not FIXTURES.is_dir(), reason="frontend sources are not present in this checkout")
def test_capture_is_deterministic():
    """Two captures must be identical, or the check above would fail at random."""
    mod = _load()
    assert mod.capture() == mod.capture()


def test_fixture_dataset_declares_itself_synthetic():
    """An 'executed' record exists in the fixtures to exercise the UI. It must say what it is."""
    mod = _load()
    experiments = {e["id"]: e for e in mod.capture()["experiments"]}
    for exp in experiments.values():
        assert "Synthetic fixture" in exp["provenance"]["notes"], exp["id"]
    assert experiments["hpc_fixture_run"]["model_version"] == "fixture"
