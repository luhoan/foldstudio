/**
 * Response and request shapes of the FoldStudio backend, as it actually returns them.
 *
 * These were first written from the contract document while the backend was built separately, and
 * the two drifted on most endpoints. They now mirror the server, and `__fixtures__/*.json` — captured
 * from the real app by `scripts/export_api_fixtures.py` — are what the tests run against. If you
 * change a type here, change it because the backend changed, and regenerate the fixtures.
 */

export type StructureSource = 'experimental' | 'predicted' | 'uploaded'
export type StructureFormat = 'pdb' | 'mmcif' | 'fasta'
export type ExperimentKind = 'executed' | 'imported' | 'demo'
export type ExperimentStatus = 'ok' | 'failed' | 'partial'

export interface Provenance {
  source: string
  retrieved_at: string | null
  url: string | null
  notes: string
  /** Set on structures the backend registered from an experiment bundle. */
  experiment_id?: string
  [key: string]: unknown
}

export interface ChainSummary {
  id: string
  n_residues: number
  sequence: string
  first_resseq?: number
  last_resseq?: number
}

export interface Structure {
  id: string
  label: string
  source: StructureSource
  /** Database id for fetched entries; "<experiment id>:<file>" for bundle-registered ones. */
  origin_id: string | null
  format: StructureFormat
  sha256: string
  chains: ChainSummary[]
  n_residues: number
  provenance: Provenance
  created_at: string
  has_pae: boolean
}

export interface Residue {
  chain: string
  resseq: number
  icode: string
  resname: string
  aa: string
  has_ca: boolean
}

export interface ResiduesResponse {
  structure_id: string
  source: StructureSource
  chains: ChainSummary[]
  residues: Residue[]
}

/** The backend's band names. Lower bound inclusive: >=90, 70-<90, 50-<70, <50. */
export type PlddtBinName = 'very_high' | 'confident' | 'low' | 'very_low'

export interface PlddtResidue {
  chain: string
  resseq: number
  icode: string
  resname: string
  label: string
  plddt: number
  bin: PlddtBinName
}

export interface PlddtBinCount {
  name: PlddtBinName
  range: string
  count: number
  fraction: number
}

export interface PlddtResponse {
  structure_id: string
  source: StructureSource
  per_residue: PlddtResidue[]
  n_residues: number
  mean: number | null
  median: number | null
  bins: PlddtBinCount[]
  histogram: Array<{ lo: number; hi: number; count: number }>
  note: string
}

export interface PaeResponse {
  structure_id: string
  size: number
  max_pae: number | null
  matrix: number[][]
  note: string
}

/** What attaching a PAE file to a structure returns. */
export interface PaeAttachResponse {
  structure_id: string
  size: number
  max_pae: number | null
}

export interface ExplanationRef {
  name: string
  value: number | string | null
  unit?: string
}

/** One rule's output: fixed template text plus the exact numbers it was built from. */
export interface Explanation {
  rule_id: string
  text: string
  refs: ExplanationRef[]
}

/** The tail every explaining endpoint shares. `summary` omits the disclaimer; show `limitations` too. */
export interface Explained {
  explanations: Explanation[]
  summary: string
  numbers_used: Record<string, number | string | null>
  limitations: string[]
}

export interface ExplainResponse extends Explained {
  structure_id: string
  source: StructureSource
  chain: string
  start: number
  end: number
  n_residues: number
}

export interface ResidueRange {
  start: number
  end: number
}

export interface ChainInterface {
  chain_a: string
  chain_b: string
  n_residue_pairs: number
  n_residues_a: number
  n_residues_b: number
  residues_a: number[]
  residues_b: number[]
  ranges_a: ResidueRange[]
  ranges_b: ResidueRange[]
  interface_mean_plddt: number | null
  mean_interchain_pae: number | null
  explanation: Explanation
}

export interface InterfacesResponse {
  structure_id: string
  source: StructureSource
  cutoff_angstrom: number
  atom_selection: string
  n_chains: number
  interfaces: ChainInterface[]
  note: string
  pae_note: string
  limitations: string[]
}

/** How residues of the two structures are paired before superposition. */
export type MatchingMethod = 'sequence' | 'resnum' | 'auto'

export interface AlignmentSelection {
  mobile_chain?: string
  reference_chain?: string
  mobile_range?: [number, number]
  reference_range?: [number, number]
  method?: MatchingMethod
}

export interface AlignmentRequest {
  mobile_id: string
  reference_id: string
  selection?: AlignmentSelection
}

export interface AlignmentResponse extends Explained {
  rmsd: number
  tm_score: number
  tm_score_method: string
  aligned_atoms: number
  aligned_residues: number
  atom_type: string
  /** 4x4, row by row; maps mobile coordinates into the reference frame. */
  matrix: number[][]
  matrix_convention: string
  mobile_chain: string
  reference_chain: string
  /** The method actually used (never "auto"). */
  matching: 'sequence' | 'resnum'
  matching_requested: MatchingMethod
  sequence_identity: number
  mobile_residues_in_selection: number
  reference_residues_in_selection: number
  pairs: Array<{ mobile: string; reference: string; identical: boolean }>
  procedure: string
  notes: string[]
  mobile_id: string
  reference_id: string
  mobile_source: StructureSource
  reference_source: StructureSource
  mobile_label: string
  reference_label: string
}

/** One producer writes plain paths, another writes objects. Both are valid; see `outputPath`. */
export type ExperimentOutput =
  | string
  | { type?: string; path: string; sha256?: string; source?: string; label?: string }

/** One row of a pipeline bundle's `workflow` block. Status is whatever the pipeline recorded. */
export interface WorkflowStage {
  stage: string
  status: string
  status_label?: string | null
  error?: string | null
  outputs?: number | null
  wall_seconds?: number | null
  preemptions?: number | null
  note?: string | null
  ledger_stage?: string | null
}

/** What a database entry said about itself; written by scripts/fetch_demo_data.py. */
export interface EntryInfo {
  label?: string
  reason?: string
  title_from_entry?: string
  method_from_entry?: string
  chain_descriptions_from_entry?: Record<string, string>
  citation_from_entry?: Record<string, unknown>
  origin_id?: string
  url?: string
  [key: string]: unknown
}

/** One predicted design in a pipeline bundle. Producers add fields freely; only these are relied on. */
export interface PerDesign {
  name: string
  /** Path inside the bundle, e.g. "structures/design_0_s1.pdb". */
  file?: string
  n_residues?: number
  /** "input_sequence" marks a fold of ProteinMPNN's echoed input record, which is not a design. */
  role?: string
  note?: string
  mean_plddt?: number
  mean_plddt_source?: string
  ptm?: number
  /** Self-consistency CA RMSD against the backbone it was designed for; `rmsd` is null with a `reason`. */
  scrmsd?: {
    rmsd: number | null
    reason?: string | null
    aligned_atoms?: number
    backbone?: string
    method?: string
  }
  [key: string]: unknown
}

export interface Experiment {
  id: string
  created_at: string
  kind: ExperimentKind
  status: ExperimentStatus
  model_name: string
  model_version: string | null
  settings: Record<string, unknown>
  inputs: unknown[]
  outputs: ExperimentOutput[]
  /** Mostly scalars, but producers may record lists or objects (e.g. per-interface contact counts). */
  metrics: Record<string, unknown>
  error: string | null
  provenance: Provenance
  // ---- optional blocks carried by pipeline bundles and fetched entries ----
  workflow?: WorkflowStage[]
  /** metric name -> the reason the run recorded for not measuring it */
  metrics_unavailable?: Record<string, string>
  metric_definitions?: Record<string, string>
  structure_sources?: Record<string, string>
  structure_labels?: Record<string, string>
  per_design?: PerDesign[]
  entry?: EntryInfo
  /** Present when the record was loaded from data/experiments/<dir>/. */
  bundle?: { dir: string; path: string }
  [key: string]: unknown
}

export interface FetchStructureRequest {
  source: 'rcsb' | 'afdb'
  id: string
}

export interface CompareRequest {
  /** The backend's canonical field. It also accepts `experiment_ids` as an alias. */
  ids: string[]
}

/** A field, setting or metric across the compared experiments, keyed by experiment id. */
export interface CompareRow {
  field: string
  values: Record<string, unknown>
  differs: boolean
}

export interface CompareResponse {
  ids: string[]
  experiments: Experiment[]
  fields: CompareRow[]
  settings: CompareRow[]
  metrics: CompareRow[]
  note: string
}

export interface ReportResponse {
  generated_at: string
  markdown: string
  html: string
}

export interface ReindexReport {
  at: string
  imported: string[]
  errors: Array<{ path: string; error: string }>
  structures_registered: string[]
  structures_updated: string[]
  removed: string[]
}

export interface HealthResponse {
  status: string
  data_dir: string
  runners: string[]
  reindex: ReindexReport
}

export interface ApiErrorBody {
  detail: string
}
