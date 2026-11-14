FoldStudio: browser workspace for reviewing computational protein design results. 36-hour hackathon, 4 developers, parallel AI agents, one repo.

STACK: Vite + React + TypeScript + Tailwind + shadcn/ui + Recharts; Mol* (molstar npm) for 3D behind a ViewerAdapter interface; Python FastAPI + Biopython + NumPy/SciPy; SQLite + files under data/. No microservices. App must be fully useful with no GPU.

REPO OWNERSHIP (touch only your directories):
- backend/app/** and backend/tests/**  -> Stream 1
- frontend/src/viewer/**, frontend/src/layout/**, frontend/src/main.tsx -> Stream 2
- hpc/**, scripts/hpc_*  -> Stream 3
- data/**, scripts/fetch_*, backend/app/services/explain_rules/** -> Stream 4
- frontend/src/panels/**, frontend/src/api/** -> Stream 5
- frontend/src/input/** -> Stream 6 (later)
- contracts/** is shared: add examples, never break existing fields.

API (base /api): POST /structures/upload; POST /structures/fetch {source: rcsb|afdb, id}; GET /structures; GET /structures/{id}/file; GET /structures/{id}/residues; GET /structures/{id}/plddt; GET /structures/{id}/pae (404 with {detail:"pae_unavailable"} if none); POST /analysis/align {mobile_id, reference_id, selection} -> {rmsd, tm_score|null, aligned_atoms, aligned_residues, atom_type, matrix[4x4]}; GET /explain?structure=&chain=&start=&end=; GET/POST /experiments; GET /experiments/{id}; POST /experiments/compare {ids:[>=2 distinct experiment ids]} (alias: experiment_ids) -> {ids, experiments[full records], fields[], settings[], metrics[], note} where each row is {field, values{id: value}, differs}; GET /reports?ids=a,b (HTML+Markdown); POST /jobs (501 {detail:"no_runner"} when no runner).

CORE JSON (see contracts/examples/ for full files):ß
Structure {id, label, source: "experimental"|"predicted"|"uploaded", origin_id (e.g. PDB ID or UniProt/AFDB id), format: "pdb"|"mmcif", sha256, chains[], n_residues}
Experiment {id, created_at, kind: "executed"|"imported"|"demo", status: "ok"|"failed"|"partial", model_name, model_version, settings{}, inputs[structure ids/files], outputs[], metrics{}, error|null, provenance{source, retrieved_at, url|null, notes}}

SCIENTIFIC INTEGRITY (non-negotiable): never fabricate runs, scores, citations, or experimental validation. Label every dataset executed / imported / demo. pLDDT and PAE are model confidence, not proof of folding, binding, affinity, efficacy, or safety. Report which atoms/residues were aligned for RMSD/TM-score. Binder/antibody content is review of curated, precomputed, public complexes only; no novel therapeutic binder generation. Not a clinical tool.

WORKING RULES: real data only; write tests for what you build and run them; do not claim something works unless you ran it; small commits with clear messages; if blocked by another stream, code against contracts/examples and note the assumption in your final summary.