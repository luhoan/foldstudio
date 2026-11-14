"""Tests for explain_rules. Run: python -m unittest discover -s backend/app/services/explain_rules
(also collected by pytest)."""
import itertools
import json
import re
import unittest
from pathlib import Path

try:
    from . import engine as E
except ImportError:  # run as plain script / unittest discover
    import engine as E

FORBIDDEN = re.compile(
    r"\b(bind\w*|bound|affinit\w*|efficac\w*|efficien\w*|safe\w*|safety|valid\w*|"
    r"therapeutic\w*|clinical\w*|prov(?:e|es|en|ing)|proof|confirm\w*|drug\w*|potent\w*)\b",
    re.I,
)


def strip_disclaimer(text: str) -> str:
    return text.replace(E.DISCLAIMER, "")


def all_outputs():
    """Exercise every rule over a grid of inputs, including edge values."""
    out = []
    for v in [0, 49.9, 50, 69.9, 70, 89.9, 90, 100]:
        out.append(E.explain_plddt_residue(v, "A", 1))
    out.append(E.explain_plddt_region([95, 80, 60, 30], "A", 1, 4))
    out.append(E.explain_pae_region([[0, 2.5], [3.0, 0]], "A", 1, 2))
    out.append(E.explain_pae_interchain([[10.0, 12.0], [8.0, 30.0]], "A", "B"))
    for tm, n in itertools.product([None, 0.42, 0.95], [5, 300]):
        out.append(E.explain_alignment(1.23, tm, n, n // 4 or 1, "CA", "m", "r"))
        out.append(E.explain_experimental_vs_predicted("1EMA", "AF-P42212-F1", 0.9, tm, n, n, "CA", 91.2))
        out.append(E.explain_experimental_vs_predicted("1EMA", "AF-P42212-F1", 0.9, tm, n, n, "CA"))
    out.append(E.explain_interface("6M0J", "A", "E", 40, 4.5, 85.0, 6.0))
    out.append(E.explain_interface("6M0J", "A", "E", 40, 4.5))
    for source in ("experimental", "uploaded"):
        out.append(E.explain_no_confidence(source, "A", 1, 60, 60))
    for identity in (0.0, 0.05, 0.24):
        out.append(E.explain_low_identity_matching(identity, 17))
    out.append(E.explain_interface_coordinates("my_upload.pdb", "A", "B", 12, 4.5))
    return out


class NoForbiddenClaims(unittest.TestCase):
    def test_no_rule_claims_binding_affinity_efficacy_safety_validation(self):
        for ex in all_outputs():
            body = strip_disclaimer(ex.text)
            m = FORBIDDEN.search(body)
            self.assertIsNone(m, f"{ex.rule_id}: forbidden term {m and m.group(0)!r} in: {body}")

    def test_every_template_and_bin_text_is_clean(self):
        data = json.loads(Path(E.__file__).with_name("rules_data.json").read_text())
        texts = list(data["templates"].values()) + [b["text"] for b in data["plddt_bins"]]
        for t in texts:
            self.assertIsNone(FORBIDDEN.search(t), f"forbidden term in template: {t}")

    def test_disclaimer_is_the_only_place_those_words_appear(self):
        self.assertTrue(FORBIDDEN.search(E.DISCLAIMER))  # sanity: the check can fire
        for ex in all_outputs():
            self.assertTrue(ex.text.endswith(E.DISCLAIMER))
            self.assertEqual(ex.text.count(E.DISCLAIMER), 1)

    def test_disclaimer_is_negative(self):
        self.assertIn("is not evidence of", E.DISCLAIMER)


class ReferencesNumbers(unittest.TestCase):
    def test_every_output_has_well_formed_refs(self):
        for ex in all_outputs():
            self.assertTrue(ex.refs, ex.rule_id)
            for r in ex.refs:
                self.assertEqual(set(r), {"name", "value", "unit"})

    def test_plddt_bins(self):
        cases = {95: "very_high", 90: "very_high", 89.9: "high", 70: "high",
                 69.9: "low", 50: "low", 49.9: "very_low", 0: "very_low"}
        for v, b in cases.items():
            self.assertEqual(E.plddt_bin(v)["id"], b, v)
        with self.assertRaises(ValueError):
            E.plddt_bin(101)
        with self.assertRaises(ValueError):
            E.plddt_bin(-1)

    def test_plddt_70_90_wording(self):
        ex = E.explain_plddt_residue(80, "A", 5)
        self.assertIn("relatively high local model confidence", ex.text)
        self.assertIn("not experimentally observed folding or function", ex.text)
        self.assertEqual({r["name"]: r["value"] for r in ex.refs}["plddt"], 80)

    def test_region_mean_and_refs(self):
        ex = E.explain_plddt_region([100, 50, 0, 50], "B", 10, 13)
        d = {r["name"]: r["value"] for r in ex.refs}
        self.assertEqual(d["mean_plddt"], 50.0)
        self.assertEqual(d["n_residues"], 4)
        self.assertIn("mean pLDDT 50.0", ex.text)

    def test_pae_wording_and_values(self):
        ex = E.explain_pae_region([[0, 2], [4, 0]], "A", 1, 2)
        d = {r["name"]: r["value"] for r in ex.refs}
        self.assertEqual(d["mean_pae"], 1.5)
        self.assertEqual(d["max_pae"], 4.0)
        self.assertIn("relative uncertainty between residue pairs", ex.text)

    def test_alignment_reports_what_was_aligned(self):
        ex = E.explain_alignment(1.5, 0.8, 120, 120, "CA", "m1", "r1")
        for s in ["120 CA atoms", "120 aligned residues", "RMSD", "TM-score 0.800"]:
            self.assertIn(s, ex.text)
        self.assertIn("only those atoms", ex.text)

    def test_missing_tm_and_small_alignment_flagged(self):
        ex = E.explain_alignment(0.5, None, 5, 5, "CA", "m", "r")
        self.assertIn("No TM-score was reported", ex.text)
        self.assertIn("very small part", ex.text)

    def test_exp_vs_pred_mentions_both_kinds(self):
        ex = E.explain_experimental_vs_predicted("1EMA", "AF-P42212-F1", 1.0, 0.9, 200, 200, "CA", 88.0)
        self.assertIn("derived from measured data", ex.text)
        self.assertIn("computational estimate", ex.text)
        self.assertIn("Mean pLDDT of the predicted model", ex.text)

    def test_experimental_interface_has_no_confidence_claims(self):
        ex = E.explain_interface("6M0J", "A", "E", 33, 4.5)
        self.assertNotIn("pLDDT", ex.text)
        self.assertIn("computed from the deposited coordinates", ex.text)

    def test_non_predicted_structures_get_no_confidence_numbers(self):
        exp = E.explain_no_confidence("experimental", "A", 1, 46, 46)
        self.assertIn("experimental B-factors", exp.text)
        self.assertIn("different quantity from pLDDT", exp.text)
        unl = E.explain_no_confidence("uploaded", "A", 1, 60, 60)
        self.assertIn("not declared", unl.text)
        self.assertIn("designed backbone", unl.text)
        for ex in (exp, unl):
            names = {r["name"] for r in ex.refs}
            self.assertFalse(names & {"plddt", "mean_plddt", "mean_pae"},
                             "no confidence value may be attached to a non-predicted structure")

    def test_coordinates_only_interface_asserts_no_origin(self):
        """An uploaded file must not be called an experimental entry or a model."""
        ex = E.explain_interface_coordinates("my_upload.pdb", "A", "B", 12, 4.5)
        for word in ("experimental", "deposited", "pLDDT", "PAE"):
            self.assertNotIn(word, strip_disclaimer(ex.text))
        self.assertIn("12 residue pairs", ex.text)

    def test_low_identity_caveat_states_the_identity(self):
        ex = E.explain_low_identity_matching(0.05, 17)
        self.assertIn("5% sequence identity", ex.text)
        self.assertIn("matching by residue number", ex.text)

    def test_deterministic(self):
        a = [e.to_dict() for e in all_outputs()]
        b = [e.to_dict() for e in all_outputs()]
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
