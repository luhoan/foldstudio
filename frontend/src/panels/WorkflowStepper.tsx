import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { experimentIdOf } from '@/api'
import type { Experiment, Structure, WorkflowStage } from '@/api'
import { ExperimentStructures, StageStatus, ValueView } from './ExperimentDetail'
import { formatDate, formatSeconds, inputClass } from './format'
import { useLibrary } from './library'
import { historyLink } from './links'
import { Card, Code, EmptyState, ErrorNote, KindBadge, Loading, Note, Stat, StatusBadge, TextLink } from './ui'

/**
 * What each stage of a design run does and, more to the point, what its output can and cannot be
 * taken to show. Fixed text: it describes the method, not any particular run.
 */
const GUIDE: Record<string, { does: string; can: string; cannot: string }> = {
  Structure: {
    does: 'An input structure, when the design starts from one.',
    can: 'Fix which file was used, by its hash and parsed chains.',
    cannot: 'Say anything about function or about how good the input is.',
  },
  'Backbone generation': {
    does: 'RFdiffusion generates backbone coordinates with no sequence.',
    can: 'Propose a backbone geometry.',
    cannot: 'Show that any sequence folds into it. A backbone carries no confidence of its own.',
  },
  'Sequence design': {
    does: 'ProteinMPNN proposes amino-acid sequences for a backbone.',
    can: 'Rank sequences by the model\'s own score for that backbone.',
    cannot: 'Establish expression, stability or function.',
  },
  'Structure prediction': {
    does: 'ESMFold predicts a structure from each designed sequence alone.',
    can: 'Give the predictor\'s confidence (pLDDT, PAE) in its own model.',
    cannot: 'Stand in for an experiment. pLDDT and PAE are not validation.',
  },
  Evaluation: {
    does: 'Metrics computed from the files the run produced.',
    can: 'Report how closely a prediction matches the backbone it was designed for.',
    cannot: 'Establish binding, affinity, efficacy or safety.',
  },
  'Candidate review': {
    does: 'A person looks at the candidates in this app.',
    can: 'Record what was inspected.',
    cannot: 'Replace laboratory testing. Nothing here is a therapeutic claim.',
  },
}

const STAGE_ORDER = ['Structure', 'Backbone generation', 'Sequence design', 'Structure prediction', 'Evaluation', 'Candidate review']

/** Evaluation metrics shown as headline figures when the run measured them. */
const HEADLINE: Array<{ key: string; label: string; unit?: string }> = [
  { key: 'self_consistency_ca_rmsd_best', label: 'Best self-consistency RMSD', unit: 'Å' },
  { key: 'predicted_best_mean_plddt', label: 'Best mean pLDDT' },
  { key: 'mpnn_best_score', label: 'Best ProteinMPNN score' },
  { key: 'n_backbones', label: 'Backbones' },
  { key: 'n_sequences_designed', label: 'Sequences designed' },
  { key: 'n_predicted_structures', label: 'Structures predicted' },
]

function isPipelineRun(experiment: Experiment): boolean {
  return Array.isArray(experiment.workflow) && experiment.workflow.length > 0
}

/** Which registered structures a stage produced: backbones carry no declared source, predictions are "predicted". */
const STAGE_SOURCE: Record<string, Structure['source']> = {
  'Backbone generation': 'uploaded',
  'Structure prediction': 'predicted',
}

function StageCard({ index, last, name, stage, experiment, structures }: {
  index: number
  last: boolean
  name: string
  stage: WorkflowStage | null
  experiment: Experiment | null
  structures: Structure[]
}) {
  const guide = GUIDE[name]
  const source = STAGE_SOURCE[name]
  const hasProduced = experiment !== null && source !== undefined
    && structures.some((s) => experimentIdOf(s) === experiment.id && s.source === source)
  const facts = stage
    ? [
        stage.wall_seconds !== null && stage.wall_seconds !== undefined ? `ran for ${formatSeconds(stage.wall_seconds)}` : null,
        stage.outputs ? `${stage.outputs} output${stage.outputs === 1 ? '' : 's'}` : null,
        stage.preemptions ? `preempted ${stage.preemptions} time${stage.preemptions === 1 ? '' : 's'} and resumed` : null,
      ].filter((fact): fact is string => fact !== null)
    : []

  return (
    <li className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-4 pb-7 last:pb-0">
      {/* the rail joining one stage to the next */}
      {!last && <span aria-hidden className="absolute top-8 bottom-0 left-4 w-px -translate-x-1/2 bg-border" />}
      <span
        aria-hidden
        className={`flex size-8 items-center justify-center rounded-full border text-sm font-semibold ${
          stage?.status === 'executed' ? 'border-primary/60 bg-primary/10 text-primary'
            : stage?.status === 'failed' ? 'border-bad/50 bg-bad/10 text-bad'
              : 'border-input text-muted-foreground'
        }`}
      >
        {index + 1}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-base font-semibold">{name}</h3>
          {stage ? <StageStatus stage={stage} /> : null}
          {facts.length > 0 && <span className="text-sm text-muted-foreground">{facts.join(', ')}</span>}
        </div>
        {guide && <p className="mt-1 text-sm text-muted-foreground">{guide.does}</p>}
        {stage?.error && <div className="mt-2"><ErrorNote>{stage.error}</ErrorNote></div>}
        {stage?.note && <p className="mt-2 max-w-[80ch] text-sm">{stage.note}</p>}
        {experiment && hasProduced && (
          <div className="mt-2 max-w-3xl rounded-md border border-border px-3">
            <ExperimentStructures experiment={experiment} structures={structures} source={source} />
          </div>
        )}
        {guide && (
          <dl className="mt-2.5 grid max-w-[90ch] gap-x-4 gap-y-0.5 text-[0.8125rem] sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Can show</dt>
            <dd>{guide.can}</dd>
            <dt className="text-muted-foreground">Cannot show</dt>
            <dd>{guide.cannot}</dd>
          </dl>
        )}
      </div>
    </li>
  )
}

/**
 * The Design Workspace: one pipeline run, stage by stage, read from the `workflow` block its
 * bundle carries. A stage's status is whatever the pipeline recorded; nothing here upgrades it.
 */
export function WorkflowStepper() {
  const library = useLibrary()
  const [params, setParams] = useSearchParams()
  const runs = useMemo(
    () => library.experiments.filter(isPipelineRun).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    [library.experiments],
  )
  const requested = params.get('run')
  const run = runs.find((e) => e.id === requested) ?? runs.find((e) => e.kind === 'executed') ?? runs[0] ?? null
  const stages = run?.workflow ?? []
  const known = new Map(stages.map((s) => [s.stage, s]))
  const names = run ? [...new Set([...STAGE_ORDER.filter((n) => known.has(n)), ...stages.map((s) => s.stage)])] : STAGE_ORDER
  const headline = run ? HEADLINE.filter(({ key }) => key in run.metrics) : []
  const unavailable = Object.entries(run?.metrics_unavailable ?? {})
  const definitions = run?.metric_definitions ?? {}

  if (library.status !== 'ready') return <Loading>Loading runs…</Loading>

  return (
    <div className="flex flex-col gap-4">
      {library.error && <ErrorNote>{library.error}</ErrorNote>}

      {run ? (
        <Card
          title={<span className="font-mono text-[0.95rem] break-all">{run.id}</span>}
          description={`${run.model_name}. Recorded ${formatDate(run.created_at)}.`}
          actions={runs.length > 1 && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Run
              <select aria-label="Run" className={inputClass} value={run.id} onChange={(e) => setParams({ run: e.target.value }, { replace: true })}>
                {runs.map((e) => <option key={e.id} value={e.id}>{e.id} ({e.kind}, {e.status})</option>)}
              </select>
            </label>
          )}
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <KindBadge kind={run.kind} />
              <StatusBadge status={run.status} />
              <TextLink to={historyLink(run.id)}>Open the full record</TextLink>
            </div>
            {requested && requested !== run.id && (
              <ErrorNote>Run <Code>{requested}</Code> is not loaded. Showing {run.id} instead.</ErrorNote>
            )}
            {run.error && <ErrorNote>{run.error}</ErrorNote>}
            {run.kind !== 'executed' && (
              <Note>
                This record is {run.kind === 'demo' ? 'a demo: no model was run to produce it' : 'imported: it was not run on this installation'}.
              </Note>
            )}
            {headline.length > 0 && (
              <dl className="grid grid-cols-2 gap-x-8 gap-y-5 border-t border-border pt-4 md:grid-cols-3">
                {headline.map(({ key, label, unit }) => (
                  <Stat key={key} label={label} unit={unit} value={<ValueView value={run.metrics[key]} />} hint={definitions[key]} />
                ))}
              </dl>
            )}
            {unavailable.length > 0 && (
              <div className="border-t border-border pt-4">
                <h3 className="mb-1.5 text-sm font-semibold">Not measured in this run</h3>
                <ul className="space-y-1 text-sm">
                  {unavailable.map(([name, reason]) => (
                    <li key={name}><span className="font-mono text-[0.8125rem]">{name}</span><span className="text-muted-foreground">: {reason}</span></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      ) : (
        <EmptyState title="No pipeline run loaded yet">
          This page follows a design run through its stages. Export a bundle on the cluster
          with <Code>bash hpc/run_pipeline.sh export</Code>, copy the tarball here, and
          run <Code>python3 scripts/hpc_import_bundle.py &lt;bundle.tar.gz&gt;</Code>. Until then, the stages below
          describe what a run does.
        </EmptyState>
      )}

      <Card title="Stages" description={run ? 'Statuses are the ones the pipeline recorded for this run.' : 'What each stage does, and what its output can and cannot show.'}>
        <ol>
          {names.map((name, index) => (
            <StageCard key={name} index={index} last={index === names.length - 1} name={name} stage={known.get(name) ?? null} experiment={run} structures={library.structures} />
          ))}
        </ol>
      </Card>
    </div>
  )
}
