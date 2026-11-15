import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'
import { fakeAdapter } from '@/test/fakeViewer'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { CandidateLibrary } from './CandidateLibrary'
import { getPanelState } from './panelState'

const viewer = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof import('@/test/fakeViewer').fakeAdapter> }))
vi.mock('@/viewer/createAdapter', () => ({ createViewerAdapter: async () => viewer.current.adapter }))

const complex = fixtures.structures.find((s) => s.id === fixtureIds.complex)!
const item = fixtures.interfaces.interfaces[0]

beforeEach(() => {
  viewer.current = fakeAdapter()
})

describe('CandidateLibrary (interface review)', () => {
  it('lists only multi-chain structures and reviews the first one', async () => {
    const net = installFetch(fixtureRoutes())
    renderPanel(<CandidateLibrary />, '/library')

    const pick = await screen.findByRole('button', { name: new RegExp(complex.label.replace(/[()]/g, '\\$&')) })
    expect(pick).toHaveAttribute('aria-pressed', 'true')
    for (const single of fixtures.structures.filter((s) => s.chains.length < 2)) {
      expect(screen.queryByRole('button', { name: new RegExp(single.label.replace(/[()]/g, '\\$&')) })).not.toBeInTheDocument()
    }
    await waitFor(() => expect(net.callsTo(`GET /structures/${complex.id}/interfaces`)).toHaveLength(1))
    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenCalledWith(`/api/structures/${complex.id}/file`, 'pdb'))
    // The sidebar describes the complex being reviewed.
    expect(getPanelState().activeStructureId).toBe(complex.id)
  })

  it('shows each interface as the backend computed it: pair count, residues per side and its sentence', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<CandidateLibrary />, '/library')

    const heading = await screen.findByRole('heading', { name: `Chain ${item.chain_a} with chain ${item.chain_b}` })
    const row = within(heading.closest('li') as HTMLElement)
    expect(row.getByText(`${item.n_residue_pairs} residue pairs in contact`)).toBeInTheDocument()
    expect(row.getByText(`Chain ${item.chain_a}, ${item.n_residues_a} residues`)).toBeInTheDocument()
    expect(row.getByText(`Chain ${item.chain_b}, ${item.n_residues_b} residues`)).toBeInTheDocument()
    expect(row.getByText(`${item.ranges_a[0].start}–${item.ranges_a[0].end}`)).toBeInTheDocument()
    expect(row.getByText(item.explanation.text)).toBeInTheDocument()
    // No confidence is reported for an experimental complex.
    expect(item.interface_mean_plddt).toBeNull()
    expect(row.queryByText(/Mean pLDDT of interface residues/)).not.toBeInTheDocument()
    expect(screen.getByText(new RegExp(fixtures.interfaces.atom_selection.slice(0, 30).replace(/[()]/g, '\\$&')))).toBeInTheDocument()
    for (const limitation of fixtures.interfaces.limitations) expect(screen.getByText(limitation)).toBeInTheDocument()
  })

  it('highlights one side of an interface in the 3D view, and clears it again', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<CandidateLibrary />, '/library')

    const button = await screen.findByRole('button', { name: `Highlight chain ${item.chain_b} side` })
    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenCalled())
    await userEvent.click(button)
    await waitFor(() => expect(viewer.current.mocks.highlightResidues).toHaveBeenLastCalledWith(item.chain_b, item.ranges_b))
    const active = screen.getByRole('button', { name: 'Highlighted in 3D' })
    expect(active).toHaveAttribute('aria-pressed', 'true')
    viewer.current.mocks.clearHighlight.mockClear()
    await userEvent.click(active)
    await waitFor(() => expect(viewer.current.mocks.clearHighlight).toHaveBeenCalled())
  })

  it('recomputes with the contact distance that is chosen', async () => {
    const net = installFetch(fixtureRoutes())
    renderPanel(<CandidateLibrary />, '/library')
    const cutoff = await screen.findByRole('combobox', { name: 'Contact distance' })
    expect(cutoff).toHaveValue('4.5')
    await userEvent.selectOptions(cutoff, '6')
    await waitFor(() => expect(net.callsTo(`GET /structures/${complex.id}/interfaces`).at(-1)?.query.get('cutoff')).toBe('6'))
  })

  it('reports interface confidence only when the backend returns it', async () => {
    const predictedComplex = { ...complex, source: 'predicted' as const }
    installFetch(fixtureRoutes({
      'GET /structures': [predictedComplex],
      [`GET /structures/${complex.id}/interfaces`]: {
        ...fixtures.interfaces,
        source: 'predicted',
        interfaces: [{ ...item, interface_mean_plddt: 81.25, mean_interchain_pae: 6.4 }],
      },
    }))
    renderPanel(<CandidateLibrary />, '/library')
    await screen.findByText('Mean pLDDT of interface residues')
    expect(screen.getByText('81.3')).toBeInTheDocument()
    expect(screen.getByText('6.4 Å')).toBeInTheDocument()
    expect(screen.getByText(fixtures.interfaces.pae_note)).toBeInTheDocument()
  })

  it('says when no chains touch at the chosen distance', async () => {
    installFetch(fixtureRoutes({ [`GET /structures/${complex.id}/interfaces`]: { ...fixtures.interfaces, interfaces: [] } }))
    renderPanel(<CandidateLibrary />, '/library')
    await screen.findByText(`No chains are in contact within ${fixtures.interfaces.cutoff_angstrom} Å`)
  })

  it('opens the complex a link names', async () => {
    const second = { ...complex, id: 'st_second', label: 'Second complex' }
    installFetch(fixtureRoutes({
      'GET /structures': [complex, second],
      'GET /structures/st_second/interfaces': { ...fixtures.interfaces, structure_id: 'st_second' },
    }))
    const view = renderPanel(<CandidateLibrary />, '/library?structure=st_second')
    await screen.findByRole('heading', { name: 'Second complex' })
    expect(getPanelState().activeStructureId).toBe('st_second')
    await userEvent.click(screen.getByRole('button', { name: new RegExp(complex.label.replace(/[()]/g, '\\$&')) }))
    await waitFor(() => expect(view.location()).toBe(`/library?structure=${complex.id}`))
  })

  it('explains what it needs when there is no multi-chain structure, and keeps its caveat', async () => {
    installFetch(fixtureRoutes({ 'GET /structures': fixtures.structures.filter((s) => s.chains.length < 2) }))
    renderPanel(<CandidateLibrary />, '/library')
    await screen.findByText('No multi-chain structures in the library')
    expect(screen.getByText(/It does not generate binders or antibodies/)).toBeInTheDocument()
    expect(screen.getByText(/do not establish binding affinity, efficacy, or safety\. Not a clinical tool\./)).toBeInTheDocument()
  })

  it('shows the backend\'s reason when interfaces cannot be computed', async () => {
    installFetch(fixtureRoutes({ [`GET /structures/${complex.id}/interfaces`]: { status: 422, body: { detail: 'invalid_request: cutoff must be between 2 and 12' } } }))
    renderPanel(<CandidateLibrary />, '/library')
    await screen.findByText('invalid_request: cutoff must be between 2 and 12')
  })
})
