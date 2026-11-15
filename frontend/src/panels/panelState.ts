import { useSyncExternalStore } from 'react'
import type { ResidueClickEvent } from '@/viewer'

/**
 * What the panels around the viewer need to agree on: which structure is active, and which residue
 * (if any) is selected. The Protein Explorer sets it from its picker and from clicks in the 3D
 * view; the sidebar, the sequence strip and the PAE panel read it.
 *
 * The Explorer can also show a local sample file that is not in the library. That is recorded
 * here too (`sampleUrl`), in the same update that clears the active structure, so no panel ever
 * sees a half-made choice.
 */

export interface SelectedResidue {
  structureId: string
  chain: string
  seqId: number
  insCode?: string
  compId?: string
}

interface PanelState {
  activeStructureId: string | null
  selectedResidue: SelectedResidue | null
  /** A file from frontend/public/samples/ on screen in the Explorer; set only while nothing is active. */
  sampleUrl: string | null
}

const INITIAL: PanelState = { activeStructureId: null, selectedResidue: null, sampleUrl: null }

let state: PanelState = INITIAL
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePanelState(): PanelState {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

export function getPanelState(): PanelState {
  return state
}

export function setActiveStructure(id: string) {
  if (state.activeStructureId === id) return
  state = { activeStructureId: id, selectedResidue: null, sampleUrl: null }
  emit()
}

/** Show a local sample file in the Explorer. No library structure is active while it is on screen. */
export function showSample(url: string) {
  if (state.sampleUrl === url && state.activeStructureId === null) return
  state = { activeStructureId: null, selectedResidue: null, sampleUrl: url }
  emit()
}

export function setSelectedResidue(residue: SelectedResidue | null) {
  state = { ...state, selectedResidue: residue }
  emit()
}

/** A residue was clicked in the 3D view of `structureId`. */
export function selectFromViewer(structureId: string, event: ResidueClickEvent) {
  state = {
    activeStructureId: structureId,
    sampleUrl: null,
    selectedResidue: {
      structureId,
      chain: event.chain,
      seqId: event.seqId,
      insCode: event.insCode.trim() || undefined,
      compId: event.compId,
    },
  }
  emit()
}

/** Tests only: back to the initial state. */
export function resetPanelState() {
  state = INITIAL
  emit()
}
