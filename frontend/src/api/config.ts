/**
 * Mock mode is opt-in. Production defaults to the real FastAPI backend.
 * Set VITE_USE_MOCKS=true in frontend/.env.local to use clearly labelled demo fixtures.
 */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '')
export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true'
