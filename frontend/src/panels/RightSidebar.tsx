import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ApiError, experimentIdOf } from '@/api'
import type { Experiment, PlddtResidue, Residue, Structure } from '@/api'
import { useViewerState } from '@/viewer'
import { bandOf } from './bands'
import { ConfidenceSummary } from './Confidence'
import { useExplanation, usePlddt, useResidues } from './details'
import { errorMessage, formatDate, inputClass, sourceMeaning } from './format'
import { useLibrary } from './library'
import { explorerLink, historyLink } from './links'
import { setActiveStructure, setSelectedResidue, usePanelState, type SelectedResidue } from './panelState'
import {
  Card, Code, EmptyState, ErrorNote, ExplainedText, KindBadge, Loading, Note, SourceBadge, StatusBadge,
  StructureSelect, TextLink,
} from './ui'

function sameResidue(a: { chain: string; resseq: number; icode: string }, b: SelectedResidue): boolean {
  return a.chain === b.chain && a.resseq === b.seqId && (a.icode || '') === (b.insCode ?? '')
}

/** What the structure is and where it came from. */
export function StructureFacts({ structure }: { structure: Structure }) {
  const experimentId = experimentIdOf(structure)
  const { provenance } = structure
  return (
    <Card tight title={structure.label}>
      <div className="space-y-3 text-[0.8125rem]">
        <div>
          <SourceBadge source={structure.source} />
          <p className="mt-1.5 text-muted-foreground">{sourceMeaning(structure.source)}</p>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          <dt className="text-muted-foreground">Residues</dt>
          <dd>{structure.n_residues}</dd>
          <dt className="text-muted-foreground">Chains</dt>
          <dd>{structure.chains.length === 0 ? 'none' : structure.chains.map((c) => `${c.id} (${c.n_residues})`).join(', ')}</dd>
          <dt className="text-muted-foreground">Format</dt>
          <dd>{structure.format === 'mmcif' ? 'mmCIF' : structure.format.toUpperCase()}</dd>
          {structure.origin_id && (
            <>
              <dt className="text-muted-foreground">Origin</dt>
              <dd className="font-mono break-all">{structure.origin_id}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Source</dt>
          <dd className="break-words">
            {provenance.url
              ? <a className="fs-link" href={provenance.url} target="_blank" rel="noreferrer">{provenance.source}</a>
              : provenance.source}
          </dd>
          <dt className="text-muted-foreground">Retrieved</dt>
          <dd>{formatDate(provenance.retrieved_at)}</dd>
          {experimentId && (
            <>
              <dt className="text-muted-foreground">Experiment</dt>
              <dd className="break-all"><TextLink to={historyLink(experimentId)}>{experimentId}</TextLink></dd>
            </>
          )}
          <dt className="text-muted-foreground">File hash</dt>
          <dd className="font-mono" title={`sha256 ${structure.sha256}`}>{structure.sha256.slice(0, 12)}</dd>
        </dl>
        {provenance.notes && <Note>{provenance.notes}</Note>}
      </div>
    </Card>
  )
}

/** pLDDT for a predicted model; for anything else, why there is none. */
export function ConfidencePanel({ structure, selected, onSelect }: {
  structure: Structure
  selected: SelectedResidue | null
  onSelect: (residue: PlddtResidue) => void
}) {
  const plddt = usePlddt(structure)
  let body
  if (structure.format === 'fasta') {
    body = <Note>A sequence on its own has no predicted structure, so there is no confidence to report.</Note>
  } else if (structure.source !== 'predicted') {
    body = (
      <Note>
        Not reported. This structure is {structure.source === 'experimental' ? 'experimental' : 'not declared as a predicted model'},
        so its B-factor column is not read as pLDDT.
      </Note>
    )
  } else if (plddt.state === 'ok') {
    const index = selected ? plddt.data.per_residue.findIndex((r) => sameResidue(r, selected)) : -1
    body = <ConfidenceSummary plddt={plddt.data} selectedIndex={index >= 0 ? index : null} onSelect={onSelect} />
  } else if (plddt.state === 'error') {
    body = <ErrorNote>{errorMessage(plddt.error, 'pLDDT could not be loaded.')}</ErrorNote>
  } else {
    body = <Loading>Reading pLDDT…</Loading>
  }
  return <Card tight title="Model confidence (pLDDT)">{body}</Card>
}

/** The clicked residue: what it is, its pLDDT if it has one, and the rule-based sentence for it. */
export function ResiduePanel({ structure, selected, residues, plddt }: {
  structure: Structure
  selected: SelectedResidue | null
  residues: Residue[] | null
  plddt: PlddtResidue[] | null
}) {
  const residue = selected && residues ? residues.find((r) => sameResidue(r, selected)) ?? null : null
  const score = selected && plddt ? plddt.find((r) => sameResidue(r, selected)) ?? null : null
  const explanation = useExplanation(
    residue ? structure.id : null,
    residue ? { chain: residue.chain, start: residue.resseq, end: residue.resseq } : null,
  )

  let body
  if (!selected) {
    body = <Note>Click a residue in the 3D view, in the sequence, or on the pLDDT line to read about it here.</Note>
  } else if (!residues) {
    body = <Loading>Loading residues…</Loading>
  } else if (!residue) {
    body = (
      <Note>
        {selected.compId ?? 'The clicked group'} {selected.chain}:{selected.seqId}{selected.insCode ?? ''} is not an
        amino-acid residue of this structure (it may be a ligand, an ion or water), so there is nothing to report for it.
      </Note>
    )
  } else {
    body = (
      <div className="space-y-3 text-[0.8125rem]">
        <p className="text-base font-semibold">
          {residue.resname} {residue.resseq}{residue.icode}
          <span className="ml-2 text-[0.8125rem] font-normal text-muted-foreground">chain {residue.chain}, one-letter code {residue.aa}</span>
        </p>
        {score && (
          <p className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-sm" style={{ backgroundColor: bandOf(score.bin)?.css }} />
            <span><span className="font-semibold">{score.plddt.toFixed(1)}</span> pLDDT, {bandOf(score.bin)?.label.toLowerCase() ?? score.bin}</span>
          </p>
        )}
        {!residue.has_ca && <Note>This residue has no CA atom in the file, so it is left out of alignments.</Note>}
        {explanation.state === 'ok' && <ExplainedText value={explanation.data} compact />}
        {explanation.state === 'loading' && <Loading>Building the explanation…</Loading>}
        {explanation.state === 'error' && <ErrorNote>{errorMessage(explanation.error, 'The explanation could not be loaded.')}</ErrorNote>}
      </div>
    )
  }
  return <Card tight title="Selected residue">{body}</Card>
}

/** The rule-based description of one chain. Sentences are fixed templates filled with measured values. */
export function ExplanationPanel({ structure }: { structure: Structure }) {
  const [chosen, setChosen] = useState<{ structureId: string; chain: string } | null>(null)
  const chains = structure.chains.map((c) => c.id)
  const chain = chosen && chosen.structureId === structure.id && chains.includes(chosen.chain) ? chosen.chain : chains[0] ?? null
  const explanation = useExplanation(
    structure.format === 'fasta' || !chain ? null : structure.id,
    chain && chains.length > 1 ? { chain } : null,
  )

  return (
    <Card
      tight
      title="What the numbers say"
      actions={chains.length > 1 && (
        <select
          aria-label="Chain to describe"
          value={chain ?? ''}
          onChange={(e) => setChosen({ structureId: structure.id, chain: e.target.value })}
          className={`${inputClass} h-7 px-1.5 text-[0.8125rem]`}
        >
          {chains.map((id) => <option key={id} value={id}>Chain {id}</option>)}
        </select>
      )}
    >
      {structure.format === 'fasta' ? <Note>There is no structure to describe for a sequence-only record.</Note>
        : explanation.state === 'ok' ? <ExplainedText value={explanation.data} compact />
          : explanation.state === 'error' ? <ErrorNote>{errorMessage(explanation.error, 'The explanation could not be loaded.')}</ErrorNote>
            : <Loading>Building the explanation…</Loading>}
    </Card>
  )
}

/** The experiment record a structure was registered from, if it came from one. */
export function ProvenancePanel({ structure, experiments }: { structure: Structure; experiments: Experiment[] }) {
  const experimentId = experimentIdOf(structure)
  const experiment = experimentId ? experiments.find((e) => e.id === experimentId) ?? null : null
  if (!experimentId) return null
  return (
    <Card tight title="Where it came from">
      {!experiment ? (
        <Note>
          Registered from experiment <Code>{experimentId}</Code>, which is no longer in the experiment list.
        </Note>
      ) : (
        <div className="space-y-2 text-[0.8125rem]">
          <p className="font-medium">{experiment.model_name}</p>
          <p className="flex flex-wrap items-center gap-2"><KindBadge kind={experiment.kind} /><StatusBadge status={experiment.status} /></p>
          <p className="text-muted-foreground">{experiment.provenance.source}, recorded {formatDate(experiment.created_at)}.</p>
          {experiment.error && <ErrorNote>{experiment.error}</ErrorNote>}
          <p><TextLink to={historyLink(experiment.id)}>Open the experiment record</TextLink></p>
        </div>
      )}
    </Card>
  )
}

/** Details of the active structure. Lives in the right sidebar on every page. */
export function RightSidebar() {
  const library = useLibrary()
  const { activeStructureId, selectedResidue } = usePanelState()
  const { adapter } = useViewerState()
  const location = useLocation()
  const onExplorer = location.pathname === '/explorer'
  // On the Explorer the viewer panel decides what is active (it may be showing a local sample
  // file, with nothing active). Elsewhere, describe the first structure until one is chosen.
  const structure = library.structures.find((s) => s.id === activeStructureId)
    ?? (onExplorer ? null : library.structures[0] ?? null)
  const viewable = structure !== null && structure.format !== 'fasta'
  const residues = useResidues(viewable ? structure.id : null)
  const plddt = usePlddt(structure)
  const selected = structure && selectedResidue?.structureId === structure.id ? selectedResidue : null

  function selectFromChart(residue: PlddtResidue) {
    if (!structure) return
    setSelectedResidue({ structureId: structure.id, chain: residue.chain, seqId: residue.resseq, insCode: residue.icode || undefined, compId: residue.resname })
    if (onExplorer) adapter?.highlightResidues(residue.chain, [{ start: residue.resseq, end: residue.resseq }], { focus: true })
  }

  if (library.status !== 'ready') return <Loading>Loading structure details…</Loading>

  return (
    <div className="flex flex-col gap-3">
      {library.error && <ErrorNote>{library.error}</ErrorNote>}
      {library.structures.length === 0 ? (
        <EmptyState title="No structures yet">
          Add one in the Protein Explorer, or put a bundle in <Code>data/experiments/</Code> and restart the backend.
        </EmptyState>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-[0.8125rem] text-muted-foreground">
            Structure
            <StructureSelect
              structures={library.structures}
              value={structure?.id ?? ''}
              onChange={(id) => id && setActiveStructure(id)}
              placeholder={structure ? undefined : 'Choose a structure'}
              className="text-foreground"
            />
          </label>
          {!structure ? (
            <Note>Choose a structure to see where it came from, its confidence and what can be said about it.</Note>
          ) : (
            <>
              {!onExplorer && viewable && <p className="text-[0.8125rem]"><TextLink to={explorerLink(structure.id)}>Open in the 3D viewer</TextLink></p>}
              <StructureFacts structure={structure} />
              <ConfidencePanel structure={structure} selected={selected} onSelect={selectFromChart} />
              <ResiduePanel
                structure={structure}
                selected={selected}
                residues={residues.state === 'ok' ? residues.data.residues : null}
                plddt={plddt.state === 'ok' ? plddt.data.per_residue : null}
              />
              {residues.state === 'error' && !(residues.error instanceof ApiError && residues.error.status === 409) && (
                <ErrorNote>{errorMessage(residues.error, 'Residues could not be loaded.')}</ErrorNote>
              )}
              <ExplanationPanel structure={structure} />
              <ProvenancePanel structure={structure} experiments={library.experiments} />
            </>
          )}
        </>
      )}
      <Note>
        pLDDT and PAE are model-confidence estimates. They do not establish folding, binding, affinity, efficacy, or
        safety. FoldStudio is not a clinical tool.
      </Note>
    </div>
  )
}
