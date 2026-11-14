export type StructureSource = 'experimental' | 'predicted' | 'uploaded'
export type StructureFormat = 'pdb' | 'mmcif'
export type ExperimentKind = 'executed' | 'imported' | 'demo'
export type ExperimentStatus = 'ok' | 'failed' | 'partial'

export interface Structure {
  id: string
  label: string
  source: StructureSource
  origin_id: string
  format: StructureFormat
  sha256: string
  chains: string[]
  n_residues: number
}

export interface Experiment {
  id: string
  created_at: string
  kind: ExperimentKind
  status: ExperimentStatus
  model_name: string
  model_version: string
  settings: Record<string, unknown>
  inputs: string[]
  outputs: string[]
  metrics: Record<string, number | string | null>
  error: string | null
  provenance: {
    source: string
    retrieved_at: string
    url: string | null
    notes: string
  }
}

export interface ResidueRecord {
  structure_id: string
  chain: string
  seq_id: number
  ins_code?: string
  comp_id: string
  plddt?: number | null
  residue_name?: string
  [key: string]: unknown
}

export interface ResiduesResponse {
  structure_id: string
  residues: ResidueRecord[]
}

export interface PlddtPoint {
  chain: string
  seq_id: number
  plddt: number
}

export interface PlddtResponse {
  structure_id: string
  residues: PlddtPoint[]
}

export interface PaeResponse {
  structure_id: string
  matrix: number[][]
  residue_indices?: number[]
  chains?: string[]
}

export interface AlignmentRequest {
  mobile_id: string
  reference_id: string
  selection: {
    chain?: string
    start?: number
    end?: number
    atom_type?: string
  }
}

export interface AlignmentResponse {
  rmsd: number
  tm_score: number | null
  aligned_atoms: number
  aligned_residues: number
  atom_type: string
  matrix: number[][]
}

export interface ExplanationResponse {
  structure_id: string
  chain: string
  start: number
  end: number
  summary: string
  numbers_used: Record<string, number | string | null>
  evidence?: Array<{ label: string; value: number | string; source?: string }>
  limitations?: string[]
}

export interface CompareRequest {
  /** The backend's canonical field. It also accepts `experiment_ids` as an
   *  alias, because this client shipped with that name. */
  ids: string[]
}

/** A field, setting or metric across the compared experiments.
 *  `values` is keyed by experiment id; `differs` is computed by the backend. */
export interface CompareRow {
  field: string
  values: Record<string, unknown>
  differs: boolean
}

export interface CompareResponse {
  ids: string[]
  /** Full experiment records, in the order requested. Keyed by `id`. */
  experiments: Experiment[]
  fields: CompareRow[]
  settings: CompareRow[]
  metrics: CompareRow[]
  note: string
}


export interface ReportResponse {
  html?: string
  markdown?: string
  content?: string
  format?: 'html' | 'markdown'
}

export interface ApiErrorBody {
  detail?: string
  message?: string
}
