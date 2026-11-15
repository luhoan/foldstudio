import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'
import type { Experiment } from '@/api'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { WorkflowStepper } from './WorkflowStepper'

const run = fixtures.experiments.find((e) => e.id === fixtureIds.pipelineRun)!

function stage(name: string): HTMLElement {
  return screen.getByRole('heading', { name, level: 3 }).closest('li') as HTMLElement
}

describe('WorkflowStepper (Design Workspace)', () => {
  it('shows each stage with the status the pipeline recorded, in the pipeline\'s order', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<WorkflowStepper />, '/design')

    await screen.findByText(run.id)
    const items = document.querySelector('ol') as HTMLElement // the stage list is the only ordered list
    const names = within(items).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(names).toEqual(run.workflow!.map((s) => s.stage))
    for (const recorded of run.workflow!) {
      expect(within(stage(recorded.stage)).getByText(recorded.status_label ?? recorded.status)).toBeInTheDocument()
    }
    // The status itself (not just its wording) is on the element, stage for stage.
    const shown = [...items.querySelectorAll('[data-stage-status]')].map((el) => el.getAttribute('data-stage-status'))
    expect(shown).toEqual(run.workflow!.map((s) => s.status))
  })

  it('shows a failed stage as failed, with the error it recorded, and never as executed', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<WorkflowStepper />, '/design')
    await screen.findByText(run.id)

    const failed = run.workflow!.find((s) => s.status === 'failed')!
    const card = within(stage(failed.stage))
    expect(card.getByText('failed')).toBeInTheDocument()
    expect(card.getByRole('alert')).toHaveTextContent(failed.error!)
    expect(card.queryByText('executed')).not.toBeInTheDocument()
  })

  it('reports wall time, output counts and preemptions only from what was recorded', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<WorkflowStepper />, '/design')
    await screen.findByText(run.id)
    const backbone = run.workflow!.find((s) => s.stage === 'Backbone generation')!
    expect(backbone.wall_seconds).toBeGreaterThan(0)
    expect(within(stage('Backbone generation')).getByText(new RegExp(`ran for .*${backbone.outputs} output`))).toBeInTheDocument()
    const untimed = run.workflow!.find((s) => s.wall_seconds === null && !s.outputs)!
    expect(within(stage(untimed.stage)).queryByText(/ran for/)).not.toBeInTheDocument()
  })

  it('links the backbone and the predicted design into the viewer, and offers the backbone comparison', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<WorkflowStepper />, '/design')
    await screen.findByText(run.id)

    expect(within(stage('Backbone generation')).getByRole('link', { name: 'View in 3D' }))
      .toHaveAttribute('href', `/explorer?structure=${fixtureIds.backbone}`)
    const prediction = within(stage('Structure prediction'))
    expect(prediction.getByRole('link', { name: 'View in 3D' })).toHaveAttribute('href', `/explorer?structure=${fixtureIds.design}`)
    expect(prediction.getByRole('link', { name: 'Compare with its backbone' }))
      .toHaveAttribute('href', `/analysis?mobile=${fixtureIds.design}&reference=${fixtureIds.backbone}`)
    // A backbone carries no confidence, and the page says so where the backbone is.
    expect(within(stage('Backbone generation')).getByText(/A backbone carries no confidence of its own/)).toBeInTheDocument()
  })

  it('shows the run\'s headline metrics with their definitions, and lists what was not measured', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<WorkflowStepper />, '/design')
    await screen.findByText(run.id)

    expect(screen.getByText('Best self-consistency RMSD')).toBeInTheDocument()
    expect(screen.getByText(run.metric_definitions!.self_consistency_ca_rmsd_best)).toBeInTheDocument()
    const missing = screen.getByRole('heading', { name: 'Not measured in this run' }).parentElement as HTMLElement
    for (const [name, reason] of Object.entries(run.metrics_unavailable!)) {
      expect(within(missing).getByText(name)).toBeInTheDocument()
      expect(within(missing).getByText(`: ${reason}`)).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: 'Open the full record' })).toHaveAttribute('href', `/history?experiment=${run.id}`)
  })

  it('says plainly when the record on screen was not run here', async () => {
    const demo: Experiment = { ...run, id: 'hpc_dry_run', kind: 'demo', status: 'ok', error: null,
      workflow: run.workflow!.map((s) => ({ ...s, status: s.status === 'executed' || s.status === 'failed' ? 'demo' : s.status, status_label: s.status === 'not_started' ? 'not started' : 'demo', error: null })) }
    installFetch(fixtureRoutes({ 'GET /experiments': [demo] }))
    renderPanel(<WorkflowStepper />, '/design')
    await screen.findByText('hpc_dry_run')
    expect(screen.getByText('This record is a demo: no model was run to produce it.')).toBeInTheDocument()
    expect(screen.queryByText('executed')).not.toBeInTheDocument()
  })

  it('prefers an executed run, lets another be chosen, and reflects the choice in the address', async () => {
    const older: Experiment = { ...run, id: 'hpc_older_run', created_at: '2025-06-01T00:00:00Z' }
    const demo: Experiment = { ...run, id: 'hpc_newer_demo', kind: 'demo', created_at: '2026-06-01T00:00:00Z' }
    installFetch(fixtureRoutes({ 'GET /experiments': [older, demo, run] }))
    const view = renderPanel(<WorkflowStepper />, '/design')

    const picker = await screen.findByRole('combobox', { name: 'Run' })
    expect(picker).toHaveValue(run.id) // newest executed, not the newer demo
    await userEvent.selectOptions(picker, 'hpc_older_run')
    await screen.findByText('hpc_older_run', { selector: 'span' })
    expect(view.location()).toBe('/design?run=hpc_older_run')
  })

  it('opens the run a link names, and says so when that run is not loaded', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<WorkflowStepper />, '/design?run=hpc_gone')
    await screen.findByText(run.id)
    expect(screen.getByText('hpc_gone').closest('[role="alert"]')).toHaveTextContent(`Run hpc_gone is not loaded. Showing ${run.id} instead.`)
  })

  it('describes the stages and how to import a bundle when no run is loaded', async () => {
    installFetch(fixtureRoutes({ 'GET /experiments': fixtures.experiments.filter((e) => !e.workflow) }))
    renderPanel(<WorkflowStepper />, '/design')
    await screen.findByText('No pipeline run loaded yet')
    expect(screen.getByText(/python3 scripts\/hpc_import_bundle\.py/)).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Structure', 'Backbone generation', 'Sequence design', 'Structure prediction', 'Evaluation', 'Candidate review',
    ])
    // No status is invented for a run that does not exist.
    expect(screen.queryByText('executed')).not.toBeInTheDocument()
    expect(screen.queryByText('not started')).not.toBeInTheDocument()
    expect(screen.getByText('Stand in for an experiment. pLDDT and PAE are not validation.')).toBeInTheDocument()
  })
})
