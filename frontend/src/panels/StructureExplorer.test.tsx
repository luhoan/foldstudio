import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'
import { fakeAdapter } from '@/test/fakeViewer'
import { fixtureRoutes, installFetch, type Routes } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { getPanelState, setActiveStructure } from './panelState'
import { StructureExplorer } from './StructureExplorer'

// The real adapter needs WebGL; the panel is tested against a recording stand-in.
const viewer = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof import('@/test/fakeViewer').fakeAdapter> }))
vi.mock('@/viewer/createAdapter', () => ({ createViewerAdapter: async () => viewer.current.adapter }))

const first = fixtures.structures[0]
const predicted = fixtures.structures.find((s) => s.id === fixtureIds.predicted)!
const complex = fixtures.structures.find((s) => s.id === fixtureIds.complex)!

function routes(overrides: Routes = {}): Routes {
  return fixtureRoutes({ 'GET /samples/manifest.json': [], ...overrides })
}

beforeEach(() => {
  viewer.current = fakeAdapter()
})

describe('StructureExplorer', () => {
  it('opens the first library structure, loads its coordinates from the API and puts it in the address', async () => {
    installFetch(routes())
    const view = renderPanel(<StructureExplorer />, '/explorer')

    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenCalledWith(`/api/structures/${first.id}/file`, 'pdb'))
    expect(screen.getByRole('combobox', { name: 'Structure' })).toHaveValue(`library:${first.id}`)
    expect(getPanelState().activeStructureId).toBe(first.id)
    await waitFor(() => expect(view.location()).toBe(`/explorer?structure=${first.id}`))
    // Every library structure is offered, each labelled with what kind of structure it is.
    for (const s of fixtures.structures) expect(screen.getByRole('option', { name: new RegExp(s.label.replace(/[()]/g, '\\$&')) })).toBeInTheDocument()
  })

  it('opens the structure a link names, colours a predicted model by pLDDT, and highlights the residues asked for', async () => {
    installFetch(routes())
    renderPanel(<StructureExplorer />, `/explorer?structure=${predicted.id}&chain=A&ranges=3-5,9`)

    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenCalledWith(`/api/structures/${predicted.id}/file`, 'pdb'))
    expect(getPanelState().activeStructureId).toBe(predicted.id)
    await waitFor(() => expect(viewer.current.mocks.colorBy).toHaveBeenLastCalledWith('plddt'))
    await waitFor(() => expect(viewer.current.mocks.highlightResidues).toHaveBeenCalledWith('A', [{ start: 3, end: 5 }, { start: 9, end: 9 }]))
    expect(screen.getByText('Highlighted: chain A, residues 3–5, 9')).toBeInTheDocument()
  })

  it('clears a highlight on request', async () => {
    installFetch(routes())
    const view = renderPanel(<StructureExplorer />, `/explorer?structure=${predicted.id}&chain=A&ranges=3-5`)
    await userEvent.click(await screen.findByRole('button', { name: 'Clear highlight' }))
    await waitFor(() => expect(view.location()).toBe(`/explorer?structure=${predicted.id}`))
    await waitFor(() => expect(viewer.current.mocks.clearHighlight).toHaveBeenCalled())
    expect(screen.queryByText(/Highlighted:/)).not.toBeInTheDocument()
  })

  it('colours a structure that is not a predicted model by chain', async () => {
    installFetch(routes())
    renderPanel(<StructureExplorer />, `/explorer?structure=${complex.id}`)
    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenCalledWith(`/api/structures/${complex.id}/file`, 'pdb'))
    await waitFor(() => expect(viewer.current.mocks.colorBy).toHaveBeenLastCalledWith('chain'))
    expect(viewer.current.mocks.colorBy).not.toHaveBeenCalledWith('plddt')
  })

  it('switches structure from its picker and keeps the address in step', async () => {
    installFetch(routes())
    const view = renderPanel(<StructureExplorer />, '/explorer')
    const picker = await screen.findByRole('combobox', { name: 'Structure' })
    await userEvent.selectOptions(picker, `library:${complex.id}`)
    expect(getPanelState().activeStructureId).toBe(complex.id)
    await waitFor(() => expect(view.location()).toBe(`/explorer?structure=${complex.id}`))
    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenLastCalledWith(`/api/structures/${complex.id}/file`, 'pdb'))
  })

  it('follows a choice made elsewhere, such as the sidebar', async () => {
    installFetch(routes())
    const view = renderPanel(<StructureExplorer />, '/explorer')
    await waitFor(() => expect(view.location()).toBe(`/explorer?structure=${first.id}`))
    setActiveStructure(predicted.id)
    await waitFor(() => expect(view.location()).toBe(`/explorer?structure=${predicted.id}`))
    expect(screen.getByRole('combobox', { name: 'Structure' })).toHaveValue(`library:${predicted.id}`)
  })

  it('follows a link to another structure while the page is open', async () => {
    installFetch(routes())
    const view = renderPanel(<StructureExplorer />, `/explorer?structure=${first.id}`)
    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenCalledWith(`/api/structures/${first.id}/file`, 'pdb'))
    view.navigate(`/explorer?structure=${predicted.id}&chain=A&ranges=2-3`)
    await waitFor(() => expect(getPanelState().activeStructureId).toBe(predicted.id))
    await waitFor(() => expect(viewer.current.mocks.highlightResidues).toHaveBeenCalledWith('A', [{ start: 2, end: 3 }]))
    expect(view.location()).toBe(`/explorer?structure=${predicted.id}&chain=A&ranges=2-3`)
  })

  it('turns a click in the 3D view into the selected residue', async () => {
    installFetch(routes())
    renderPanel(<StructureExplorer />, `/explorer?structure=${predicted.id}`)
    await waitFor(() => expect(viewer.current.mocks.onResidueClick).toHaveBeenCalled())
    viewer.current.click({ chain: 'A', seqId: 7, insCode: '', compId: 'ILE', structureIndex: 0 })
    expect(getPanelState().selectedResidue).toEqual({ structureId: predicted.id, chain: 'A', seqId: 7, insCode: undefined, compId: 'ILE' })
  })

  it('says when a link points at a structure that is not in the library', async () => {
    installFetch(routes())
    renderPanel(<StructureExplorer />, '/explorer?structure=st_gone')
    await screen.findByText(/This link points to structure/)
    expect(screen.getByText('st_gone')).toBeInTheDocument()
    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenCalledWith(`/api/structures/${first.id}/file`, 'pdb'))
  })

  it('opens the add-structure form when the library is empty, and says how data gets in', async () => {
    installFetch(routes({ 'GET /structures': [] }))
    renderPanel(<StructureExplorer />, '/explorer')
    await screen.findByText('No structures yet')
    expect(screen.getByRole('tab', { name: 'Fetch from a database' })).toBeInTheDocument()
    expect(screen.getByText('python3 scripts/fetch_demo_data.py')).toBeInTheDocument()
    expect(viewer.current.mocks.load).not.toHaveBeenCalled()
  })

  it('shows a newly added structure straight away', async () => {
    let structures = fixtures.structures
    const net = installFetch(routes({ 'GET /structures': () => structures }))
    const view = renderPanel(<StructureExplorer />, '/explorer')
    await userEvent.click(await screen.findByRole('button', { name: 'Add structure' }))
    await userEvent.type(screen.getByLabelText('PDB id'), '1ubq')
    structures = [...fixtures.structures, fixtures.upload]
    await userEvent.click(screen.getByRole('button', { name: 'Fetch entry' }))

    await waitFor(() => expect(view.location()).toBe(`/explorer?structure=${fixtures.upload.id}`))
    expect(net.callsTo('POST /structures/fetch')[0].body).toEqual({ source: 'rcsb', id: '1ubq' })
    expect(getPanelState().activeStructureId).toBe(fixtures.upload.id)
    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenLastCalledWith(`/api/structures/${fixtures.upload.id}/file`, 'pdb'))
  })

  it('offers local sample files separately, and shows one without touching the library selection', async () => {
    installFetch(routes({ 'GET /samples/manifest.json': [{ file: 'demo.cif', url: '/samples/demo.cif', format: 'mmcif' }] }))
    const view = renderPanel(<StructureExplorer />, '/explorer')
    const picker = await screen.findByRole('combobox', { name: 'Structure' })
    const option = await screen.findByRole('option', { name: 'demo.cif' })
    await userEvent.selectOptions(picker, option)
    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenLastCalledWith('/samples/demo.cif', 'mmcif'))
    expect(getPanelState().activeStructureId).toBeNull()
    await waitFor(() => expect(view.location()).toBe('/explorer'))
    expect(screen.getByText(/It is not in the library/)).toBeInTheDocument()

    // Choosing a library structure again, from anywhere, leaves the sample.
    setActiveStructure(predicted.id)
    await waitFor(() => expect(viewer.current.mocks.load).toHaveBeenLastCalledWith(`/api/structures/${predicted.id}/file`, 'pdb'))
    expect(screen.queryByText(/It is not in the library/)).not.toBeInTheDocument()
  })
})
