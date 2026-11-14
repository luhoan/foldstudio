"""Offline tests for fetch_demo_data.py using a fake HTTP layer (no network).
Run: python -m unittest scripts/fetch_demo_data_test.py   (from repo root: python scripts/fetch_demo_data_test.py)
These do NOT prove the live downloads work; they prove the logic around them."""
import hashlib, json, sys, tempfile, unittest, urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_demo_data as F


def atom(serial, name, resn, chain, resseq, x, y, z, b=90.0, elem="C"):
    return (f"ATOM  {serial:5d} {name:<4s}{' '}{resn:>3s} {chain}{resseq:4d}    "
            f"{x:8.3f}{y:8.3f}{z:8.3f}  1.00{b:6.2f}          {elem:>2s}")


def make_pdb(two_chain=True, plddt=80.0):
    lines = [atom(1, "CA", "ALA", "A", 1, 0, 0, 0, plddt), atom(2, "CA", "GLY", "A", 2, 3.8, 0, 0, plddt)]
    if two_chain:
        lines += [atom(3, "CA", "SER", "B", 1, 3.0, 3.0, 0, plddt),   # within 4.5 A of A:1 (dist 4.24)
                  atom(4, "CA", "THR", "B", 2, 30, 30, 30, plddt)]    # far away
    return ("\n".join(lines) + "\nEND\n").encode()


class FakeHttp:
    def __init__(self, routes): self.routes = routes; self.calls = []
    def get(self, url, data=None, headers=None):
        self.calls.append(url)
        v = self.routes.get(url)
        if v is None:
            raise urllib.error.HTTPError(url, 404, "nf", {}, None)
        if isinstance(v, Exception): raise v
        return v if isinstance(v, bytes) else json.dumps(v).encode()
    def json(self, url, **kw): return json.loads(self.get(url, **kw))


def rcsb_routes(pdb_id, title, two=True, citation=True):
    meta = {"struct": {"title": title}, "exptl": [{"method": "X-RAY DIFFRACTION"}],
            "rcsb_entry_container_identifiers": {"polymer_entity_ids": ["1"]}}
    if citation:
        meta["rcsb_primary_citation"] = {"title": "A paper", "year": 1999, "pdbx_database_id_doi": "10.1/x"}
    return {F.RCSB_ENTRY.format(id=pdb_id): meta,
            F.RCSB_FILE.format(id=pdb_id): make_pdb(two),
            F.RCSB_ENTITY.format(id=pdb_id, n="1"): {
                "rcsb_polymer_entity": {"pdbx_description": "Entity one"},
                "rcsb_polymer_entity_container_identifiers": {"auth_asym_ids": ["A"]}}}


class Geometry(unittest.TestCase):
    def test_parse_and_summary(self):
        atoms = F.parse_pdb(make_pdb().decode())
        s = F.summarize(atoms)
        self.assertEqual(s, {"chains": ["A", "B"], "n_residues": 4})

    def test_contacts_known_distance(self):
        atoms = F.parse_pdb(make_pdb().decode())
        c = F.interface_contacts(atoms, 4.5)
        self.assertEqual(len(c), 1)
        # A1-B1 = 4.243 A, A2-B1 = 3.098 A, everything else far away
        self.assertEqual((c[0]["chain_a"], c[0]["chain_b"], c[0]["n_residue_pairs"]), ("A", "B", 2))
        self.assertEqual(F.interface_contacts(atoms, 3.5)[0]["n_residue_pairs"], 1)
        self.assertEqual(F.interface_contacts(atoms, 3.0), [])

    def test_mean_plddt_from_bfactor(self):
        self.assertEqual(F.mean_plddt_from_bfactor(F.parse_pdb(make_pdb(False, 77.5).decode())), 77.5)


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name)
        self._orig = F.HTTP
        self.addCleanup(lambda: setattr(F, "HTTP", self._orig))

    def use(self, routes):
        F.HTTP = FakeHttp(routes)

    def test_success_manifest_and_experiment(self):
        r = rcsb_routes("6M0J", "Crystal structure of ACE2 with spike RBD")
        self.use(r)
        rep = F.run(self.data, {"rbd_ace2"})
        self.assertEqual(rep["succeeded"], ["6m0j"])
        m = json.loads((self.data / "manifest.json").read_text())["structures"][0]
        raw = (self.data / "structures/6m0j.pdb").read_bytes()
        self.assertEqual(m["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual((m["source"], m["origin_id"], m["format"], m["n_residues"]), ("experimental", "6M0J", "pdb", 4))
        self.assertTrue(m["retrieved_at"] and m["url"])
        e = json.loads((self.data / "experiments/imported-6m0j/experiment.json").read_text())
        self.assertEqual((e["kind"], e["status"], e["error"]), ("imported", "ok", None))
        self.assertEqual(e["metrics"]["interfaces"][0]["n_residue_pairs"], 2)
        self.assertIn("did not run any experiment or model", e["provenance"]["notes"])
        self.assertIn('"doi": "10.1/x"', e["provenance"]["notes"])  # only from entry metadata
        # what the backend needs to register the structure under a readable name, with a source
        out = e["outputs"][0]
        self.assertEqual((out["type"], out["source"], out["path"]), ("structure", "experimental", "structures/6m0j.pdb"))
        self.assertEqual(out["label"], m["label"])
        # entry metadata is carried verbatim, and only what the entry actually returned
        self.assertEqual(e["entry"]["title_from_entry"], "Crystal structure of ACE2 with spike RBD")
        self.assertEqual(e["entry"]["chain_descriptions_from_entry"], {"A": "Entity one"})
        self.assertEqual(e["entry"]["citation_from_entry"]["doi"], "10.1/x")
        self.assertEqual(e["entry"]["origin_id"], "6M0J")

    def test_no_citation_means_none_written(self):
        self.use(rcsb_routes("1CRN", "Crambin", citation=False))
        F.run(self.data, {"crambin"})
        e = json.loads((self.data / "experiments/imported-1crn/experiment.json").read_text())
        self.assertNotIn("citation", e["provenance"]["notes"].lower())
        self.assertNotIn("citation_from_entry", e["entry"])  # absent in the entry -> absent here

    def test_title_mismatch_is_dropped(self):
        self.use(rcsb_routes("1UBQ", "Something unrelated entirely"))
        rep = F.run(self.data, {"ubiquitin"})
        self.assertEqual(rep["succeeded"], [])
        self.assertIn("matches none of", rep["failed_verification_or_download"][0]["tried"][0]["error"])
        self.assertEqual(json.loads((self.data / "manifest.json").read_text())["structures"], [])

    def test_unresolvable_id_dropped_and_next_candidate_used(self):
        self.use(rcsb_routes("193L", "Lysozyme"))  # 1LYZ routes absent -> 404
        rep = F.run(self.data, {"hewl_experimental"})
        self.assertEqual(rep["succeeded"], ["193l"])
        self.assertEqual(rep["earlier_candidates_that_failed_before_a_later_one_verified"]["hewl_experimental"][0]["id"], "1LYZ")

    def test_search_fallback_is_labelled(self):
        routes = rcsb_routes("9ZZZ", "A de novo designed protein")
        self.use(routes)
        F.search_fallback = lambda q: ["9ZZZ"]
        rep = F.run(self.data, {"de_novo_designed"})
        self.assertEqual(rep["succeeded"], ["9zzz"])
        m = json.loads((self.data / "manifest.json").read_text())["structures"][0]
        self.assertIn("full-text search", m["selection_note"])

    def test_afdb_with_pae_and_plddt(self):
        acc = "P42212"; base = "https://alphafold.ebi.ac.uk/files/AF-P42212-F1"
        pae = [{"predicted_aligned_error": [[0, 1, 2, 3]] * 2 + [[1, 0, 1, 2]] * 2, "max_predicted_aligned_error": 31.75}]
        self.use({F.AFDB_API.format(acc=acc): [{"entryId": "AF-P42212-F1", "uniprotAccession": acc,
                  "pdbUrl": base + "-model_v4.pdb", "paeDocUrl": base + "-predicted_aligned_error_v4.json",
                  "latestVersion": 4}],
                  base + "-model_v4.pdb": make_pdb(False, 91.0),
                  base + "-predicted_aligned_error_v4.json": pae})
        rep = F.run(self.data, {"gfp_predicted"})
        self.assertEqual(rep["succeeded"], ["af-p42212-f1"])
        m = json.loads((self.data / "manifest.json").read_text())["structures"][0]
        self.assertEqual(m["source"], "predicted"); self.assertEqual(m["pae"]["size"], 4)
        e = json.loads((self.data / "experiments/imported-af-p42212-f1/experiment.json").read_text())
        self.assertEqual(e["metrics"]["mean_plddt_ca"], 91.0)
        self.assertEqual([o["type"] for o in e["outputs"]], ["structure", "pae"])
        self.assertEqual(e["outputs"][0]["source"], "predicted")
        self.assertEqual(e["model_version"], "4")
        self.assertEqual(rep["warnings"], {"af-p42212-f1": {"pae_warning": "PAE size 4 != n_residues 2"}})

    def test_afdb_missing_pae_is_reported_not_faked(self):
        acc = "P42212"; base = "https://x/AF"
        self.use({F.AFDB_API.format(acc=acc): [{"entryId": "AF-P42212-F1", "pdbUrl": base + ".pdb"}],
                  base + ".pdb": make_pdb(False)})
        rep = F.run(self.data, {"gfp_predicted"})
        m = json.loads((self.data / "manifest.json").read_text())["structures"][0]
        self.assertNotIn("pae", m)
        self.assertIn("pae_error", rep["warnings"]["af-p42212-f1"])

    def test_afdb_wrong_entry_dropped(self):
        self.use({F.AFDB_API.format(acc="P00698"): [{"entryId": "AF-OTHER-F1", "pdbUrl": "x"}]})
        rep = F.run(self.data, {"hewl_predicted"})
        self.assertEqual(rep["succeeded"], [])

    def test_pairs_only_when_both_succeed(self):
        r = rcsb_routes("1LYZ", "Lysozyme")
        self.use(r)
        F.run(self.data, {"hewl_experimental"})
        self.assertEqual(json.loads((self.data / "manifest.json").read_text())["pairs_for_prediction_vs_experiment"], [])


if __name__ == "__main__":
    unittest.main()
