import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ExperimentHistory } from './ExperimentHistory'

vi.mock('@/api', () => ({ listExperiments: vi.fn(), getReports: vi.fn() }))
import * as api from '@/api'

describe('ExperimentHistory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the empty state', async () => {
    vi.mocked(api.listExperiments).mockResolvedValue([])
    render(<ExperimentHistory />)
    expect(await screen.findByText('No experiments match these filters.')).toBeInTheDocument()
  })

  it('shows API errors', async () => {
    vi.mocked(api.listExperiments).mockRejectedValue(new Error('history unavailable'))
    render(<ExperimentHistory />)
    expect(await screen.findByRole('alert')).toHaveTextContent('history unavailable')
  })

  it('filters by kind', async () => {
    vi.mocked(api.listExperiments).mockResolvedValue([
      { id: 'e1', created_at: '2026-01-01', kind: 'demo', status: 'partial', model_name: 'Demo model', model_version: 'x', settings: {}, inputs: [], outputs: [], metrics: {}, error: null, provenance: { source: 'fixture', retrieved_at: '2026-01-01', url: null, notes: 'demo' } },
      { id: 'e2', created_at: '2026-01-01', kind: 'imported', status: 'ok', model_name: 'Imported model', model_version: 'x', settings: {}, inputs: [], outputs: [], metrics: {}, error: null, provenance: { source: 'public', retrieved_at: '2026-01-01', url: null, notes: 'imported' } },
    ] as never)
    render(<ExperimentHistory />)
    expect(await screen.findByText('Demo model')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'imported' } })
    expect(screen.getByText('Imported model')).toBeInTheDocument()
    expect(screen.queryByText('Demo model')).not.toBeInTheDocument()
  })
})
