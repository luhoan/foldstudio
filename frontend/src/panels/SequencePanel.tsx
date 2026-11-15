import { useMemo } from 'react'
import type { PlddtResidue, Residue } from '@/api'
import { useViewerState } from '@/viewer'
import { BANDS, bandOf } from './bands'
import { usePlddt, useResidues } from './details'
import { errorMessage } from './format'
import { useLibrary } from './library'
import { setSelectedResidue, usePanelState } from './panelState'
import { Card, ErrorNote, Loading, Note } from './ui'

const BLOCK = 10

function keyOf(r: { chain: string; resseq: number; icode: string }): string {
  return `${r.chain}|${r.resseq}|${r.icode || ''}`
}

/**
 * The active structure's sequence, chain by chain, in blocks of ten. Each letter is a residue you
 * can click: it becomes the selected residue and is highlighted in the 3D view. For a predicted
 * model the letters carry their pLDDT band colour, the same colours as the 3D view.
 */
export function SequencePanel() {
  const { structures } = useLibrary()
  const { activeStructureId, selectedResidue } = usePanelState()
  const { adapter } = useViewerState()
  const structure = structures.find((s) => s.id === activeStructureId) ?? null
  const hasCoordinates = structure !== null && structure.format !== 'fasta'
  const residues = useResidues(hasCoordinates ? structure.id : null)
  const plddt = usePlddt(structure)

  const scores = useMemo(() => {
    const map = new Map<string, PlddtResidue>()
    if (plddt.state === 'ok') for (const r of plddt.data.per_residue) map.set(keyOf(r), r)
    return map
  }, [plddt])

  const chains = useMemo(() => {
    const grouped = new Map<string, Residue[]>()
    if (residues.state === 'ok') {
      for (const r of residues.data.residues) {
        const list = grouped.get(r.chain)
        if (list) list.push(r)
        else grouped.set(r.chain, [r])
      }
    }
    return [...grouped.entries()]
  }, [residues])

  if (!structure) return null

  function select(residue: Residue) {
    if (!structure) return
    setSelectedResidue({ structureId: structure.id, chain: residue.chain, seqId: residue.resseq, insCode: residue.icode || undefined, compId: residue.resname })
    adapter?.highlightResidues(residue.chain, [{ start: residue.resseq, end: residue.resseq }], { focus: true })
  }

  const selectedKey = selectedResidue?.structureId === structure.id
    ? `${selectedResidue.chain}|${selectedResidue.seqId}|${selectedResidue.insCode ?? ''}`
    : null
  const coloured = scores.size > 0

  return (
    <Card
      title="Sequence"
      description={hasCoordinates
        ? 'Click a residue to select it and find it in the 3D view. Numbers are the residue numbers in the file.'
        : undefined}
    >
      {!hasCoordinates ? (
        <div className="space-y-3">
          {structure.chains.map((chain) => (
            <div key={chain.id}>
              <p className="mb-1 text-sm text-muted-foreground">Chain {chain.id}, {chain.n_residues} residues</p>
              <p className="font-mono text-[0.8125rem] break-all">{chain.sequence}</p>
            </div>
          ))}
        </div>
      ) : residues.state === 'error' ? (
        <ErrorNote>{errorMessage(residues.error, 'The residues could not be loaded.')}</ErrorNote>
      ) : residues.state !== 'ok' ? (
        <Loading>Loading the sequence…</Loading>
      ) : (
        <div className="space-y-5">
          {chains.map(([chainId, list]) => (
            <div key={chainId}>
              <p className="mb-2 text-sm text-muted-foreground">Chain {chainId}, {list.length} residue{list.length === 1 ? '' : 's'}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-2.5">
                {Array.from({ length: Math.ceil(list.length / BLOCK) }, (_, b) => list.slice(b * BLOCK, (b + 1) * BLOCK)).map((block) => (
                  <div key={keyOf(block[0])}>
                    <div className="mb-0.5 font-mono text-[0.6875rem] leading-none text-muted-foreground">{block[0].resseq}{block[0].icode}</div>
                    <div className="flex">
                      {block.map((r) => {
                        const key = keyOf(r)
                        const score = scores.get(key)
                        const band = score ? bandOf(score.bin) : undefined
                        const isSelected = key === selectedKey
                        return (
                          <button
                            key={key}
                            type="button"
                            aria-pressed={isSelected}
                            aria-label={`${r.resname} ${r.resseq}${r.icode}, chain ${r.chain}${score ? `, pLDDT ${score.plddt.toFixed(1)}` : ''}`}
                            title={`${r.chain}:${r.resname}${r.resseq}${r.icode}${score ? `, pLDDT ${score.plddt.toFixed(1)} (${band?.label.toLowerCase() ?? score.bin})` : ''}`}
                            onClick={() => select(r)}
                            style={band ? { backgroundColor: band.css, color: band.ink } : undefined}
                            className={`h-6 w-[1.15rem] font-mono text-[0.8125rem] leading-6 transition-[box-shadow] hover:shadow-[inset_0_0_0_1.5px_var(--foreground)] ${
                              band ? '' : 'bg-muted/60 text-foreground'
                            } ${isSelected ? 'relative z-10 shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)]' : ''}`}
                          >
                            {r.aa}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {coloured ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] text-muted-foreground">
              <span>Letter colour is the pLDDT band:</span>
              {BANDS.map((band) => (
                <span key={band.name} className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="size-2.5 rounded-sm" style={{ backgroundColor: band.css }} />
                  {band.label} ({band.range})
                </span>
              ))}
            </div>
          ) : (
            <Note>
              {structure.source === 'predicted'
                ? plddt.state === 'error' ? `Confidence colours are not shown: ${errorMessage(plddt.error, 'pLDDT could not be loaded')}` : 'Reading pLDDT…'
                : 'No confidence colours: this structure is not a predicted model, so it has no pLDDT.'}
            </Note>
          )}
        </div>
      )}
    </Card>
  )
}
