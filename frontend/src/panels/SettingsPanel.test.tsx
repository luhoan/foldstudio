import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { fixtures } from '@/api/fixtures'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { SettingsPanel } from './SettingsPanel'

const health = fixtures.health

describe('SettingsPanel', () => {
  it('shows what the app is connected to and what the backend says about itself', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<SettingsPanel />)

    await screen.findByText(`reachable: ${fixtures.experiments.length} experiments, ${fixtures.structures.length} structures`)
    expect(screen.getByText('/api')).toBeInTheDocument()
    expect(screen.getByText('off')).toBeInTheDocument()
    expect(screen.getByText(health.data_dir)).toBeInTheDocument()
    expect(screen.getByText(health.runners.length ? health.runners.join(', ') : 'none registered')).toBeInTheDocument()
  })

  it('reports what the backend loaded from data/experiments, with links to the records', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<SettingsPanel />)
    const card = within((await screen.findByRole('heading', { name: 'Experiment bundles' })).closest('section') as HTMLElement)
    const report = health.reindex
    await card.findByText(new RegExp(`${report.imported.length} bundles loaded, ${report.structures_registered.length} structures? registered`))
    for (const id of report.imported) expect(card.getByRole('link', { name: id })).toHaveAttribute('href', `/history?experiment=${id}`)
  })

  it('shows every bundle the backend could not load, with its path and the reason', async () => {
    const broken = { ...health, reindex: { ...health.reindex, errors: [{ path: 'data/experiments/hpc_bad/experiment.json', error: 'schema: kind must be one of executed, imported, demo' }] } }
    installFetch(fixtureRoutes({ 'GET /health': broken }))
    renderPanel(<SettingsPanel />)
    await screen.findByText('1 bundle could not be loaded:')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('data/experiments/hpc_bad/experiment.json')
    expect(alert).toHaveTextContent('schema: kind must be one of executed, imported, demo')
  })

  it('rescans on request, shows the new report and reloads the shared library', async () => {
    const after = { ...fixtures.reindex, imported: [...fixtures.reindex.imported, 'hpc_new_run'], structures_registered: ['st_new'] }
    const net = installFetch(fixtureRoutes({ 'POST /experiments/reindex': after }))
    renderPanel(<SettingsPanel />)
    await screen.findByText(new RegExp(`${health.reindex.imported.length} bundles loaded`))
    const before = net.callsTo('GET /structures').length

    await userEvent.click(screen.getByRole('button', { name: 'Rescan now' }))
    await screen.findByText(new RegExp(`${after.imported.length} bundles loaded, 1 structure registered`))
    expect(screen.getByRole('link', { name: 'hpc_new_run' })).toBeInTheDocument()
    expect(net.callsTo('POST /experiments/reindex')).toHaveLength(1)
    await waitFor(() => expect(net.callsTo('GET /structures').length).toBeGreaterThan(before))
  })

  it('reports an unreachable backend and how to start it, and recovers on "Check again"', async () => {
    let up = false
    installFetch(fixtureRoutes({ 'GET /health': () => (up ? health : { status: 502, body: { detail: 'connection refused' } }) }))
    renderPanel(<SettingsPanel />)
    await screen.findByText('unreachable: connection refused')
    expect(screen.getByText('Not available while the backend cannot be reached.')).toBeInTheDocument()
    up = true
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByText(/^reachable:/)
  })

  it('offers no preference toggles, because nothing would read them', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<SettingsPanel />)
    await screen.findByText(/^reachable:/)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Check again', 'Rescan now'])
  })
})
