import { USE_MOCKS } from './config'
import { apiRequest } from './client'
import { demoPae, demoPlddt, demoResidues, demoStructure } from './mocks'
import type { PaeResponse, PlddtResponse, ResiduesResponse, Structure } from './types'

export async function listStructures(): Promise<Structure[]> {
  if (USE_MOCKS) return [demoStructure]
  return apiRequest<Structure[]>('/structures')
}

export async function getStructure(id: string): Promise<Structure> {
  if (USE_MOCKS) {
    if (id !== demoStructure.id) throw new Error(`Unknown demo structure: ${id}`)
    return demoStructure
  }
  return apiRequest<Structure>(`/structures/${encodeURIComponent(id)}`)
}

export async function getStructureFile(id: string): Promise<Blob> {
  return apiRequest<Blob>(`/structures/${encodeURIComponent(id)}/file`)
}

export async function getResidues(id: string): Promise<ResiduesResponse> {
  if (USE_MOCKS) return { ...demoResidues, structure_id: id }
  return apiRequest<ResiduesResponse>(`/structures/${encodeURIComponent(id)}/residues`)
}

export async function getPlddt(id: string): Promise<PlddtResponse> {
  if (USE_MOCKS) return { ...demoPlddt, structure_id: id }
  return apiRequest<PlddtResponse>(`/structures/${encodeURIComponent(id)}/plddt`)
}

export async function getPae(id: string): Promise<PaeResponse> {
  if (USE_MOCKS) return { ...demoPae, structure_id: id }
  return apiRequest<PaeResponse>(`/structures/${encodeURIComponent(id)}/pae`)
}

export async function fetchStructure(source: 'rcsb' | 'afdb', id: string): Promise<Structure> {
  return apiRequest<Structure>('/structures/fetch', {
    method: 'POST',
    body: JSON.stringify({ source, id }),
  })
}

export async function uploadStructure(file: File): Promise<Structure> {
  const body = new FormData()
  body.append('file', file)
  return apiRequest<Structure>('/structures/upload', { method: 'POST', body })
}
