import { describe, expect, it } from 'vitest'
import { fixtureIds, fixtures } from './fixtures'

/**
 * The fixtures are captured backend responses; the types in types.ts are what the UI believes the
 * backend returns. JSON imports cannot be checked against string-literal unions at compile time,
 * so the fields the UI relies on are checked here at runtime. A failure means types.ts and the
 * backend disagree.
 */

type Leaf = 'string' | 'number' | 'boolean' | 'string|null' | 'number|null' | 'array' | 'object'
type Spec = Leaf | readonly Spec[] | { readonly [key: string]: Spec }

function isList(spec: Spec): spec is readonly Spec[] {
  return Array.isArray(spec)
}

function problems(value: unknown, spec: Spec, path = '$'): string[] {
  if (typeof spec === 'string') {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    return spec.split('|').includes(actual) ? [] : [`${path}: expected ${spec}, got ${actual}`]
  }
  if (isList(spec)) {
    if (!Array.isArray(value)) return [`${path}: expected an array`]
    if (value.length === 0) return [`${path}: fixture array is empty, so its element shape is unchecked`]
    return value.flatMap((item, i) => problems(item, spec[0], `${path}[${i}]`))
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: expected an object`]
  const record = value as Record<string, unknown>
  return Object.entries(spec).flatMap(([key, sub]) =>
    key in record ? problems(record[key], sub, `${path}.${key}`) : [`${path}.${key}: missing`])
}

const explained = {
  explanations: [{ rule_id: 'string', text: 'string', refs: [{ name: 'string' }] }],
  summary: 'string',
  numbers_used: 'object',
  limitations: ['string'],
} as const

const structure = {
  id: 'string', label: 'string', source: 'string', format: 'string', sha256: 'string',
  chains: [{ id: 'string', n_residues: 'number', sequence: 'string' }],
  n_residues: 'number', has_pae: 'boolean', created_at: 'string',
  provenance: { source: 'string', notes: 'string' },
} as const

describe('captured backend responses match the shapes the UI is typed against', () => {
  const cases: Array<[string, unknown, Spec]> = [
    ['structures', fixtures.structures, [structure]],
    ['upload', fixtures.upload, structure],
    ['residues', fixtures.residues, {
      structure_id: 'string', source: 'string',
      residues: [{ chain: 'string', resseq: 'number', icode: 'string', resname: 'string', aa: 'string', has_ca: 'boolean' }],
    }],
    ['plddt', fixtures.plddt, {
      structure_id: 'string', n_residues: 'number', mean: 'number|null', median: 'number|null', note: 'string',
      per_residue: [{ chain: 'string', resseq: 'number', resname: 'string', label: 'string', plddt: 'number', bin: 'string' }],
      bins: [{ name: 'string', range: 'string', count: 'number', fraction: 'number' }],
      histogram: [{ lo: 'number', hi: 'number', count: 'number' }],
    }],
    ['pae', fixtures.pae, { structure_id: 'string', size: 'number', max_pae: 'number|null', matrix: 'array', note: 'string' }],
    ['pae attached', fixtures.pae_attached, { structure_id: 'string', size: 'number', max_pae: 'number|null' }],
    ['interfaces', fixtures.interfaces, {
      structure_id: 'string', cutoff_angstrom: 'number', atom_selection: 'string', n_chains: 'number', note: 'string',
      limitations: ['string'],
      interfaces: [{
        chain_a: 'string', chain_b: 'string', n_residue_pairs: 'number', residues_a: 'array', residues_b: 'array',
        ranges_a: [{ start: 'number', end: 'number' }], ranges_b: [{ start: 'number', end: 'number' }],
        explanation: { rule_id: 'string', text: 'string' },
      }],
    }],
    ['explain (predicted)', fixtures.explain_predicted, {
      structure_id: 'string', source: 'string', chain: 'string', start: 'number', end: 'number', n_residues: 'number', ...explained,
    }],
    ['explain (experimental)', fixtures.explain_experimental, { structure_id: 'string', ...explained }],
    ['explain (uploaded)', fixtures.explain_uploaded, { structure_id: 'string', ...explained }],
    ['align', fixtures.align, {
      rmsd: 'number', tm_score: 'number', tm_score_method: 'string', aligned_atoms: 'number', aligned_residues: 'number',
      atom_type: 'string', matrix: 'array', matching: 'string', matching_requested: 'string', sequence_identity: 'number',
      mobile_chain: 'string', reference_chain: 'string', mobile_label: 'string', reference_label: 'string',
      pairs: [{ mobile: 'string', reference: 'string', identical: 'boolean' }], notes: ['string'], procedure: 'string',
      ...explained,
    }],
    ['experiments', fixtures.experiments, [{
      id: 'string', created_at: 'string', kind: 'string', status: 'string', model_name: 'string',
      settings: 'object', inputs: 'array', outputs: 'array', metrics: 'object', error: 'string|null',
      provenance: { source: 'string', notes: 'string' },
    }]],
    ['compare', fixtures.compare, {
      ids: ['string'], experiments: [{ id: 'string' }], note: 'string',
      fields: [{ field: 'string', values: 'object', differs: 'boolean' }],
      metrics: [{ field: 'string', values: 'object', differs: 'boolean' }],
      settings: [{ field: 'string', values: 'object', differs: 'boolean' }],
    }],
    ['report', fixtures.report, { generated_at: 'string', markdown: 'string', html: 'string' }],
    ['health', fixtures.health, {
      status: 'string', data_dir: 'string', runners: 'array',
      reindex: { at: 'string', imported: 'array', errors: 'array', structures_registered: 'array', structures_updated: 'array', removed: 'array' },
    }],
    ['reindex', fixtures.reindex, { at: 'string', imported: ['string'], errors: 'array', structures_registered: 'array', structures_updated: 'array', removed: 'array' }],
    ['error bodies', [fixtures.plddt_refused, fixtures.pae_unavailable], [{ detail: 'string' }]],
  ]

  it.each(cases)('%s', (_name, value, spec) => {
    expect(problems(value, spec)).toEqual([])
  })

  it('the alignment matrix is 4x4 numbers', () => {
    expect(fixtures.align.matrix).toHaveLength(4)
    for (const row of fixtures.align.matrix) {
      expect(row).toHaveLength(4)
      expect(row.every((v) => typeof v === 'number')).toBe(true)
    }
  })

  it('the PAE matrix is square and matches its declared size', () => {
    expect(fixtures.pae.matrix).toHaveLength(fixtures.pae.size)
    expect(fixtures.pae.matrix.every((row) => row.length === fixtures.pae.size)).toBe(true)
  })

  it('the named fixture ids exist and are what their names say', () => {
    const byId = new Map(fixtures.structures.map((s) => [s.id, s]))
    expect(byId.get(fixtureIds.backbone)?.source).toBe('uploaded')
    expect(byId.get(fixtureIds.design)?.source).toBe('predicted')
    expect(byId.get(fixtureIds.complex)?.source).toBe('experimental')
    expect(byId.get(fixtureIds.complex)?.chains).toHaveLength(2)
    expect(byId.get(fixtureIds.predicted)?.has_pae).toBe(true)
    expect(fixtures.experiments.map((e) => e.id).sort()).toEqual(
      [fixtureIds.importedComplex, fixtureIds.importedPredicted, fixtureIds.pipelineRun].sort())
  })

  it('every fixture experiment says it is synthetic', () => {
    for (const experiment of fixtures.experiments) expect(experiment.provenance.notes).toContain('Synthetic fixture')
  })
})
