import { NAV_ITEMS, type RouteId } from './nav'
import { PanelSlot } from './PanelSlot'

function PageHeader({ id }: { id: RouteId }) {
  const item = NAV_ITEMS.find((n) => n.id === id)!
  return (
    <header className="mb-5">
      <h1 className="fs-page-title">{item.label}</h1>
      <p className="mt-1.5 max-w-[70ch] text-[0.95rem] text-muted-foreground">{item.description}</p>
    </header>
  )
}

/** Generic route page: header + the route's main slot. */
export function SlotPage({ id }: { id: RouteId }) {
  return (
    <div className="mx-auto max-w-[88rem]">
      <PageHeader id={id} />
      <PanelSlot name={`${id}.main`} />
    </div>
  )
}

/**
 * Protein Explorer: the viewer panel in `explorer.main`, with supporting panels in
 * `explorer.below`. The page itself holds no state; the panels own the structure choice.
 */
export function ExplorerPage() {
  return (
    <div className="mx-auto flex max-w-[88rem] flex-col">
      <PageHeader id="explorer" />
      <div className="flex flex-col gap-4">
        <PanelSlot name="explorer.main" />
        <PanelSlot name="explorer.below" empty={null} />
      </div>
    </div>
  )
}
