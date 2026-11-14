import { USE_MOCKS } from './config'
import { apiRequest, queryString } from './client'
import { demoAlignment, demoExplanation } from './mocks'
import type { AlignmentRequest, AlignmentResponse, ExplanationResponse } from './types'

export async function alignStructures(request: AlignmentRequest): Promise<AlignmentResponse> {
  if (USE_MOCKS) return demoAlignment
  return apiRequest<AlignmentResponse>('/analysis/align', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

export async function getExplanation(args: {
  structure: string
  chain?: string
  start?: number
  end?: number
}): Promise<ExplanationResponse> {
  if (USE_MOCKS) return { ...demoExplanation, structure_id: args.structure }
  return apiRequest<ExplanationResponse>(`/explain${queryString(args)}`)
}
