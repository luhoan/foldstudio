import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'
import { fakeAdapter } from '@/test/fakeViewer'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { AlignmentPanel } from './AlignmentPanel'

const viewer = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof import('@/test/fakeViewer').fakeAdapter> }))
vi.mock('@/viewer/createAdapter', () => ({ createViewerAdapter: async () => viewer.current.adapter }))

const align = fixtures.align

beforeEach(() => {
  viewer.current = fakeAdapter()
})

describe('AlignmentPanel (Structural Analysis)', () => {
  it('sends the chosen structures, chains and matching method, and does nothing until asked', async () => {
    const net = installFetch(fixtureRoutes())
    renderPanel(<AlignmentPanel />, '/analysis')

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Mobile structure' }), fixtureIds.design)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Reference structure' }), fixtureIds.backbone)
    expect(screen.getByRole('combobox', { name: 'How residues are paired' })).toHaveValue('auto')
    expect(net.callsTo('POST /analysis/align')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Align' }))
    await screen.findByRole('heading', { name: 'Result' })
    expect(net.callsTo('POST /analysis/align')[0].body).toEqual({
      mobile_id: fixtureIds.design,
      reference_id: fixtureIds.backbone,
      selection: { mobile_chain: 'A', reference_chain: 'A', method: 'auto' },
    })
  })

  it('reports the numbers together with exactly what was aligned', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<AlignmentPanel />, `/analysis?mobile=${fixtureIds.design}&reference=${fixtureIds.backbone}`)

    const result = within((await screen.findByRole('heading', { name: 'Result' })).closest('section') as HTMLElement)
    expect(result.getByText(align.rmsd.toFixed(2))).toBeInTheDocument()
    expect(result.getByText(align.tm_score.toFixed(3))).toBeInTheDocument()
    expect(result.getByText(`Over ${align.aligned_atoms} ${align.atom_type} atoms`)).toBeInTheDocument()
    expect(result.getByText(`${(align.sequence_identity * 100).toFixed(1)}%`)).toBeInTheDocument()
    expect(result.getByText(align.procedure)).toBeInTheDocument()
    expect(result.getByText(align.tm_score_method)).toBeInTheDocument()
    // The automatic choice of matching is stated, not hidden.
    expect(align.matching).toBe('resnum')
    expect(result.getByText(/Residues were paired by residue number\s+\(chosen automatically; you asked for auto\)\./)).toBeInTheDocument()
    for (const note of align.notes) expect(result.getByText(note)).toBeInTheDocument()
    expect(result.getByText(align.summary)).toBeInTheDocument()
    for (const limitation of align.limitations) expect(result.getByText(limitation)).toBeInTheDocument()
  })

  it('runs straight away when opened from a link, pairing residues automatically', async () => {
    const net = installFetch(fixtureRoutes())
    renderPanel(<AlignmentPanel />, `/analysis?mobile=${fixtureIds.design}&reference=${fixtureIds.backbone}`)
    await screen.findByRole('heading', { name: 'Result' })
    expect(net.callsTo('POST /analysis/align')[0].body).toEqual({
      mobile_id: fixtureIds.design, reference_id: fixtureIds.backbone, selection: { method: 'auto' },
    })
    expect(screen.getByRole('combobox', { name: 'Mobile structure' })).toHaveValue(fixtureIds.design)
    expect(screen.getByRole('combobox', { name: 'Reference structure' })).toHaveValue(fixtureIds.backbone)
  })

  it('draws the reference with the mobile structure moved onto it by the returned transform', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<AlignmentPanel />, `/analysis?mobile=${fixtureIds.design}&reference=${fixtureIds.backbone}`)
    await screen.findByRole('heading', { name: 'Result' })

    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenCalledWith(`/api/structures/${align.reference_id}/file`, 'pdb'))
    await waitFor(() => expect(viewer.current.mocks.loadSecond).toHaveBeenCalledWith(
      `/api/structures/${align.mobile_id}/file`, align.matrix, { format: 'pdb', layout: 'overlay' }))
    // Which colour is which structure is written out next to the view.
    expect(screen.getByText(`Reference: ${align.reference_label}`)).toBeInTheDocument()
    expect(screen.getByText(`Mobile: ${align.mobile_label}, moved onto the reference`)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Side by side' }))
    await waitFor(() => expect(viewer.current.mocks.loadSecond).toHaveBeenLastCalledWith(
      `/api/structures/${align.mobile_id}/file`, align.matrix, { format: 'pdb', layout: 'side-by-side' }))
    expect(screen.getByText('Side by side shows the two structures apart, without the superposition.')).toBeInTheDocument()
  })

  it('lists the matched residue pairs on request', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<AlignmentPanel />, `/analysis?mobile=${fixtureIds.design}&reference=${fixtureIds.backbone}`)
    await userEvent.click(await screen.findByText(`The ${align.pairs.length} matched residue pairs`))
    const table = screen.getByRole('columnheader', { name: 'Same residue type' }).closest('table') as HTMLElement
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(align.pairs.length)
    expect(rows[0].textContent).toBe(`${align.pairs[0].mobile}${align.pairs[0].reference}${align.pairs[0].identical ? 'yes' : 'no'}`)
  })

  it('sends residue ranges and an explicit method when they are set', async () => {
    const net = installFetch(fixtureRoutes())
    renderPanel(<AlignmentPanel />, '/analysis')
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Mobile structure' }), fixtureIds.design)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Reference structure' }), fixtureIds.backbone)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'How residues are paired' }), 'resnum')
    await userEvent.click(screen.getByText('Limit to a residue range'))
    await userEvent.type(screen.getByLabelText(/Mobile residues/), '2-9')
    await userEvent.type(screen.getByLabelText(/Reference residues/), '3 - 10')
    await userEvent.click(screen.getByRole('button', { name: 'Align' }))
    await waitFor(() => expect(net.callsTo('POST /analysis/align')).toHaveLength(1))
    expect(net.callsTo('POST /analysis/align')[0].body).toEqual({
      mobile_id: fixtureIds.design,
      reference_id: fixtureIds.backbone,
      selection: { mobile_chain: 'A', reference_chain: 'A', method: 'resnum', mobile_range: [2, 9], reference_range: [3, 10] },
    })
  })

  it('refuses a range it cannot read, and the same chain against itself, before calling the backend', async () => {
    const net = installFetch(fixtureRoutes())
    renderPanel(<AlignmentPanel />, '/analysis')
    const mobile = await screen.findByRole('combobox', { name: 'Mobile structure' })
    await userEvent.selectOptions(mobile, fixtureIds.design)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Reference structure' }), fixtureIds.design)
    await userEvent.click(screen.getByRole('button', { name: 'Align' }))
    expect(screen.getByRole('alert')).toHaveTextContent('These are the same chain of the same structure.')

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Reference structure' }), fixtureIds.backbone)
    await userEvent.click(screen.getByText('Limit to a residue range'))
    await userEvent.type(screen.getByLabelText(/Mobile residues/), 'ten to twenty')
    await userEvent.click(screen.getByRole('button', { name: 'Align' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Write a residue range as first-last')
    expect(net.callsTo('POST /analysis/align')).toHaveLength(0)
  })

  it('offers two different chains by default when a structure is aligned with itself', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<AlignmentPanel />, '/analysis')
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Mobile structure' }), fixtureIds.complex)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Reference structure' }), fixtureIds.complex)
    expect(screen.getByRole('combobox', { name: 'Mobile chain' })).toHaveValue('A')
    expect(screen.getByRole('combobox', { name: 'Reference chain' })).toHaveValue('B')
  })

  it('shows the backend\'s reason when an alignment cannot be computed', async () => {
    const reason = 'invalid_request: only 1 matched residues with CA atoms; need at least 3. Try selection.method "auto" or "resnum".'
    installFetch(fixtureRoutes({ 'POST /analysis/align': { status: 400, body: { detail: reason } } }))
    renderPanel(<AlignmentPanel />, `/analysis?mobile=${fixtureIds.design}&reference=${fixtureIds.backbone}`)
    await screen.findByText(reason)
    expect(screen.queryByRole('heading', { name: 'Result' })).not.toBeInTheDocument()
    expect(viewer.current.mocks.loadSecond).not.toHaveBeenCalled()
  })

  it('asks for structures when there are none', async () => {
    installFetch(fixtureRoutes({ 'GET /structures': [] }))
    renderPanel(<AlignmentPanel />, '/analysis')
    await screen.findByText('No structures to align yet')
  })
})
