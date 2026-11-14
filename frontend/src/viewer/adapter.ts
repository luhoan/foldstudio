/**
 * ViewerAdapter: the ONLY surface the rest of the app uses to drive the 3D viewer.
 * This file must stay free of any `molstar` import. The Mol* implementation lives in
 * ./molstar/ and is loaded lazily through createViewerAdapter() in ./index.ts.
 */

export type StructureFormat = 'pdb' | 'mmcif'
export type RepresentationKind = 'cartoon' | 'ball-and-stick' | 'surface'
export type ColorScheme = 'chain' | 'secondary-structure' | 'plddt' | 'uniform'

/** Inclusive residue range using author residue numbering (auth_seq_id), as Biopython reports. */
export interface ResidueRange {
  start: number
  end: number
}

/** Row-major 4x4 transform, exactly as returned by POST /api/analysis/align (`matrix`). */
export type Matrix4x4 = number[][]

export interface ResidueClickEvent {
  /** auth_asym_id */
  chain: string
  /** auth_seq_id */
  seqId: number
  insCode: string
  /** residue / component name, e.g. "ALA" */
  compId: string
  /** 0 = primary structure, 1 = second structure (loadSecond) */
  structureIndex: number
}

export interface CameraState {
  position: [number, number, number]
  target: [number, number, number]
  up: [number, number, number]
  radius: number
  radiusMax: number
  fov: number
  mode: 'perspective' | 'orthographic'
}

export type SecondLayout = 'overlay' | 'side-by-side'

export interface LoadSecondOptions {
  /** Inferred from the URL extension when omitted. */
  format?: StructureFormat
  /**
   * overlay (default): second structure shares the first's coordinate frame; `matrix` (if given)
   *   is applied to it, e.g. the superposition returned by /analysis/align.
   * side-by-side: second structure is translated next to the first along +x; `matrix` is ignored
   *   because a superposition and a separated layout are mutually exclusive.
   */
  layout?: SecondLayout
}

export interface HighlightOptions {
  /** Which loaded structure to highlight. Default 0 (primary). */
  structureIndex?: number
  /** Move the camera to the highlighted residues. Default true. */
  focus?: boolean
}

export type ViewerErrorCode = 'webgl' | 'fetch' | 'parse' | 'internal'

export class ViewerError extends Error {
  code: ViewerErrorCode
  constructor(code: ViewerErrorCode, message: string) {
    super(message)
    this.name = 'ViewerError'
    this.code = code
  }
}

export interface ViewerAdapter {
  /** Mount into a sized DOM container. Rejects with ViewerError('webgl') if WebGL is unavailable. */
  init(container: HTMLElement): Promise<void>
  /** Replace everything in the scene with one structure. Rejects with ViewerError. */
  load(url: string, format: StructureFormat): Promise<void>
  /** Add a second structure to the current scene (requires load() first). */
  loadSecond(url: string, matrix?: Matrix4x4, options?: LoadSecondOptions): Promise<void>
  unloadSecond(): Promise<void>

  setRepresentation(kind: RepresentationKind): Promise<void>
  colorBy(scheme: ColorScheme): Promise<void>

  /** Persistently highlight (select) residue ranges in one chain. Empty ranges clears. */
  highlightResidues(chain: string, ranges: ResidueRange[], options?: HighlightOptions): void
  /** Select a whole chain, or clear the selection with null. */
  selectChain(chain: string | null): void
  clearHighlight(): void

  resetCamera(): void
  setCamera(state: CameraState): void
  getCamera(): CameraState
  screenshot(): Promise<Blob>

  /** Returns an unsubscribe function. */
  onResidueClick(cb: (e: ResidueClickEvent) => void): () => void

  dispose(): void
}

export type AdapterFactory = () => Promise<ViewerAdapter>

export function formatFromUrl(url: string): StructureFormat | undefined {
  const path = url.split(/[?#]/)[0].toLowerCase()
  if (/\.(pdb|ent)$/.test(path)) return 'pdb'
  if (/\.(cif|mmcif)$/.test(path)) return 'mmcif'
  return undefined
}
