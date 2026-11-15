import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { USE_MOCKS } from '@/api/config'
import { refreshLibrary, useLibrary } from '@/panels/library'
import { cn } from '@/lib/utils'

/**
 * Whether the app can reach its backend, said once, in the same place on every page.
 *
 * Every panel depends on the API, and "the backend is not running" used to surface as a different
 * error in each of them. This reads the shared library, so it reports the same thing they see.
 */
export function ApiStatus() {
  const library = useLibrary()
  const [busy, setBusy] = useState(false)

  async function reload() {
    setBusy(true)
    try {
      await refreshLibrary()
    } finally {
      setBusy(false)
    }
  }

  const loading = library.status !== 'ready'
  const down = !loading && library.error !== null
  const nothing = !loading && !down && library.structures.length === 0 && library.experiments.length === 0

  let text: string
  if (loading) text = 'Connecting to the backend…'
  else if (down) text = 'Backend not reachable'
  else if (USE_MOCKS) text = 'Mock mode: showing synthetic fixtures, not your data'
  else if (nothing) text = 'Connected. Nothing loaded yet'
  else {
    const s = library.structures.length
    const e = library.experiments.length
    text = `Connected: ${s} structure${s === 1 ? '' : 's'}, ${e} experiment${e === 1 ? '' : 's'}`
  }

  return (
    <div role="status" className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">
      <span
        aria-hidden
        className={cn('size-2 shrink-0 rounded-full', loading ? 'bg-muted-foreground/50' : down ? 'bg-bad' : USE_MOCKS ? 'bg-warn' : 'bg-good')}
      />
      <span className="truncate">
        {text}
        {down && <span className="text-foreground"> — start it with <code className="font-mono text-[0.85em]">./run.sh</code> in <code className="font-mono text-[0.85em]">backend/</code>, then reload.</span>}
      </span>
      <button
        type="button"
        onClick={reload}
        disabled={busy || loading}
        aria-label="Reload structures and experiments"
        title="Reload structures and experiments"
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
      </button>
    </div>
  )
}
