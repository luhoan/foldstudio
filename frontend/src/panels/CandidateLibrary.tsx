import { useEffect, useState } from 'react'
import { listExperiments, listStructures } from '@/api'
import { setActiveStructure } from './panelState'
import type { Experiment, Structure } from '@/api'
import type { ResidueRange, ViewerAdapter } from '@/viewer/adapter'

interface CandidateLibraryProps {
  /** Injected by the viewer integration; no Mol* dependency is used here. */
  adapter?: ViewerAdapter
}

function getString(settings: Record<string, unknown>, key: string): string | null {
  const value = settings[key]
  return typeof value === 'string' && value.length ? value : null
}

function getRanges(settings: Record<string, unknown>): ResidueRange[] {
  const raw = settings.interface_ranges
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): ResidueRange[] => {
    if (!item || typeof item !== 'object') return []
    const range = item as { start?: unknown; end?: unknown }
    return typeof range.start === 'number' && typeof range.end === 'number' && range.start <= range.end
      ? [{ start: range.start, end: range.end }] : []
  })
}

export function CandidateLibrary({ adapter }: CandidateLibraryProps) {
  const [structures, setStructures] = useState<Structure[]>([])
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState<string>('')
  useEffect(() => {
    let alive = true
    Promise.all([listStructures(), listExperiments()]).then(([s, e]) => {
      if (!alive) return
      setStructures(s); setExperiments(e)
      setActive((current) => current || s.find((structure) =>
        structure.source === 'experimental' && e.some((experiment) => experiment.kind === 'imported' &&
          (experiment.inputs.includes(structure.id) || experiment.outputs.includes(structure.id))))?.id || '')
    }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Unable to load curated complexes') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const complexes = structures.map((structure) => ({
    structure,
    experiment: experiments.find((e) => e.kind === 'imported' &&
      (e.inputs.includes(structure.id) || e.outputs.includes(structure.id))),
  })).filter(({ structure, experiment }) =>
    structure.source === 'experimental' && experiment?.kind === 'imported',
  )

  function highlight(structureId: string, experiment: Experiment | undefined) {
    setActive(structureId)
    setActiveStructure(structureId)
    if (!adapter || !experiment) return
    const chain = getString(experiment.settings, 'candidate_chain')
    const ranges = getRanges(experiment.settings)
    if (!chain || !ranges.length) return
    adapter.highlightResidues(chain, ranges, { structureIndex: 0, focus: true })
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header><h2 className="text-base font-semibold">Candidate library</h2>
        <p className="text-xs text-muted-foreground">Review curated, precomputed public complexes only. This panel does not generate binders or antibodies.</p></header>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading ? <p role="status" className="text-sm text-muted-foreground">Loading curated complexes…</p> : null}
      {!loading && !error && !complexes.length ? <p className="rounded border border-dashed border-border p-4 text-sm text-muted-foreground">No curated imported experimental complexes with documented provenance are available.</p>
        : !loading && !error ? <div className="grid gap-3 md:grid-cols-2">
          {complexes.map(({ structure, experiment }) => {
            const candidate = experiment ? getString(experiment.settings, 'candidate_chain') : null
            const partner = experiment ? getString(experiment.settings, 'partner_chain') : null
            const ranges = experiment ? getRanges(experiment.settings) : []
            return <article key={structure.id} className="rounded border border-border p-3">
              <h3 className="text-sm font-semibold">{structure.label}</h3>
              <p className="mt-1 text-[11px] text-muted-foreground">{structure.origin_id} · {experiment?.provenance.source}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div><dt className="text-muted-foreground">Candidate chain</dt><dd>{candidate ?? 'Not documented'}</dd></div>
                <div><dt className="text-muted-foreground">Partner chain</dt><dd>{partner ?? 'Not documented'}</dd></div>
                <div><dt className="text-muted-foreground">Interface ranges</dt><dd>{ranges.length ? ranges.map((r) => `${r.start}–${r.end}`).join(', ') : 'Not documented'}</dd></div>
                <div><dt className="text-muted-foreground">Provenance</dt><dd>{experiment?.kind ?? '—'}</dd></div>
              </dl>
              <button type="button" disabled={!adapter || !candidate || !ranges.length}
                onClick={() => highlight(structure.id, experiment)} className="mt-3 rounded border border-border px-3 py-1.5 text-xs disabled:opacity-40">
                Highlight documented interface
              </button>
              {active === structure.id && <span className="ml-2 text-[11px] text-primary">Selected</span>}
            </article>
          })}
        </div> : null}
      <div className="rounded bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
        Interface assignments and residue ranges are shown only when present in imported experiment metadata. Confidence scores and structural predictions do not establish binding affinity, efficacy, or safety. Not a clinical tool.
      </div>
    </section>
  )
}
