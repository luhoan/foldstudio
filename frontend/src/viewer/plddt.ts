/**
 * Standard AlphaFold confidence palette and bands (same colours Mol* and the AlphaFold DB use).
 * Single source of truth for both the 3D colour theme and the legend.
 *
 * pLDDT is the model's own per-residue confidence. It is NOT proof of correct folding, binding,
 * affinity, efficacy or safety.
 */
export interface PlddtBin {
  id: 'very-high' | 'confident' | 'low' | 'very-low'
  label: string
  range: string
  hex: number
  css: string
}

export const PLDDT_BINS: readonly PlddtBin[] = [
  { id: 'very-high', label: 'Very high', range: '≥ 90', hex: 0x0053d6, css: '#0053D6' },
  { id: 'confident', label: 'Confident', range: '70 – <90', hex: 0x65cbf3, css: '#65CBF3' },
  { id: 'low', label: 'Low', range: '50 – <70', hex: 0xffdb13, css: '#FFDB13' },
  { id: 'very-low', label: 'Very low', range: '< 50', hex: 0xff7d45, css: '#FF7D45' },
]

export const PLDDT_NO_SCORE_HEX = 0xaaaaaa

/**
 * Lower bound inclusive: [0,50) [50,70) [70,90) [90,100]. This is the app-wide convention, shared
 * with the backend's /plddt bins and the explanation rules (backend/tests/test_plddt_convention.py
 * reads this function to hold all three together), so the 3D colours, the histogram and the
 * explanation text never disagree about a residue sitting exactly on a boundary.
 */
export function plddtBin(score: number): PlddtBin | undefined {
  if (!Number.isFinite(score) || score < 0) return undefined
  if (score < 50) return PLDDT_BINS[3]
  if (score < 70) return PLDDT_BINS[2]
  if (score < 90) return PLDDT_BINS[1]
  return PLDDT_BINS[0]
}

export function plddtColor(score: number): number {
  return plddtBin(score)?.hex ?? PLDDT_NO_SCORE_HEX
}
