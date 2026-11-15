import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { compareExperiments } from '@/api'
import type { CompareResponse, CompareRow } from '@/api'
import { ValueView } from './ExperimentDetail'
import { errorMessage } from './format'
import { useLibrary } from './library'
import { historyLink } from './links'
import { Card, EmptyState, ErrorNote, KindBadge, Loading, Note, StatusBadge, TextLink } from './ui'
import { useAsync } from './useAsync'

const SECTIONS: Array<{ key: 'fields' | 'settings' | 'metrics'; title: string }> = [
  { key: 'fields', title: 'Record' },
  { key: 'settings', title: 'Settings' },
  { key: 'metrics', title: 'Metrics' },
]

function ComparisonTable({ result, onlyDiffering }: { result: CompareResponse; onlyDiffering: boolean }) {
  const ids = result.ids
  const visible = (rows: CompareRow[]) => (onlyDiffering ? rows.filter((r) => r.differs) : rows)
  const anything = SECTIONS.some(({ key }) => visible(result[key]).length > 0)
  if (!anything) return <Note>No row differs between these records.</Note>
  return (
    <div className="overflow-x-auto">
      <table className="fs-table table-fixed" style={{ minWidth: `${14 + ids.length * 13}rem` }}>
        <colgroup>
          <col style={{ width: '14rem' }} />
          {ids.map((id) => <col key={id} />)}
          {!onlyDiffering && <col style={{ width: '5rem' }} />}
        </colgroup>
        <thead>
          <tr>
            <th>Field</th>
            {ids.map((id) => <th key={id} className="font-mono !whitespace-normal break-all">{id}</th>)}
            {!onlyDiffering && <th>Differs</th>}
          </tr>
        </thead>
        {SECTIONS.map(({ key, title }) => {
          const rows = visible(result[key])
          if (rows.length === 0) return null
          return (
            <tbody key={key}>
              <tr>
                <th colSpan={ids.length + (onlyDiffering ? 1 : 2)} scope="rowgroup" className="!border-b-0 !pt-4 !pb-1 text-left !text-foreground">{title}</th>
              </tr>
              {rows.map((row) => (
                <tr key={`${key}:${row.field}`}>
                  <td className="font-mono break-all">{row.field}</td>
                  {ids.map((id) => (
                    <td key={id} className={row.values[id] === null || row.values[id] === undefined ? 'text-muted-foreground' : 'break-words'}>
                      {row.values[id] === null || row.values[id] === undefined ? 'not recorded' : <ValueView value={row.values[id]} />}
                    </td>
                  ))}
                  {!onlyDiffering && <td className={row.differs ? 'font-medium' : 'text-muted-foreground'}>{row.differs ? 'yes' : 'no'}</td>}
                </tr>
              ))}
            </tbody>
          )
        })}
      </table>
    </div>
  )
}

/**
 * Comparison: two or more experiment records side by side. The backend lines the records up and
 * marks the rows that differ; a value one record does not have is shown as "not recorded", never
 * as zero. `?ids=a,b` opens the page with those records chosen.
 */
export function ExperimentComparison() {
  const library = useLibrary()
  const [params, setParams] = useSearchParams()
  const [onlyDiffering, setOnlyDiffering] = useState(true)
  const known = new Set(library.experiments.map((e) => e.id))
  const chosen = (params.get('ids') ?? '').split(',').filter((id) => id && known.has(id))
  const key = chosen.length >= 2 ? chosen.join(',') : null
  const result = useAsync(key, () => compareExperiments({ ids: chosen }))

  function toggle(id: string) {
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]
    setParams(next.length > 0 ? { ids: next.join(',') } : {}, { replace: true })
  }

  if (library.status !== 'ready') return <Loading>Loading experiment records…</Loading>
  if (library.experiments.length < 2) {
    return (
      <EmptyState title="Two records are needed to compare">
        {library.experiments.length === 0 ? 'There are no experiment records yet.' : 'There is only one experiment record so far.'}{' '}
        To compare two structures instead, use Structural Analysis.
      </EmptyState>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {library.error && <ErrorNote>{library.error}</ErrorNote>}
      <Card title="Choose records" description="Tick two or more. To superpose two structures, use Structural Analysis instead.">
        <ul className="divide-y divide-border/60">
          {library.experiments.map((e) => (
            <li key={e.id}>
              <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.includes(e.id)}
                  onChange={() => toggle(e.id)}
                  className="size-4 accent-[var(--primary)]"
                />
                <span className="font-mono break-all">{e.id}</span>
                <KindBadge kind={e.kind} />
                <StatusBadge status={e.status} />
                <span className="text-muted-foreground">{e.model_name}</span>
              </label>
            </li>
          ))}
        </ul>
      </Card>

      {chosen.length < 2 ? (
        <Note>Tick {chosen.length === 0 ? 'two records' : 'one more record'} to see them side by side.</Note>
      ) : result.state === 'error' ? (
        <Card title="The comparison could not be made">
          <ErrorNote>{errorMessage(result.error, 'The backend did not return a comparison.')}</ErrorNote>
        </Card>
      ) : result.state !== 'ok' ? (
        <Loading>Comparing…</Loading>
      ) : (
        <Card
          title="Side by side"
          actions={
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={onlyDiffering} onChange={(e) => setOnlyDiffering(e.target.checked)} className="size-4 accent-[var(--primary)]" />
              Only rows that differ
            </label>
          }
        >
          <div className="space-y-4">
            <ComparisonTable result={result.data} onlyDiffering={onlyDiffering} />
            <Note className="max-w-[90ch]">{result.data.note}</Note>
            <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              {result.data.ids.map((id) => <TextLink key={id} to={historyLink(id)}>Open {id}</TextLink>)}
            </p>
          </div>
        </Card>
      )}
    </div>
  )
}
