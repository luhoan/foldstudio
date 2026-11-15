import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'
import { fakeAdapter } from '@/test/fakeViewer'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { viewerActions } from '@/viewer/store'
import { bandOf } from './bands'
import { getPanelState, setActiveStructure } from './panelState'
import { SequencePanel } from './SequencePanel'

describe('SequencePanel', () => {
  it('renders nothing until a library structure is active', async () => {
    installFetch(fixtureRoutes())
    const { container } = renderPanel(<SequencePanel />)
    await waitFor(() => expect(container.querySelector('section')).toBeNull())
  })

  it('lays the sequence out residue by residue, coloured by the backend\'s pLDDT band', async () => {
    installFetch(fixtureRoutes())
    setActiveStructure(fixtureIds.predicted)
    renderPanel(<SequencePanel />)

    const residues = fixtures.residues.residues
    const first = await screen.findByRole('button', { name: /^MET 1, chain A, pLDDT 95\.0$/ })
    expect(first).toHaveTextContent('M')
    expect(screen.getAllByRole('button')).toHaveLength(residues.length)
    for (const score of fixtures.plddt.per_residue) {
      const button = screen.getByRole('button', { name: new RegExp(`^${score.resname} ${score.resseq}, chain A, pLDDT ${score.plddt.toFixed(1)}$`) })
      expect(button.style.backgroundColor).not.toBe('')
      expect(button.title).toContain(bandOf(score.bin)!.label.toLowerCase())
    }
    // Colour is never the only carrier: the legend names every band with its range.
    expect(screen.getByText('Very high (≥ 90)')).toBeInTheDocument()
    expect(screen.getByText('Very low (< 50)')).toBeInTheDocument()
  })

  it('selects the clicked residue and finds it in the 3D view', async () => {
    installFetch(fixtureRoutes())
    const viewer = fakeAdapter()
    viewerActions.setAdapter(viewer.adapter)
    setActiveStructure(fixtureIds.predicted)
    renderPanel(<SequencePanel />)

    const leucine = await screen.findByRole('button', { name: /^LEU 4, chain A/ })
    await userEvent.click(leucine)
    expect(getPanelState().selectedResidue).toEqual({ structureId: fixtureIds.predicted, chain: 'A', seqId: 4, insCode: undefined, compId: 'LEU' })
    expect(viewer.mocks.highlightResidues).toHaveBeenCalledWith('A', [{ start: 4, end: 4 }], { focus: true })
    await waitFor(() => expect(leucine).toHaveAttribute('aria-pressed', 'true'))
  })

  it('shows no confidence colours for a structure that is not a predicted model, and says why', async () => {
    const net = installFetch(fixtureRoutes())
    setActiveStructure(fixtureIds.complex)
    renderPanel(<SequencePanel />)

    const first = await screen.findByRole('button', { name: /^MET 1, chain A$/ })
    expect(first.style.backgroundColor).toBe('')
    expect(screen.getByText(/No confidence colours: this structure is not a predicted model/)).toBeInTheDocument()
    expect(net.callsTo(`GET /structures/${fixtureIds.complex}/plddt`)).toHaveLength(0)
  })

  it('reports a failed load in place of the sequence', async () => {
    installFetch(fixtureRoutes({ [`GET /structures/${fixtureIds.predicted}/residues`]: { status: 500, body: { detail: 'file is unreadable' } } }))
    setActiveStructure(fixtureIds.predicted)
    renderPanel(<SequencePanel />)
    await screen.findByText('file is unreadable')
  })
})
