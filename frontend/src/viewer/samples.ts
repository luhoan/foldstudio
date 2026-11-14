import { useEffect, useState } from 'react'
import type { StructureFormat } from './adapter'

export interface SampleEntry {
  file: string
  url: string
  format: StructureFormat
}

/**
 * Real structure files the team dropped into frontend/public/samples/ (listed by a Vite plugin
 * at /samples/manifest.json). Used only until the backend's /api/structures exists.
 */
export function useSampleStructures() {
  const [state, setState] = useState<{ samples: SampleEntry[]; loading: boolean; error: string | null }>({
    samples: [],
    loading: true,
    error: null,
  })
  useEffect(() => {
    const ctl = new AbortController()
    fetch('/samples/manifest.json', { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const json: unknown = await r.json()
        if (!Array.isArray(json)) throw new Error('manifest is not a list')
        setState({ samples: json as SampleEntry[], loading: false, error: null })
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return
        setState({ samples: [], loading: false, error: e instanceof Error ? e.message : String(e) })
      })
    return () => ctl.abort()
  }, [])
  return state
}
