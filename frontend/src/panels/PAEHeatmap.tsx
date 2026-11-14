import { useEffect, useRef, useState } from 'react'
import { ApiError } from '@/api'
import { getPae, listStructures } from '@/api'
import type { PaeResponse, Structure } from '@/api'

function paeColor(value: number, max: number): string {
  const t = Math.max(0, Math.min(1, value / Math.max(max, 1)))
  const r = Math.round(35 + 205 * t)
  const g = Math.round(190 - 145 * t)
  const b = Math.round(220 - 185 * t)
  return `rgb(${r}, ${g}, ${b})`
}

export function PAEHeatmap({ structureId: suppliedId }: { structureId?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [structures, setStructures] = useState<Structure[]>([])
  const [structureId, setStructureId] = useState(suppliedId ?? '')
  const [data, setData] = useState<PaeResponse | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<{ row: number; col: number; value: number; x: number; y: number } | null>(null)

  useEffect(() => {
    if (suppliedId) setStructureId(suppliedId)
  }, [suppliedId])

  useEffect(() => {
    let alive = true
    listStructures().then((items) => { if (alive) { setStructures(items); if (!suppliedId) setStructureId((current) => current || items[0]?.id || '') } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Unable to list structures') })
    return () => { alive = false }
  }, [suppliedId])

  useEffect(() => {
    if (!structureId) { setData(null); setHover(null); return }
    let alive = true
    setUnavailable(false)
    setError(null)
    setData(null)
    setHover(null)
    getPae(structureId).then((result) => { if (alive) setData(result) })
      .catch((e: unknown) => {
        if (!alive) return
        if (e instanceof ApiError && e.status === 404 && e.detail === 'pae_unavailable') setUnavailable(true)
        else setError(e instanceof Error ? e.message : 'Unable to load PAE')
      })
    return () => { alive = false }
  }, [structureId])

  useEffect(() => {
    const canvas = canvasRef.current
    const matrix = data?.matrix
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !matrix?.length) return
    const n = matrix.length
    const cell = Math.max(1, Math.floor(640 / n))
    canvas.width = n * cell
    canvas.height = n * cell
    const max = Math.max(1, matrix.reduce((largest, row) =>
      row.reduce((rowMax, value) => Math.max(rowMax, Number.isFinite(value) ? value : 0), largest), 0))
    matrix.forEach((row, y) => row.forEach((value, x) => {
      ctx.fillStyle = paeColor(value, max)
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }))
  }, [data])

  function onMouseMove(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const matrix = data?.matrix
    if (!canvas || !matrix?.length) return
    const rect = canvas.getBoundingClientRect()
    const x = (event.clientX - rect.left) * (canvas.width / Math.max(rect.width, 1))
    const y = (event.clientY - rect.top) * (canvas.height / Math.max(rect.height, 1))
    const col = Math.min(matrix.length - 1, Math.max(0, Math.floor(x / (canvas.width / matrix.length))))
    const row = Math.min(matrix.length - 1, Math.max(0, Math.floor(y / (canvas.height / matrix.length))))
    setHover({ row, col, value: matrix[row]?.[col] ?? 0, x: event.clientX - rect.left, y: event.clientY - rect.top })
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-sm font-semibold">Predicted aligned error (PAE)</h2>
          <p className="text-xs text-muted-foreground">Lower values indicate greater predicted positional confidence.</p></div>
        {!suppliedId && <select aria-label="Structure" className="rounded border border-border bg-background p-2 text-xs"
          value={structureId} onChange={(e) => setStructureId(e.target.value)}>
          {structures.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>}
      </div>
      {unavailable ? <p className="rounded border border-dashed border-border p-4 text-sm text-muted-foreground">PAE not available for this model.</p>
        : error ? <p role="alert" className="text-sm text-destructive">{error}</p>
          : !data ? <p role="status" className="text-sm text-muted-foreground">Loading PAE…</p>
            : <div className="relative overflow-auto">
              <canvas ref={canvasRef} aria-label="PAE heatmap" role="img" onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)}
                className="max-w-full border border-border" style={{ imageRendering: 'pixelated' }} />
              {hover && <div role="status" className="pointer-events-none absolute rounded bg-popover px-2 py-1 text-xs shadow"
                style={{ left: Math.min(hover.x + 10, 260), top: Math.max(0, hover.y - 36) }}>
                Residues {data.residue_indices?.[hover.row] ?? hover.row + 1} / {data.residue_indices?.[hover.col] ?? hover.col + 1}: {hover.value.toFixed(2)} Å
              </div>}
            </div>}
      <p className="mt-3 text-[11px] text-muted-foreground">PAE is a model-confidence estimate, not proof of folding or binding.</p>
    </section>
  )
}
