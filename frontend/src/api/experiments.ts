import { USE_MOCKS } from './config'
import { apiRequest } from './client'
import { mockResponse } from './mocks'
import type { CompareRequest, CompareResponse, Experiment, HealthResponse, ReindexReport, ReportResponse } from './types'

export async function listExperiments(): Promise<Experiment[]> {
  if (USE_MOCKS) return mockResponse('experiments')
  return apiRequest('/experiments')
}

export async function compareExperiments(body: CompareRequest): Promise<CompareResponse> {
  if (USE_MOCKS) return mockResponse('compare')
  return apiRequest('/experiments/compare', { method: 'POST', body: JSON.stringify(body) })
}

/**
 * Report for the given experiments, as both Markdown and standalone HTML.
 * `format=json` matters: without it the backend answers with an HTML page, not JSON.
 */
export async function getReport(ids: string[]): Promise<ReportResponse> {
  if (USE_MOCKS) return mockResponse('report')
  const query = new URLSearchParams({ ids: ids.join(','), format: 'json' })
  return apiRequest(`/reports?${query}`)
}

export async function getHealth(): Promise<HealthResponse> {
  if (USE_MOCKS) return mockResponse('health')
  return apiRequest('/health')
}

/**
 * Ask the backend to read data/experiments/ again, so a bundle copied in while it was running
 * shows up without a restart. Returns what it found, including any bundle it could not load.
 */
export async function reindexExperiments(): Promise<ReindexReport> {
  if (USE_MOCKS) return mockResponse('reindex')
  return apiRequest('/experiments/reindex', { method: 'POST' })
}
