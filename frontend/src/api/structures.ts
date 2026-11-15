import { API_BASE_URL, USE_MOCKS } from './config'
import { apiRequest } from './client'
import { mockResponse } from './mocks'
import type {
  FetchStructureRequest,
  InterfacesResponse,
  PaeAttachResponse,
  PaeResponse,
  PlddtResponse,
  ResiduesResponse,
  Structure,
  StructureSource,
} from './types'

export async function listStructures(): Promise<Structure[]> {
  if (USE_MOCKS) return mockResponse('structures')
  return apiRequest('/structures')
}

/** Ask the backend to download an entry from RCSB PDB or the AlphaFold DB. Nothing is predicted. */
export async function fetchStructure(body: FetchStructureRequest): Promise<Structure> {
  if (USE_MOCKS) return mockResponse('upload')
  return apiRequest('/structures/fetch', { method: 'POST', body: JSON.stringify(body) })
}

export interface UploadOptions {
  label?: string
  /**
   * What the file is. Only "predicted" makes the backend read its B-factor column as pLDDT, so
   * this must be a statement by the person uploading, never a guess.
   */
  source?: StructureSource
}

export async function uploadStructure(file: File, options: UploadOptions = {}): Promise<Structure> {
  if (USE_MOCKS) return mockResponse('upload')
  const form = new FormData()
  form.append('file', file)
  if (options.label) form.append('label', options.label)
  if (options.source) form.append('source', options.source)
  return apiRequest('/structures/upload', { method: 'POST', body: form })
}

/** URL the 3D viewer loads a structure's coordinates from. */
export function structureFileUrl(id: string): string {
  return `${API_BASE_URL}/structures/${encodeURIComponent(id)}/file`
}

export async function getResidues(id: string): Promise<ResiduesResponse> {
  if (USE_MOCKS) return mockResponse('residues')
  return apiRequest(`/structures/${encodeURIComponent(id)}/residues`)
}

export async function getPlddt(id: string): Promise<PlddtResponse> {
  if (USE_MOCKS) return mockResponse('plddt')
  return apiRequest(`/structures/${encodeURIComponent(id)}/plddt`)
}

export async function getPae(id: string): Promise<PaeResponse> {
  if (USE_MOCKS) return mockResponse('pae')
  return apiRequest(`/structures/${encodeURIComponent(id)}/pae`)
}

/** Attach a predictor's PAE JSON to a structure. The backend refuses a matrix of the wrong size. */
export async function attachPae(id: string, file: File): Promise<PaeAttachResponse> {
  if (USE_MOCKS) return mockResponse('pae_attached')
  const form = new FormData()
  form.append('file', file)
  return apiRequest(`/structures/${encodeURIComponent(id)}/pae`, { method: 'POST', body: form })
}

export async function getInterfaces(id: string, cutoff?: number): Promise<InterfacesResponse> {
  if (USE_MOCKS) return mockResponse('interfaces')
  const query = cutoff === undefined ? '' : `?cutoff=${encodeURIComponent(String(cutoff))}`
  return apiRequest(`/structures/${encodeURIComponent(id)}/interfaces${query}`)
}
