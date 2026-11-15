import type { ResidueRange } from '@/viewer'

/** Addresses of the app's own pages, built in one place so panels and tests agree on them. */

export interface Highlight {
  chain: string
  ranges: ResidueRange[]
}

function rangesText(ranges: ResidueRange[]): string {
  return ranges.map((r) => (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`)).join(',')
}

/** "12-40,55" (author residue numbers; negatives allowed, as in "-3--1") back into ranges. */
export function parseRanges(text: string | null): ResidueRange[] {
  if (!text) return []
  return text.split(',').flatMap((part): ResidueRange[] => {
    const match = /^(-?\d+)(?:-(-?\d+))?$/.exec(part.trim())
    if (!match) return []
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    return start <= end ? [{ start, end }] : []
  })
}

export function parseHighlight(params: URLSearchParams): Highlight | null {
  const chain = params.get('chain')
  const ranges = parseRanges(params.get('ranges'))
  return chain && ranges.length > 0 ? { chain, ranges } : null
}

/** The Protein Explorer showing one structure, optionally with residues of one chain highlighted. */
export function explorerLink(structureId: string, highlight?: Highlight): string {
  const params = new URLSearchParams({ structure: structureId })
  if (highlight && highlight.ranges.length > 0) {
    params.set('chain', highlight.chain)
    params.set('ranges', rangesText(highlight.ranges))
  }
  return `/explorer?${params}`
}

/** Structural Analysis with both structures already chosen. */
export function analysisLink(mobileId: string, referenceId: string): string {
  return `/analysis?${new URLSearchParams({ mobile: mobileId, reference: referenceId })}`
}

export function historyLink(experimentId: string): string {
  return `/history?${new URLSearchParams({ experiment: experimentId })}`
}

export function designLink(experimentId: string): string {
  return `/design?${new URLSearchParams({ run: experimentId })}`
}

export function libraryLink(structureId: string): string {
  return `/library?${new URLSearchParams({ structure: structureId })}`
}
