import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { experimentIdOf, structureFileUrl } from '@/api'
import type { ChainInterface, Structure } from '@/api'
import { ViewerPanel } from '@/viewer'
import { cn } from '@/lib/utils'
import { useInterfaces } from './details'
import { errorMessage, formatRanges, inputClass } from './format'
import { useLibrary } from './library'
import { explorerLink, historyLink } from './links'
import { setActiveStructure } from './panelState'
import { Card, Code, EmptyState, ErrorNote, Limitations, Loading, Note, SourceBadge, TextLink } from './ui'

const DEFAULT_CUTOFF = 4.5
const CUTOFFS = [3.5, 4, 4.5, 5, 6, 8]

interface Side {
  pair: string
  chain: string
}

function pairKey(i: ChainInterface): string {
  return `${i.chain_a}|${i.chain_b}`
}

function InterfaceRow({ item, shown, onShow }: { item: ChainInterface; shown: Side | null; onShow: (side: Side | null) => void }) {
  const key = pairKey(item)
  const sides: Array<{ chain: string; count: number; ranges: ChainInterface['ranges_a'] }> = [
    { chain: item.chain_a, count: item.n_residues_a, ranges: item.ranges_a },
    { chain: item.chain_b, count: item.n_residues_b, ranges: item.ranges_b },
  ]
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-base font-semibold">Chain {item.chain_a} with chain {item.chain_b}</h3>
        <span className="text-sm text-muted-foreground">
          {item.n_residue_pairs} residue pair{item.n_residue_pairs === 1 ? '' : 's'} in contact
        </span>
      </div>
      <dl className="mt-2 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        {sides.map((side) => {
          const active = shown?.pair === key && shown.chain === side.chain
          return (
            <div key={side.chain} className="contents">
              <dt className="text-muted-foreground">Chain {side.chain}, {side.count} residue{side.count === 1 ? '' : 's'}</dt>
              <dd className="font-mono text-[0.8125rem] break-words">{formatRanges(side.ranges) || 'none'}</dd>
              <dd>
                <button
                  type="button"
                  aria-pressed={active}
                  disabled={side.ranges.length === 0}
                  onClick={() => onShow(active ? null : { pair: key, chain: side.chain })}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-[0.8125rem] transition-colors disabled:opacity-50',
                    active ? 'border-primary/60 bg-primary/10 text-primary' : 'border-input hover:border-muted-foreground/60',
                  )}
                >
                  {active ? 'Highlighted in 3D' : `Highlight chain ${side.chain} side`}
                </button>
              </dd>
            </div>
          )
        })}
        {item.interface_mean_plddt !== null && (
          <div className="contents">
            <dt className="text-muted-foreground">Mean pLDDT of interface residues</dt>
            <dd className="sm:col-span-2">{item.interface_mean_plddt.toFixed(1)}</dd>
          </div>
        )}
        {item.mean_interchain_pae !== null && (
          <div className="contents">
            <dt className="text-muted-foreground">Mean inter-chain PAE</dt>
            <dd className="sm:col-span-2">{item.mean_interchain_pae.toFixed(1)} Å</dd>
          </div>
        )}
      </dl>
      <p className="mt-2.5 max-w-[85ch] text-sm leading-relaxed">{item.explanation.text}</p>
    </li>
  )
}

function InterfaceReview({ structure }: { structure: Structure }) {
  const [cutoff, setCutoff] = useState(DEFAULT_CUTOFF)
  const [shown, setShown] = useState<Side | null>(null)
  const interfaces = useInterfaces(structure.id, cutoff === DEFAULT_CUTOFF ? undefined : cutoff)
  const experimentId = experimentIdOf(structure)

  const data = interfaces.state === 'ok' ? interfaces.data : null
  const shownItem = data && shown ? data.interfaces.find((i) => pairKey(i) === shown.pair) ?? null : null
  const highlight = shownItem && shown
    ? { chain: shown.chain, ranges: shown.chain === shownItem.chain_a ? shownItem.ranges_a : shownItem.ranges_b }
    : null

  return (
    <Card
      title={structure.label}
      description={`${structure.chains.length} chains: ${structure.chains.map((c) => `${c.id} (${c.n_residues} residues)`).join(', ')}.`}
      actions={
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Contact distance
          <select aria-label="Contact distance" className={inputClass} value={cutoff} onChange={(e) => { setCutoff(Number(e.target.value)); setShown(null) }}>
            {CUTOFFS.map((c) => <option key={c} value={c}>{c} Å</option>)}
          </select>
        </label>
      }
    >
      <div className="space-y-5">
        <p className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          <SourceBadge source={structure.source} />
          <TextLink to={explorerLink(structure.id)}>Open in the Protein Explorer</TextLink>
          {experimentId && <TextLink to={historyLink(experimentId)}>Open its record</TextLink>}
        </p>

        <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="h-[28rem] min-h-[360px]">
            <ViewerPanel
              url={structureFileUrl(structure.id)}
              format={structure.format === 'mmcif' ? 'mmcif' : 'pdb'}
              label={structure.label}
              structureKind={structure.source}
              highlight={highlight}
            />
          </div>

          <div className="min-w-0">
            {interfaces.state === 'error' ? (
              <ErrorNote>{errorMessage(interfaces.error, 'The interfaces could not be computed.')}</ErrorNote>
            ) : !data ? (
              <Loading>Finding residues in contact…</Loading>
            ) : data.interfaces.length === 0 ? (
              <EmptyState title={`No chains are in contact within ${data.cutoff_angstrom} Å`}>
                The chains of this structure do not touch at this distance. Try a larger contact distance.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border">
                {data.interfaces.map((item) => <InterfaceRow key={pairKey(item)} item={item} shown={shown} onShow={setShown} />)}
              </ul>
            )}
          </div>
        </div>

        {data && (
          <div className="space-y-2 border-t border-border pt-4">
            <Note className="max-w-[95ch]">
              {data.note} Atoms compared: {data.atom_selection}. Residue numbers are the ones in the file.
            </Note>
            {data.interfaces.some((i) => i.mean_interchain_pae !== null) && <Note className="max-w-[95ch]">{data.pae_note}</Note>}
            <Limitations items={data.limitations} />
          </div>
        )}
      </div>
    </Card>
  )
}

/**
 * Candidate Library: the multi-chain structures in the library, with the residues where their
 * chains meet. The interfaces are computed from the coordinates by the backend; nothing is
 * generated and no binder is proposed. `?structure=<id>` opens one structure.
 */
export function CandidateLibrary() {
  const library = useLibrary()
  const [params, setParams] = useSearchParams()
  const complexes = library.structures.filter((s) => s.format !== 'fasta' && s.chains.length > 1)
  const requested = params.get('structure')
  const selected = complexes.find((s) => s.id === requested) ?? complexes[0] ?? null
  const selectedId = selected?.id ?? null

  // The sidebar describes the active structure, so it follows the complex being reviewed.
  useEffect(() => {
    if (selectedId) setActiveStructure(selectedId)
  }, [selectedId])

  function choose(id: string) {
    setParams({ structure: id }, { replace: true })
  }

  if (library.status !== 'ready') return <Loading>Loading structures…</Loading>

  return (
    <div className="flex flex-col gap-4">
      {library.error && <ErrorNote>{library.error}</ErrorNote>}
      {complexes.length === 0 ? (
        <EmptyState title="No multi-chain structures in the library">
          This page reviews where the chains of a complex meet, so it needs a structure with at least two chains.
          Fetch one in the Protein Explorer (an antibody with its antigen, for example), or
          run <Code>python3 scripts/fetch_demo_data.py</Code>, which includes complexes.
        </EmptyState>
      ) : (
        <>
          <Card title="Complexes" description="Structures with two or more chains. Choose one to see where its chains are in contact.">
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {complexes.map((s) => {
                const active = s.id === selected?.id
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => choose(s.id)}
                      className={cn(
                        'flex h-full w-full flex-col items-start gap-1.5 rounded-lg border px-3.5 py-3 text-left text-sm transition-colors',
                        active ? 'border-primary/60 bg-primary/5' : 'border-input hover:border-muted-foreground/60',
                      )}
                    >
                      <span className="font-medium break-words">{s.label}</span>
                      <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
                        <SourceBadge source={s.source} />
                        {s.chains.length} chains, {s.n_residues} residues
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </Card>
          {selected && <InterfaceReview key={selected.id} structure={selected} />}
        </>
      )}
      <Note className="max-w-[95ch]">
        This page reviews existing structures only. It does not generate binders or antibodies. Contacts, confidence
        scores and predicted structures do not establish binding affinity, efficacy, or safety. Not a clinical tool.
      </Note>
    </div>
  )
}
