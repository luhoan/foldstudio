import { PLDDT_BINS, plddtBin, plddtColor } from './plddt'

describe('pLDDT palette', () => {
  it('uses the four standard AlphaFold colours, highest confidence first', () => {
    expect(PLDDT_BINS.map((b) => b.css)).toEqual(['#0053D6', '#65CBF3', '#FFDB13', '#FF7D45'])
    expect(PLDDT_BINS.map((b) => b.range)).toEqual(['> 90', '70 – 90', '50 – 70', '< 50'])
  })

  it.each([
    [95, 'very-high'],
    [90.01, 'very-high'],
    [90, 'confident'],
    [80, 'confident'],
    [70.5, 'confident'],
    [70, 'low'],
    [60, 'low'],
    [50.5, 'low'],
    [50, 'very-low'],
    [12, 'very-low'],
    [0, 'very-low'],
  ])('bins %f as %s', (score, id) => {
    expect(plddtBin(score)?.id).toBe(id)
  })

  it('returns no bin for missing or invalid scores', () => {
    expect(plddtBin(-1)).toBeUndefined()
    expect(plddtBin(Number.NaN)).toBeUndefined()
    expect(plddtColor(-1)).toBe(0xaaaaaa)
  })
})
