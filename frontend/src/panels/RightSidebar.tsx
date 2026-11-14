import { useEffect, useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  getExplanation, getPlddt, getResidues, listExperiments, listStructures,
} from '@/api'
import type { Experiment, PlddtPoint, ResidueRecord, Structure } from '@/api'
import { setActiveStructure, usePanelSelection } from './panelState'

function PanelCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function useSidebarData() {
  const [structures, setStructures] = useState<Structure[]>([])
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    Promise.all([listStructures(), listExperiments()])
      .then(([s, e]) => { if (alive) { setStructures(s); setExperiments(e) } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load sidebar data') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])
  return { structures, experiments, error, loading }
}

export function ConfidencePanel({ structureId, points }: {
  structureId: string | null
  points: PlddtPoint[]
}) {
  const bins = useMemo(() => {
    const labels = ['0–50', '50–70', '70–90', '90–100']
    const counts = [0, 0, 0, 0]
    for (const point of points) {
      const score = point.plddt
      if (score < 50) counts[0]++
      else if (score < 70) counts[1]++
      else if (score < 90) counts[2]++
      else counts[3]++
    }
    return labels.map((range, i) => ({ range, residues: counts[i] }))
  }, [points])

  return (
    <PanelCard title="Confidence (pLDDT)">
      {!structureId ? <p className="text-xs text-muted-foreground">Select a structure to inspect confidence.</p>
        : points.length === 0 ? <p className="text-xs text-muted-foreground">No pLDDT values are available.</p>
          : <>
            <div className="h-36" role="img" aria-label="pLDDT histogram">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bins}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="range" tick={{ fontSize: 10 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="residues" fill="#2dd4bf" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              pLDDT is a model-confidence estimate, not experimental validation.
            </p>
          </>}
    </PanelCard>
  )
}

export function StructuralMetricsPanel({ structure, experiments }: {
  structure: Structure | null
  experiments: Experiment[]
}) {
  const related = experiments.filter((e) =>
    e.inputs.includes(structure?.id ?? '') || e.outputs.includes(structure?.id ?? ''),
  )
  return (
    <PanelCard title="Structural metrics">
      {!structure ? <p className="text-xs text-muted-foreground">No structure selected.</p> : (
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div><dt className="text-muted-foreground">Residues</dt><dd className="font-mono">{structure.n_residues}</dd></div>
          <div><dt className="text-muted-foreground">Chains</dt><dd className="font-mono">{structure.chains.length}</dd></div>
          <div><dt className="text-muted-foreground">Format</dt><dd>{structure.format.toUpperCase()}</dd></div>
          <div><dt className="text-muted-foreground">Source</dt><dd>{structure.source}</dd></div>
          {related.flatMap((e) => Object.entries(e.metrics).map(([key, value]) => (
            <div key={`${e.id}-${key}`}><dt className="text-muted-foreground">{key}</dt><dd className="font-mono">{String(value ?? '—')}</dd></div>
          )))}
        </dl>
      )}
    </PanelCard>
  )
}

export function ResidueInfoPanel({ residues, selected }: {
  residues: ResidueRecord[]
  selected: { chain: string; seqId: number; compId?: string; insCode?: string } | null
}) {
  const residue = selected && residues.find((r) =>
    r.chain === selected.chain && r.seq_id === selected.seqId &&
    (!('insCode' in selected) || !selected.insCode || (r.ins_code ?? '') === selected.insCode),
  )
  return (
    <PanelCard title="Selected residue">
      {!selected ? <p className="text-xs text-muted-foreground">Click a residue in the viewer to inspect it.</p>
        : !residue ? <p className="text-xs text-muted-foreground">Residue {selected.chain}:{selected.seqId} is not in the loaded residue response.</p>
          : <dl className="grid grid-cols-2 gap-2 text-xs">
            <div><dt className="text-muted-foreground">Chain</dt><dd>{residue.chain}</dd></div>
            <div><dt className="text-muted-foreground">Position</dt><dd>{residue.seq_id}{residue.ins_code ?? ''}</dd></div>
            <div><dt className="text-muted-foreground">Residue</dt><dd>{residue.comp_id}</dd></div>
            <div><dt className="text-muted-foreground">pLDDT</dt><dd>{residue.plddt ?? 'Unavailable'}</dd></div>
          </dl>}
    </PanelCard>
  )
}

export function ExplanationPanel({ explanation, error }: {
  explanation: Awaited<ReturnType<typeof getExplanation>> | null
  error: string | null
}) {
  return (
    <PanelCard title="Scientific explanation">
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p>
        : !explanation ? <p className="text-xs text-muted-foreground">No explanation available.</p>
          : <>
            <p className="text-xs leading-relaxed">{explanation.summary}</p>
            <h4 className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Numbers used</h4>
            <dl className="mt-1 grid grid-cols-2 gap-2 text-xs">
              {Object.entries(explanation.numbers_used).map(([key, value]) => (
                <div key={key}><dt className="text-muted-foreground">{key}</dt><dd className="font-mono">{String(value ?? '—')}</dd></div>
              ))}
            </dl>
            {explanation.limitations?.map((item) => <p key={item} className="mt-2 text-[11px] text-muted-foreground">{item}</p>)}
          </>}
    </PanelCard>
  )
}

export function ProvenancePanel({ experiments }: { experiments: Experiment[] }) {
  return (
    <PanelCard title="Model provenance">
      {experiments.length === 0 ? <p className="text-xs text-muted-foreground">No experiment provenance is available.</p>
        : experiments.map((experiment) => (
          <div key={experiment.id} className="mb-2 border-b border-border pb-2 last:mb-0 last:border-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">{experiment.model_name}</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase">
                {experiment.kind}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{experiment.provenance.source} · {experiment.status}</p>
            <p className="text-[11px] text-muted-foreground">{experiment.provenance.notes}</p>
          </div>
        ))}
    </PanelCard>
  )
}

export function RightSidebar() {
  const { structures, experiments, error, loading } = useSidebarData()
  const { activeStructureId, selectedResidue } = usePanelSelection()
  const selectedId = activeStructureId ?? structures[0]?.id ?? null
  const structure = structures.find((s) => s.id === selectedId) ?? null
  const [points, setPoints] = useState<PlddtPoint[]>([])
  const [residues, setResidues] = useState<ResidueRecord[]>([])
  const [explanation, setExplanation] = useState<Awaited<ReturnType<typeof getExplanation>> | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedId) return
    setActiveStructure(selectedId)
    let alive = true
    setPoints([])
    setResidues([])
    setExplanation(null)
    setDetailError(null)
    Promise.allSettled([getPlddt(selectedId), getResidues(selectedId), getExplanation({ structure: selectedId })])
      .then(([p, r, x]) => {
        if (!alive) return
        if (p.status === 'fulfilled') setPoints(p.value.residues ?? [])
        if (r.status === 'fulfilled') setResidues(r.value.residues ?? [])
        if (x.status === 'fulfilled') setExplanation(x.value)
        const failures = [p, r, x].filter((result) => result.status === 'rejected') as PromiseRejectedResult[]
        if (failures.length) setDetailError(failures.map(({ reason }) =>
          reason instanceof Error ? reason.message : 'Unable to load one or more structure details',
        ).join('; '))
      })
    return () => { alive = false }
  }, [selectedId])

  if (loading) return <div role="status" className="text-xs text-muted-foreground">Loading structure details…</div>
  if (error) return <div role="alert" className="rounded border border-destructive/40 p-3 text-xs text-destructive">{error}</div>
  if (!structures.length) return <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">No structures loaded. Upload or fetch a structure to begin.</div>

  return (
    <div className="flex flex-col gap-3">
      <label className="text-xs text-muted-foreground">
        Active structure
        <select className="mt-1 w-full rounded-md border border-border bg-background p-2 text-xs text-foreground"
          value={selectedId ?? ''} onChange={(e) => setActiveStructure(e.target.value)}>
          {structures.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      {detailError && <p role="alert" className="text-xs text-destructive">{detailError}</p>}
      <ConfidencePanel structureId={selectedId} points={points} />
      <StructuralMetricsPanel structure={structure} experiments={experiments} />
      <ResidueInfoPanel residues={residues} selected={selectedResidue?.structureId === selectedId ? selectedResidue : null} />
      <ExplanationPanel explanation={explanation} error={detailError} />
      <ProvenancePanel experiments={experiments.filter((e) =>
        e.inputs.includes(selectedId ?? '') || e.outputs.includes(selectedId ?? ''),
      )} />
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        pLDDT and PAE are model-confidence estimates. They do not establish folding, binding, affinity, efficacy, or safety. FoldStudio is not a clinical tool.
      </p>
    </div>
  )
}
