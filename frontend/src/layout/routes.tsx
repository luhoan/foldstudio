import { Navigate, type RouteObject } from 'react-router-dom'
import { AppShell } from './AppShell'
import { NAV_ITEMS, type RouteId } from './nav'
import { ExplorerPage, SlotPage } from './pages'

/** App routes; main.tsx mounts these. Exported so tests and other tooling can reuse them. */
export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      ...NAV_ITEMS.map((item): RouteObject => {
        const element = item.id === 'explorer' ? <ExplorerPage /> : <SlotPage id={item.id as RouteId} />
        return item.path === '/' ? { index: true, element } : { path: item.path.slice(1), element }
      }),
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]
