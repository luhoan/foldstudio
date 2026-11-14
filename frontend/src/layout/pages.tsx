import { useEffect } from 'react'
import { useViewerState, viewerActions, ViewerPanel, useSampleStructures, type StructureSource } from '@/viewer'
import { NAV_ITEMS, type RouteId } from './nav'
import { PanelSlot } from './PanelSlot'

function PageHeader({ id }: { id: RouteId }) {
  const item = NAV_ITEMS.find((n) => n.id === id)!
  return (
    <div className="mb-4">
      <h1 className="text-lg font-semibold">{item.label}</h1>
      <p className="text-sm text-muted-foreground">{item.description}</p>
    </div>
  )
}

/** Generic route page: header + the route's main slot. */
export function SlotPage({ id }: { id: RouteId }) {
  return (
    <div>
      <PageHeader id={id} />
      <PanelSlot name={`${id}.main`} />
    </div>
  )
}

/**
 * Protein Explorer: the viewer plus a selector. Structure source of truth is the viewer store so
 * Stream 5 panels can call viewerActions.setStructure(...). Until the backend exists, the selector
 * lists real files from frontend/public/samples/.
 */
export function ExplorerPage() {
  const { structure } = useViewerState()
  const { samples, loading, error } = useSampleStructures()

  // Default to the first sample if nothing has been chosen yet.
  useEffect(() => {
    if (!structure && samples.length > 0) {
      const s = samples[0]
      viewerActions.setStructure({ url: s.url, format: s.format, label: s.file })
    }
  }, [structure, samples])

  function choose(url: string) {
    const s = samples.find((x) => x.url === url)
    if (s) viewerActions.setStructure({ url: s.url, format: s.format, label: s.file } satisfies StructureSource)
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeader id="explorer" />
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor="sample-select" className="text-muted-foreground">
          Structure
        </label>
        <select
          id="sample-select"
          value={structure?.url ?? ''}
          onChange={(e) => choose(e.target.value)}
          disabled={samples.length === 0}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-50"
        >
          {samples.length === 0 && <option value="">{loading ? 'Loading…' : 'No samples'}</option>}
          {samples.map((s) => (
            <option key={s.url} value={s.url}>
              {s.file}
            </option>
          ))}
        </select>
        {!loading && samples.length === 0 && (
          <span className="text-xs text-muted-foreground">
            {error ? `Could not read the sample list (${error}).` : 'Drop a real .pdb/.cif file into frontend/public/samples/ to view it here.'}
          </span>
        )}
      </div>
      <div className="min-h-[420px] flex-1">
        <ViewerPanel url={structure?.url} format={structure?.format} label={structure?.label} structureKind={structure?.source} />
      </div>
      <PanelSlot name="explorer.below" />
    </div>
  )
}
