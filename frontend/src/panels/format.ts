import type { ExperimentKind, StructureSource } from '@/api'

/** Wording and formatting shared by the panels. Kept apart from the components so both hot-reload. */

const KIND_MEANING: Record<ExperimentKind, string> = {
  executed: 'Ran here: the pipeline produced these files on this installation.',
  imported: 'Brought in from a public database as-is. No model was run here.',
  demo: 'Illustrative fixture. Not a run.',
}

export function kindMeaning(kind: string): string {
  return KIND_MEANING[kind as ExperimentKind] ?? 'Provenance kind recorded by whoever produced this record.'
}

const SOURCE_TEXT: Record<StructureSource, { label: string; meaning: string }> = {
  predicted: {
    label: 'predicted model',
    meaning: 'Model output. Its B-factor column holds pLDDT, so confidence can be read.',
  },
  experimental: {
    label: 'experimental',
    meaning: 'Deposited coordinates. Its B-factors are not model confidence.',
  },
  uploaded: {
    label: 'no declared source',
    meaning: 'Provided without a declared source (a designed backbone, for example), so no confidence is reported.',
  },
}

export function sourceMeaning(source: string): string {
  return SOURCE_TEXT[source as StructureSource]?.meaning ?? ''
}

export function sourceLabel(source: string): string {
  return SOURCE_TEXT[source as StructureSource]?.label ?? source
}

export const inputClass =
  'h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground transition-colors hover:border-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50'

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'not recorded'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'not recorded'
  if (seconds < 60) return `${Number(seconds.toFixed(1))} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return minutes < 60 ? `${minutes} min ${rest} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** Message of an unknown error, without ever printing "[object Object]". */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** "A:12-40, 55" style text for residue ranges. */
export function formatRanges(ranges: Array<{ start: number; end: number }>): string {
  return ranges.map((r) => (r.start === r.end ? String(r.start) : `${r.start}–${r.end}`)).join(', ')
}
