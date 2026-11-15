import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { resetLibrary } from '@/panels/library'
import { resetPanelState } from '@/panels/panelState'
import { resetViewerStore } from '@/viewer/store'

// Module-level stores outlive a component, so each test starts from a clean slate.
afterEach(() => {
  cleanup()
  resetLibrary()
  resetPanelState()
  resetViewerStore()
  vi.unstubAllGlobals()
})
