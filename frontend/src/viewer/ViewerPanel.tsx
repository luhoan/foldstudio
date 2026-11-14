import { Camera, Loader2, RotateCcw, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  ViewerError,
  type AdapterFactory,
  type ColorScheme,
  type Matrix4x4,
  type RepresentationKind,
  type ResidueClickEvent,
  type ResidueRange,
  type SecondLayout,
  type StructureFormat,
  type ViewerAdapter,
} from './adapter'
import { createViewerAdapter } from './createAdapter'
import { PlddtLegend } from './PlddtLegend'
import { viewerActions } from './store'

export interface ViewerPanelProps {
  url?: string | null
  format?: StructureFormat
  label?: string
  /** Structure.source from the contract; controls the pLDDT-vs-B-factor caveat. */
  structureKind?: 'experimental' | 'predicted' | 'uploaded'
  secondUrl?: string | null
  secondFormat?: StructureFormat
  /** Row-major 4x4 from /api/analysis/align, applied to the second structure in overlay layout. */
  secondMatrix?: Matrix4x4
  secondLayout?: SecondLayout
  initialRepresentation?: RepresentationKind
  highlight?: { chain: string; ranges: ResidueRange[] } | null
  onResidueClick?: (e: ResidueClickEvent) => void
  onReady?: (adapter: ViewerAdapter) => void
  /** Injection point for tests; defaults to the lazily loaded Mol* adapter. */
  adapterFactory?: AdapterFactory
  className?: string
}

type Status = 'initializing' | 'idle' | 'loading' | 'ready' | 'error'

const REPRESENTATIONS: { id: RepresentationKind; label: string }[] = [
  { id: 'cartoon', label: 'Cartoon' },
  { id: 'ball-and-stick', label: 'Ball & stick' },
  { id: 'surface', label: 'Surface' },
]

const COLOR_OPTIONS: { id: ColorScheme; label: string }[] = [
  { id: 'chain', label: 'Chain' },
  { id: 'secondary-structure', label: 'Secondary structure' },
  { id: 'plddt', label: 'pLDDT confidence' },
  { id: 'uniform', label: 'Uniform' },
]

const defaultFactory: AdapterFactory = () => createViewerAdapter()

function describe(e: unknown): { code: string; message: string } {
  if (e instanceof ViewerError) return { code: e.code, message: e.message }
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) }
}

export function ViewerPanel({
  url,
  format = 'pdb',
  label,
  structureKind,
  secondUrl,
  secondFormat,
  secondMatrix,
  secondLayout = 'overlay',
  initialRepresentation = 'cartoon',
  highlight,
  onResidueClick,
  onReady,
  adapterFactory = defaultFactory,
  className,
}: ViewerPanelProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [adapter, setAdapter] = useState<ViewerAdapter | null>(null)
  const [status, setStatus] = useState<Status>('initializing')
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [representation, setRepresentation] = useState<RepresentationKind>(initialRepresentation)
  const [userScheme, setUserScheme] = useState<ColorScheme | null>(null)
  const [lastClick, setLastClick] = useState<ResidueClickEvent | null>(null)
  const secondLoadedRef = useRef(false)
  const onClickRef = useRef(onResidueClick)
  const onReadyRef = useRef(onReady)
  onClickRef.current = onResidueClick
  onReadyRef.current = onReady

  // With two structures overlaid, uniform colours (teal vs purple) are the only way to tell them apart.
  const scheme: ColorScheme = userScheme ?? (secondUrl ? 'uniform' : 'chain')

  // 1. Create + initialise the adapter once per mount.
  useEffect(() => {
    const container = mountRef.current
    if (!container) return
    let cancelled = false
    let created: ViewerAdapter | null = null
    ;(async () => {
      try {
        const a = await adapterFactory()
        created = a
        await a.init(container)
        if (cancelled) {
          a.dispose()
          return
        }
        setAdapter(a)
        setStatus('idle')
        viewerActions.setAdapter(a)
        onReadyRef.current?.(a)
      } catch (e) {
        if (cancelled) return
        created?.dispose()
        setError(describe(e))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
      viewerActions.setAdapter(null)
      setAdapter(null)
      secondLoadedRef.current = false
      created?.dispose()
    }
    // adapterFactory intentionally excluded: the adapter lives for the lifetime of the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 2. Keep adapter-held display state in sync (cheap no-ops until a structure is loaded).
  useEffect(() => {
    adapter?.setRepresentation(representation).catch((e) => setNotice(describe(e).message))
  }, [adapter, representation])
  useEffect(() => {
    adapter?.colorBy(scheme).catch((e) => setNotice(describe(e).message))
  }, [adapter, scheme])

  // 3. Load the primary structure.
  useEffect(() => {
    if (!adapter) return
    if (!url) {
      setStatus('idle')
      setError(null)
      return
    }
    let stale = false
    secondLoadedRef.current = false
    setStatus('loading')
    setError(null)
    setNotice(null)
    setLastClick(null)
    adapter
      .load(url, format)
      .then(() => {
        if (stale) return
        setStatus('ready')
      })
      .catch((e) => {
        if (stale) return
        setError(describe(e))
        setStatus('error')
      })
    return () => {
      stale = true
    }
  }, [adapter, url, format, retry])

  // 4. Second structure (overlay / side-by-side), once the primary is ready.
  useEffect(() => {
    if (!adapter || status !== 'ready') return
    let stale = false
    if (secondUrl) {
      adapter
        .loadSecond(secondUrl, secondMatrix, { format: secondFormat, layout: secondLayout })
        .then(() => {
          if (!stale) {
            secondLoadedRef.current = true
            setNotice(null)
          }
        })
        .catch((e) => !stale && setNotice(`Second structure: ${describe(e).message}`))
    } else if (secondLoadedRef.current) {
      secondLoadedRef.current = false
      adapter.unloadSecond().catch((e) => setNotice(describe(e).message))
    }
    return () => {
      stale = true
    }
  }, [adapter, status, secondUrl, secondFormat, secondMatrix, secondLayout])

  // 5. Highlight.
  useEffect(() => {
    if (!adapter || status !== 'ready') return
    if (highlight && highlight.ranges.length > 0) adapter.highlightResidues(highlight.chain, highlight.ranges)
    else adapter.clearHighlight()
  }, [adapter, status, highlight])

  // 6. Residue clicks.
  useEffect(() => {
    if (!adapter) return
    return adapter.onResidueClick((e) => {
      setLastClick(e)
      onClickRef.current?.(e)
    })
  }, [adapter])

  async function takeScreenshot() {
    if (!adapter) return
    try {
      const blob = await adapter.screenshot()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${(label ?? 'structure').replace(/[^\w.-]+/g, '_')}.png`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      setNotice(`Screenshot failed: ${describe(e).message}`)
    }
  }

  const interactive = status === 'ready'
  const canRetry = error && error.code !== 'webgl'

  return (
    <div data-testid="viewer-panel" className={cn('flex h-full min-h-[360px] flex-col overflow-hidden rounded-lg border border-border bg-card', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div role="group" aria-label="Representation" className="flex overflow-hidden rounded-md border border-border">
          {REPRESENTATIONS.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={representation === r.id}
              disabled={!interactive}
              onClick={() => setRepresentation(r.id)}
              className={cn(
                'px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                representation === r.id ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Colour
          <select
            aria-label="Colour by"
            value={scheme}
            disabled={!interactive}
            onChange={(e) => setUserScheme(e.target.value as ColorScheme)}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
          >
            {COLOR_OPTIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-1">
          {lastClick && (
            <span data-testid="clicked-residue" className="mr-2 rounded bg-muted px-2 py-0.5 text-xs tabular-nums">
              {lastClick.chain}:{lastClick.compId}
              {lastClick.seqId}
              {lastClick.insCode.trim()}
            </span>
          )}
          <Button variant="ghost" size="sm" disabled={!interactive} onClick={() => adapter?.resetCamera()} aria-label="Reset camera">
            <RotateCcw /> Reset view
          </Button>
          <Button variant="ghost" size="sm" disabled={!interactive} onClick={takeScreenshot} aria-label="Save screenshot">
            <Camera /> PNG
          </Button>
        </div>
      </div>

      <div className="relative flex-1 bg-[#0a0f1d]">
        {/* Owned by the adapter (it appends its canvas here); React never renders children into it. */}
        <div ref={mountRef} data-testid="viewer-mount" className="absolute inset-0" />

        {(status === 'initializing' || status === 'loading') && (
          <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/60 text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin text-primary" />
            {status === 'initializing' ? 'Starting 3D viewer…' : `Loading ${label ?? 'structure'}…`}
          </div>
        )}

        {status === 'idle' && !url && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0f1d] p-6 text-center text-sm text-muted-foreground">
            No structure loaded. Choose or upload a structure to view it here.
          </div>
        )}

        {status === 'error' && error && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 p-6 text-center">
            <TriangleAlert className="size-7 text-destructive" />
            <p className="max-w-md text-sm text-foreground">{error.message}</p>
            {canRetry && (
              <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
                Retry
              </Button>
            )}
          </div>
        )}

        {notice && interactive && (
          <div role="status" className="absolute inset-x-3 top-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
            {notice}
          </div>
        )}

        {interactive && scheme === 'plddt' && <PlddtLegend structureKind={structureKind} className="absolute bottom-3 left-3" />}
      </div>
    </div>
  )
}
