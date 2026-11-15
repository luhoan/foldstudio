import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { alignStructures, structureFileUrl } from '@/api'
import type { AlignmentRequest, AlignmentResponse, MatchingMethod, Structure } from '@/api'
import { Button } from '@/components/ui/button'
import { ViewerPanel } from '@/viewer'
import type { SecondLayout } from '@/viewer'
import { errorMessage, inputClass } from './format'
import { useLibrary } from './library'
import { Card, EmptyState, ErrorNote, ExplainedText, Field, Loading, Note, Stat, StructureSelect } from './ui'
import { useAsync } from './useAsync'

const METHODS: Array<{ value: MatchingMethod; label: string; hint: string }> = [
  { value: 'auto', label: 'Automatic', hint: 'Sequence alignment, falling back to residue numbers when the sequences do not match (a backbone with no sequence, for one). The result says which was used.' },
  { value: 'sequence', label: 'By sequence alignment', hint: 'Pairs residues by aligning the two sequences. Right for the same protein numbered differently.' },
  { value: 'resnum', label: 'By residue number', hint: 'Pairs residues that carry the same number. Right when both files use the same numbering.' },
]

/** The colours the 3D view gives the two structures of an overlay. */
const REFERENCE_COLOR = '#2dd4bf'
const MOBILE_COLOR = '#a78bfa'

interface Choice {
  mobile: string
  reference: string
  mobileChain: string
  referenceChain: string
  method: MatchingMethod
  mobileRange: string
  referenceRange: string
}

function chainsOf(structure: Structure | undefined): string[] {
  return structure?.chains.map((c) => c.id) ?? []
}

/** "10-80" into [10, 80]; empty means the whole chain; anything else is an error to show. */
function parseRange(text: string): [number, number] | null | 'invalid' {
  const trimmed = text.trim()
  if (!trimmed) return null
  const match = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(trimmed)
  if (!match) return 'invalid'
  const range: [number, number] = [Number(match[1]), Number(match[2])]
  return range[0] <= range[1] ? range : 'invalid'
}

function viewerFormat(structure: Structure | undefined): 'pdb' | 'mmcif' {
  return structure?.format === 'mmcif' ? 'mmcif' : 'pdb'
}

function AlignmentResult({ result, mobile, reference }: { result: AlignmentResponse; mobile?: Structure; reference?: Structure }) {
  const [layout, setLayout] = useState<SecondLayout>('overlay')
  const sameMatching = result.matching === result.matching_requested
  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-5 md:grid-cols-4">
        <Stat label="RMSD" value={result.rmsd.toFixed(2)} unit="Å" hint={`Over ${result.aligned_atoms} ${result.atom_type} atoms`} />
        <Stat label="TM-score" value={result.tm_score.toFixed(3)} hint="0 to 1; normalised by the reference chain's length" />
        <Stat label="Aligned residues" value={result.aligned_residues} hint={`${result.mobile_residues_in_selection} selected in the mobile chain, ${result.reference_residues_in_selection} in the reference`} />
        <Stat label="Sequence identity" value={`${(result.sequence_identity * 100).toFixed(1)}%`} hint="Of the matched residue pairs" />
      </dl>

      <section>
        <h3 className="mb-1.5 text-sm font-semibold">What was aligned</h3>
        <ul className="max-w-[90ch] space-y-1 text-sm">
          <li>
            Mobile: {result.mobile_label}, chain {result.mobile_chain}. Reference: {result.reference_label}, chain {result.reference_chain}.
          </li>
          <li>
            Residues were paired {result.matching === 'sequence' ? 'by sequence alignment' : 'by residue number'}
            {sameMatching ? '.' : ` (chosen automatically; you asked for ${result.matching_requested}).`}
          </li>
          <li>{result.procedure}</li>
          <li className="text-muted-foreground">{result.tm_score_method}</li>
        </ul>
      </section>

      {result.notes.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-sm font-semibold">Notes on this alignment</h3>
          <ul className="max-w-[90ch] list-disc space-y-1 pl-5 text-sm">
            {result.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-1.5 text-sm font-semibold">What the numbers say</h3>
        <ExplainedText value={result} />
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Superposition in 3D</h3>
          <div role="group" aria-label="Layout" className="inline-flex rounded-md border border-input p-0.5 text-sm">
            {([['overlay', 'Overlaid'], ['side-by-side', 'Side by side']] as const).map(([value, text]) => (
              <button
                key={value}
                type="button"
                aria-pressed={layout === value}
                onClick={() => setLayout(value)}
                className={`rounded px-2.5 py-1 transition-colors ${layout === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
        <ul className="mb-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <li className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-sm" style={{ backgroundColor: REFERENCE_COLOR }} />
            Reference: {result.reference_label}
          </li>
          <li className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-sm" style={{ backgroundColor: MOBILE_COLOR }} />
            Mobile: {result.mobile_label}{layout === 'overlay' ? ', moved onto the reference' : ''}
          </li>
        </ul>
        <div className="h-[28rem] min-h-[360px]">
          <ViewerPanel
            url={structureFileUrl(result.reference_id)}
            format={viewerFormat(reference)}
            label={result.reference_label}
            structureKind={result.reference_source}
            secondUrl={structureFileUrl(result.mobile_id)}
            secondFormat={viewerFormat(mobile)}
            secondMatrix={result.matrix}
            secondLayout={layout}
          />
        </div>
        <Note className="mt-2">
          {layout === 'overlay'
            ? `The mobile structure is drawn after applying the transform the alignment returned (${result.matrix_convention}).`
            : 'Side by side shows the two structures apart, without the superposition.'}
        </Note>
      </section>

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
          The {result.pairs.length} matched residue pairs
        </summary>
        <div className="mt-2 max-h-72 max-w-xl overflow-auto rounded-md border border-border">
          <table className="fs-table">
            <thead><tr><th>Mobile</th><th>Reference</th><th>Same residue type</th></tr></thead>
            <tbody>
              {result.pairs.map((pair) => (
                <tr key={`${pair.mobile}|${pair.reference}`}>
                  <td className="font-mono">{pair.mobile}</td>
                  <td className="font-mono">{pair.reference}</td>
                  <td>{pair.identical ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

/**
 * Structural Analysis: superpose one structure on another and report RMSD and TM-score together
 * with exactly what was aligned. `?mobile=<id>&reference=<id>` opens it with the pair chosen and
 * the alignment already run (the Design Workspace links here to compare a design with its backbone).
 */
export function AlignmentPanel() {
  const library = useLibrary()
  const [params, setParams] = useSearchParams()
  const linkedMobile = params.get('mobile')
  const linkedReference = params.get('reference')
  const [choice, setChoice] = useState<Partial<Choice>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [request, setRequest] = useState<AlignmentRequest | null>(() =>
    linkedMobile && linkedReference
      ? { mobile_id: linkedMobile, reference_id: linkedReference, selection: { method: 'auto' } }
      : null)

  const structures = library.structures.filter((s) => s.format !== 'fasta')
  const byId = new Map(structures.map((s) => [s.id, s]))
  const mobileId = choice.mobile ?? (linkedMobile && byId.has(linkedMobile) ? linkedMobile : structures[0]?.id ?? '')
  const referenceId = choice.reference ?? (linkedReference && byId.has(linkedReference) ? linkedReference : structures[1]?.id ?? structures[0]?.id ?? '')
  const mobile = byId.get(mobileId)
  const reference = byId.get(referenceId)
  const mobileChains = chainsOf(mobile)
  const referenceChains = chainsOf(reference)
  const mobileChain = choice.mobileChain && mobileChains.includes(choice.mobileChain) ? choice.mobileChain : mobileChains[0] ?? ''
  // Aligning a structure to itself only makes sense between two different chains.
  const referenceDefault = mobileId === referenceId ? referenceChains.find((c) => c !== mobileChain) ?? referenceChains[0] : referenceChains[0]
  const referenceChain = choice.referenceChain && referenceChains.includes(choice.referenceChain) ? choice.referenceChain : referenceDefault ?? ''
  const method = choice.method ?? 'auto'

  const result = useAsync(request ? JSON.stringify(request) : null, () => alignStructures(request!))

  function update(patch: Partial<Choice>) {
    setChoice((current) => ({ ...current, ...patch }))
    setFormError(null)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!mobileId || !referenceId) {
      setFormError('Choose two structures first.')
      return
    }
    if (mobileId === referenceId && mobileChain === referenceChain) {
      setFormError('These are the same chain of the same structure. Choose a different structure, or two different chains.')
      return
    }
    const mobileRange = parseRange(choice.mobileRange ?? '')
    const referenceRange = parseRange(choice.referenceRange ?? '')
    if (mobileRange === 'invalid' || referenceRange === 'invalid') {
      setFormError('Write a residue range as first-last, for example 10-80, or leave it empty for the whole chain.')
      return
    }
    setFormError(null)
    setParams({ mobile: mobileId, reference: referenceId }, { replace: true })
    setRequest({
      mobile_id: mobileId,
      reference_id: referenceId,
      selection: {
        mobile_chain: mobileChain || undefined,
        reference_chain: referenceChain || undefined,
        method,
        ...(mobileRange ? { mobile_range: mobileRange } : {}),
        ...(referenceRange ? { reference_range: referenceRange } : {}),
      },
    })
  }

  if (library.status !== 'ready') return <Loading>Loading structures…</Loading>
  if (structures.length === 0) {
    return (
      <EmptyState title="No structures to align yet">
        Add structures in the Protein Explorer first. An alignment needs two structures, or two chains of one.
      </EmptyState>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {library.error && <ErrorNote>{library.error}</ErrorNote>}
      <Card title="Choose what to align" description="The mobile structure is moved onto the reference. Only CA atoms of matched residues are used.">
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <Field label="Mobile structure">
                <StructureSelect structures={structures} value={mobileId} onChange={(id) => update({ mobile: id, mobileChain: undefined })} />
              </Field>
              <Field label="Mobile chain">
                <select aria-label="Mobile chain" className={inputClass} value={mobileChain} onChange={(e) => update({ mobileChain: e.target.value })}>
                  {mobileChains.map((c) => <option key={c} value={c}>Chain {c}</option>)}
                </select>
              </Field>
            </div>
            <div className="space-y-3">
              <Field label="Reference structure">
                <StructureSelect structures={structures} value={referenceId} onChange={(id) => update({ reference: id, referenceChain: undefined })} />
              </Field>
              <Field label="Reference chain">
                <select aria-label="Reference chain" className={inputClass} value={referenceChain} onChange={(e) => update({ referenceChain: e.target.value })}>
                  {referenceChains.map((c) => <option key={c} value={c}>Chain {c}</option>)}
                </select>
              </Field>
            </div>
          </div>

          <Field label="How residues are paired" hint={METHODS.find((m) => m.value === method)?.hint} className="max-w-xl">
            <select aria-label="How residues are paired" className={inputClass} value={method} onChange={(e) => update({ method: e.target.value as MatchingMethod })}>
              {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>

          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">Limit to a residue range</summary>
            <div className="mt-3 grid max-w-xl gap-4 sm:grid-cols-2">
              <Field label="Mobile residues" hint="first-last, by the numbers in the file">
                <input className={inputClass} placeholder="whole chain" value={choice.mobileRange ?? ''} onChange={(e) => update({ mobileRange: e.target.value })} />
              </Field>
              <Field label="Reference residues" hint="first-last, by the numbers in the file">
                <input className={inputClass} placeholder="whole chain" value={choice.referenceRange ?? ''} onChange={(e) => update({ referenceRange: e.target.value })} />
              </Field>
            </div>
          </details>

          {formError && <ErrorNote>{formError}</ErrorNote>}
          <Button type="submit" disabled={result.state === 'loading'}>{result.state === 'loading' ? 'Aligning…' : 'Align'}</Button>
        </form>
      </Card>

      {result.state === 'error' && (
        <Card title="The alignment could not be computed">
          <ErrorNote>{errorMessage(result.error, 'The backend did not return an alignment.')}</ErrorNote>
        </Card>
      )}
      {result.state === 'ok' && (
        <Card title="Result">
          <AlignmentResult result={result.data} mobile={byId.get(result.data.mobile_id)} reference={byId.get(result.data.reference_id)} />
        </Card>
      )}
    </div>
  )
}
