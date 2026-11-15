import { describe, expect, it } from 'vitest'
import { fixtureIds, fixtures } from './fixtures'
import { describeValue, experimentIdOf, isScalar, outputPath, outputPaths } from './helpers'

describe('experiment outputs', () => {
  it('reads the path from both shapes producers write', () => {
    expect(outputPath('structures/a.pdb')).toBe('structures/a.pdb')
    expect(outputPath({ type: 'structure', path: 'structures/b.pdb', sha256: 'x' })).toBe('structures/b.pdb')
  })

  it('handles every experiment in the captured dataset', () => {
    for (const experiment of fixtures.experiments) {
      const paths = outputPaths(experiment)
      expect(paths).toHaveLength(experiment.outputs.length)
      expect(paths.every((p) => typeof p === 'string' && p.length > 0)).toBe(true)
    }
  })
})

describe('experimentIdOf', () => {
  it('finds the experiment a bundle-registered structure came from', () => {
    const design = fixtures.structures.find((s) => s.id === fixtureIds.design)!
    expect(experimentIdOf(design)).toBe(fixtureIds.pipelineRun)
  })

  it('falls back to the older "experiment:<id>" provenance source', () => {
    expect(experimentIdOf({ provenance: { source: 'experiment:run_7', retrieved_at: null, url: null, notes: '' } })).toBe('run_7')
  })

  it('is null for a structure that did not come from an experiment', () => {
    expect(experimentIdOf(fixtures.upload)).toBeNull()
    expect(experimentIdOf({ provenance: { source: 'experiment:', retrieved_at: null, url: null, notes: '' } })).toBeNull()
  })
})

describe('describeValue', () => {
  it('prints scalars plainly and trims float noise', () => {
    expect(describeValue(3)).toBe('3')
    expect(describeValue(0.30000000000000004)).toBe('0.3')
    expect(describeValue('ok')).toBe('ok')
    expect(describeValue(true)).toBe('true')
    expect(describeValue(null)).toBe('—')
    expect(describeValue(undefined)).toBe('—')
  })

  it('never prints "[object Object]" for lists and records', () => {
    expect(describeValue([1, 2, 'x'])).toBe('1, 2, x')
    expect(describeValue([{ a: 1 }, { a: 2 }])).toBe('2 items')
    expect(describeValue([{ a: 1 }])).toBe('1 item')
    expect(describeValue({ a: 1, b: 2 })).toBe('2 fields')
    for (const experiment of fixtures.experiments) {
      for (const value of Object.values(experiment.metrics)) expect(describeValue(value)).not.toContain('[object')
    }
  })

  it('tells scalars from structures', () => {
    expect(isScalar(1)).toBe(true)
    expect(isScalar(null)).toBe(true)
    expect(isScalar([1])).toBe(false)
    expect(isScalar({})).toBe(false)
  })
})
