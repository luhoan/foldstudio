import type {
  AlignmentResponse, CompareResponse, Experiment, ExplanationResponse, PaeResponse,
  PlddtResponse, ResiduesResponse, Structure,
} from './types'

/**
 * Synthetic fixtures for UI development only. These values are NOT measured results,
 * experimental observations, or claims about a real protein.
 */
export const demoStructure: Structure = {
  id: 'demo-structure-001',
  label: 'Illustrative demo structure',
  source: 'predicted',
  origin_id: 'DEMO-UNIPROT-0001',
  format: 'pdb',
  sha256: 'demo-sha256-not-a-real-file',
  chains: ['A', 'B'],
  n_residues: 12,
}

export const demoExperiment: Experiment = {
  id: 'demo-experiment-001',
  created_at: '2026-01-01T12:00:00Z',
  kind: 'demo',
  status: 'partial',
  model_name: 'Illustrative model',
  model_version: 'demo-only',
  settings: {
    workflow_stage: 'structure_prediction',
    candidate_chain: null,
    partner_chain: null,
  },
  inputs: [demoStructure.id],
  outputs: [demoStructure.id],
  metrics: { illustrative_metric: 0.72 },
  error: null,
  provenance: {
    source: 'Synthetic UI fixture',
    retrieved_at: '2026-01-01T12:00:00Z',
    url: null,
    notes: 'Synthetic demo fixture; not a real run or scientific result.',
  },
}

export const demoResidues: ResiduesResponse = {
  structure_id: demoStructure.id,
  residues: Array.from({ length: 12 }, (_, i) => ({
    structure_id: demoStructure.id,
    chain: 'A',
    seq_id: i + 1,
    comp_id: ['MET', 'GLY', 'SER', 'ALA'][i % 4],
    plddt: 50 + (i * 3),
  })),
}

export const demoPlddt: PlddtResponse = {
  structure_id: demoStructure.id,
  residues: demoResidues.residues.map((r) => ({
    chain: r.chain,
    seq_id: r.seq_id,
    plddt: r.plddt ?? 0,
  })),
}

export const demoPae: PaeResponse = {
  structure_id: demoStructure.id,
  residue_indices: Array.from({ length: 12 }, (_, i) => i + 1),
  chains: ['A'],
  matrix: Array.from({ length: 12 }, (_, row) =>
    Array.from({ length: 12 }, (_, col) => Math.abs(row - col) * 0.4 + 1),
  ),
}

export const demoExplanation: ExplanationResponse = {
  structure_id: demoStructure.id,
  chain: 'A',
  start: 1,
  end: 12,
  summary: 'Illustrative explanation for the demo fixture. It is not a scientific interpretation.',
  numbers_used: { mean_plddt: 66.5, residue_count: 12 },
  limitations: ['Synthetic demo values; not experimental validation.'],
}

export const demoAlignment: AlignmentResponse = {
  rmsd: 0.8,
  tm_score: null,
  aligned_atoms: 12,
  aligned_residues: 12,
  atom_type: 'CA',
  matrix: [
    [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
  ],
}

export const demoComparison: CompareResponse = {
  ids: [demoExperiment.id],
  experiments: [demoExperiment],
  fields: [
    { field: 'kind', values: { [demoExperiment.id]: demoExperiment.kind }, differs: false },
    { field: 'status', values: { [demoExperiment.id]: demoExperiment.status }, differs: false },
    { field: 'model_name', values: { [demoExperiment.id]: demoExperiment.model_name }, differs: false },
  ],
  settings: [],
  metrics: Object.entries(demoExperiment.metrics).map(([field, v]) => ({
    field, values: { [demoExperiment.id]: v }, differs: false,
  })),
  note: 'Demo fixture: a single experiment, so nothing differs.',
}
