import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ViewerError, type ResidueClickEvent, type ViewerAdapter } from './adapter'
import { ViewerPanel } from './ViewerPanel'
import { getViewerState, resetViewerStore } from './store'

function fakeAdapter(overrides: Partial<ViewerAdapter> = {}) {
  const clickHandlers: ((e: ResidueClickEvent) => void)[] = []
  const a = {
    init: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
    loadSecond: vi.fn().mockResolvedValue(undefined),
    unloadSecond: vi.fn().mockResolvedValue(undefined),
    setRepresentation: vi.fn().mockResolvedValue(undefined),
    colorBy: vi.fn().mockResolvedValue(undefined),
    highlightResidues: vi.fn(),
    selectChain: vi.fn(),
    clearHighlight: vi.fn(),
    resetCamera: vi.fn(),
    setCamera: vi.fn(),
    getCamera: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/png' })),
    onResidueClick: vi.fn((cb: (e: ResidueClickEvent) => void) => {
      clickHandlers.push(cb)
      return () => undefined
    }),
    dispose: vi.fn(),
    ...overrides,
  } satisfies ViewerAdapter
  return { adapter: a as ViewerAdapter, mocks: a, click: (e: ResidueClickEvent) => clickHandlers.forEach((h) => h(e)) }
}

beforeEach(() => resetViewerStore())

describe('ViewerPanel', () => {
  it('shows a loading state, then becomes interactive once the structure loads', async () => {
    let resolveLoad!: () => void
    const { adapter, mocks } = fakeAdapter({ load: vi.fn(() => new Promise<void>((r) => (resolveLoad = r))) })
    render(<ViewerPanel url="/samples/a.pdb" format="pdb" label="a.pdb" adapterFactory={async () => adapter} />)

    expect(await screen.findByText(/Loading a\.pdb/)).toBeInTheDocument()
    expect(mocks.load).toHaveBeenCalledWith('/samples/a.pdb', 'pdb')
    expect(screen.getByRole('button', { name: /reset camera/i })).toBeDisabled()

    await act(async () => resolveLoad())
    await waitFor(() => expect(screen.queryByText(/Loading a\.pdb/)).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /reset camera/i })).toBeEnabled()
  })

  it('shows an error with Retry when loading fails, and retries', async () => {
    const load = vi.fn().mockRejectedValueOnce(new ViewerError('fetch', 'HTTP 404 Not Found while fetching /samples/nope.pdb')).mockResolvedValue(undefined)
    const { adapter } = fakeAdapter({ load })
    render(<ViewerPanel url="/samples/nope.pdb" format="pdb" adapterFactory={async () => adapter} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('HTTP 404')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reports WebGL failure without offering a pointless Retry', async () => {
    const { adapter } = fakeAdapter({ init: vi.fn().mockRejectedValue(new ViewerError('webgl', 'WebGL is not available')) })
    render(<ViewerPanel url="/samples/a.pdb" format="pdb" adapterFactory={async () => adapter} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('WebGL is not available')
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(adapter.load).not.toHaveBeenCalled()
  })

  it('shows an empty state when no structure is given', async () => {
    const { adapter } = fakeAdapter()
    render(<ViewerPanel adapterFactory={async () => adapter} />)
    expect(await screen.findByText(/No structure loaded/)).toBeInTheDocument()
    expect(adapter.load).not.toHaveBeenCalled()
  })

  it('shows the four-bin pLDDT legend only when colouring by pLDDT, and applies the scheme', async () => {
    const { adapter, mocks } = fakeAdapter()
    render(<ViewerPanel url="/samples/a.pdb" format="pdb" structureKind="predicted" adapterFactory={async () => adapter} />)
    await waitFor(() => expect(screen.getByLabelText('Colour by')).toBeEnabled())
    expect(screen.queryByTestId('plddt-legend')).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Colour by'), 'plddt')
    expect(mocks.colorBy).toHaveBeenLastCalledWith('plddt')
    const legend = screen.getByTestId('plddt-legend')
    for (const id of ['very-high', 'confident', 'low', 'very-low']) {
      expect(screen.getByTestId(`plddt-bin-${id}`)).toBeInTheDocument()
    }
    expect(legend).toHaveTextContent(/not proof of folding, binding/i)
  })

  it('warns that experimental structures carry B-factors, not pLDDT', async () => {
    const { adapter } = fakeAdapter()
    render(<ViewerPanel url="/samples/a.pdb" format="pdb" structureKind="experimental" adapterFactory={async () => adapter} />)
    await waitFor(() => expect(screen.getByLabelText('Colour by')).toBeEnabled())
    await userEvent.selectOptions(screen.getByLabelText('Colour by'), 'plddt')
    expect(screen.getByRole('note')).toHaveTextContent(/B-factors, not pLDDT/)
  })

  it('switches representation through the adapter', async () => {
    const { adapter, mocks } = fakeAdapter()
    render(<ViewerPanel url="/samples/a.pdb" format="pdb" adapterFactory={async () => adapter} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Surface' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Surface' }))
    expect(mocks.setRepresentation).toHaveBeenLastCalledWith('surface')
  })

  it('loads a second structure with its matrix and defaults to uniform colours for overlays', async () => {
    const { adapter, mocks } = fakeAdapter()
    const matrix = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    render(
      <ViewerPanel url="/samples/a.pdb" format="pdb" secondUrl="/samples/b.cif" secondFormat="mmcif" secondMatrix={matrix} adapterFactory={async () => adapter} />,
    )
    await waitFor(() => expect(mocks.loadSecond).toHaveBeenCalledWith('/samples/b.cif', matrix, { format: 'mmcif', layout: 'overlay' }))
    expect(mocks.colorBy).toHaveBeenCalledWith('uniform')
  })

  it('highlights residues and reports clicked residues', async () => {
    const onResidueClick = vi.fn()
    const { adapter, mocks, click } = fakeAdapter()
    render(
      <ViewerPanel url="/samples/a.pdb" format="pdb" highlight={{ chain: 'A', ranges: [{ start: 10, end: 20 }] }} onResidueClick={onResidueClick} adapterFactory={async () => adapter} />,
    )
    await waitFor(() => expect(mocks.highlightResidues).toHaveBeenCalledWith('A', [{ start: 10, end: 20 }]))
    act(() => click({ chain: 'A', seqId: 12, insCode: ' ', compId: 'ALA', structureIndex: 0 }))
    expect(onResidueClick).toHaveBeenCalledWith(expect.objectContaining({ chain: 'A', seqId: 12 }))
    expect(screen.getByTestId('clicked-residue')).toHaveTextContent('A:ALA12')
  })

  it('publishes its adapter to the viewer store and disposes it on unmount', async () => {
    const { adapter, mocks } = fakeAdapter()
    const { unmount } = render(<ViewerPanel url="/samples/a.pdb" format="pdb" adapterFactory={async () => adapter} />)
    await waitFor(() => expect(getViewerState().adapter).toBe(adapter))
    unmount()
    expect(mocks.dispose).toHaveBeenCalled()
    expect(getViewerState().adapter).toBeNull()
  })
})
