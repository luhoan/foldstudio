import { USE_MOCKS } from './config'
import { apiRequest } from './client'
import { demoComparison, demoExperiment } from './mocks'
import type { CompareRequest, CompareResponse, Experiment, ReportResponse } from './types'

export async function listExperiments(): Promise<Experiment[]> {
  if (USE_MOCKS) return [demoExperiment]
  return apiRequest<Experiment[]>('/experiments')
}

export async function getExperiment(id: string): Promise<Experiment> {
  if (USE_MOCKS) {
    if (id !== demoExperiment.id) throw new Error(`Unknown demo experiment: ${id}`)
    return demoExperiment
  }
  return apiRequest<Experiment>(`/experiments/${encodeURIComponent(id)}`)
}

export async function compareExperiments(request: CompareRequest): Promise<CompareResponse> {
  if (USE_MOCKS) return demoComparison
  return apiRequest<CompareResponse>('/experiments/compare', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

export async function getReports(ids: string[]): Promise<ReportResponse> {
  const params = new URLSearchParams({ ids: ids.join(',') })
  if (USE_MOCKS) {
    return {
      html: `<p>Demo report for ${ids.join(', ') || 'no experiments'}.</p>`,
      markdown: `# Demo report\n\nSynthetic UI fixture. No scientific results are represented.`,
    }
  }
  return apiRequest<ReportResponse>(`/reports?${params.toString()}`)
}
