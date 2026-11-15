import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'
import type { Experiment } from '@/api'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { Dashboard } from './Dashboard'

const run = fixtures.experiments.find((e) => e.id === fixtureIds.pipelineRun)!

function stat(label: string): string {
  const dt = screen.getAllByText(label).find((el) => el.tagName === 'DT') as HTMLElement
  return (dt.nextElementSibling as HTMLElement).textContent ?? ''
}

function count<T>(items: T[], pick: (item: T) => string, value: string): number {
  return items.filter((item) => pick(item) === value).length
}

describe('Dashboard', () => {
  it('counts records by provenance and structures by source, from what the API returned', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<Dashboard />)
    await screen.findByRole('heading', { name: 'What is loaded' })

    for (const kind of ['executed', 'imported', 'demo']) {
      expect(stat(kind)).toBe(String(count(fixtures.experiments, (e) => e.kind, kind)))
    }
    expect(stat('predicted model')).toBe(String(count(fixtures.structures, (s) => s.source, 'predicted')))
    expect(stat('experimental')).toBe(String(count(fixtures.structures, (s) => s.source, 'experimental')))
    expect(stat('no declared source')).toBe(String(count(fixtures.structures, (s) => s.source, 'uploaded')))
    // A bucket with nothing in it is shown as zero, not hidden and not filled in.
    expect(count(fixtures.experiments, (e) => e.kind, 'demo')).toBe(0)
    expect(stat('demo')).toBe('0')
    // The page says what the provenance labels mean.
    expect(screen.getByText('Ran here: the pipeline produced these files on this installation.')).toBeInTheDocument()
  })

  it('leads with the latest pipeline run: every stage and the status the pipeline recorded', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<Dashboard />)

    const card = within((await screen.findByRole('heading', { name: 'Latest design run' })).closest('section') as HTMLElement)
    expect(card.getByText(run.id)).toBeInTheDocument()
    expect(card.getByText('partial')).toBeInTheDocument()
    const items = card.getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(
      run.workflow!.map((s, i) => `Stage ${i + 1}${s.stage}${s.status_label ?? s.status}${s.error ?? ''}`))
    expect(card.getByRole('alert')).toHaveTextContent(run.error!)
    expect(card.getByRole('link', { name: 'Follow this run stage by stage' })).toHaveAttribute('href', `/design?run=${run.id}`)
    expect(card.getByRole('link', { name: 'Open the full record' })).toHaveAttribute('href', `/history?experiment=${run.id}`)
  })

  it('prefers a run that was executed here over a newer demo, and labels a demo as a demo', async () => {
    const demo: Experiment = { ...run, id: 'hpc_dry_run', kind: 'demo', created_at: '2026-12-01T00:00:00Z' }
    installFetch(fixtureRoutes({ 'GET /experiments': [demo, run] }))
    const view = renderPanel(<Dashboard />)
    const card = within((await screen.findByRole('heading', { name: 'Latest design run' })).closest('section') as HTMLElement)
    expect(card.getByText(run.id)).toBeInTheDocument()
    view.unmount()
  })

  it('says so when the only run on record is not one that was executed here', async () => {
    const demo: Experiment = { ...run, id: 'hpc_dry_run', kind: 'demo', error: null }
    installFetch(fixtureRoutes({ 'GET /experiments': [demo] }))
    renderPanel(<Dashboard />)
    await screen.findByRole('heading', { name: 'Latest design run' })
    expect(screen.getByText('This record is a demo: no model was run to produce it.')).toBeInTheDocument()
  })

  it('lists records that ended failed or partial, with the error they recorded', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<Dashboard />)
    const card = within((await screen.findByRole('heading', { name: 'Needs attention' })).closest('section') as HTMLElement)
    expect(card.getByRole('link', { name: run.id })).toHaveAttribute('href', `/history?experiment=${run.id}`)
    expect(card.getByText(run.error!)).toBeInTheDocument()
    expect(card.getAllByRole('listitem')).toHaveLength(fixtures.experiments.filter((e) => e.status !== 'ok').length)
  })

  it('links recent structures into the viewer', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<Dashboard />)
    const card = within((await screen.findByRole('heading', { name: 'Structures' })).closest('section') as HTMLElement)
    const links = card.getAllByRole('link', { name: 'View in 3D' })
    expect(links).toHaveLength(fixtures.structures.length)
    expect(links.map((l) => l.getAttribute('href')).sort()).toEqual(fixtures.structures.map((s) => `/explorer?structure=${s.id}`).sort())
  })

  it('shows zeros and how to load data when nothing is loaded, rather than placeholder numbers', async () => {
    installFetch(fixtureRoutes({ 'GET /experiments': [], 'GET /structures': [] }))
    renderPanel(<Dashboard />)
    await screen.findByText('Nothing is loaded yet')
    expect(screen.getByText('python3 scripts/fetch_demo_data.py')).toBeInTheDocument()
    for (const label of ['executed', 'imported', 'demo', 'predicted model', 'experimental', 'no declared source']) expect(stat(label)).toBe('0')
    expect(screen.queryByRole('heading', { name: 'Latest design run' })).not.toBeInTheDocument()
  })

  it('reports an unreachable backend instead of showing zeros as if they were real', async () => {
    installFetch(fixtureRoutes({
      'GET /experiments': { status: 500, body: { detail: 'backend down' } },
      'GET /structures': { status: 500, body: { detail: 'backend down' } },
    }))
    renderPanel(<Dashboard />)
    await screen.findByText('Structures: backend down · Experiments: backend down')
    expect(screen.queryByText('Nothing is loaded yet')).not.toBeInTheDocument()
  })

  it('keeps the caveat on screen', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<Dashboard />)
    await screen.findByText(/They do not establish folding, binding\s+affinity, efficacy or safety\. Not a clinical tool\./)
  })
})
