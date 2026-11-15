import { useState } from 'react'
import { API_BASE_URL, USE_MOCKS, getHealth, reindexExperiments } from '@/api'
import type { ReindexReport } from '@/api'
import { Button } from '@/components/ui/button'
import { errorMessage, formatDate } from './format'
import { refreshLibrary, useLibrary } from './library'
import { historyLink } from './links'
import { Card, Code, ErrorNote, Loading, Note, TextLink } from './ui'
import { useAsync } from './useAsync'

/**
 * What this installation is actually talking to, and what the backend loaded.
 *
 * Deliberately not a preferences screen: there are no toggles here, because nothing in the app
 * reads a user-set preference, and a switch that silently does nothing is worse than no switch.
 * Everything shown is build configuration or a live answer from the backend.
 */

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-0.5 border-t border-border py-3 first:border-t-0 first:pt-0 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">
        <div className="break-words">{value}</div>
        {hint && <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">{hint}</p>}
      </dd>
    </div>
  )
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** What the backend found the last time it read data/experiments/, including what it could not load. */
function ReindexSummary({ report }: { report: ReindexReport }) {
  return (
    <div className="space-y-3 text-sm">
      <p>
        Read {formatDate(report.at)}: {plural(report.imported.length, 'bundle')} loaded,{' '}
        {plural(report.structures_registered.length, 'structure')} registered,{' '}
        {report.structures_updated.length} refreshed, {plural(report.removed.length, 'stale record')} removed.
      </p>
      {report.errors.length > 0 && (
        <div className="space-y-2">
          <p className="font-medium">{plural(report.errors.length, 'bundle')} could not be loaded:</p>
          {report.errors.map((problem) => (
            <ErrorNote key={`${problem.path}:${problem.error}`}>
              <span className="font-mono text-[0.8125rem] break-all">{problem.path}</span>
              <span className="block">{problem.error}</span>
            </ErrorNote>
          ))}
        </div>
      )}
      {report.imported.length > 0 && (
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {report.imported.map((id) => <li key={id}><TextLink to={historyLink(id)}>{id}</TextLink></li>)}
        </ul>
      )}
      {report.removed.length > 0 && (
        <p className="text-muted-foreground">
          Removed because their bundle directory is gone: <span className="font-mono text-[0.8125rem]">{report.removed.join(', ')}</span>
        </p>
      )}
    </div>
  )
}

export function SettingsPanel() {
  const library = useLibrary()
  const [attempt, setAttempt] = useState(0)
  const health = useAsync(`health:${attempt}`, getHealth)
  const [rescan, setRescan] = useState<{ state: 'idle' | 'busy' } | { state: 'done'; report: ReindexReport } | { state: 'error'; message: string }>({ state: 'idle' })

  async function rescanNow() {
    setRescan({ state: 'busy' })
    try {
      const report = await reindexExperiments()
      await refreshLibrary()
      setRescan({ state: 'done', report })
      setAttempt((n) => n + 1)
    } catch (e) {
      setRescan({ state: 'error', message: errorMessage(e, 'The backend could not rescan.') })
    }
  }

  const report = rescan.state === 'done' ? rescan.report : health.state === 'ok' ? health.data.reindex : null

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Connection"
        description="Build configuration and the current answer from the backend."
        actions={<Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>Check again</Button>}
      >
        <dl>
          <Row label="API base URL" value={<Code>{API_BASE_URL}</Code>}
            hint="Set with VITE_API_BASE_URL. In development the dev server forwards /api to the backend on port 8000." />
          <Row label="Mock mode" value={USE_MOCKS ? 'on' : 'off'}
            hint={USE_MOCKS
              ? 'Responses are synthetic fixtures, not the backend. Set VITE_USE_MOCKS=false to use real data.'
              : 'Responses come from the backend. Set VITE_USE_MOCKS=true to see the layout with synthetic fixtures instead.'} />
          <Row
            label="Backend"
            value={health.state === 'ok'
              ? `reachable: ${plural(library.experiments.length, 'experiment')}, ${plural(library.structures.length, 'structure')}`
              : health.state === 'error' ? `unreachable: ${errorMessage(health.error, 'no answer')}`
                : 'checking…'}
            hint={health.state === 'error' ? <>Start it with <Code>./run.sh</Code> in <Code>backend/</Code>, then check again.</> : undefined}
          />
          {health.state === 'ok' && (
            <>
              <Row label="Data directory" value={<Code>{health.data.data_dir}</Code>}
                hint="Structures, PAE files, experiment bundles and the SQLite index live here." />
              <Row label="Model runners" value={health.data.runners.length > 0 ? health.data.runners.join(', ') : 'none registered'}
                hint="This backend does not run models itself. Design runs happen on the cluster and arrive as bundles." />
            </>
          )}
        </dl>
      </Card>

      <Card
        title="Experiment bundles"
        description={<>Bundles are read from <Code>data/experiments/</Code> when the backend starts, and the structures each one lists are registered at the same time.</>}
        actions={<Button variant="outline" size="sm" disabled={rescan.state === 'busy'} onClick={rescanNow}>{rescan.state === 'busy' ? 'Rescanning…' : 'Rescan now'}</Button>}
      >
        <div className="space-y-3">
          {rescan.state === 'error' && <ErrorNote>{rescan.message}</ErrorNote>}
          {report ? <ReindexSummary report={report} />
            : health.state === 'error' ? <Note>Not available while the backend cannot be reached.</Note>
              : <Loading>Asking the backend…</Loading>}
          <Note className="max-w-[90ch]">
            To add a bundle exported on the cluster, run <Code>python3 scripts/hpc_import_bundle.py &lt;bundle.tar.gz&gt;</Code> from
            the repository root. It unpacks the bundle into place and asks the running backend to rescan, so nothing needs
            restarting.
          </Note>
        </div>
      </Card>
    </div>
  )
}
