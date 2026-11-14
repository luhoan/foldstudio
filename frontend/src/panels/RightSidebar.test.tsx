import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { RightSidebar } from './RightSidebar'

vi.mock('@/api', () => ({
  listStructures: vi.fn(),
  listExperiments: vi.fn(),
  getPlddt: vi.fn(),
  getResidues: vi.fn(),
  getExplanation: vi.fn(),
}))

import * as api from '@/api'

const structure = {
  id: 's1', label: 'Test structure', source: 'uploaded', origin_id: 'local',
  format: 'pdb', sha256: 'abc', chains: ['A'], n_residues: 2,
}
const experiment = {
  id: 'e1', created_at: '2026-01-01T00:00:00Z', kind: 'imported', status: 'ok',
  model_name: 'Imported model', model_version: '1', settings: {}, inputs: ['s1'], outputs: ['s1'],
  metrics: {}, error: null, provenance: { source: 'Public import', retrieved_at: '2026-01-01T00:00:00Z', url: null, notes: 'Imported fixture' },
}

describe('RightSidebar', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the empty structure state', async () => {
    vi.mocked(api.listStructures).mockResolvedValue([])
    vi.mocked(api.listExperiments).mockResolvedValue([])
    render(<RightSidebar />)
    expect(await screen.findByText(/No structures loaded/)).toBeInTheDocument()
  })

  it('renders a loading error instead of crashing', async () => {
    vi.mocked(api.listStructures).mockRejectedValue(new Error('backend offline'))
    vi.mocked(api.listExperiments).mockResolvedValue([])
    render(<RightSidebar />)
    expect(await screen.findByRole('alert')).toHaveTextContent('backend offline')
  })

  it('renders confidence, residue and provenance panels', async () => {
    vi.mocked(api.listStructures).mockResolvedValue([structure] as never)
    vi.mocked(api.listExperiments).mockResolvedValue([experiment] as never)
    vi.mocked(api.getPlddt).mockResolvedValue({ structure_id: 's1', residues: [{ chain: 'A', seq_id: 1, plddt: 90 }] })
    vi.mocked(api.getResidues).mockResolvedValue({ structure_id: 's1', residues: [] })
    vi.mocked(api.getExplanation).mockResolvedValue({
      structure_id: 's1', chain: 'A', start: 1, end: 1, summary: 'Fixture explanation',
      numbers_used: { mean_plddt: 90 },
    })
    render(<RightSidebar />)
    expect(await screen.findByText('Confidence (pLDDT)')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Fixture explanation')).toBeInTheDocument())
    expect(screen.getByText('Imported model')).toBeInTheDocument()
  })
})

describe('RightSidebar partial detail availability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('retains available confidence data when the explanation endpoint fails', async () => {
    vi.mocked(api.listStructures).mockResolvedValue([structure] as never)
    vi.mocked(api.listExperiments).mockResolvedValue([experiment] as never)
    vi.mocked(api.getPlddt).mockResolvedValue({ structure_id: 's1', residues: [{ chain: 'A', seq_id: 1, plddt: 90 }] })
    vi.mocked(api.getResidues).mockResolvedValue({ structure_id: 's1', residues: [] })
    vi.mocked(api.getExplanation).mockRejectedValue(new Error('explanation unavailable'))
    render(<RightSidebar />)
    expect((await screen.findAllByText(/explanation unavailable/)).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('pLDDT histogram')).toBeInTheDocument()
  })
})
