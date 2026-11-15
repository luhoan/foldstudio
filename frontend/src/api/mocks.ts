/**
 * Mock mode (VITE_USE_MOCKS=true): every call answers with a captured backend response.
 *
 * The answers are the same for any id, so mock mode shows the app's layout, not your data. The
 * dataset is synthetic and every record in it says so. The fixtures are loaded on first use, so
 * they are not part of the bundle a real backend is used with.
 */
import type { FixtureName, fixtures } from './fixtures'

export async function mockResponse<K extends FixtureName>(name: K): Promise<(typeof fixtures)[K]> {
  const module = await import('./fixtures')
  return structuredClone(module.fixtures[name]) as (typeof fixtures)[K]
}
