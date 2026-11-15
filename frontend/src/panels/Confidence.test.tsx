import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { fixtures } from '@/api/fixtures'
import { PLDDT_BINS, plddtBin } from '@/viewer'
import { BANDS, bandOf } from './bands'
import { BandSplit, PlddtProfile } from './Confidence'

describe('confidence bands', () => {
  it('uses the same colours and ranges as the 3D view', () => {
    expect(BANDS.map((b) => b.css)).toEqual(PLDDT_BINS.map((b) => b.css))
    expect(BANDS.map((b) => b.range)).toEqual(PLDDT_BINS.map((b) => b.range))
  })

  it('agrees with the 3D view on which band every residue of the fixture is in', () => {
    for (const residue of fixtures.plddt.per_residue) {
      expect(bandOf(residue.bin)?.name.replace('_', '-')).toBe(plddtBin(residue.plddt)?.id)
    }
  })

  it('leaves an empty band out of the bar but keeps its row, as zero', () => {
    const plddt = {
      ...fixtures.plddt,
      bins: fixtures.plddt.bins.map((b) => (b.name === 'very_low' ? { ...b, count: 0, fraction: 0 } : b)),
    }
    render(<BandSplit plddt={plddt} />)
    const bar = screen.getByRole('img', { name: /Share of residues by confidence band/ })
    expect(bar.children).toHaveLength(3)
    expect(screen.getByRole('row', { name: /Very low/ }).textContent).toBe('Very low< 5000%')
  })
})

describe('PlddtProfile', () => {
  const residues = fixtures.plddt.per_residue

  it('reads out a residue as the keyboard moves along the line, and selects on Enter', async () => {
    const onSelect = vi.fn()
    render(<PlddtProfile residues={residues} selectedIndex={null} onSelect={onSelect} />)
    const line = screen.getByRole('slider', { name: 'pLDDT along the sequence' })
    expect(screen.getByRole('status')).toHaveTextContent('Point at the line')

    line.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('status')).toHaveTextContent(`${residues[1].plddt.toFixed(1)} pLDDT at A:${residues[1].resname}${residues[1].resseq}, very high`)
    expect(line).toHaveAttribute('aria-valuenow', '2')

    await userEvent.keyboard('{End}')
    const last = residues[residues.length - 1]
    expect(screen.getByRole('status')).toHaveTextContent(`${last.plddt.toFixed(1)} pLDDT at A:${last.resname}${last.resseq}, very low`)
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith(last)

    await userEvent.keyboard('{Home}{ArrowLeft}')
    expect(line).toHaveAttribute('aria-valuenow', '1')
  })

  it('marks the selected residue when nothing is hovered', () => {
    render(<PlddtProfile residues={residues} selectedIndex={4} onSelect={() => undefined} />)
    expect(screen.getByRole('status')).toHaveTextContent(`${residues[4].plddt.toFixed(1)} pLDDT at A:${residues[4].resname}${residues[4].resseq}`)
  })

  it('offers every value as a table', async () => {
    render(<PlddtProfile residues={residues} selectedIndex={null} onSelect={() => undefined} />)
    await userEvent.click(screen.getByText('Show as a table'))
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(residues.length)
    expect(rows[0].textContent).toBe(`A:${residues[0].resname}${residues[0].resseq}${residues[0].plddt.toFixed(1)}Very high`)
  })

  it('draws nothing for an empty profile', () => {
    const { container } = render(<PlddtProfile residues={[]} selectedIndex={null} onSelect={() => undefined} />)
    expect(container).toBeEmptyDOMElement()
  })
})
