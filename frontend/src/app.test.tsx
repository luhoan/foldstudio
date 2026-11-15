import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'
import { NAV_ITEMS, appRoutes, loadPanelRegistrations } from '@/layout'
import { fakeAdapter } from '@/test/fakeViewer'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'

/**
 * The whole app, as main.tsx assembles it, against the captured backend responses.
 *
 * Each panel has its own tests; this checks the assembly: every page has its panel registered,
 * no panel crashes, and no page asks the backend for something it does not serve (an unmatched
 * route answers 404 here, exactly as a path the backend lacks would).
 */
const viewer = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof import('@/test/fakeViewer').fakeAdapter> }))
vi.mock('@/viewer/createAdapter', () => ({ createViewerAdapter: async () => viewer.current.adapter }))

function renderAt(path: string) {
  return render(<RouterProvider router={createMemoryRouter(appRoutes, { initialEntries: [path] })} />)
}

async function settled(net: ReturnType<typeof installFetch>) {
  // Wait until the page has stopped issuing requests.
  let seen = -1
  await waitFor(() => {
    const now = net.calls.length
    const stable = now === seen
    seen = now
    expect(stable).toBe(true)
  }, { timeout: 4000, interval: 150 })
}

beforeEach(() => {
  viewer.current = fakeAdapter()
  loadPanelRegistrations()
  localStorage.clear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => undefined,
  })) as never)
})

describe('the assembled app', () => {
  const pages: Array<[string, string]> = [
    ...NAV_ITEMS.map((item): [string, string] => [item.label, item.path]),
    ['Protein Explorer with a predicted model and a highlight', `/explorer?structure=${fixtureIds.predicted}&chain=A&ranges=2-5`],
    ['Design Workspace on a named run', `/design?run=${fixtureIds.pipelineRun}`],
    ['Candidate Library on a named complex', `/library?structure=${fixtureIds.complex}`],
    ['Structural Analysis from a link', `/analysis?mobile=${fixtureIds.design}&reference=${fixtureIds.backbone}`],
    ['Comparison from a link', `/comparison?ids=${fixtures.compare.ids.join(',')}`],
    ['Experiment History with a record open', `/history?experiment=${fixtureIds.pipelineRun}`],
  ]

  it.each(pages)('%s renders with real panels and only asks for what the backend serves', async (_name, path) => {
    const net = installFetch(fixtureRoutes({ 'GET /samples/manifest.json': [] }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderAt(path)

    await screen.findByText(/^Connected:/)
    await settled(net)

    expect(net.unmatched).toEqual([])
    expect(document.querySelector('[data-slot-empty]')).toBeNull()
    expect(screen.queryByText(/failed to render/)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('[object Object]')
    expect(document.body.textContent).not.toContain('undefined')
    expect(document.body.textContent).not.toContain('NaN')
    // React reports a crash or an invalid render through console.error.
    expect(errors.mock.calls.map((call) => String(call[0]).slice(0, 200))).toEqual([])
  })

  it('registers exactly one main panel per page, plus the Explorer\'s extras and the sidebar', () => {
    const net = installFetch(fixtureRoutes({ 'GET /samples/manifest.json': [] }))
    renderAt('/explorer')
    const ids = [...document.querySelectorAll('[data-panel-id]')].map((el) => el.getAttribute('data-panel-id'))
    expect(ids).toEqual(['structure-explorer', 'sequence', 'pae', 'structure-details'])
    expect(net.unmatched).toEqual([])
  })
})
