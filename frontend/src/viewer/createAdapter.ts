import type { ViewerAdapter } from './adapter'

/** Lazily loads the Mol* implementation so it is code-split out of the main bundle. */
export async function createViewerAdapter(): Promise<ViewerAdapter> {
  const { MolstarAdapter } = await import('./molstar/MolstarAdapter')
  return new MolstarAdapter()
}
