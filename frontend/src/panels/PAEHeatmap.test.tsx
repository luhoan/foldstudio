import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { setActiveStructure } from './panelState'
import { PAEHeatmap } from './PAEHeatmap'

// jsdom has no canvas. A stand-in records what the panel paints.
const painted: Array<{ width: number; height: number; data: Uint8ClampedArray }> = []
beforeEach(() => {
  painted.length = 0
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: (image: { width: number; height: number; data: Uint8ClampedArray }) => { painted.push(image) },
  })) as never)
})
afterEach(() => vi.restoreAllMocks())

function brightness(image: { width: number; data: Uint8ClampedArray }, row: number, col: number): number {
  const at = (row * image.width + col) * 4
  return image.data[at] + image.data[at + 1] + image.data[at + 2]
}

describe('PAEHeatmap', () => {
  it('paints the matrix the backend returned, brighter where the expected error is lower', async () => {
    installFetch(fixtureRoutes())
    setActiveStructure(fixtureIds.predicted)
    renderPanel(<PAEHeatmap />)

    const n = fixtures.pae.size
    await screen.findByRole('img', { name: `PAE heatmap, ${n} by ${n} residues. Use the arrow keys to read a cell.` })
    await waitFor(() => expect(painted.length).toBeGreaterThan(0))
    const image = painted.at(-1)!
    expect([image.width, image.height]).toEqual([n, n])

    // Find the lowest and highest values in the fixture and check their order on screen.
    let low = { row: 0, col: 0 }
    let high = { row: 0, col: 0 }
    fixtures.pae.matrix.forEach((values, row) => values.forEach((value, col) => {
      if (value < fixtures.pae.matrix[low.row][low.col]) low = { row, col }
      if (value > fixtures.pae.matrix[high.row][high.col]) high = { row, col }
    }))
    expect(fixtures.pae.matrix[low.row][low.col]).toBeLessThan(fixtures.pae.matrix[high.row][high.col])
    expect(brightness(image, low.row, low.col)).toBeGreaterThan(brightness(image, high.row, high.col))

    expect(screen.getByText('0 Å')).toBeInTheDocument()
    expect(screen.getByText(`${Number(fixtures.pae.max_pae!.toFixed(1))} Å or more`)).toBeInTheDocument()
    expect(screen.getByText('Expected position error. Brighter means lower error.')).toBeInTheDocument()
    expect(screen.getByText(fixtures.pae.note)).toBeInTheDocument()
  })

  it('reads out a pair of residues from the keyboard, naming both', async () => {
    installFetch(fixtureRoutes())
    setActiveStructure(fixtureIds.predicted)
    renderPanel(<PAEHeatmap />)

    const plot = await screen.findByRole('img', { name: /PAE heatmap/ })
    plot.focus()
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowDown}')
    const value = fixtures.pae.matrix[1][2]
    const names = fixtures.residues.residues.map((r) => `${r.chain}:${r.resname}${r.resseq}`)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`${value.toFixed(1)} Å`))
    expect(screen.getByRole('status')).toHaveTextContent(`expected error at ${names[2]} when aligned on ${names[1]}`)
    fireEvent.pointerLeave(plot)
    expect(screen.getByRole('status')).toHaveTextContent('Point at the plot')
  })

  it('says PAE does not apply to an experimental structure, and asks the backend for nothing', async () => {
    const net = installFetch(fixtureRoutes())
    setActiveStructure(fixtureIds.complex)
    renderPanel(<PAEHeatmap />)
    await screen.findByText('PAE does not apply to this structure')
    expect(screen.getByText(/This structure is\s+experimental, so there is none\./)).toBeInTheDocument()
    expect(net.callsTo(`GET /structures/${fixtureIds.complex}/pae`)).toHaveLength(0)
    expect(screen.queryByLabelText(/Attach the PAE file/)).not.toBeInTheDocument()
  })

  it('offers to attach a PAE file to a predicted model that has none, and shows the plot once attached', async () => {
    const withoutPae = fixtures.structures.map((s) => (s.id === fixtureIds.predicted ? { ...s, has_pae: false } : s))
    let structures = withoutPae
    const net = installFetch(fixtureRoutes({ 'GET /structures': () => structures }))
    setActiveStructure(fixtureIds.predicted)
    renderPanel(<PAEHeatmap />)

    await screen.findByText('No PAE file for this model')
    structures = fixtures.structures
    await userEvent.upload(screen.getByLabelText(/Attach the PAE file/), new File(['[]'], 'model.pae.json', { type: 'application/json' }))
    await screen.findByRole('img', { name: /PAE heatmap/ })
    expect(net.callsTo(`POST /structures/${fixtureIds.predicted}/pae`)).toHaveLength(1)
  })

  it('shows the backend\'s reason when a PAE file is refused', async () => {
    const withoutPae = fixtures.structures.map((s) => (s.id === fixtureIds.predicted ? { ...s, has_pae: false } : s))
    installFetch(fixtureRoutes({
      'GET /structures': withoutPae,
      [`POST /structures/${fixtureIds.predicted}/pae`]: { status: 400, body: { detail: 'pae_mismatch: matrix is 5x5 but the structure has 12 residues' } },
    }))
    setActiveStructure(fixtureIds.predicted)
    renderPanel(<PAEHeatmap />)
    await userEvent.upload(await screen.findByLabelText(/Attach the PAE file/), new File(['[]'], 'wrong.json', { type: 'application/json' }))
    await screen.findByText('pae_mismatch: matrix is 5x5 but the structure has 12 residues')
    expect(screen.queryByRole('img', { name: /PAE heatmap/ })).not.toBeInTheDocument()
  })

  it('renders nothing when no library structure is active', async () => {
    installFetch(fixtureRoutes())
    const { container } = renderPanel(<PAEHeatmap />)
    await waitFor(() => expect(container.querySelector('section')).toBeNull())
  })
})
