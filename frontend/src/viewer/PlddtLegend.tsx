import { PLDDT_BINS } from './plddt'
import { cn } from '@/lib/utils'

export interface PlddtLegendProps {
  /** Structure.source from the contract, when known. */
  structureKind?: 'experimental' | 'predicted' | 'uploaded'
  className?: string
}

export function PlddtLegend({ structureKind, className }: PlddtLegendProps) {
  return (
    <div
      data-testid="plddt-legend"
      className={cn('w-56 rounded-md border border-border bg-card/90 p-3 text-xs shadow-lg backdrop-blur', className)}
    >
      <div className="mb-2 font-medium text-foreground">Model confidence (pLDDT)</div>
      <ul className="space-y-1">
        {PLDDT_BINS.map((b) => (
          <li key={b.id} data-testid={`plddt-bin-${b.id}`} className="flex items-center gap-2">
            <span className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: b.css }} aria-hidden />
            <span className="text-foreground">{b.label}</span>
            <span className="ml-auto tabular-nums text-muted-foreground">{b.range}</span>
          </li>
        ))}
      </ul>
      {structureKind === 'experimental' ? (
        <p role="note" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-amber-300">
          Experimental structure: the coloured column holds crystallographic B-factors, not pLDDT. These
          colours are not confidence scores.
        </p>
      ) : (
        <p className="mt-2 text-muted-foreground">
          {structureKind === 'predicted'
            ? 'Read from the B-factor column, where predictors store pLDDT. '
            : 'Reads the B-factor column; meaningful only for predicted models. '}
          Confidence is the model's own estimate, not proof of folding, binding, affinity, efficacy or safety.
        </p>
      )}
    </div>
  )
}
