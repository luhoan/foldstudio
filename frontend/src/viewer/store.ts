import { useSyncExternalStore } from 'react'
import type { StructureFormat, ViewerAdapter } from './adapter'

/** What the viewer should show. Stream 5 panels call viewerActions.setStructure(...). */
export interface StructureSource {
  url: string
  format: StructureFormat
  label?: string
  /** From the Structure contract; drives the pLDDT-vs-B-factor caveat. */
  source?: 'experimental' | 'predicted' | 'uploaded'
}

interface ViewerState {
  structure: StructureSource | null
  /** Set by ViewerPanel once its adapter is ready; null otherwise. */
  adapter: ViewerAdapter | null
}

let state: ViewerState = { structure: null, adapter: null }
const listeners = new Set<() => void>()

function set(patch: Partial<ViewerState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export const viewerActions = {
  setStructure: (structure: StructureSource | null) => set({ structure }),
  setAdapter: (adapter: ViewerAdapter | null) => set({ adapter }),
}

export function getViewerState() {
  return state
}

export function useViewerState(): ViewerState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
}

/** Test helper. */
export function resetViewerStore() {
  state = { structure: null, adapter: null }
  listeners.forEach((l) => l())
}
