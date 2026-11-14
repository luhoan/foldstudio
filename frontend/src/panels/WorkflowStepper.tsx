import { useEffect, useMemo, useState } from 'react'
import { listExperiments } from '@/api'
import type { Experiment } from '@/api'

const stages = [
  { id: 'structure', title: 'Structure', model: 'Structure intake and validation', compute: 'CPU / none', input: 'PDB or mmCIF file / public accession', output: 'Validated structure record', can: 'Can establish file identity and parsed chains.', cannot: 'Cannot establish biological function or experimental validity.' },
  { id: 'backbone_generation', title: 'Backbone generation', model: 'Backbone model', compute: 'GPU commonly required; optional external precomputed result', input: 'Target / design constraints', output: 'Candidate backbone coordinates', can: 'Can produce a computational backbone proposal.', cannot: 'Cannot establish folding, binding, or function.' },
  { id: 'sequence_design', title: 'Sequence design', model: 'Sequence-design model', compute: 'GPU commonly required; optional external precomputed result', input: 'Backbone coordinates', output: 'Candidate amino-acid sequence', can: 'Can propose sequences compatible with model constraints.', cannot: 'Cannot establish expression, stability, or efficacy.' },
  { id: 'structure_prediction', title: 'Structure prediction', model: 'Structure-prediction model', compute: 'GPU or imported public prediction', input: 'Candidate sequence', output: 'Predicted coordinates and confidence estimates', can: 'Can estimate structural confidence.', cannot: 'pLDDT / PAE are not experimental validation.' },
  { id: 'evaluation', title: 'Evaluation', model: 'Structural analysis / explainability', compute: 'CPU', input: 'Structures and confidence outputs', output: 'Alignment, metrics, and explanations', can: 'Can report explicitly computed metrics.', cannot: 'Cannot establish binding affinity, safety, or clinical utility.' },
  { id: 'candidate_review', title: 'Candidate review', model: 'Human review of curated public complexes', compute: 'CPU / human review', input: 'Precomputed public complex and documented interface', output: 'Review notes and interface visualization', can: 'Can help inspect documented public data.', cannot: 'Does not generate novel therapeutic binders or validate a treatment.' },
] as const

type StageStatus = 'not started' | 'imported' | 'executed' | 'failed'

function stageFor(experiment: Experiment) {
  const stage = experiment.settings.workflow_stage ?? experiment.settings.stage
  return typeof stage === 'string' ? stage : ''
}

function statusFor(experiments: Experiment[], stage: string): { status: StageStatus; experiment?: Experiment } {
  const match = experiments.find((e) => stageFor(e) === stage)
  if (!match) return { status: 'not started' }
  if (match.status === 'failed') return { status: 'failed', experiment: match }
  return { status: match.kind === 'imported' ? 'imported' : 'executed', experiment: match }
}

export function WorkflowStepper() {
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    listExperiments().then((items) => { if (alive) setExperiments(items) })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Unable to load workflow records') })
    return () => { alive = false }
  }, [])

  const cards = useMemo(() => stages.map((stage) => ({ ...stage, ...statusFor(experiments, stage.id) })), [experiments])

  return (
    <section className="space-y-3">
      <header><h2 className="text-base font-semibold">Workflow</h2>
        <p className="text-xs text-muted-foreground">Statuses are derived only from experiment records. Missing records remain not started.</p></header>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <ol className="grid gap-3 lg:grid-cols-2">
        {cards.map((stage, index) => (
          <li key={stage.id} className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{index + 1}. {stage.title}</h3>
              <span className={`rounded-full border px-2 py-1 text-[10px] uppercase ${stage.status === 'failed' ? 'border-destructive/50 text-destructive' : 'border-border text-muted-foreground'}`}>{stage.status}</span>
            </div>
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              <div><dt className="text-muted-foreground">Model / method</dt><dd>{stage.model}</dd></div>
              <div><dt className="text-muted-foreground">Compute</dt><dd>{stage.compute}</dd></div>
              <div><dt className="text-muted-foreground">Input</dt><dd>{stage.input}</dd></div>
              <div><dt className="text-muted-foreground">Output</dt><dd>{stage.output}</dd></div>
            </dl>
            <div className="mt-3 space-y-1 text-xs"><p><strong>Can conclude:</strong> {stage.can}</p><p><strong>Cannot conclude:</strong> {stage.cannot}</p></div>
            {stage.experiment && <div className="mt-3 rounded bg-muted p-2 text-xs">
              <p>{stage.experiment.model_name} · {stage.experiment.kind} · {stage.experiment.status}</p>
              {stage.experiment.error && <p role="alert" className="mt-1 text-destructive">{stage.experiment.error}</p>}
              <p className="mt-1 text-muted-foreground">Inputs: {stage.experiment.inputs.join(', ') || '—'} · Outputs: {stage.experiment.outputs.join(', ') || '—'}</p>
            </div>}
          </li>
        ))}
      </ol>
    </section>
  )
}
