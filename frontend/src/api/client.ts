import { API_BASE_URL } from './config'

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

async function readError(response: Response): Promise<ApiError> {
  let detail = response.statusText || `HTTP ${response.status}`
  try {
    const body = await response.clone().json() as { detail?: string; message?: string }
    detail = body.detail ?? body.message ?? detail
  } catch {
    // The backend may return a plain-text error body.
    try {
      const body = await response.text()
      if (body) detail = body
    } catch {
      // Keep the HTTP status text.
    }
  }
  return new ApiError(response.status, detail)
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers })
  if (!response.ok) throw await readError(response)
  if (response.status === 204) return undefined as T

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return response.json() as Promise<T>
  return response.blob() as Promise<T>
}

export function queryString(values: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const result = params.toString()
  return result ? `?${result}` : ''
}
