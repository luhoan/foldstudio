import { USE_MOCKS } from './config'
import { apiRequest } from './client'
import { mockResponse } from './mocks'
import type { AlignmentRequest, AlignmentResponse, ExplainResponse } from './types'

export async function alignStructures(body: AlignmentRequest): Promise<AlignmentResponse> {
  if (USE_MOCKS) return mockResponse('align')
  return apiRequest('/analysis/align', { method: 'POST', body: JSON.stringify(body) })
}

export interface ExplainParams {
  structure: string
  chain?: string
  start?: number
  end?: number
}

export async function getExplanation(params: ExplainParams): Promise<ExplainResponse> {
  if (USE_MOCKS) return mockResponse('explain_predicted')
  const query = new URLSearchParams({ structure: params.structure })
  if (params.chain) query.set('chain', params.chain)
  if (params.start !== undefined) query.set('start', String(params.start))
  if (params.end !== undefined) query.set('end', String(params.end))
  return apiRequest(`/explain?${query}`)
}
