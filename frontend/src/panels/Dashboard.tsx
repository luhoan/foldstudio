import { useEffect, useState } from 'react'
import { listExperiments, listStructures } from '@/api'
import type { Experiment, Structure } from '@/api'

/**
 * Overview of what is actually loaded.
 *
 * Every number here is a count of real records returned by the API. Nothing is
 * a target, a projection or a placeholder: if a bucket is zero it is shown as
 * zero, because an empty dashboard is information and an invented one is not.
 *
 * The kind breakdown is the point of the page. "imported" and "demo" records
 * came from somewhere else; only "executed" means this installation ran the
 * pipeline and produced the files itself.
 */

const KINDS = ['executed', 'imported', 'demo'] as const
const KIND_BLURB: Record<string, string> = {
  executed: 'Ran here: the pipeline produced these files on this installation.',
  imported: 'Brought in from a public database as-is. No model was run here.',
  demo: 'Illustrative fixtures. Not a run.',
}
const SOURCE_BLURB: Record<string, string> = {
  predicted: 'Model output. B-factors carry pLDDT, so confidence can be read.',
  experimental: 'Deposited coordinates. B-factors are not confidence.',
  uploaded: 'Provided without a declared source, so confidence is not reported.',
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1
  return out
}

function Tile({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-2xl">{value}</dd>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function Dashboard() {
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [structures, setStructures] = useState<Structure[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    Promise.all([listExperiments(), listStructures()])
      .then(([e, s]) => { if (alive) { setExperiments(e); setStructures(s) } })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not reach the API')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const byKind = countBy(experiments, (e) => e.kind)
  const bySource = countBy(structures, (s) => s.source)
  const failed = experiments.filter((e) => e.status === 'failed' || e.status === 'partial')
  const recent = [...experiments]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 5)

  if (loading) return <section className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">Loading…</section>

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <header>
        <h2 className="text-base font-semibold">Overview</h2>
        <p className="text-sm text-muted-foreground">Counts of the records currently loaded. Nothing here is projected.</p>
      </header>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {!error && experiments.length === 0 && structures.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing is loaded yet. Run <code className="font-mono">python3 scripts/fetch_demo_data.py</code> and
          restart the backend, or export a pipeline bundle into <code className="font-mono">data/experiments/</code>.
        </p>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold">Experiments by provenance</h3>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {KINDS.map((k) => <Tile key={k} label={k} value={byKind[k] ?? 0} hint={KIND_BLURB[k]} />)}
          <Tile label="total" value={experiments.length} />
        </dl>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Structures by source</h3>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {(['predicted', 'experimental', 'uploaded'] as const).map((s) => (
            <Tile key={s} label={s} value={bySource[s] ?? 0} hint={SOURCE_BLURB[s]} />
          ))}
          <Tile label="total" value={structures.length} />
        </dl>
      </div>

      {failed.length > 0 && (
        <div className="rounded border border-destructive/40 p-3">
          <h3 className="mb-2 text-sm font-semibold">Needs attention</h3>
          <ul className="space-y-1 text-xs">
            {failed.map((e) => (
              <li key={e.id}>
                <span className="font-mono">{e.id}</span> — {e.status}
                {e.error ? `: ${e.error}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {recent.length > 0 && (
        <div className="overflow-x-auto">
          <h3 className="mb-2 text-sm font-semibold">Most recent</h3>
          <table className="w-full text-left text-xs">
            <thead>
              <tr><th className="p-2">Experiment</th><th className="p-2">Kind</th><th className="p-2">Status</th><th className="p-2">Model</th></tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="p-2 font-mono">{e.id}</td>
                  <td className="p-2">{e.kind}</td>
                  <td className="p-2">{e.status}</td>
                  <td className="p-2">{e.model_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Confidence scores and structural predictions are model estimates. They do not establish
        folding, binding affinity, efficacy or safety. Not a clinical tool.
      </p>
    </section>
  )
}
