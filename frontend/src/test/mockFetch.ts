import { vi } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'

/**
 * A stand-in for the network, one level below the API client.
 *
 * Panel tests used to mock `@/api` itself and hand each panel whatever shape it expected, which is
 * how every test stayed green while most endpoints had drifted from the backend. Stubbing `fetch`
 * instead means the real client code runs (URL building, error mapping, JSON parsing) and the
 * bodies are the captured backend responses in `src/api/__fixtures__`.
 */

export interface RecordedCall {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

export interface Reply {
  status?: number
  body: unknown
}

export type Handler = (call: RecordedCall) => Reply | unknown
export type Routes = Record<string, Reply | Handler | unknown>

function isReply(value: unknown): value is Reply {
  return typeof value === 'object' && value !== null && 'body' in value
    && Object.keys(value).every((k) => k === 'body' || k === 'status')
}

function toResponse(reply: Reply): Response {
  const status = reply.status ?? 200
  return new Response(JSON.stringify(reply.body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Install a fake `fetch`. Routes are keyed "METHOD /path" with the `/api` prefix removed, e.g.
 * "GET /structures" or "POST /analysis/align". A route that is not listed answers 404 and is
 * recorded in `unmatched`, so a test can assert the UI made no call it did not expect.
 */
export function installFetch(routes: Routes) {
  const calls: RecordedCall[] = []
  const unmatched: string[] = []

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace(/^\/api/, '') || '/'
    let body: unknown = init?.body
    if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch { /* leave as text */ }
    }
    const call: RecordedCall = { method, path, query: url.searchParams, body }
    calls.push(call)

    const key = `${method} ${path}`
    if (!(key in routes)) {
      unmatched.push(`${key}${url.search}`)
      return toResponse({ status: 404, body: { detail: `no test route for ${key}` } })
    }
    const route = routes[key]
    const result = typeof route === 'function' ? (route as Handler)(call) : route
    return toResponse(isReply(result) ? result : { body: result })
  }

  const fetchMock = vi.fn(impl)
  vi.stubGlobal('fetch', fetchMock)
  return { calls, unmatched, fetchMock, callsTo: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key) }
}

const predictedLike = new Set<string>([fixtureIds.predicted, fixtureIds.design])

/** Routes for the whole fixture dataset: what a backend loaded with it answers. */
export function fixtureRoutes(overrides: Routes = {}): Routes {
  const routes: Routes = {
    'GET /structures': fixtures.structures,
    'GET /experiments': fixtures.experiments,
    'GET /health': fixtures.health,
    'GET /reports': fixtures.report,
    'POST /analysis/align': fixtures.align,
    'POST /experiments/compare': fixtures.compare,
    'POST /experiments/reindex': fixtures.reindex,
    'POST /structures/upload': { status: 201, body: fixtures.upload },
    'POST /structures/fetch': { status: 201, body: fixtures.upload },
    'GET /explain': (call: RecordedCall) => {
      const id = call.query.get('structure') ?? ''
      if (id === fixtureIds.complex) return fixtures.explain_experimental
      if (id === fixtureIds.backbone) return fixtures.explain_uploaded
      return call.query.get('start') && call.query.get('start') === call.query.get('end')
        ? fixtures.explain_residue
        : fixtures.explain_predicted
    },
  }
  for (const structure of fixtures.structures) {
    const base = `GET /structures/${structure.id}`
    routes[`POST /structures/${structure.id}/pae`] = { status: 201, body: { ...fixtures.pae_attached, structure_id: structure.id } }
    routes[`${base}/residues`] = { ...fixtures.residues, structure_id: structure.id, source: structure.source }
    routes[`${base}/interfaces`] = structure.id === fixtureIds.complex
      ? fixtures.interfaces
      : { ...fixtures.interfaces, structure_id: structure.id, source: structure.source, n_chains: 1, interfaces: [] }
    if (predictedLike.has(structure.id)) {
      routes[`${base}/plddt`] = { ...fixtures.plddt, structure_id: structure.id }
      routes[`${base}/pae`] = { ...fixtures.pae, structure_id: structure.id }
    } else {
      routes[`${base}/plddt`] = { status: 409, body: fixtures.plddt_refused }
      routes[`${base}/pae`] = { status: 404, body: fixtures.pae_unavailable }
    }
  }
  return { ...routes, ...overrides }
}
