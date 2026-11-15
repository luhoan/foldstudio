import { act, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'

/**
 * Render a panel the way the app does: inside a router, at a given address.
 *
 * `location()` returns the current path and query, so a test can assert that a panel updated the
 * address bar; `navigate(to)` follows a link (a push), as a click on a link elsewhere would.
 */
export function renderPanel(ui: ReactElement, at = '/') {
  let current = at
  let go: NavigateFunction | null = null
  function Probe() {
    const location = useLocation()
    const navigate = useNavigate()
    current = `${location.pathname}${location.search}`
    go = navigate
    return null
  }
  const view = render(
    <MemoryRouter initialEntries={[at]}>
      {ui}
      <Probe />
    </MemoryRouter>,
  )
  return {
    ...view,
    location: () => current,
    navigate: (to: string) => act(() => { void go?.(to) }),
  }
}
