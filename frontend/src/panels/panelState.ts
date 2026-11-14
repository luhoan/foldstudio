import { useSyncExternalStore } from 'react'
import type { ResidueClickEvent } from '@/viewer/adapter'

export interface SelectedResidue {
  structureId: string
  chain: string
  seqId: number
  insCode?: string
  compId?: string
}

interface PanelSelectionSnapshot {
  activeStructureId: string | null
  selectedResidue: SelectedResidue | null
}

let snapshot: PanelSelectionSnapshot = {
  activeStructureId: null,
  selectedResidue: null,
}
const listeners = new Set<() => void>()

function publish(next: PanelSelectionSnapshot) {
  snapshot = next
  listeners.forEach((listener) => listener())
}

export function setActiveStructure(id: string | null) {
  if (snapshot.activeStructureId === id) return
  publish({ ...snapshot, activeStructureId: id })
}

export function setSelectedResidue(value: SelectedResidue | null) {
  publish({ ...snapshot, selectedResidue: value })
}

export function selectFromViewer(structureId: string, event: ResidueClickEvent) {
  publish({
    activeStructureId: structureId,
    selectedResidue: {
      structureId,
      chain: event.chain,
      seqId: event.seqId,
      insCode: event.insCode,
      compId: event.compId,
    },
  })
}

export function usePanelSelection() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
    () => snapshot,
  )
}
