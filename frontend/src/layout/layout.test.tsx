import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { NAV_ITEMS, PanelSlot, appRoutes, registerPanel } from './index'
import { clearPanels } from './slots'

function renderAt(path: string) {
  return render(<RouterProvider router={createMemoryRouter(appRoutes, { initialEntries: [path] })} />)
}

beforeEach(() => {
  clearPanels()
  localStorage.clear()
  // Explorer fetches the sample manifest; stub it so tests never hit the network.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }))
})
afterEach(() => vi.unstubAllGlobals())

describe('PanelSlot', () => {
  it('shows a placeholder naming the slot when nothing is registered', () => {
    render(<PanelSlot name="right" />)
    expect(screen.getByText(/No panel registered for slot/)).toHaveTextContent('right')
  })

  it('renders registered panels in order', () => {
    registerPanel({ id: 'b', slot: 'right', order: 2, component: () => <p>second</p> })
    registerPanel({ id: 'a', slot: 'right', order: 1, component: () => <p>first</p> })
    render(<PanelSlot name="right" />)
    const texts = screen.getAllByText(/first|second/).map((n) => n.textContent)
    expect(texts).toEqual(['first', 'second'])
  })

  it('isolates a crashing panel so siblings keep rendering', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    registerPanel({ id: 'bad', slot: 'right', order: 1, component: () => { throw new Error('boom') } })
    registerPanel({ id: 'good', slot: 'right', order: 2, component: () => <p>still here</p> })
    render(<PanelSlot name="right" />)
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
    expect(screen.getByText('still here')).toBeInTheDocument()
  })

  it('replaces a registration with the same id and supports unregistering', () => {
    const off = registerPanel({ id: 'x', slot: 'right', component: () => <p>v1</p> })
    registerPanel({ id: 'x', slot: 'right', component: () => <p>v2</p> })
    const { rerender } = render(<PanelSlot name="right" />)
    expect(screen.queryByText('v1')).not.toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()
    off() // already replaced: must not remove v2
    rerender(<PanelSlot name="right" />)
    expect(screen.getByText('v2')).toBeInTheDocument()
  })
})

describe('AppShell + routes', () => {
  it('lists all eight sections in the left sidebar', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Dashboard',
      'Protein Explorer',
      'Design Workspace',
      'Candidate Library',
      'Structural Analysis',
      'Comparison',
      'Experiment History',
      'Settings',
    ])
    expect(NAV_ITEMS).toHaveLength(8)
  })

  it('mounts panels registered for a route main slot and for the right sidebar', () => {
    registerPanel({ id: 'hist', slot: 'history.main', component: () => <p>history panel</p> })
    registerPanel({ id: 'side', slot: 'right', component: () => <p>side panel</p> })
    renderAt('/history')
    expect(screen.getByRole('heading', { name: 'Experiment History' })).toBeInTheDocument()
    expect(screen.getByText('history panel')).toBeInTheDocument()
    expect(screen.getByText('side panel')).toBeInTheDocument()
  })

  it('collapses and expands the right sidebar', async () => {
    renderAt('/')
    const aside = document.getElementById('right-sidebar')!
    expect(aside).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: /collapse right sidebar/i }))
    expect(aside).not.toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: /expand right sidebar/i }))
    expect(aside).toBeVisible()
  })

  it('falls back to the dashboard for unknown paths', () => {
    renderAt('/nope')
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
  })
})
