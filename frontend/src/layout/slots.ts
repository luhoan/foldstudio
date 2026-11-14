import type { ComponentType } from 'react'
import { useSyncExternalStore } from 'react'
import type { RouteId } from './nav'

/**
 * Named slots. Every route exposes `<routeId>.main`; the Protein Explorer also exposes
 * `explorer.below` (under the viewer); `right` is the collapsible right sidebar on every route.
 * Stream 5 registers panels into these by name; it never edits layout/ or main.tsx.
 */
export type SlotName = `${RouteId}.main` | 'explorer.below' | 'right'

export const RIGHT_SLOT: SlotName = 'right'

export interface PanelRegistration {
  /** Unique id; re-registering the same id replaces the earlier registration (HMR-safe). */
  id: string
  slot: SlotName
  title?: string
  /** Ascending; default 100. */
  order?: number
  component: ComponentType
}

let panels: readonly PanelRegistration[] = []
const listeners = new Set<() => void>()

function emit(next: readonly PanelRegistration[]) {
  panels = next
  listeners.forEach((l) => l())
}

export function registerPanel(reg: PanelRegistration): () => void {
  emit([...panels.filter((p) => p.id !== reg.id), reg])
  return () => emit(panels.filter((p) => p !== reg))
}

export function getPanels(slot: SlotName): PanelRegistration[] {
  return panels.filter((p) => p.slot === slot).sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

export function usePanels(slot: SlotName): PanelRegistration[] {
  const all = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => panels,
  )
  return all.filter((p) => p.slot === slot).sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

/** Test helper. */
export function clearPanels() {
  emit([])
}
