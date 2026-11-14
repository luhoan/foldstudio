import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PAEHeatmap } from './PAEHeatmap'
import { ApiError } from '@/api'

vi.mock('@/api', () => ({
  ApiError: class ApiError extends Error { status: number; detail: string; constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail } },
  listStructures: vi.fn(),
  getPae: vi.fn(),
}))
import * as api from '@/api'

describe('PAEHeatmap', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the explicit unavailable state', async () => {
    vi.mocked(api.listStructures).mockResolvedValue([{ id: 's1', label: 'S1' }] as never)
    vi.mocked(api.getPae).mockRejectedValue(new ApiError(404, 'pae_unavailable'))
    render(<PAEHeatmap structureId="s1" />)
    expect(await screen.findByText('PAE not available for this model.')).toBeInTheDocument()
  })

  it('shows a recoverable error for other failures', async () => {
    vi.mocked(api.listStructures).mockResolvedValue([{ id: 's1', label: 'S1' }] as never)
    vi.mocked(api.getPae).mockRejectedValue(new Error('network unavailable'))
    render(<PAEHeatmap structureId="s1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('network unavailable')
  })
})
