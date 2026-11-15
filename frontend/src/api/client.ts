import { API_BASE_URL } from './config'

/**
 * An API call that did not produce a result. `status` is the HTTP status, or 0 when no response
 * arrived at all. `message` is something a person can act on: the backend's own `detail` when it
 * sent one, otherwise a sentence saying what went wrong and where to look.
 */
export class ApiError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, detail: string, message = detail) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

const HOW_TO_START = 'Is the backend running? Start it with ./run.sh in backend/.'

async function readError(response: Response): Promise<ApiError> {
  const raw = await response.text().catch(() => '')
  let detail: string | undefined
  try {
    const body = JSON.parse(raw) as { detail?: unknown; message?: unknown }
    if (typeof body.detail === 'string') detail = body.detail
    else if (typeof body.message === 'string') detail = body.message
    // FastAPI reports request-validation failures as a list of problems.
    else if (Array.isArray(body.detail)) {
      detail = body.detail
        .map((item) => (typeof item === 'object' && item !== null && 'msg' in item ? String((item as { msg: unknown }).msg) : JSON.stringify(item)))
        .join('; ')
    }
  } catch {
    // Not JSON: decided below.
  }
  if (detail === undefined) {
    // The dev server answers with a bare 500/502 when it cannot reach the backend, and a
    // misrouted request comes back as an HTML page. Neither body is worth showing.
    const looksLikeHtml = /^\s*</.test(raw)
    if (response.status >= 500 && (raw.trim() === '' || looksLikeHtml)) {
      detail = `The backend did not answer (HTTP ${response.status}). ${HOW_TO_START}`
    } else if (raw.trim() !== '' && !looksLikeHtml) {
      detail = raw.trim().slice(0, 500)
    } else {
      detail = response.statusText ? `${response.statusText} (HTTP ${response.status})` : `HTTP ${response.status}`
    }
  }
  return new ApiError(response.status, detail)
}

/** Call the backend and return its JSON. Every way of failing surfaces as an ApiError. */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, `The backend could not be reached at ${API_BASE_URL}. ${HOW_TO_START}`)
  }
  if (!response.ok) throw await readError(response)
  if (response.status === 204) return undefined as T

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    // Every endpoint this client calls answers in JSON. Anything else means the request did not
    // reach the API (a wrong VITE_API_BASE_URL makes the web server answer with its own page).
    throw new ApiError(
      response.status,
      `Expected JSON from ${API_BASE_URL}${path} but received ${contentType || 'an untyped response'}. Check VITE_API_BASE_URL.`,
    )
  }
  return response.json() as Promise<T>
}
