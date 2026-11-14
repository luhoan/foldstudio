import { Bond, StructureElement, Unit } from 'molstar/lib/mol-model/structure'
import { ColorTheme } from 'molstar/lib/mol-theme/color'
import { ColorThemeCategory } from 'molstar/lib/mol-theme/color/categories'
import { Color } from 'molstar/lib/mol-util/color'
import { TableLegend } from 'molstar/lib/mol-util/legend'
import { PLDDT_BINS, PLDDT_NO_SCORE_HEX, plddtColor } from '../plddt'

/**
 * pLDDT colour theme using the standard AlphaFold bins. Reads the atom B-factor column, which is
 * where AlphaFold DB / ColabFold / most predictors store pLDDT. For experimental structures the
 * same column is a real B-factor, so the panel warns when this is used on non-predicted data.
 */
const legend = TableLegend([
  ...PLDDT_BINS.map((b) => [`${b.label} (${b.range})`, Color(b.hex)] as [string, Color]),
  ['No score', Color(PLDDT_NO_SCORE_HEX)],
])

function scoreAt(unit: Unit, element: StructureElement.Location['element']): number {
  if (!Unit.isAtomic(unit)) return -1
  return unit.model.atomicConformation.B_iso_or_equiv.value(element)
}

export const FS_PLDDT_THEME = 'fs-plddt'

export const FoldStudioPlddtThemeProvider: ColorTheme.Provider<{}, typeof FS_PLDDT_THEME> = {
  name: FS_PLDDT_THEME,
  label: 'pLDDT (AlphaFold confidence bins)',
  category: ColorThemeCategory.Validation,
  factory: (_ctx, props) => ({
    factory: () => ({}) as never,
    granularity: 'group',
    preferSmoothing: true,
    color: (location) => {
      if (StructureElement.Location.is(location)) {
        return Color(plddtColor(scoreAt(location.unit, location.element)))
      }
      if (Bond.isLocation(location)) {
        return Color(plddtColor(scoreAt(location.aUnit, location.aUnit.elements[location.aIndex])))
      }
      return Color(PLDDT_NO_SCORE_HEX)
    },
    props,
    description: 'Colours by pLDDT (read from the B-factor column) using the standard AlphaFold confidence bins.',
    legend,
  }),
  getParams: () => ({}),
  defaultValues: {},
  isApplicable: () => true,
}
