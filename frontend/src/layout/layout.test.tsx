import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { fixtures } from '@/api/fixtures'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { NAV_ITEMS, PanelSlot, appRoutes, registerPanel } from './index'
import { clearPanels } from './slots'

function renderAt(path: string) {
  return render(<RouterProvider router={createMemoryRouter(appRoutes, { initialEntries: [path] })} />)
}

beforeEach(() => {
  clearPanels()
  localStorage.clear()
  // The shell reports whether the backend answers, so every test gives it one that does.
  installFetch(fixtureRoutes())
})

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

  it('keeps the research-tool caveat in the shell on every page', () => {
    renderAt('/settings')
    expect(screen.getByText('Research review tool. Not a clinical tool. Confidence scores are model estimates, not validation.')).toBeInTheDocument()
  })

  it('mounts panels registered for a route main slot and for the right sidebar', () => {
    registerPanel({ id: 'hist', slot: 'history.main', component: () => <p>history panel</p> })
    registerPanel({ id: 'side', slot: 'right', component: () => <p>side panel</p> })
    renderAt('/history')
    expect(screen.getByRole('heading', { name: 'Experiment History' })).toBeInTheDocument()
    expect(screen.getByText('history panel')).toBeInTheDocument()
    expect(screen.getByText('side panel')).toBeInTheDocument()
  })

  it('gives the Protein Explorer a main slot and a slot below it', () => {
    registerPanel({ id: 'view', slot: 'explorer.main', component: () => <p>viewer panel</p> })
    registerPanel({ id: 'under', slot: 'explorer.below', component: () => <p>panel below</p> })
    renderAt('/explorer')
    expect(screen.getByRole('heading', { name: 'Protein Explorer' })).toBeInTheDocument()
    const order = screen.getAllByText(/viewer panel|panel below/).map((n) => n.textContent)
    expect(order).toEqual(['viewer panel', 'panel below'])
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

describe('backend status in the shell', () => {
  it('says the backend is connected and how much it holds', async () => {
    renderAt('/')
    await screen.findByText(`Connected: ${fixtures.structures.length} structures, ${fixtures.experiments.length} experiments`)
  })

  it('says when the backend is connected but empty', async () => {
    installFetch(fixtureRoutes({ 'GET /structures': [], 'GET /experiments': [] }))
    renderAt('/')
    await screen.findByText('Connected. Nothing loaded yet')
  })

  it('says how to start the backend when it does not answer, and recovers on reload', async () => {
    let up = false
    const net = installFetch(fixtureRoutes({
      'GET /structures': () => (up ? fixtures.structures : { status: 502, body: { detail: 'connection refused' } }),
      'GET /experiments': () => (up ? fixtures.experiments : { status: 502, body: { detail: 'connection refused' } }),
    }))
    renderAt('/')
    const status = await screen.findByText(/Backend not reachable/)
    expect(status).toHaveTextContent('start it with ./run.sh in backend/, then reload.')

    up = true
    const before = net.callsTo('GET /structures').length
    await userEvent.click(screen.getByRole('button', { name: 'Reload structures and experiments' }))
    await screen.findByText(/^Connected:/)
    await waitFor(() => expect(net.callsTo('GET /structures').length).toBe(before + 1))
  })
})
