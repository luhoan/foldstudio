import { useEffect, useSyncExternalStore } from 'react'
import { listExperiments, listStructures } from '@/api'
import type { Experiment, Structure } from '@/api'
import { clearDetailCache } from './details'
import { errorMessage } from './format'

/**
 * The structures and experiments the backend currently holds, loaded once and shared by every
 * panel. Before this, each panel fetched its own copy on mount, so the sidebar could show a
 * different list from the page next to it and a new upload appeared in one place but not another.
 */
export interface Library {
  status: 'idle' | 'loading' | 'ready'
  structures: Structure[]
  experiments: Experiment[]
  /** Set when a list could not be loaded. Whatever did load is still shown. */
  error: string | null
}

const EMPTY: Library = { status: 'idle', structures: [], experiments: [], error: null }

let state: Library = EMPTY
let generation = 0
const listeners = new Set<() => void>()

function set(next: Library) {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Load both lists again. Safe to call at any time; only the newest request is applied. */
export function refreshLibrary(): Promise<void> {
  const mine = ++generation
  clearDetailCache()
  if (state.status === 'idle') set({ ...state, status: 'loading' })
  return Promise.allSettled([listStructures(), listExperiments()]).then(([structures, experiments]) => {
    if (mine !== generation) return
    const problems: string[] = []
    if (structures.status === 'rejected') problems.push(`Structures: ${errorMessage(structures.reason, 'could not be loaded')}`)
    if (experiments.status === 'rejected') problems.push(`Experiments: ${errorMessage(experiments.reason, 'could not be loaded')}`)
    set({
      status: 'ready',
      structures: structures.status === 'fulfilled' ? structures.value : state.structures,
      experiments: experiments.status === 'fulfilled' ? experiments.value : state.experiments,
      error: problems.length ? problems.join(' · ') : null,
    })
  })
}

export function useLibrary(): Library {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => state)
  useEffect(() => {
    if (state.status === 'idle') void refreshLibrary()
  }, [])
  return snapshot
}

export function getLibrary(): Library {
  return state
}

/** Tests only: forget everything, and ignore any response still in flight. */
export function resetLibrary() {
  generation++
  clearDetailCache()
  set(EMPTY)
}
