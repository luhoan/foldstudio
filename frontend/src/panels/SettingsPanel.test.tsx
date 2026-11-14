import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SettingsPanel } from './SettingsPanel'

vi.mock('@/api', () => ({
  API_BASE_URL: '/api',
  USE_MOCKS: false,
  listExperiments: vi.fn(),
  listStructures: vi.fn(),
}))
import * as api from '@/api'

describe('SettingsPanel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports a reachable backend with what it found', async () => {
    vi.mocked(api.listExperiments).mockResolvedValue([{ id: 'a' }] as never)
    vi.mocked(api.listStructures).mockResolvedValue([{ id: 's' }, { id: 't' }] as never)
    render(<SettingsPanel />)
    expect(await screen.findByText(/reachable — 1 experiment\(s\), 2 structure\(s\)/)).toBeInTheDocument()
  })

  it('reports an unreachable backend and how to start it', async () => {
    vi.mocked(api.listExperiments).mockRejectedValue(new Error('connection refused'))
    vi.mocked(api.listStructures).mockRejectedValue(new Error('connection refused'))
    render(<SettingsPanel />)
    expect(await screen.findByText(/unreachable — connection refused/)).toBeInTheDocument()
    expect(screen.getByText(/run\.sh/)).toBeInTheDocument()
  })

  it('re-checks on demand', async () => {
    vi.mocked(api.listExperiments).mockRejectedValue(new Error('down'))
    vi.mocked(api.listStructures).mockRejectedValue(new Error('down'))
    render(<SettingsPanel />)
    expect(await screen.findByText(/unreachable/)).toBeInTheDocument()

    vi.mocked(api.listExperiments).mockResolvedValue([] as never)
    vi.mocked(api.listStructures).mockResolvedValue([] as never)
    fireEvent.click(screen.getByRole('button', { name: 'Re-check connection' }))
    expect(await screen.findByText(/reachable — 0 experiment\(s\), 0 structure\(s\)/)).toBeInTheDocument()
  })

  it('shows the configured API base and mock mode', async () => {
    vi.mocked(api.listExperiments).mockResolvedValue([] as never)
    vi.mocked(api.listStructures).mockResolvedValue([] as never)
    render(<SettingsPanel />)
    expect(await screen.findByText('API base URL')).toBeInTheDocument()
    expect(screen.getByText('off')).toBeInTheDocument()
  })
})
