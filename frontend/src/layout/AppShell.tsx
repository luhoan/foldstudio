import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ApiStatus } from './ApiStatus'
import { NAV_ITEMS } from './nav'
import { PanelSlot } from './PanelSlot'

const RIGHT_KEY = 'foldstudio.rightSidebarOpen'

function readOpen(): boolean {
  try {
    return localStorage.getItem(RIGHT_KEY) !== '0'
  } catch {
    return true
  }
}

export function AppShell() {
  const [rightOpen, setRightOpen] = useState(readOpen)
  function toggleRight() {
    setRightOpen((open) => {
      try {
        localStorage.setItem(RIGHT_KEY, open ? '0' : '1')
      } catch {
        /* storage unavailable: keep in-memory state only */
      }
      return !open
    })
  }

  return (
    <div className="flex h-full bg-background text-foreground">
      <nav aria-label="Primary" className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <span className="fs-wordmark">FoldStudio</span>
        </div>
        <ul className="flex-1 space-y-0.5 overflow-auto px-2 py-2">
          {NAV_ITEMS.map(({ id, path, label, icon: Icon }) => (
            <li key={id}>
              <NavLink
                to={path}
                end={path === '/'}
                className={({ isActive }) =>
                  cn(
                    'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-muted/70 hover:text-foreground',
                    isActive && 'bg-muted font-medium text-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      aria-hidden
                      className={cn('absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary transition-opacity', isActive ? 'opacity-100' : 'opacity-0')}
                    />
                    <Icon className={cn('size-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
                    {label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <p className="border-t border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          Research review tool. Not a clinical tool. Confidence scores are model estimates, not validation.
        </p>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
          <ApiStatus />
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleRight}
            aria-expanded={rightOpen}
            aria-controls="right-sidebar"
            aria-label={rightOpen ? 'Collapse right sidebar' : 'Expand right sidebar'}
          >
            {rightOpen ? <PanelRightClose /> : <PanelRightOpen />}
            Details
          </Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-auto px-6 py-6">
            <Outlet />
          </main>
          <aside
            id="right-sidebar"
            aria-label="Details"
            hidden={!rightOpen}
            className="w-[21rem] shrink-0 overflow-auto border-l border-border bg-sidebar p-4 data-[hidden]:hidden"
          >
            <PanelSlot name="right" />
          </aside>
        </div>
      </div>
    </div>
  )
}
