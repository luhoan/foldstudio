import { useId, useState, type KeyboardEvent } from 'react'
import type { PlddtResidue, PlddtResponse } from '@/api'
import { BANDS, bandOf } from './bands'
import { Note } from './ui'

/** "A:MET1" for a pLDDT row, with the insertion code when there is one. */
function residueName(r: PlddtResidue): string {
  return `${r.chain}:${r.resname}${r.resseq}${r.icode}`
}

/**
 * How the residues split across the four confidence bands: a thin segmented bar over a list that
 * gives each band's name, range, count and share. The counts and shares are the backend's.
 */
export function BandSplit({ plddt }: { plddt: PlddtResponse }) {
  const rows = BANDS.map((band) => ({ band, bin: plddt.bins.find((b) => b.name === band.name) }))
  const summary = rows.map(({ band, bin }) => `${band.label} ${Math.round((bin?.fraction ?? 0) * 100)}%`).join(', ')
  return (
    <div>
      <div role="img" aria-label={`Share of residues by confidence band: ${summary}`} className="flex h-2 w-full gap-0.5">
        {rows.map(({ band, bin }) =>
          bin && bin.count > 0 ? (
            <span key={band.name} className="h-full rounded-full" style={{ backgroundColor: band.css, flexGrow: bin.count, flexBasis: 0, minWidth: 3 }} />
          ) : null,
        )}
      </div>
      <table className="mt-2.5 w-full text-[0.8125rem]">
        <caption className="sr-only">Residues by pLDDT band</caption>
        <tbody>
          {rows.map(({ band, bin }) => (
            <tr key={band.name}>
              <th scope="row" className="py-0.5 pr-2 text-left font-normal">
                <span className="inline-flex items-center gap-2">
                  <span aria-hidden className="size-2.5 rounded-sm" style={{ backgroundColor: band.css }} />
                  {band.label}
                </span>
              </th>
              <td className="py-0.5 pr-2 text-muted-foreground">{band.range}</td>
              <td className="py-0.5 pr-2 text-right">{bin?.count ?? 0}</td>
              <td className="w-12 py-0.5 text-right text-muted-foreground">{Math.round((bin?.fraction ?? 0) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const W = 300
const H = 128
const PAD = { left: 26, right: 6, top: 8, bottom: 22 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom
const STRIP_H = 5
/** Gridlines at the band boundaries and the ends of the scale; 100 is drawn but not labelled (it would sit on 90). */
const TICKS = [0, 50, 70, 90, 100]

/**
 * pLDDT along the sequence. One line; the hairlines at 50, 70 and 90 are the band boundaries, and
 * the strip under the axis repeats each residue's band colour so low-confidence stretches can be
 * matched to the 3D view. Hover, or focus and use the arrow keys, to read a residue; click or
 * press Enter to select it.
 */
export function PlddtProfile({ residues, selectedIndex, onSelect }: {
  residues: PlddtResidue[]
  selectedIndex: number | null
  onSelect: (residue: PlddtResidue) => void
}) {
  const [hover, setHover] = useState<number | null>(null)
  const titleId = useId()
  const n = residues.length
  if (n === 0) return null

  // Each residue owns an equal slice of the plot; its point sits at the centre of its slice.
  const cell = PLOT_W / n
  const x = (i: number) => PAD.left + (i + 0.5) * cell
  const y = (v: number) => PAD.top + (1 - Math.max(0, Math.min(100, v)) / 100) * PLOT_H

  // One path, lifted at chain boundaries so the line never joins two chains.
  let path = ''
  const chainStarts: number[] = []
  residues.forEach((r, i) => {
    const newChain = i === 0 || residues[i - 1].chain !== r.chain
    if (newChain && i > 0) chainStarts.push(i)
    path += `${newChain ? 'M' : 'L'}${x(i).toFixed(2)} ${y(r.plddt).toFixed(2)}`
  })

  const active = hover ?? selectedIndex
  const shown = active !== null && active < n ? residues[active] : null

  function indexAt(event: { clientX: number; currentTarget: Element }): number {
    const box = event.currentTarget.getBoundingClientRect()
    const fraction = box.width > 0 ? (event.clientX - box.left) / box.width : 0
    return Math.max(0, Math.min(n - 1, Math.floor(fraction * n)))
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const from = hover ?? selectedIndex ?? 0
    const step = event.shiftKey ? 10 : 1
    let next: number | null = null
    if (event.key === 'ArrowRight') next = Math.min(n - 1, from + step)
    else if (event.key === 'ArrowLeft') next = Math.max(0, from - step)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = n - 1
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(residues[from])
      return
    }
    if (next !== null) {
      event.preventDefault()
      setHover(next)
    }
  }

  return (
    <figure className="m-0">
      <figcaption id={titleId} className="mb-1 text-[0.8125rem] text-muted-foreground">pLDDT along the sequence</figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full rounded-md"
          role="slider"
          tabIndex={0}
          aria-labelledby={titleId}
          aria-valuemin={1}
          aria-valuemax={n}
          aria-valuenow={(active ?? 0) + 1}
          aria-valuetext={shown ? `${residueName(shown)}, pLDDT ${shown.plddt.toFixed(1)}, ${bandOf(shown.bin)?.label ?? shown.bin}` : 'No residue chosen'}
          onKeyDown={onKeyDown}
          onBlur={() => setHover(null)}
        >
          {TICKS.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth={1} />
              {tick !== 100 && <text x={PAD.left - 5} y={y(tick) + 3} textAnchor="end" fontSize={9} fill="var(--muted-foreground)">{tick}</text>}
            </g>
          ))}
          {chainStarts.map((i) => (
            <line key={i} x1={PAD.left + i * cell} x2={PAD.left + i * cell} y1={PAD.top} y2={H - PAD.bottom + STRIP_H + 3} stroke="var(--input)" strokeWidth={1} />
          ))}
          <path d={path} fill="none" stroke="var(--foreground)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
          {residues.map((r, i) => (
            <rect
              key={i}
              x={PAD.left + i * cell}
              y={H - PAD.bottom + 3}
              width={cell + 0.2}
              height={STRIP_H}
              fill={bandOf(r.bin)?.css ?? 'var(--muted)'}
            />
          ))}
          <text x={PAD.left} y={H - 3} fontSize={9} fill="var(--muted-foreground)">{residueName(residues[0])}</text>
          <text x={W - PAD.right} y={H - 3} fontSize={9} textAnchor="end" fill="var(--muted-foreground)">{residueName(residues[n - 1])}</text>
          {shown && active !== null && (
            <g pointerEvents="none">
              <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--muted-foreground)" strokeWidth={1} />
              <circle cx={x(active)} cy={y(shown.plddt)} r={4} fill="var(--foreground)" stroke="var(--card)" strokeWidth={2} />
            </g>
          )}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={PLOT_W}
            height={PLOT_H + STRIP_H + 4}
            fill="transparent"
            className="cursor-crosshair"
            onPointerMove={(event) => setHover(indexAt(event))}
            onPointerLeave={() => setHover(null)}
            onClick={(event) => onSelect(residues[indexAt(event)])}
          />
        </svg>
        <p role="status" className="mt-1 min-h-5 text-[0.8125rem]">
          {shown ? (
            <>
              <span className="font-semibold">{shown.plddt.toFixed(1)}</span>{' '}
              <span className="text-muted-foreground">
                pLDDT at {residueName(shown)}, {bandOf(shown.bin)?.label.toLowerCase() ?? shown.bin}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Point at the line, or focus it and use the arrow keys, to read a residue.</span>
          )}
        </p>
      </div>
      <details className="mt-1 text-[0.8125rem]">
        <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">Show as a table</summary>
        <div className="mt-2 max-h-56 overflow-auto rounded-md border border-border">
          <table className="fs-table">
            <thead>
              <tr><th>Residue</th><th className="text-right">pLDDT</th><th>Band</th></tr>
            </thead>
            <tbody>
              {residues.map((r, i) => (
                <tr key={i}>
                  <td className="font-mono">{residueName(r)}</td>
                  <td className="text-right">{r.plddt.toFixed(1)}</td>
                  <td>{bandOf(r.bin)?.label ?? r.bin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}

/** Mean and median with the band split and the profile: everything the backend reports on pLDDT. */
export function ConfidenceSummary({ plddt, selectedIndex, onSelect }: {
  plddt: PlddtResponse
  selectedIndex: number | null
  onSelect: (residue: PlddtResidue) => void
}) {
  return (
    <div className="space-y-4">
      <dl className="flex gap-8">
        <div>
          <dt className="text-[0.8125rem] text-muted-foreground">Mean pLDDT</dt>
          <dd className="text-2xl font-semibold tracking-tight">{plddt.mean === null ? 'n/a' : plddt.mean.toFixed(1)}</dd>
        </div>
        <div>
          <dt className="text-[0.8125rem] text-muted-foreground">Median</dt>
          <dd className="text-2xl font-semibold tracking-tight">{plddt.median === null ? 'n/a' : plddt.median.toFixed(1)}</dd>
        </div>
        <div>
          <dt className="text-[0.8125rem] text-muted-foreground">Residues</dt>
          <dd className="text-2xl font-semibold tracking-tight">{plddt.n_residues}</dd>
        </div>
      </dl>
      <BandSplit plddt={plddt} />
      <PlddtProfile residues={plddt.per_residue} selectedIndex={selectedIndex} onSelect={onSelect} />
      <Note>{plddt.note}</Note>
    </div>
  )
}
