import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { attachPae } from '@/api'
import type { Structure } from '@/api'
import { usePae, useResidues } from './details'
import { errorMessage } from './format'
import { refreshLibrary, useLibrary } from './library'
import { usePanelState } from './panelState'
import { Card, EmptyState, ErrorNote, Loading, Note } from './ui'

/**
 * One hue, from the card surface up to a bright mint. Low expected error is the bright end, so
 * confidently placed domains stand out as lit blocks and uncertain regions sink into the page:
 * the dark-surface counterpart of the dark-green-on-white plots AlphaFold DB draws. The scale
 * under the plot spells the direction out.
 */
const RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [0x9a, 0xf7, 0xe6], // 0 A: brightest
  [0x4f, 0xd8, 0xc3],
  [0x23, 0xa8, 0x98],
  [0x17, 0x76, 0x6f],
  [0x15, 0x4a, 0x52],
  [0x13, 0x26, 0x3a], // the cap and beyond: nearly the surface
]

function rampColor(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 1))
  const scaled = clamped * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(scaled))
  const f = scaled - i
  const a = RAMP[i]
  const b = RAMP[i + 1]
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)]
}

const RAMP_CSS = `linear-gradient(to right, ${RAMP.map(([r, g, b]) => `rgb(${r} ${g} ${b})`).join(', ')})`

/** The value at which the colour scale saturates: the predictor's own cap when it states one. */
function scaleCap(maxPae: number | null, matrix: number[][]): number {
  if (maxPae !== null && Number.isFinite(maxPae) && maxPae > 0) return maxPae
  let largest = 0
  for (const row of matrix) for (const v of row) if (Number.isFinite(v) && v > largest) largest = v
  return largest > 0 ? largest : 1
}

function AttachPae({ structure, onAttached }: { structure: Structure; onAttached: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function attach(file: File | undefined) {
    if (!file) return
    setBusy(true); setError(null)
    try {
      await attachPae(structure.id, file)
      await refreshLibrary()
      onAttached()
    } catch (e) {
      setError(errorMessage(e, 'The PAE file could not be attached.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-2 text-sm">
      <label className="inline-flex flex-col gap-1">
        <span className="text-muted-foreground">Attach the PAE file from the same prediction (JSON)</span>
        <input
          type="file"
          accept=".json"
          disabled={busy}
          onChange={(e) => attach(e.target.files?.[0])}
          className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-muted file:px-3 file:py-1.5 file:text-sm file:text-foreground"
        />
      </label>
      {busy && <Loading>Attaching…</Loading>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  )
}

interface Cell { row: number; col: number }

/**
 * Predicted aligned error of the active structure: for each pair of residues, the error the model
 * expects in the position of one when the structure is aligned on the other.
 */
export function PAEHeatmap() {
  const { structures } = useLibrary()
  const { activeStructureId } = usePanelState()
  const structure = structures.find((s) => s.id === activeStructureId) ?? null
  const [revision, setRevision] = useState(0)
  const pae = usePae(structure, revision)
  const residues = useResidues(structure && structure.has_pae && structure.format !== 'fasta' ? structure.id : null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [cell, setCell] = useState<Cell | null>(null)

  const matrix = pae.state === 'ok' ? pae.data.matrix : null
  const n = matrix?.length ?? 0
  const cap = useMemo(() => (pae.state === 'ok' ? scaleCap(pae.data.max_pae, pae.data.matrix) : 1), [pae])

  // Residue names for the axes and the readout, when the residue list lines up with the matrix.
  const names = useMemo(() => {
    if (residues.state !== 'ok' || residues.data.residues.length !== n) return null
    return residues.data.residues.map((r) => `${r.chain}:${r.resname}${r.resseq}${r.icode}`)
  }, [residues, n])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !matrix || n === 0) return
    const context = canvas.getContext('2d')
    if (!context) return
    canvas.width = n
    canvas.height = n
    const image = context.createImageData(n, n)
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const [r, g, b] = rampColor((matrix[row]?.[col] ?? cap) / cap)
        const at = (row * n + col) * 4
        image.data[at] = r
        image.data[at + 1] = g
        image.data[at + 2] = b
        image.data[at + 3] = 255
      }
    }
    context.putImageData(image, 0, 0)
  }, [matrix, n, cap])

  if (!structure) return null

  function cellAt(event: PointerEvent<HTMLCanvasElement>): Cell {
    const box = event.currentTarget.getBoundingClientRect()
    const fx = box.width > 0 ? (event.clientX - box.left) / box.width : 0
    const fy = box.height > 0 ? (event.clientY - box.top) / box.height : 0
    return { row: Math.max(0, Math.min(n - 1, Math.floor(fy * n))), col: Math.max(0, Math.min(n - 1, Math.floor(fx * n))) }
  }

  function onKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    const from = cell ?? { row: 0, col: 0 }
    const step = event.shiftKey ? 10 : 1
    const moves: Record<string, Cell> = {
      ArrowRight: { row: from.row, col: from.col + step },
      ArrowLeft: { row: from.row, col: from.col - step },
      ArrowDown: { row: from.row + step, col: from.col },
      ArrowUp: { row: from.row - step, col: from.col },
    }
    const next = moves[event.key]
    if (!next) return
    event.preventDefault()
    setCell({ row: Math.max(0, Math.min(n - 1, next.row)), col: Math.max(0, Math.min(n - 1, next.col)) })
  }

  const shown = cell && matrix && cell.row < n && cell.col < n ? cell : null
  const label = (index: number) => names?.[index] ?? `residue ${index + 1}`
  const ticks = n > 1 ? [0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1] : [0]

  let body
  if (!structure.has_pae) {
    body = structure.source === 'predicted' ? (
      <>
        <EmptyState title="No PAE file for this model">
          PAE is a separate file a predictor writes next to the structure. This model was added without one.
        </EmptyState>
        <AttachPae structure={structure} onAttached={() => setRevision((r) => r + 1)} />
      </>
    ) : (
      <EmptyState title="PAE does not apply to this structure">
        PAE is a predictor's estimate of its own positional error. This structure is{' '}
        {structure.source === 'experimental' ? 'experimental' : 'not declared as a predicted model'}, so there is none.
      </EmptyState>
    )
  } else if (pae.state === 'error') {
    body = <ErrorNote>{errorMessage(pae.error, 'PAE could not be loaded.')}</ErrorNote>
  } else if (pae.state !== 'ok' || !matrix) {
    body = <Loading>Loading PAE…</Loading>
  } else {
    body = (
      <div className="flex flex-wrap items-start gap-6">
        <figure className="m-0">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
            <div className="relative w-9 text-right text-[0.6875rem] text-muted-foreground" aria-hidden>
              {ticks.map((t) => (
                <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${n > 1 ? (t / (n - 1)) * 100 : 50}%` }}>{t + 1}</span>
              ))}
            </div>
            <canvas
              ref={canvasRef}
              role="img"
              tabIndex={0}
              aria-label={`PAE heatmap, ${n} by ${n} residues. Use the arrow keys to read a cell.`}
              onPointerMove={(event) => setCell(cellAt(event))}
              onPointerLeave={() => setCell(null)}
              onKeyDown={onKeyDown}
              className="size-[min(26rem,60vw)] cursor-crosshair rounded-md border border-border"
              style={{ imageRendering: 'pixelated' }}
            />
            <span />
            <div className="relative h-4 text-[0.6875rem] text-muted-foreground" aria-hidden>
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 -translate-x-1/2" style={{ left: `${n > 1 ? (t / (n - 1)) * 100 : 50}%` }}>{t + 1}</span>
              ))}
            </div>
          </div>
          <figcaption className="mt-1 pl-11 text-[0.8125rem] text-muted-foreground">
            Across: scored residue. Down: residue the structure is aligned on.
          </figcaption>
        </figure>

        <div className="min-w-56 flex-1 space-y-4 text-sm">
          <div>
            <div className="h-2.5 w-full max-w-64 rounded-full" style={{ background: RAMP_CSS }} aria-hidden />
            <div className="mt-1 flex w-full max-w-64 justify-between text-[0.8125rem] text-muted-foreground">
              <span>0 Å</span>
              <span>{Number(cap.toFixed(1))} Å or more</span>
            </div>
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">Expected position error. Brighter means lower error.</p>
          </div>

          <p role="status" className="min-h-12">
            {shown ? (
              <>
                <span className="text-xl font-semibold">{(matrix[shown.row]?.[shown.col] ?? Number.NaN).toFixed(1)} Å</span>
                <span className="block text-[0.8125rem] text-muted-foreground">
                  expected error at {label(shown.col)} when aligned on {label(shown.row)}
                </span>
              </>
            ) : (
              <span className="text-[0.8125rem] text-muted-foreground">Point at the plot, or focus it and use the arrow keys, to read a pair of residues.</span>
            )}
          </p>

          <Note>{pae.data.note}</Note>
        </div>
      </div>
    )
  }

  return (
    <Card title="Predicted aligned error (PAE)" description={structure.has_pae ? `${structure.label}` : undefined}>
      {body}
    </Card>
  )
}
