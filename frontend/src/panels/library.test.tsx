import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fixtures } from '@/api/fixtures'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { getLibrary, refreshLibrary, useLibrary } from './library'

function Count({ name }: { name: string }) {
  const library = useLibrary()
  return <p>{name}: {library.status} {library.structures.length}/{library.experiments.length} {library.error ?? ''}</p>
}

describe('shared library', () => {
  it('loads once however many panels use it', async () => {
    const net = installFetch(fixtureRoutes())
    render(<><Count name="a" /><Count name="b" /><Count name="c" /></>)
    await screen.findByText(`a: ready ${fixtures.structures.length}/${fixtures.experiments.length}`)
    expect(screen.getByText(`c: ready ${fixtures.structures.length}/${fixtures.experiments.length}`)).toBeInTheDocument()
    expect(net.callsTo('GET /structures')).toHaveLength(1)
    expect(net.callsTo('GET /experiments')).toHaveLength(1)
  })

  it('keeps the list that loaded when the other one fails, and says which failed', async () => {
    installFetch(fixtureRoutes({ 'GET /experiments': { status: 500, body: { detail: 'index is corrupt' } } }))
    render(<Count name="a" />)
    await screen.findByText(/a: ready/)
    expect(getLibrary().structures).toHaveLength(fixtures.structures.length)
    expect(getLibrary().experiments).toEqual([])
    expect(getLibrary().error).toBe('Experiments: index is corrupt')
  })

  it('picks up changes on refresh, and applies only the newest answer', async () => {
    let structures = fixtures.structures.slice(0, 1)
    installFetch(fixtureRoutes({ 'GET /structures': () => structures }))
    render(<Count name="a" />)
    await screen.findByText(`a: ready 1/${fixtures.experiments.length}`)
    structures = fixtures.structures
    await refreshLibrary()
    await waitFor(() => expect(getLibrary().structures).toHaveLength(fixtures.structures.length))
    expect(getLibrary().error).toBeNull()
  })
})
