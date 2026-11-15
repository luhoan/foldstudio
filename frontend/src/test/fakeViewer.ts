import { vi } from 'vitest'
import type { ResidueClickEvent, ViewerAdapter } from '@/viewer/adapter'

/**
 * A ViewerAdapter that records calls instead of drawing. jsdom has no WebGL, so panels that embed
 * the 3D viewer are tested against this, the same way ViewerPanel's own tests are.
 */
export function fakeAdapter(overrides: Partial<ViewerAdapter> = {}) {
  const clickHandlers: Array<(e: ResidueClickEvent) => void> = []
  const mocks = {
    init: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
    loadSecond: vi.fn().mockResolvedValue(undefined),
    unloadSecond: vi.fn().mockResolvedValue(undefined),
    setRepresentation: vi.fn().mockResolvedValue(undefined),
    colorBy: vi.fn().mockResolvedValue(undefined),
    highlightResidues: vi.fn(),
    selectChain: vi.fn(),
    clearHighlight: vi.fn(),
    resetCamera: vi.fn(),
    setCamera: vi.fn(),
    getCamera: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/png' })),
    onResidueClick: vi.fn((cb: (e: ResidueClickEvent) => void) => {
      clickHandlers.push(cb)
      return () => undefined
    }),
    dispose: vi.fn(),
  } satisfies ViewerAdapter
  const adapter: ViewerAdapter = { ...mocks, ...overrides }
  return {
    adapter,
    mocks,
    /** Simulate a click on a residue in the 3D view. */
    click: (event: ResidueClickEvent) => clickHandlers.forEach((handler) => handler(event)),
  }
}
