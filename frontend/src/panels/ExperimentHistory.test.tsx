import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureIds, fixtures } from '@/api/fixtures'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { downloadText } from './download'
import { ExperimentHistory } from './ExperimentHistory'

vi.mock('./download', () => ({ downloadText: vi.fn() }))

const run = fixtures.experiments.find((e) => e.id === fixtureIds.pipelineRun)!
const importedComplex = fixtures.experiments.find((e) => e.id === fixtureIds.importedComplex)!

function rowOf(id: string): HTMLElement {
  return screen.getByRole('button', { name: `Show details of ${id}` }).closest('tr') as HTMLElement
}

beforeEach(() => vi.mocked(downloadText).mockClear())

describe('ExperimentHistory', () => {
  it('lists every record with its id, model, provenance kind and status', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<ExperimentHistory />, '/history')

    await screen.findByRole('button', { name: `Show details of ${run.id}` })
    for (const experiment of fixtures.experiments) {
      const row = rowOf(experiment.id)
      expect(within(row).getByText(experiment.id)).toBeInTheDocument()
      expect(within(row).getByText(experiment.model_name)).toBeInTheDocument()
      expect(within(row).getByText(experiment.kind)).toBeInTheDocument()
      expect(within(row).getByText(experiment.status)).toBeInTheDocument()
    }
    expect(screen.getByText(`${fixtures.experiments.length} of ${fixtures.experiments.length} records`)).toBeInTheDocument()
    // What each provenance kind means is spelled out on the page.
    expect(screen.getByText('Ran here: the pipeline produced these files on this installation.')).toBeInTheDocument()
    expect(screen.getByText('Brought in from a public database as-is. No model was run here.')).toBeInTheDocument()
  })

  it('filters by kind and status', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<ExperimentHistory />, '/history')
    await screen.findByRole('button', { name: `Show details of ${run.id}` })

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by kind' }), 'executed')
    expect(screen.queryByRole('button', { name: `Show details of ${importedComplex.id}` })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Show details of ${run.id}` })).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'failed')
    expect(screen.getByText('No experiments match these filters.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export report (HTML)' })).toBeDisabled()
  })

  it('opens a record to show its stages, its metrics with definitions, and what was not measured', async () => {
    installFetch(fixtureRoutes())
    const view = renderPanel(<ExperimentHistory />, '/history')
    await userEvent.click(await screen.findByRole('button', { name: `Show details of ${run.id}` }))
    await waitFor(() => expect(view.location()).toBe(`/history?experiment=${run.id}`))

    // The record's error is shown in full in the detail (and clipped in the row summary).
    expect(await screen.findByRole('alert')).toHaveTextContent(run.error!)
    const stages = within(screen.getByRole('heading', { name: 'Pipeline stages' }).closest('section') as HTMLElement)
    for (const stage of run.workflow!) {
      const row = stages.getByRole('cell', { name: stage.stage }).closest('tr') as HTMLElement
      expect(within(row).getByText(stage.status_label ?? stage.status)).toBeInTheDocument()
      if (stage.error) expect(within(row).getByText(stage.error)).toBeInTheDocument()
    }

    const metrics = within(screen.getByRole('heading', { name: 'Metrics' }).closest('section') as HTMLElement)
    for (const [name, definition] of Object.entries(run.metric_definitions!)) {
      if (name in run.metrics) expect(metrics.getByText(definition)).toBeInTheDocument()
    }

    const missing = within(screen.getByRole('heading', { name: 'Metrics not measured' }).closest('section') as HTMLElement)
    for (const [name, reason] of Object.entries(run.metrics_unavailable!)) {
      expect(missing.getByText(name)).toBeInTheDocument()
      expect(missing.getByText(reason)).toBeInTheDocument()
    }
    expect(missing.getByText('The run recorded that it could not measure these, and why. They are not zero; they are absent.')).toBeInTheDocument()
  })

  it('links a record\'s structures into the 3D viewer, and a design to the backbone it was made for', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<ExperimentHistory />, `/history?experiment=${run.id}`)

    const structures = within((await screen.findByRole('heading', { name: 'Structures from this record' })).closest('section') as HTMLElement)
    const links = structures.getAllByRole('link', { name: 'View in 3D' }).map((a) => a.getAttribute('href'))
    expect(links).toEqual([`/explorer?structure=${fixtureIds.backbone}`, `/explorer?structure=${fixtureIds.design}`])
    expect(structures.getByRole('link', { name: 'Compare with its backbone' }))
      .toHaveAttribute('href', `/analysis?mobile=${fixtureIds.design}&reference=${fixtureIds.backbone}`)

    const designs = within(screen.getByRole('heading', { name: 'Predicted designs' }).closest('section') as HTMLElement)
    const design = run.per_design![0]
    const row = designs.getByRole('cell', { name: design.name }).closest('tr') as HTMLElement
    expect(within(row).getByText(design.mean_plddt!.toFixed(1))).toBeInTheDocument()
    expect(within(row).getByText(`${design.scrmsd!.rmsd!.toFixed(2)} Å on ${design.scrmsd!.aligned_atoms} CA`)).toBeInTheDocument()
  })

  it('renders a metric that is a list of records, never "[object Object]"', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<ExperimentHistory />, `/history?experiment=${importedComplex.id}`)
    await screen.findByRole('heading', { name: 'Metrics' })
    const interfaces = importedComplex.metrics.interfaces as Array<Record<string, unknown>>
    expect(Array.isArray(interfaces)).toBe(true)
    expect(screen.getByText('n residue pairs')).toBeInTheDocument()
    expect(screen.getByText(String(interfaces[0].n_residue_pairs))).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('[object Object]')
  })

  it('keeps a record opened by a link on screen even when the filters would hide it', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<ExperimentHistory />, `/history?experiment=${importedComplex.id}`)
    await screen.findByRole('button', { name: `Hide details of ${importedComplex.id}` })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by kind' }), 'executed')
    expect(screen.getByRole('button', { name: `Hide details of ${importedComplex.id}` })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: `Hide details of ${importedComplex.id}` }))
    await waitFor(() => expect(screen.queryByText(importedComplex.id)).not.toBeInTheDocument())
  })

  it('exports a report for the rows shown, asking the backend for JSON', async () => {
    const net = installFetch(fixtureRoutes())
    renderPanel(<ExperimentHistory />, '/history')
    await screen.findByRole('button', { name: `Show details of ${run.id}` })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by kind' }), 'imported')
    await userEvent.click(screen.getByRole('button', { name: 'Export report (HTML)' }))

    await waitFor(() => expect(downloadText).toHaveBeenCalledWith('foldstudio-report.html', fixtures.report.html, 'text/html'))
    const [call] = net.callsTo('GET /reports')
    expect(call.query.get('format')).toBe('json')
    expect(call.query.get('ids')!.split(',').sort()).toEqual([fixtureIds.importedComplex, fixtureIds.importedPredicted].sort())

    await userEvent.click(screen.getByRole('button', { name: 'Export report (Markdown)' }))
    await waitFor(() => expect(downloadText).toHaveBeenCalledWith('foldstudio-report.md', fixtures.report.markdown, 'text/markdown'))
  })

  it('says why an export failed instead of downloading nothing', async () => {
    installFetch(fixtureRoutes({ 'GET /reports': { status: 404, body: { detail: 'not_found: experiment x' } } }))
    renderPanel(<ExperimentHistory />, '/history')
    await screen.findByRole('button', { name: `Show details of ${run.id}` })
    await userEvent.click(screen.getByRole('button', { name: 'Export report (HTML)' }))
    await screen.findByText('not_found: experiment x')
    expect(downloadText).not.toHaveBeenCalled()
  })

  it('explains how records get in when there are none', async () => {
    installFetch(fixtureRoutes({ 'GET /experiments': [] }))
    renderPanel(<ExperimentHistory />, '/history')
    await screen.findByText('No experiment records yet')
    expect(screen.getByText(/python3 scripts\/hpc_import_bundle\.py/)).toBeInTheDocument()
  })
})
