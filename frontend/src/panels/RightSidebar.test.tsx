import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { getPanelState, setActiveStructure, setSelectedResidue } from './panelState'
import { RightSidebar } from './RightSidebar'

const predicted = fixtures.structures.find((s) => s.id === fixtureIds.predicted)!
const complex = fixtures.structures.find((s) => s.id === fixtureIds.complex)!
const design = fixtures.structures.find((s) => s.id === fixtureIds.design)!

function card(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('section') as HTMLElement
}

describe('RightSidebar', () => {
  it('shows the backend\'s pLDDT summary for a predicted model, without recomputing anything', async () => {
    const net = installFetch(fixtureRoutes())
    setActiveStructure(predicted.id)
    renderPanel(<RightSidebar />)

    const confidence = await waitFor(() => card('Model confidence (pLDDT)'))
    await within(confidence).findByText(fixtures.plddt.mean!.toFixed(1))
    expect(within(confidence).getByText(fixtures.plddt.median!.toFixed(1))).toBeInTheDocument()
    expect(within(confidence).getByText(fixtures.plddt.note)).toBeInTheDocument()
    // One row per band, with the count and share the backend reported.
    const rows = within(within(confidence).getByRole('table', { name: 'Residues by pLDDT band' })).getAllByRole('row')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Very high≥ 90325%', 'Confident70 – <90325%', 'Low50 – <70325%', 'Very low< 50325%',
    ])
    expect(fixtures.plddt.bins.map((b) => [b.name, b.count, b.fraction])).toEqual([
      ['very_high', 3, 0.25], ['confident', 3, 0.25], ['low', 3, 0.25], ['very_low', 3, 0.25],
    ])
    expect(net.callsTo(`GET /structures/${predicted.id}/plddt`)).toHaveLength(1)
    expect(net.unmatched).toEqual([])
  })

  it('says what the structure is and where it came from', async () => {
    installFetch(fixtureRoutes())
    setActiveStructure(design.id)
    renderPanel(<RightSidebar />)

    const facts = await waitFor(() => card(design.label))
    expect(within(facts).getByText('predicted model')).toBeInTheDocument()
    expect(within(facts).getByText(design.origin_id!)).toBeInTheDocument()
    expect(within(facts).getByText(design.provenance.notes)).toBeInTheDocument()
    expect(within(facts).getByRole('link', { name: fixtureIds.pipelineRun })).toHaveAttribute('href', `/history?experiment=${fixtureIds.pipelineRun}`)

    const origin = card('Where it came from')
    expect(within(origin).getByText('executed')).toBeInTheDocument()
    expect(within(origin).getByText('partial')).toBeInTheDocument()
    expect(within(origin).getByRole('link', { name: 'Open the experiment record' })).toHaveAttribute('href', `/history?experiment=${fixtureIds.pipelineRun}`)
  })

  it('reports no confidence for an experimental structure and does not ask the backend for any', async () => {
    const net = installFetch(fixtureRoutes())
    setActiveStructure(complex.id)
    renderPanel(<RightSidebar />)

    const confidence = await waitFor(() => card('Model confidence (pLDDT)'))
    expect(within(confidence).getByText(/Not reported\. This structure is experimental/)).toBeInTheDocument()
    await screen.findByText(fixtures.explain_experimental.summary)
    expect(net.callsTo(`GET /structures/${complex.id}/plddt`)).toHaveLength(0)
    expect(screen.queryByText('Mean pLDDT')).not.toBeInTheDocument()
  })

  it('shows the rule-based explanation exactly as returned, with its limitations', async () => {
    installFetch(fixtureRoutes())
    setActiveStructure(predicted.id)
    renderPanel(<RightSidebar />)

    const explanation = await waitFor(() => card('What the numbers say'))
    await within(explanation).findByText(fixtures.explain_predicted.summary)
    for (const limitation of fixtures.explain_predicted.limitations) {
      expect(within(explanation).getByText(limitation)).toBeInTheDocument()
    }
  })

  it('lets a multi-chain structure be described one chain at a time', async () => {
    const net = installFetch(fixtureRoutes())
    setActiveStructure(complex.id)
    renderPanel(<RightSidebar />)

    const chain = await screen.findByRole('combobox', { name: 'Chain to describe' })
    await waitFor(() => expect(net.callsTo('GET /explain')).toHaveLength(1))
    expect(net.callsTo('GET /explain')[0].query.get('chain')).toBe('A')
    await userEvent.selectOptions(chain, 'B')
    await waitFor(() => expect(net.callsTo('GET /explain').at(-1)?.query.get('chain')).toBe('B'))
  })

  it('describes the selected residue: its type, its pLDDT and the sentence for that residue', async () => {
    const net = installFetch(fixtureRoutes())
    setActiveStructure(predicted.id)
    setSelectedResidue({ structureId: predicted.id, chain: 'A', seqId: 3 })
    renderPanel(<RightSidebar />)

    const residue = fixtures.residues.residues.find((r) => r.resseq === 3)!
    const score = fixtures.plddt.per_residue.find((r) => r.resseq === 3)!
    const selected = await waitFor(() => card('Selected residue'))
    await within(selected).findByText(`${residue.resname} ${residue.resseq}`)
    expect(within(selected).getByText(score.plddt.toFixed(1))).toBeInTheDocument()
    await within(selected).findByText(fixtures.explain_residue.summary)
    const call = net.callsTo('GET /explain').find((c) => c.query.get('start') === '3')!
    expect(Object.fromEntries(call.query)).toEqual({ structure: predicted.id, chain: 'A', start: '3', end: '3' })
  })

  it('says so when the clicked group is not an amino-acid residue', async () => {
    installFetch(fixtureRoutes())
    setActiveStructure(predicted.id)
    setSelectedResidue({ structureId: predicted.id, chain: 'A', seqId: 901, compId: 'HOH' })
    renderPanel(<RightSidebar />)
    await screen.findByText(/HOH A:901 is not an\s+amino-acid residue of this structure/)
  })

  it('selects a residue from the pLDDT line', async () => {
    installFetch(fixtureRoutes())
    setActiveStructure(predicted.id)
    renderPanel(<RightSidebar />)

    const line = await screen.findByRole('slider', { name: 'pLDDT along the sequence' })
    line.focus()
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{Enter}')
    expect(getPanelState().selectedResidue).toMatchObject({ structureId: predicted.id, chain: 'A', seqId: 3, compId: 'VAL' })
  })

  it('follows the structure picker', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<RightSidebar />)
    const picker = await screen.findByRole('combobox', { name: /Structure/ })
    await userEvent.selectOptions(picker, complex.id)
    expect(getPanelState().activeStructureId).toBe(complex.id)
    await screen.findByRole('heading', { name: complex.label })
  })

  it('describes the first structure by default, except on the Explorer, where the viewer decides', async () => {
    installFetch(fixtureRoutes())
    const first = fixtures.structures[0]
    const view = renderPanel(<RightSidebar />, '/history')
    await screen.findByRole('heading', { name: first.label })
    expect(screen.getByRole('link', { name: 'Open in the 3D viewer' })).toHaveAttribute('href', `/explorer?structure=${first.id}`)
    view.unmount()

    renderPanel(<RightSidebar />, '/explorer')
    await screen.findByText(/Choose a structure to see where it came from/)
    expect(screen.queryByRole('heading', { name: first.label })).not.toBeInTheDocument()
  })

  it('explains an empty library', async () => {
    installFetch(fixtureRoutes({ 'GET /structures': [] }))
    renderPanel(<RightSidebar />)
    await screen.findByText('No structures yet')
  })

  it('shows why the structures could not be loaded', async () => {
    installFetch(fixtureRoutes({ 'GET /structures': { status: 500, body: { detail: 'database is locked' } } }))
    renderPanel(<RightSidebar />)
    await screen.findByText('Structures: database is locked')
  })

  it('keeps the model-confidence caveat on screen in every state', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<RightSidebar />)
    await screen.findByText(/They\s+do not establish folding, binding, affinity, efficacy, or\s+safety\. FoldStudio is not a clinical tool\./)
  })
})
