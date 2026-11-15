import type { PlddtBinName } from '@/api'
import { PLDDT_BINS } from '@/viewer'

/**
 * The four pLDDT bands as the panels draw them. Colours and ranges come from viewer/plddt.ts, the
 * same table the 3D view is coloured from, so a residue is one colour everywhere in the app.
 *
 * These are the AlphaFold colours, kept because everyone who has seen an AlphaFold model reads
 * them on sight. Checked with the dataviz palette validator against this app's card surface:
 * neighbouring bands stay apart for colour-blind readers (worst pair deltaE 16.9, deuteranopia),
 * but the darkest blue is only 2.7:1 against the surface. That is why a band is never shown as a
 * colour alone here: every use has its name and range in text beside it.
 */
export interface Band {
  name: PlddtBinName
  label: string
  range: string
  /** Fill colour. */
  css: string
  /** Text colour that is legible on top of the fill. */
  ink: string
}

const INK: Record<PlddtBinName, string> = {
  very_high: '#ffffff',
  confident: '#0b0b0b',
  low: '#0b0b0b',
  very_low: '#0b0b0b',
}

export const BANDS: readonly Band[] = (['very_high', 'confident', 'low', 'very_low'] as const).map((name) => {
  const bin = PLDDT_BINS.find((b) => b.id === name.replace('_', '-'))!
  return { name, label: bin.label, range: bin.range, css: bin.css, ink: INK[name] }
})

export function bandOf(name: string): Band | undefined {
  return BANDS.find((b) => b.name === name)
}
