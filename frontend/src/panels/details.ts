import { getExplanation, getInterfaces, getPae, getPlddt, getResidues } from '@/api'
import type { ExplainResponse, InterfacesResponse, PaeResponse, PlddtResponse, ResiduesResponse, Structure } from '@/api'
import { useAsync, type Async } from './useAsync'

/**
 * Per-structure data that several panels show at once (the sidebar, the sequence strip and the
 * PAE panel all want the same residues). Identical requests are shared, and a failed request is
 * not remembered, so the next mount tries again.
 */
const cache = new Map<string, Promise<unknown>>()

function shared<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Promise<T> | undefined
  if (hit) return hit
  const request = load()
  cache.set(key, request)
  request.catch(() => {
    if (cache.get(key) === request) cache.delete(key)
  })
  return request
}

/** Forget everything, e.g. after the library changed or between tests. */
export function clearDetailCache() {
  cache.clear()
}

export function useResidues(structureId: string | null): Async<ResiduesResponse> {
  const key = structureId ? `residues:${structureId}` : null
  return useAsync(key, () => shared(key!, () => getResidues(structureId!)))
}

/**
 * pLDDT of a structure. Only asked for when the structure is declared predicted: for anything
 * else the backend refuses (409), and there is no point sending a request to be told so.
 */
export function usePlddt(structure: Pick<Structure, 'id' | 'source' | 'format'> | null): Async<PlddtResponse> {
  const key = structure && structure.source === 'predicted' && structure.format !== 'fasta' ? `plddt:${structure.id}` : null
  return useAsync(key, () => shared(key!, () => getPlddt(structure!.id)))
}

export function usePae(structure: Pick<Structure, 'id' | 'has_pae'> | null, revision = 0): Async<PaeResponse> {
  const key = structure && structure.has_pae ? `pae:${structure.id}:${revision}` : null
  return useAsync(key, () => shared(key!, () => getPae(structure!.id)))
}

/**
 * The rule-based explanation of a structure. With no region the backend describes the first chain
 * from end to end; a region narrows it to one chain, or to a residue range within it.
 */
export function useExplanation(
  structureId: string | null,
  region?: { chain: string; start?: number; end?: number } | null,
): Async<ExplainResponse> {
  const key = structureId
    ? `explain:${structureId}:${region ? `${region.chain}:${region.start ?? ''}:${region.end ?? ''}` : ''}`
    : null
  return useAsync(key, () => shared(key!, () => getExplanation({ structure: structureId!, ...(region ?? {}) })))
}

export function useInterfaces(structureId: string | null, cutoff?: number): Async<InterfacesResponse> {
  const key = structureId ? `interfaces:${structureId}:${cutoff ?? 'default'}` : null
  return useAsync(key, () => shared(key!, () => getInterfaces(structureId!, cutoff)))
}
