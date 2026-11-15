import { ChevronRight } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getReport } from '@/api'
import type { ExperimentKind, ExperimentStatus } from '@/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { downloadText } from './download'
import { ExperimentDetail } from './ExperimentDetail'
import { errorMessage, formatDate, inputClass, kindMeaning } from './format'
import { useLibrary } from './library'
import { Card, Code, EmptyState, ErrorNote, KindBadge, Loading, StatusBadge } from './ui'

const KINDS: ExperimentKind[] = ['executed', 'imported', 'demo']

/**
 * Every experiment record the backend holds. Each row says what kind of record it is, and opens
 * to show everything the record states: provenance, stages, metrics and the metrics the run
 * recorded it could not measure. A report of the rows on screen can be exported.
 */
export function ExperimentHistory() {
  const library = useLibrary()
  const [params, setParams] = useSearchParams()
  const [kind, setKind] = useState<'all' | ExperimentKind>('all')
  const [status, setStatus] = useState<'all' | ExperimentStatus>('all')
  const [exporting, setExporting] = useState<'html' | 'markdown' | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const openId = params.get('experiment')
  const openRow = useRef<HTMLTableRowElement>(null)

  const experiments = useMemo(
    () => [...library.experiments].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    [library.experiments],
  )
  const shown = useMemo(
    () => experiments.filter((e) => (kind === 'all' || e.kind === kind) && (status === 'all' || e.status === status)),
    [experiments, kind, status],
  )
  // A record opened by a link stays visible even when the filters would hide it.
  const linked = openId ? experiments.find((e) => e.id === openId) ?? null : null
  const rows = linked && !shown.includes(linked) ? [linked, ...shown] : shown

  useEffect(() => {
    if (openId && library.status === 'ready') openRow.current?.scrollIntoView?.({ block: 'nearest' })
  }, [openId, library.status])

  function toggle(id: string) {
    setParams(openId === id ? {} : { experiment: id }, { replace: true })
  }

  async function exportReport(format: 'html' | 'markdown') {
    if (rows.length === 0) return
    setExporting(format); setExportError(null)
    try {
      const report = await getReport(rows.map((e) => e.id))
      const content = format === 'html' ? report.html : report.markdown
      if (typeof content !== 'string' || content.length === 0) throw new Error(`The report came back without its ${format} part.`)
      downloadText(`foldstudio-report.${format === 'html' ? 'html' : 'md'}`, content, format === 'html' ? 'text/html' : 'text/markdown')
    } catch (e) {
      setExportError(errorMessage(e, 'The report could not be exported.'))
    } finally {
      setExporting(null)
    }
  }

  return (
    <Card
      title="Records"
      description="Open a row to read everything the record states. A report covers the rows shown."
      actions={
        <>
          <Button variant="outline" size="sm" disabled={rows.length === 0 || exporting !== null} onClick={() => exportReport('html')}>
            {exporting === 'html' ? 'Exporting…' : 'Export report (HTML)'}
          </Button>
          <Button variant="outline" size="sm" disabled={rows.length === 0 || exporting !== null} onClick={() => exportReport('markdown')}>
            {exporting === 'markdown' ? 'Exporting…' : 'Export report (Markdown)'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Kind
            <select aria-label="Filter by kind" className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="all">All kinds</option>
              <option value="executed">Executed</option>
              <option value="imported">Imported</option>
              <option value="demo">Demo</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Status
            <select aria-label="Filter by status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="all">All statuses</option>
              <option value="ok">OK</option>
              <option value="partial">Partial</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <span className="text-sm text-muted-foreground">
            {rows.length} of {experiments.length} record{experiments.length === 1 ? '' : 's'}
          </span>
        </div>

        {exportError && <ErrorNote>{exportError}</ErrorNote>}
        {library.error && <ErrorNote>{library.error}</ErrorNote>}

        {library.status !== 'ready' ? (
          <Loading>Loading experiment records…</Loading>
        ) : experiments.length === 0 ? (
          <EmptyState title="No experiment records yet">
            Records are read from <Code>data/experiments/</Code> when the backend starts. Import a pipeline bundle
            with <Code>python3 scripts/hpc_import_bundle.py &lt;bundle.tar.gz&gt;</Code>, or download the reference set
            with <Code>python3 scripts/fetch_demo_data.py</Code>.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState title="No experiments match these filters.">Change the kind or status filter to see more.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="fs-table">
              <thead>
                <tr>
                  <th className="w-8"><span className="sr-only">Details</span></th>
                  <th>Experiment</th><th>Kind</th><th>Status</th><th>Recorded</th><th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const open = e.id === openId
                  return (
                    <Fragment key={e.id}>
                      <tr ref={open ? openRow : undefined} className={cn(open && '[&>td]:bg-muted/40')}>
                        <td>
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-label={`${open ? 'Hide' : 'Show'} details of ${e.id}`}
                            onClick={() => toggle(e.id)}
                            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
                          </button>
                        </td>
                        <td className="max-w-[22rem]">
                          <button type="button" className="text-left font-mono break-all hover:underline" onClick={() => toggle(e.id)}>{e.id}</button>
                          <span className="block text-muted-foreground">{e.model_name}</span>
                        </td>
                        <td><KindBadge kind={e.kind} /></td>
                        <td><StatusBadge status={e.status} /></td>
                        <td className="whitespace-nowrap">{formatDate(e.created_at)}</td>
                        <td className="min-w-[14rem] text-muted-foreground">
                          <span className="line-clamp-2">{e.error ?? e.provenance.notes}</span>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={6} className="!bg-transparent !p-0">
                            <div className="border-l-2 border-primary/50 px-5 py-5">
                              <ExperimentDetail experiment={e} structures={library.structures} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <dl className="grid gap-x-6 gap-y-1.5 border-t border-border pt-4 text-[0.8125rem] sm:grid-cols-[auto_minmax(0,1fr)]">
          {KINDS.map((k) => (
            <div key={k} className="contents">
              <dt><KindBadge kind={k} /></dt>
              <dd className="text-muted-foreground">{kindMeaning(k)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  )
}
