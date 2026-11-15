import type { ReactNode } from 'react'
import { describeValue, experimentIdOf, isScalar, outputPath } from '@/api'
import type { Experiment, ExperimentOutput, Structure, WorkflowStage } from '@/api'
import { formatDate, formatSeconds } from './format'
import { analysisLink, explorerLink } from './links'
import { Badge, Code, ErrorNote, Note, SourceBadge, TextLink } from './ui'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A metric or setting value. Mostly a number or a word, but a producer may record a list of
 * records (per-interface contact counts, for one), which is shown as a small table rather than
 * squeezed into a cell as "[object Object]".
 */
export function ValueView({ value }: { value: unknown }) {
  if (isScalar(value) || value === undefined) return <>{describeValue(value)}</>
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return <>{describeValue(value)}</>
    if (value.every(isRecord)) {
      // One block per record, stacked: it reads the same in a wide detail view and a narrow table cell.
      return (
        <div className="space-y-2">
          {value.map((row, i) => (
            <dl key={i} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-l-2 border-border pl-2.5 text-[0.8125rem]">
              {Object.entries(row).map(([key, inner]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{key.replaceAll('_', ' ')}</dt>
                  <dd className="break-words">{isScalar(inner) ? describeValue(inner) : JSON.stringify(inner)}</dd>
                </div>
              ))}
            </dl>
          ))}
        </div>
      )
    }
    return <>{value.map((item) => (isScalar(item) ? describeValue(item) : JSON.stringify(item))).join(', ')}</>
  }
  if (isRecord(value)) {
    return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-[0.8125rem]">
        {Object.entries(value).map(([key, inner]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{key.replaceAll('_', ' ')}</dt>
            <dd className="break-words">{isScalar(inner) ? describeValue(inner) : JSON.stringify(inner)}</dd>
          </div>
        ))}
      </dl>
    )
  }
  return <>{String(value)}</>
}

type StageTone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent'

const STAGE_TONE: Record<string, StageTone> = {
  executed: 'accent',
  imported: 'info',
  demo: 'neutral',
  failed: 'bad',
  partial: 'warn',
  not_started: 'neutral',
}

/** A pipeline stage's status, in the pipeline's own words. */
export function StageStatus({ stage }: { stage: WorkflowStage }) {
  return (
    <span data-stage-status={stage.status}>
      <Badge tone={STAGE_TONE[stage.status] ?? 'neutral'}>{stage.status_label ?? stage.status.replaceAll('_', ' ')}</Badge>
    </span>
  )
}

export function StageTable({ stages }: { stages: WorkflowStage[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="fs-table">
        <thead>
          <tr><th>Stage</th><th>Status</th><th className="text-right">Wall time</th><th className="text-right">Outputs</th><th className="text-right">Preemptions</th><th>Note</th></tr>
        </thead>
        <tbody>
          {stages.map((stage) => (
            <tr key={stage.stage}>
              <td className="font-medium whitespace-nowrap">{stage.stage}</td>
              <td><StageStatus stage={stage} /></td>
              <td className="text-right whitespace-nowrap">{formatSeconds(stage.wall_seconds)}</td>
              <td className="text-right">{stage.outputs ?? 0}</td>
              <td className="text-right">{stage.preemptions ?? 0}</td>
              <td className="max-w-[42ch] text-muted-foreground">
                {stage.error && <span className="block text-foreground">{stage.error}</span>}
                {stage.note}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Block({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-sm font-semibold">{title}</h4>
      {note && <Note className="mb-2">{note}</Note>}
      {children}
    </section>
  )
}

function OutputRow({ output }: { output: ExperimentOutput }) {
  const path = outputPath(output)
  const extra = typeof output === 'string' ? null : [output.type, output.label].filter(Boolean).join(', ')
  return (
    <li className="break-all">
      <span className="font-mono text-[0.8125rem]">{path}</span>
      {extra && <span className="text-muted-foreground"> ({extra})</span>}
    </li>
  )
}

/** The structures the backend registered from this experiment, with links into the 3D view. */
export function ExperimentStructures({ experiment, structures, source }: {
  experiment: Experiment
  structures: Structure[]
  /** List only the structures of this kind (their backbones are still found among all of them). */
  source?: Structure['source']
}) {
  const all = structures.filter((s) => experimentIdOf(s) === experiment.id)
  const mine = source ? all.filter((s) => s.source === source) : all
  if (mine.length === 0) return null
  const byOrigin = new Map(all.map((s) => [s.origin_id, s]))
  // For a pipeline run, a prediction can be compared with the backbone it was designed for. The
  // pairing is the one the bundle states (per_design[].scrmsd.backbone); nothing is guessed.
  const backboneFor = new Map<string, Structure>()
  for (const design of experiment.per_design ?? []) {
    const file = typeof design.file === 'string' ? design.file.split('/').pop() : undefined
    const predicted = file ? byOrigin.get(`${experiment.id}:${file}`) : undefined
    const backbone = design.scrmsd?.backbone ? byOrigin.get(`${experiment.id}:${design.scrmsd.backbone}`) : undefined
    if (predicted && backbone) backboneFor.set(predicted.id, backbone)
  }
  return (
    <ul className="divide-y divide-border/60">
      {mine.map((s) => {
        const backbone = backboneFor.get(s.id)
        return (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
            <span className="min-w-0 flex-1 font-medium break-words">{s.label}</span>
            <SourceBadge source={s.source} />
            {s.format !== 'fasta' && <TextLink to={explorerLink(s.id)}>View in 3D</TextLink>}
            {backbone && <TextLink to={analysisLink(s.id, backbone.id)}>Compare with its backbone</TextLink>}
          </li>
        )
      })}
    </ul>
  )
}

/** Everything one experiment record says about itself. Nothing is derived that the record does not state. */
export function ExperimentDetail({ experiment, structures }: { experiment: Experiment; structures: Structure[] }) {
  const { provenance } = experiment
  const metrics = Object.entries(experiment.metrics ?? {})
  const unavailable = Object.entries(experiment.metrics_unavailable ?? {})
  const settings = Object.entries(experiment.settings ?? {})
  const definitions = experiment.metric_definitions ?? {}
  const entry = experiment.entry
  const designs = experiment.per_design ?? []
  const hasStructures = structures.some((s) => experimentIdOf(s) === experiment.id)

  return (
    <div className="space-y-6 text-sm">
      {experiment.error && <ErrorNote>{experiment.error}</ErrorNote>}

      <Block title="Provenance">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5">
          <dt className="text-muted-foreground">Source</dt>
          <dd>
            {provenance.url
              ? <a className="fs-link" href={provenance.url} target="_blank" rel="noreferrer">{provenance.source}</a>
              : provenance.source}
          </dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd className="break-words">{experiment.model_name}{experiment.model_version ? `, version ${experiment.model_version}` : ''}</dd>
          <dt className="text-muted-foreground">Recorded</dt>
          <dd>{formatDate(experiment.created_at)}</dd>
          <dt className="text-muted-foreground">Retrieved</dt>
          <dd>{formatDate(provenance.retrieved_at)}</dd>
          {experiment.bundle && (
            <>
              <dt className="text-muted-foreground">Bundle</dt>
              <dd><Code>data/experiments/{experiment.bundle.dir}/</Code></dd>
            </>
          )}
        </dl>
        {provenance.notes && <Note className="mt-2 max-w-[90ch]">{provenance.notes}</Note>}
      </Block>

      {entry && (entry.title_from_entry || entry.reason || entry.method_from_entry) && (
        <Block title="What the database entry says about itself">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5">
            {entry.title_from_entry && (<><dt className="text-muted-foreground">Title</dt><dd>{entry.title_from_entry}</dd></>)}
            {entry.method_from_entry && (<><dt className="text-muted-foreground">Method</dt><dd>{entry.method_from_entry}</dd></>)}
            {entry.chain_descriptions_from_entry && Object.keys(entry.chain_descriptions_from_entry).length > 0 && (
              <>
                <dt className="text-muted-foreground">Chains</dt>
                <dd>{Object.entries(entry.chain_descriptions_from_entry).map(([chain, text]) => <span key={chain} className="block">{chain}: {String(text)}</span>)}</dd>
              </>
            )}
            {entry.reason && (<><dt className="text-muted-foreground">Why it is here</dt><dd>{entry.reason}</dd></>)}
          </dl>
        </Block>
      )}

      {experiment.workflow && experiment.workflow.length > 0 && (
        <Block title="Pipeline stages" note="A stage counts as executed only when it ran here and its output files exist.">
          <StageTable stages={experiment.workflow} />
        </Block>
      )}

      {hasStructures && (
        <Block title="Structures from this record">
          <ExperimentStructures experiment={experiment} structures={structures} />
        </Block>
      )}

      {metrics.length > 0 && (
        <Block title="Metrics">
          <div className="overflow-x-auto">
            <table className="fs-table">
              <thead><tr><th>Metric</th><th>Value</th><th>What it is</th></tr></thead>
              <tbody>
                {metrics.map(([name, value]) => (
                  <tr key={name}>
                    <td className="font-mono whitespace-nowrap">{name}</td>
                    <td className="font-medium"><ValueView value={value} /></td>
                    <td className="max-w-[52ch] text-muted-foreground">{definitions[name] ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      {unavailable.length > 0 && (
        <Block title="Metrics not measured" note="The run recorded that it could not measure these, and why. They are not zero; they are absent.">
          <div className="overflow-x-auto">
            <table className="fs-table">
              <thead><tr><th>Metric</th><th>Reason recorded by the run</th></tr></thead>
              <tbody>
                {unavailable.map(([name, reason]) => (
                  <tr key={name}><td className="font-mono whitespace-nowrap">{name}</td><td className="text-muted-foreground">{reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      {designs.length > 0 && (
        <Block title="Predicted designs" note="Self-consistency RMSD is between a predicted structure and the backbone it was designed for, on CA atoms after superposition.">
          <div className="overflow-x-auto">
            <table className="fs-table">
              <thead>
                <tr><th>Design</th><th className="text-right">Residues</th><th className="text-right">Mean pLDDT</th><th className="text-right">pTM</th><th className="text-right">Self-consistency RMSD</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {designs.map((design) => (
                  <tr key={design.name}>
                    <td className="font-mono whitespace-nowrap">{design.name}</td>
                    <td className="text-right">{design.n_residues ?? '—'}</td>
                    <td className="text-right">{typeof design.mean_plddt === 'number' ? design.mean_plddt.toFixed(1) : 'not measured'}</td>
                    <td className="text-right">{typeof design.ptm === 'number' ? design.ptm.toFixed(2) : 'not measured'}</td>
                    <td className="text-right whitespace-nowrap">
                      {typeof design.scrmsd?.rmsd === 'number'
                        ? `${design.scrmsd.rmsd.toFixed(2)} Å on ${design.scrmsd.aligned_atoms ?? '?'} CA`
                        : 'not measured'}
                    </td>
                    <td className="max-w-[46ch] text-muted-foreground">
                      {design.role === 'input_sequence' && <span className="block text-foreground">Fold of ProteinMPNN's input record, not a design. Left out of the run's metrics.</span>}
                      {design.note && <span className="block">{design.note}</span>}
                      {design.scrmsd?.rmsd === null && design.scrmsd.reason && <span className="block">RMSD: {design.scrmsd.reason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      {settings.length > 0 && (
        <Block title="Settings">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5">
            {settings.map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="font-mono text-[0.8125rem] text-muted-foreground">{name}</dt>
                <dd className="break-words"><ValueView value={value} /></dd>
              </div>
            ))}
          </dl>
        </Block>
      )}

      {experiment.outputs.length > 0 && (
        <Block title="Files">
          <ul className="space-y-0.5">
            {experiment.outputs.map((output) => <OutputRow key={outputPath(output)} output={output} />)}
          </ul>
        </Block>
      )}
    </div>
  )
}
