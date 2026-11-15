import type { Experiment, Structure } from '@/api'
import { StageStatus, ValueView } from './ExperimentDetail'
import { formatDate, kindMeaning, sourceLabel, sourceMeaning } from './format'
import { useLibrary } from './library'
import { designLink, explorerLink, historyLink } from './links'
import { Card, Code, EmptyState, ErrorNote, KindBadge, Loading, Note, SourceBadge, Stat, StatusBadge, TextLink } from './ui'

/**
 * Overview of what is actually loaded.
 *
 * Every number here is a count of real records returned by the API, or a metric a run recorded.
 * Nothing is a target, a projection or a placeholder: if a bucket is zero it is shown as zero,
 * because an empty dashboard is information and an invented one is not.
 *
 * The provenance breakdown is the point of the page. "imported" and "demo" records came from
 * somewhere else; only "executed" means this installation ran the pipeline and produced the files.
 */

const KINDS = ['executed', 'imported', 'demo'] as const
const SOURCES = ['predicted', 'experimental', 'uploaded'] as const

const RUN_FIGURES: Array<{ key: string; label: string; unit?: string }> = [
  { key: 'self_consistency_ca_rmsd_best', label: 'Best self-consistency RMSD', unit: 'Å' },
  { key: 'predicted_best_mean_plddt', label: 'Best mean pLDDT' },
  { key: 'n_predicted_structures', label: 'Structures predicted' },
]

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1
  return out
}

function byNewest<T extends { created_at: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

/** The newest pipeline run, with every stage and the status the pipeline recorded for it. */
function LatestRun({ run }: { run: Experiment }) {
  const stages = run.workflow ?? []
  const figures = RUN_FIGURES.filter(({ key }) => key in run.metrics)
  const definitions = run.metric_definitions ?? {}
  return (
    <Card
      title="Latest design run"
      description={`${run.model_name}. Recorded ${formatDate(run.created_at)}.`}
      actions={<><KindBadge kind={run.kind} /><StatusBadge status={run.status} /></>}
    >
      <div className="space-y-5">
        <p className="font-mono text-sm break-all text-muted-foreground">{run.id}</p>
        {run.error && <ErrorNote>{run.error}</ErrorNote>}
        {run.kind !== 'executed' && (
          <Note>This record is {run.kind === 'demo' ? 'a demo: no model was run to produce it' : 'imported: it was not run on this installation'}.</Note>
        )}

        <ol className="grid gap-x-3 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
          {stages.map((stage, index) => (
            <li key={stage.stage} className="relative border-t-2 border-border pt-3">
              <span className="block text-xs text-muted-foreground">Stage {index + 1}</span>
              {/* two lines reserved in the six-across layout, so every badge sits on the same line */}
              <span className="block font-medium xl:min-h-[2.75rem]">{stage.stage}</span>
              <span className="mt-1.5 block"><StageStatus stage={stage} /></span>
              {stage.error && <span className="mt-1.5 block text-xs text-muted-foreground">{stage.error}</span>}
            </li>
          ))}
        </ol>

        {figures.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-5 border-t border-border pt-4 md:grid-cols-3">
            {figures.map(({ key, label, unit }) => (
              <Stat key={key} label={label} unit={unit} value={<ValueView value={run.metrics[key]} />} hint={definitions[key]} />
            ))}
          </dl>
        )}

        <p className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <TextLink to={designLink(run.id)}>Follow this run stage by stage</TextLink>
          <TextLink to={historyLink(run.id)}>Open the full record</TextLink>
        </p>
      </div>
    </Card>
  )
}

function Counts({ experiments, structures }: { experiments: Experiment[]; structures: Structure[] }) {
  const byKind = countBy(experiments, (e) => e.kind)
  const bySource = countBy(structures, (s) => s.source)
  return (
    <Card title="What is loaded" description="Counts of the records the backend holds right now. Nothing here is projected.">
      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <h3 className="mb-3 text-sm font-semibold">{experiments.length} experiment record{experiments.length === 1 ? '' : 's'}, by provenance</h3>
          <dl className="grid grid-cols-3 gap-x-6 gap-y-4">
            {KINDS.map((kind) => <Stat key={kind} label={kind} value={byKind[kind] ?? 0} hint={kindMeaning(kind)} />)}
          </dl>
        </section>
        <section>
          <h3 className="mb-3 text-sm font-semibold">{structures.length} structure{structures.length === 1 ? '' : 's'}, by source</h3>
          <dl className="grid grid-cols-3 gap-x-6 gap-y-4">
            {SOURCES.map((source) => <Stat key={source} label={sourceLabel(source)} value={bySource[source] ?? 0} hint={sourceMeaning(source)} />)}
          </dl>
        </section>
      </div>
    </Card>
  )
}

export function Dashboard() {
  const library = useLibrary()
  if (library.status !== 'ready') return <Loading>Loading…</Loading>

  const { experiments, structures } = library
  const runs = byNewest(experiments.filter((e) => Array.isArray(e.workflow) && e.workflow.length > 0))
  const latestRun = runs.find((e) => e.kind === 'executed') ?? runs[0] ?? null
  const attention = experiments.filter((e) => e.status === 'failed' || e.status === 'partial')
  const recentStructures = byNewest(structures).slice(0, 6)
  const empty = experiments.length === 0 && structures.length === 0

  return (
    <div className="flex flex-col gap-4">
      {library.error && <ErrorNote>{library.error}</ErrorNote>}

      {empty && !library.error && (
        <EmptyState title="Nothing is loaded yet">
          Download the reference set with <Code>python3 scripts/fetch_demo_data.py</Code>, or import a pipeline bundle
          with <Code>python3 scripts/hpc_import_bundle.py &lt;bundle.tar.gz&gt;</Code>. Then press the reload button
          at the top of the page, or restart the backend.
        </EmptyState>
      )}

      {latestRun && <LatestRun run={latestRun} />}

      <Counts experiments={experiments} structures={structures} />

      {attention.length > 0 && (
        <Card title="Needs attention" description="Records that ended failed or partial, with the error they recorded.">
          <ul className="divide-y divide-border/60">
            {attention.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 text-sm">
                <TextLink to={historyLink(e.id)}>{e.id}</TextLink>
                <StatusBadge status={e.status} />
                <span className="min-w-0 flex-1 text-muted-foreground">{e.error ?? 'No error text was recorded.'}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {recentStructures.length > 0 && (
        <Card title="Structures" description={structures.length > recentStructures.length ? `The ${recentStructures.length} most recently added of ${structures.length}.` : undefined}>
          <ul className="divide-y divide-border/60">
            {recentStructures.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
                <span className="min-w-0 flex-1 font-medium break-words">{s.label}</span>
                <SourceBadge source={s.source} />
                <span className="text-muted-foreground">{s.n_residues} residues</span>
                {s.format !== 'fasta' && <TextLink to={explorerLink(s.id)}>View in 3D</TextLink>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Note className="max-w-[95ch]">
        Confidence scores and structural predictions are model estimates. They do not establish folding, binding
        affinity, efficacy or safety. Not a clinical tool.
      </Note>
    </div>
  )
}
