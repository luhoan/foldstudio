import type { Experiment, ExperimentOutput, Structure } from './types'

/** Path of an experiment output, whichever of the two shapes its producer wrote. */
export function outputPath(output: ExperimentOutput): string {
  return typeof output === 'string' ? output : output.path
}

export function outputPaths(experiment: Pick<Experiment, 'outputs'>): string[] {
  return (experiment.outputs ?? []).map(outputPath)
}

/**
 * The experiment a structure was registered from, if any.
 *
 * Newer registrations carry `provenance.experiment_id`. Rows registered by an earlier backend only
 * have `provenance.source = "experiment:<id>"`, which is read as a fallback so an existing database
 * keeps working without being rebuilt.
 */
export function experimentIdOf(structure: Pick<Structure, 'provenance'>): string | null {
  const provenance = structure.provenance
  if (typeof provenance?.experiment_id === 'string' && provenance.experiment_id) return provenance.experiment_id
  const source = provenance?.source
  if (typeof source === 'string' && source.startsWith('experiment:')) return source.slice('experiment:'.length) || null
  return null
}

export function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

/**
 * Text for a metric or setting value. Producers mostly record scalars, but lists and objects are
 * legal (per-interface contact counts, for one), and `String()` on those prints "[object Object]".
 */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
  if (isScalar(value)) return String(value)
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return value.map((v) => describeValue(v)).join(', ')
    return `${value.length} item${value.length === 1 ? '' : 's'}`
  }
  return `${Object.keys(value as object).length} field${Object.keys(value as object).length === 1 ? '' : 's'}`
}
