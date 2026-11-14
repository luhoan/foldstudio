import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Dashboard } from './Dashboard'

vi.mock('@/api', () => ({ listExperiments: vi.fn(), listStructures: vi.fn() }))
import * as api from '@/api'

function experiment(id: string, kind: string, status = 'ok', extra: Record<string, unknown> = {}) {
  return {
    id, created_at: '2026-01-01T00:00:00Z', kind, status,
    model_name: `model-${id}`, model_version: '1', settings: {}, inputs: [], outputs: [],
    metrics: {}, error: null,
    provenance: { source: 's', retrieved_at: '2026-01-01T00:00:00Z', url: null, notes: 'n' },
    ...extra,
  }
}

function structure(id: string, source: string) {
  return { id, label: id, source, origin_id: id, format: 'pdb', sha256: 'x', chains: [], n_residues: 1 }
}

/** Read the number rendered under a tile caption, scoped to one section. */
function tile(sectionHeading: string, label: string) {
  const heading = screen.getByText(sectionHeading)
  const section = heading.parentElement as HTMLElement
  const dt = within(section).getByText(label)
  return dt.parentElement?.querySelector('dd')?.textContent
}

describe('Dashboard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('tells you what to do when nothing is loaded', async () => {
    vi.mocked(api.listExperiments).mockResolvedValue([])
    vi.mocked(api.listStructures).mockResolvedValue([])
    render(<Dashboard />)
    expect(await screen.findByText(/Nothing is loaded yet/)).toBeInTheDocument()
  })

  it('surfaces an unreachable backend instead of rendering zeroes as fact', async () => {
    vi.mocked(api.listExperiments).mockRejectedValue(new Error('connection refused'))
    vi.mocked(api.listStructures).mockResolvedValue([])
    render(<Dashboard />)
    expect(await screen.findByRole('alert')).toHaveTextContent('connection refused')
  })

  it('counts experiments by provenance kind', async () => {
    vi.mocked(api.listExperiments).mockResolvedValue([
      experiment('a', 'imported'), experiment('b', 'imported'), experiment('c', 'executed'),
    ] as never)
    vi.mocked(api.listStructures).mockResolvedValue([])
    render(<Dashboard />)
    expect(await screen.findByText('Experiments by provenance')).toBeInTheDocument()
    expect(tile('Experiments by provenance', 'imported')).toBe('2')
    expect(tile('Experiments by provenance', 'executed')).toBe('1')
    // A kind with no records reads zero rather than being hidden.
    expect(tile('Experiments by provenance', 'demo')).toBe('0')
  })

  it('counts structures by source', async () => {
    vi.mocked(api.listExperiments).mockResolvedValue([])
    vi.mocked(api.listStructures).mockResolvedValue([
      structure('s1', 'predicted'), structure('s2', 'experimental'), structure('s3', 'experimental'),
    ] as never)
    render(<Dashboard />)
    expect(await screen.findByText('Structures by source')).toBeInTheDocument()
    expect(tile('Structures by source', 'predicted')).toBe('1')
    expect(tile('Structures by source', 'experimental')).toBe('2')
    expect(tile('Structures by source', 'uploaded')).toBe('0')
  })

  it('calls out failed and partial runs with their recorded error', async () => {
    vi.mocked(api.listExperiments).mockResolvedValue([
      experiment('good', 'executed', 'ok'),
      experiment('bad', 'executed', 'partial', { error: 'predict stage died' }),
    ] as never)
    vi.mocked(api.listStructures).mockResolvedValue([])
    render(<Dashboard />)
    expect(await screen.findByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText(/predict stage died/)).toBeInTheDocument()
  })

  it('does not show the attention block when every run is ok', async () => {
    vi.mocked(api.listExperiments).mockResolvedValue([experiment('good', 'executed', 'ok')] as never)
    vi.mocked(api.listStructures).mockResolvedValue([])
    render(<Dashboard />)
    expect(await screen.findByText('Most recent')).toBeInTheDocument()
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument()
  })
})
