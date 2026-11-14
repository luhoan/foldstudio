import { useCallback, useEffect, useState } from 'react'
import { API_BASE_URL, USE_MOCKS, listExperiments, listStructures } from '@/api'

/**
 * What this installation is actually talking to.
 *
 * Deliberately not a preferences screen: there are no toggles here, because
 * nothing in the app currently reads a user-set preference, and a switch that
 * silently does nothing is worse than no switch. Everything shown is either
 * build configuration or a live probe of the backend.
 */

type Probe = { state: 'checking' } | { state: 'ok'; experiments: number; structures: number } | { state: 'down'; detail: string }

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border-t border-border py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm break-all">{value}</dd>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function SettingsPanel() {
  const [probe, setProbe] = useState<Probe>({ state: 'checking' })

  // State starts as 'checking', so the mount probe must not set it again; only
  // the button, which is re-checking from a settled state, flips it back.
  const probeNow = useCallback(() => {
    Promise.all([listExperiments(), listStructures()])
      .then(([e, s]) => setProbe({ state: 'ok', experiments: e.length, structures: s.length }))
      .catch((err: unknown) => setProbe({
        state: 'down',
        detail: err instanceof Error ? err.message : 'unreachable',
      }))
  }, [])

  useEffect(() => { probeNow() }, [probeNow])

  const recheck = useCallback(() => {
    setProbe({ state: 'checking' })
    probeNow()
  }, [probeNow])

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <header>
        <h2 className="text-base font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground">
          Build configuration and the current state of the backend connection.
        </p>
      </header>

      <dl>
        <Row label="API base URL" value={API_BASE_URL}
             hint="Set with VITE_API_BASE_URL. In development the dev server proxies /api to the backend." />
        <Row label="Mock mode" value={USE_MOCKS ? 'on' : 'off'}
             hint={USE_MOCKS
               ? 'Responses are demo fixtures, not the backend. Set VITE_USE_MOCKS=false to use real data.'
               : 'Responses come from the backend. Set VITE_USE_MOCKS=true to use demo fixtures instead.'} />
        <Row
          label="Backend"
          value={probe.state === 'checking' ? 'checking…'
            : probe.state === 'ok' ? `reachable — ${probe.experiments} experiment(s), ${probe.structures} structure(s)`
            : `unreachable — ${probe.detail}`}
          hint={probe.state === 'down'
            ? 'Start it with ./run.sh in backend/, then re-check.'
            : undefined}
        />
      </dl>

      <button type="button" onClick={recheck}
              className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent">
        Re-check connection
      </button>

      <p className="text-xs text-muted-foreground">
        Experiments are loaded from <code className="font-mono">data/experiments/</code> when the backend
        starts, and the structures each one lists are registered at the same time. To pick up new bundles,
        restart the backend.
      </p>
    </section>
  )
}
