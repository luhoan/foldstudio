import { useEffect, useEffectEvent, useState } from 'react'

export type Async<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; data: T }
  | { state: 'error'; error: unknown }

type Settled<T> = { state: 'ok'; data: T } | { state: 'error'; error: unknown }

/**
 * Load something for `key`, and reload when the key changes. `null` means "nothing to load".
 *
 * The result is stored together with the key it belongs to, so a slow response for a previous key
 * can never be shown under the current one, and "loading" is derived rather than set in an effect.
 */
export function useAsync<T>(key: string | null, load: () => Promise<T>): Async<T> {
  const [result, setResult] = useState<{ key: string; value: Settled<T> } | null>(null)
  const run = useEffectEvent(load)

  useEffect(() => {
    if (key === null) return
    let alive = true
    run().then(
      (data) => { if (alive) setResult({ key, value: { state: 'ok', data } }) },
      (error: unknown) => { if (alive) setResult({ key, value: { state: 'error', error } }) },
    )
    return () => { alive = false }
  }, [key])

  if (key === null) return { state: 'idle' }
  return result?.key === key ? result.value : { state: 'loading' }
}
