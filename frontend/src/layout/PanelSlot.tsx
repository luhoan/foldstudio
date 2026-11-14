import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { usePanels, type SlotName } from './slots'

class PanelBoundary extends Component<{ id: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[PanelSlot] panel "${this.props.id}" crashed`, error, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          Panel <code className="font-mono">{this.props.id}</code> failed to render: {this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}

export interface PanelSlotProps {
  name: SlotName
  className?: string
  /** Shown when nothing is registered. Defaults to a dashed placeholder naming the slot. */
  empty?: ReactNode
}

/** Renders every panel registered for `name`, each isolated by an error boundary + Suspense. */
export function PanelSlot({ name, className, empty }: PanelSlotProps) {
  const panels = usePanels(name)
  if (panels.length === 0) {
    return (
      <div data-slot-name={name} data-slot-empty className={className}>
        {empty ?? (
          <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
            No panel registered for slot <code className="font-mono text-foreground">{name}</code>.
          </div>
        )}
      </div>
    )
  }
  return (
    <div data-slot-name={name} className={cn('flex flex-col gap-4', className)}>
      {panels.map(({ id, title, component: Panel }) => (
        <section key={id} data-panel-id={id} aria-label={title ?? id}>
          <PanelBoundary id={id}>
            <Suspense fallback={<div role="status" className="p-3 text-xs text-muted-foreground">Loading {title ?? id}…</div>}>
              <Panel />
            </Suspense>
          </PanelBoundary>
        </section>
      ))}
    </div>
  )
}
