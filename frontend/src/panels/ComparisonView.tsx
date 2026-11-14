import { useEffect, useState } from 'react'
import { alignStructures, compareExperiments, listExperiments, listStructures } from '@/api'
import type { AlignmentResponse, CompareResponse, Experiment, Structure } from '@/api'

export function ComparisonView() {
  const [structures, setStructures] = useState<Structure[]>([])
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [mobileId, setMobileId] = useState('')
  const [referenceId, setReferenceId] = useState('')
  const [mobileExperiment, setMobileExperiment] = useState('')
  const [referenceExperiment, setReferenceExperiment] = useState('')
  const [alignment, setAlignment] = useState<AlignmentResponse | null>(null)
  const [comparison, setComparison] = useState<CompareResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    Promise.all([listStructures(), listExperiments()]).then(([s, e]) => {
      if (!alive) return
      setStructures(s); setExperiments(e)
      setMobileId(s[0]?.id ?? ''); setReferenceId(s[1]?.id ?? s[0]?.id ?? '')
      setMobileExperiment(e[0]?.id ?? ''); setReferenceExperiment(e[1]?.id ?? e[0]?.id ?? '')
    }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Unable to load comparison inputs') })
    return () => { alive = false }
  }, [])

  async function runComparison() {
    if (!mobileId || !referenceId || !mobileExperiment || !referenceExperiment) {
      setError('Choose two structures and two experiments before comparing.')
      return
    }
    setLoading(true); setError(null); setAlignment(null); setComparison(null)
    try {
      const [a, c] = await Promise.all([
        alignStructures({ mobile_id: mobileId, reference_id: referenceId, selection: {} }),
        compareExperiments({ experiment_ids: [mobileExperiment, referenceExperiment] }),
      ])
      setAlignment(a); setComparison(c)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Comparison failed')
    } finally { setLoading(false) }
  }

  const metricRows = comparison?.experiments ?? []
  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <header><h2 className="text-base font-semibold">Structure & experiment comparison</h2>
        <p className="text-xs text-muted-foreground">Compare two existing records. Alignment values come from the API response.</p></header>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs">Mobile structure
          <select className="mt-1 w-full rounded border border-border bg-background p-2" value={mobileId} onChange={(e) => setMobileId(e.target.value)}>
            {structures.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="text-xs">Reference structure
          <select className="mt-1 w-full rounded border border-border bg-background p-2" value={referenceId} onChange={(e) => setReferenceId(e.target.value)}>
            {structures.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="text-xs">Mobile experiment
          <select className="mt-1 w-full rounded border border-border bg-background p-2" value={mobileExperiment} onChange={(e) => setMobileExperiment(e.target.value)}>
            {experiments.map((e) => <option key={e.id} value={e.id}>{e.model_name} · {e.kind}</option>)}
          </select>
        </label>
        <label className="text-xs">Reference experiment
          <select className="mt-1 w-full rounded border border-border bg-background p-2" value={referenceExperiment} onChange={(e) => setReferenceExperiment(e.target.value)}>
            {experiments.map((e) => <option key={e.id} value={e.id}>{e.model_name} · {e.kind}</option>)}
          </select>
        </label>
      </div>
      <button type="button" onClick={runComparison} disabled={loading || !structures.length || !experiments.length}
        className="rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {loading ? 'Comparing…' : 'Compare'}
      </button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!structures.length || !experiments.length ? <p className="text-sm text-muted-foreground">Two structures and experiments are required. No comparison inputs are currently available.</p> : null}
      {alignment && <div className="rounded border border-primary/40 p-3">
        <h3 className="mb-3 text-sm font-semibold">Alignment result</h3>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div><dt className="text-xs text-muted-foreground">RMSD</dt><dd className="font-mono text-lg">{alignment.rmsd.toFixed(3)} Å</dd></div>
          <div><dt className="text-xs text-muted-foreground">TM-score</dt><dd className="font-mono text-lg">{alignment.tm_score == null ? 'Unavailable' : alignment.tm_score.toFixed(3)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Aligned atoms</dt><dd className="font-mono text-lg">{alignment.aligned_atoms}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Aligned residues</dt><dd className="font-mono text-lg">{alignment.aligned_residues}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Atom type</dt><dd className="font-mono text-lg">{alignment.atom_type}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          Alignment used {alignment.aligned_atoms} {alignment.atom_type} atoms across {alignment.aligned_residues} residues. The matrix is the backend-provided 4×4 transform.
        </p>
      </div>}
      {metricRows.length > 0 && <div className="overflow-x-auto">
        <table className="w-full text-left text-xs"><thead><tr><th className="p-2">Experiment</th><th className="p-2">Model</th><th className="p-2">Kind</th><th className="p-2">Status</th><th className="p-2">Metrics</th></tr></thead>
          <tbody>{metricRows.map((row) => <tr key={row.experiment_id} className="border-t border-border">
            <td className="p-2 font-mono">{row.experiment_id}</td><td className="p-2">{row.model_name ?? '—'}</td>
            <td className="p-2">{row.kind ?? '—'}</td><td className="p-2">{row.status ?? '—'}</td>
            <td className="p-2">{Object.entries(row.metrics).map(([k, v]) => `${k}: ${v ?? '—'}`).join(' · ')}</td>
          </tr>)}</tbody></table>
      </div>}
    </section>
  )
}
