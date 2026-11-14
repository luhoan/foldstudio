import { useEffect, useMemo, useState } from 'react'
import { getReports, listExperiments } from '@/api'
import type { Experiment, ExperimentKind, ExperimentStatus } from '@/api'

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function ExperimentHistory() {
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [kind, setKind] = useState<'all' | ExperimentKind>('all')
  const [status, setStatus] = useState<'all' | ExperimentStatus>('all')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    listExperiments().then((items) => { if (alive) setExperiments(items) })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Unable to load experiment history') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const filtered = useMemo(() => experiments.filter((e) =>
    (kind === 'all' || e.kind === kind) && (status === 'all' || e.status === status),
  ), [experiments, kind, status])

  async function exportReport(format: 'html' | 'markdown') {
    if (!filtered.length) return
    setExporting(true); setError(null)
    try {
      const report = await getReports(filtered.map((e) => e.id))
      const content = format === 'html' ? report.html : report.markdown
      if (!content) throw new Error(`The report endpoint did not return ${format}.`)
      downloadText(`foldstudio-report.${format === 'html' ? 'html' : 'md'}`, content,
        format === 'html' ? 'text/html' : 'text/markdown')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Report export failed')
    } finally { setExporting(false) }
  }

  if (loading) return <p role="status" className="text-sm text-muted-foreground">Loading experiment history…</p>
  if (error && !experiments.length) return <p role="alert" className="text-sm text-destructive">{error}</p>

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header><h2 className="text-base font-semibold">Experiment history</h2>
        <p className="text-xs text-muted-foreground">Every record is labelled by provenance kind.</p></header>
      <div className="flex flex-wrap gap-2">
        <label className="text-xs">Kind
          <select aria-label="Filter by kind" className="ml-2 rounded border border-border bg-background p-1.5" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">All kinds</option><option value="executed">Executed</option><option value="imported">Imported</option><option value="demo">Demo</option>
          </select>
        </label>
        <label className="text-xs">Status
          <select aria-label="Filter by status" className="ml-2 rounded border border-border bg-background p-1.5" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">All statuses</option><option value="ok">OK</option><option value="partial">Partial</option><option value="failed">Failed</option>
          </select>
        </label>
        <span className="flex-1" />
        <button type="button" disabled={!filtered.length || exporting} onClick={() => exportReport('html')} className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-50">Export HTML</button>
        <button type="button" disabled={!filtered.length || exporting} onClick={() => exportReport('markdown')} className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-50">Export Markdown</button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {!filtered.length ? <p className="rounded border border-dashed border-border p-4 text-sm text-muted-foreground">No experiments match these filters.</p>
        : <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead><tr className="border-b border-border text-muted-foreground"><th className="p-2">Created</th><th className="p-2">Model</th><th className="p-2">Kind</th><th className="p-2">Status</th><th className="p-2">Error / provenance</th></tr></thead>
          <tbody>{filtered.map((e) => <tr key={e.id} className="border-b border-border last:border-0">
            <td className="p-2 whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
            <td className="p-2">{e.model_name} <span className="text-muted-foreground">{e.model_version}</span></td>
            <td className="p-2"><span className="rounded-full border border-border px-2 py-0.5">{e.kind}</span></td>
            <td className="p-2">{e.status}</td><td className="p-2">{e.error ?? e.provenance.notes}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  )
}
