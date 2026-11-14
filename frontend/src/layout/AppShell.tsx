import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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
      <nav aria-label="Primary" className="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="flex h-12 items-center gap-2 border-b border-border px-4">
          <span className="size-2.5 rounded-full bg-primary" aria-hidden />
          <span className="text-sm font-semibold tracking-wide">FoldStudio</span>
        </div>
        <ul className="flex-1 space-y-0.5 p-2">
          {NAV_ITEMS.map(({ id, path, label, icon: Icon }) => (
            <li key={id}>
              <NavLink
                to={path}
                end={path === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-muted',
                    isActive && 'bg-primary/15 text-primary',
                  )
                }
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <p className="border-t border-border p-3 text-[11px] leading-snug text-muted-foreground">
          Research review tool. Not a clinical tool. Confidence scores are model estimates, not validation.
        </p>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-end border-b border-border px-3">
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
          <main className="min-w-0 flex-1 overflow-auto p-4">
            <Outlet />
          </main>
          <aside
            id="right-sidebar"
            aria-label="Details"
            hidden={!rightOpen}
            className="w-80 shrink-0 overflow-auto border-l border-border bg-sidebar p-3 data-[hidden]:hidden"
          >
            <PanelSlot name="right" />
          </aside>
        </div>
      </div>
    </div>
  )
}
