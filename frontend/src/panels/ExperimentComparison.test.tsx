import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { fixtures } from '@/api/fixtures'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { renderPanel } from '@/test/render'
import { ExperimentComparison } from './ExperimentComparison'

const compare = fixtures.compare
const [a, b] = compare.ids

function cells(field: string): string[] {
  const row = screen.getByRole('cell', { name: field }).closest('tr') as HTMLElement
  return within(row).getAllByRole('cell').map((cell) => cell.textContent ?? '')
}

describe('ExperimentComparison', () => {
  it('compares nothing until two records are chosen, then asks the backend with their ids', async () => {
    const net = installFetch(fixtureRoutes())
    const view = renderPanel(<ExperimentComparison />, '/comparison')

    await userEvent.click(await screen.findByRole('checkbox', { name: new RegExp(`^${a}`) }))
    expect(screen.getByText('Tick one more record to see them side by side.')).toBeInTheDocument()
    expect(net.callsTo('POST /experiments/compare')).toHaveLength(0)

    await userEvent.click(screen.getByRole('checkbox', { name: new RegExp(`^${b}`) }))
    await screen.findByRole('heading', { name: 'Side by side' })
    expect(net.callsTo('POST /experiments/compare')[0].body).toEqual({ ids: [a, b] })
    await waitFor(() => expect(view.location()).toBe(`/comparison?ids=${encodeURIComponent(`${a},${b}`)}`))
  })

  it('shows the rows that differ, one column per record, with absent values named as absent', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<ExperimentComparison />, `/comparison?ids=${a},${b}`)
    await screen.findByRole('heading', { name: 'Side by side' })

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Field', a, b])
    const differing = [...compare.fields, ...compare.settings, ...compare.metrics].filter((row) => row.differs)
    const same = [...compare.fields, ...compare.settings, ...compare.metrics].filter((row) => !row.differs)
    expect(differing.length).toBeGreaterThan(0)
    for (const row of differing) expect(screen.getByRole('cell', { name: row.field })).toBeInTheDocument()
    for (const row of same) expect(screen.queryByRole('cell', { name: row.field })).not.toBeInTheDocument()

    // A metric only one record has is "not recorded" for the other, never 0.
    const oneSided = compare.metrics.find((row) => row.values[a] === null || row.values[b] === null)!
    expect(cells(oneSided.field)).toContain('not recorded')
    expect(cells('kind').slice(1)).toEqual([String(compare.fields.find((f) => f.field === 'kind')!.values[a]), String(compare.fields.find((f) => f.field === 'kind')!.values[b])])
    expect(screen.getByText(compare.note)).toBeInTheDocument()
  })

  it('can show every row, marking which differ in words', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<ExperimentComparison />, `/comparison?ids=${a},${b}`)
    await screen.findByRole('heading', { name: 'Side by side' })
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only rows that differ' }))

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Field', a, b, 'Differs'])
    const all = [...compare.fields, ...compare.settings, ...compare.metrics]
    for (const row of all) expect(cells(row.field).at(-1)).toBe(row.differs ? 'yes' : 'no')
  })

  it('renders list-valued metrics readably', async () => {
    installFetch(fixtureRoutes())
    renderPanel(<ExperimentComparison />, `/comparison?ids=${a},${b}`)
    await screen.findByRole('heading', { name: 'Side by side' })
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only rows that differ' }))
    expect(document.body.textContent).not.toContain('[object Object]')
  })

  it('ignores ids in a link that are not loaded', async () => {
    const net = installFetch(fixtureRoutes())
    renderPanel(<ExperimentComparison />, `/comparison?ids=${a},gone,${b}`)
    await screen.findByRole('heading', { name: 'Side by side' })
    expect(net.callsTo('POST /experiments/compare')[0].body).toEqual({ ids: [a, b] })
  })

  it('shows the backend\'s reason when the comparison fails', async () => {
    installFetch(fixtureRoutes({ 'POST /experiments/compare': { status: 404, body: { detail: 'not_found: experiment x' } } }))
    renderPanel(<ExperimentComparison />, `/comparison?ids=${a},${b}`)
    await screen.findByText('not_found: experiment x')
  })

  it('says what is needed when there are fewer than two records', async () => {
    installFetch(fixtureRoutes({ 'GET /experiments': fixtures.experiments.slice(0, 1) }))
    renderPanel(<ExperimentComparison />, '/comparison')
    await screen.findByText('Two records are needed to compare')
    expect(screen.getByText(/There is only one experiment record so far\./)).toBeInTheDocument()
  })
})
