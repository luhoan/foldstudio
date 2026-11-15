import { describe, expect, it, vi } from 'vitest'
import { fixtureIds, fixtures } from './fixtures'
import {
  ApiError, alignStructures, attachPae, compareExperiments, fetchStructure, getExplanation, getHealth,
  getInterfaces, getPae, getPlddt, getReport, getResidues, listExperiments, listStructures,
  reindexExperiments, structureFileUrl, uploadStructure,
} from './index'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'

/**
 * The client against captured backend responses: the URL, method and body each function sends,
 * and how a refusal is turned into an error. The response bodies are real, so these also pin the
 * handful of places where the old client and the server disagreed.
 */
describe('API client', () => {
  it('reads the lists and per-structure data from the paths the backend serves', async () => {
    const net = installFetch(fixtureRoutes())
    expect(await listStructures()).toEqual(fixtures.structures)
    expect(await listExperiments()).toEqual(fixtures.experiments)
    expect((await getResidues(fixtureIds.predicted)).residues.length).toBeGreaterThan(0)
    expect((await getPlddt(fixtureIds.predicted)).per_residue[0]).toHaveProperty('plddt')
    expect((await getPae(fixtureIds.predicted)).matrix.length).toBe(fixtures.pae.size)
    expect((await getHealth()).reindex).toHaveProperty('imported')
    expect(net.unmatched).toEqual([])
    expect(net.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /structures', 'GET /experiments',
      `GET /structures/${fixtureIds.predicted}/residues`,
      `GET /structures/${fixtureIds.predicted}/plddt`,
      `GET /structures/${fixtureIds.predicted}/pae`,
      'GET /health',
    ])
  })

  it('asks for the report as JSON, because the default answer is an HTML page', async () => {
    const net = installFetch(fixtureRoutes())
    const report = await getReport(['a', 'b'])
    expect(report.html).toContain('<')
    expect(report.markdown.length).toBeGreaterThan(0)
    const [call] = net.callsTo('GET /reports')
    expect(call.query.get('format')).toBe('json')
    expect(call.query.get('ids')).toBe('a,b')
  })

  it('sends the explanation region as query parameters and leaves out what was not given', async () => {
    const net = installFetch(fixtureRoutes())
    await getExplanation({ structure: fixtureIds.predicted })
    await getExplanation({ structure: fixtureIds.predicted, chain: 'A', start: 3, end: 3 })
    const [whole, residue] = net.callsTo('GET /explain')
    expect([...whole.query.keys()]).toEqual(['structure'])
    expect(Object.fromEntries(residue.query)).toEqual({ structure: fixtureIds.predicted, chain: 'A', start: '3', end: '3' })
  })

  it('passes the contact cutoff only when one is chosen', async () => {
    const net = installFetch(fixtureRoutes())
    await getInterfaces(fixtureIds.complex)
    await getInterfaces(fixtureIds.complex, 6)
    const calls = net.callsTo(`GET /structures/${fixtureIds.complex}/interfaces`)
    expect(calls[0].query.has('cutoff')).toBe(false)
    expect(calls[1].query.get('cutoff')).toBe('6')
  })

  it('posts an alignment with its selection, and a comparison with the canonical "ids" field', async () => {
    const net = installFetch(fixtureRoutes())
    await alignStructures({ mobile_id: 'm', reference_id: 'r', selection: { mobile_chain: 'A', method: 'auto' } })
    await compareExperiments({ ids: ['x', 'y'] })
    expect(net.callsTo('POST /analysis/align')[0].body).toEqual({
      mobile_id: 'm', reference_id: 'r', selection: { mobile_chain: 'A', method: 'auto' },
    })
    expect(net.callsTo('POST /experiments/compare')[0].body).toEqual({ ids: ['x', 'y'] })
  })

  it('uploads a file with the declared source, and never invents one', async () => {
    const net = installFetch(fixtureRoutes())
    const file = new File(['ATOM'], 'model.pdb')
    await uploadStructure(file, { label: 'My model', source: 'predicted' })
    await uploadStructure(file)
    const [declared, bare] = net.callsTo('POST /structures/upload').map((c) => c.body as FormData)
    expect(declared.get('source')).toBe('predicted')
    expect(declared.get('label')).toBe('My model')
    expect((declared.get('file') as File).name).toBe('model.pdb')
    expect(bare.has('source')).toBe(false)
    expect(bare.has('label')).toBe(false)
  })

  it('fetches database entries, attaches PAE files and asks for a rescan', async () => {
    const net = installFetch(fixtureRoutes())
    await fetchStructure({ source: 'rcsb', id: '1UBQ' })
    const attached = await attachPae(fixtureIds.predicted, new File(['[]'], 'pae.json'))
    const report = await reindexExperiments()
    expect(net.callsTo('POST /structures/fetch')[0].body).toEqual({ source: 'rcsb', id: '1UBQ' })
    expect(attached.structure_id).toBe(fixtureIds.predicted)
    expect(net.callsTo(`POST /structures/${fixtureIds.predicted}/pae`)).toHaveLength(1)
    expect(report.imported).toEqual(fixtures.reindex.imported)
    expect(net.unmatched).toEqual([])
  })

  it('turns a refusal into an ApiError carrying the status and the backend\'s own reason', async () => {
    installFetch(fixtureRoutes())
    const refusal = await getPlddt(fixtureIds.complex).catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(ApiError)
    expect((refusal as ApiError).status).toBe(409)
    expect((refusal as ApiError).message).toBe(fixtures.plddt_refused.detail)
    const missing = await getPae(fixtureIds.complex).catch((e: unknown) => e)
    expect((missing as ApiError).status).toBe(404)
  })

  it('says how to start the backend when nothing answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const error = await listStructures().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(0)
    expect((error as ApiError).message).toMatch(/could not be reached at \/api.*\.\/run\.sh in backend/)
  })

  it('reads the dev server\'s bare 500 as "backend not answering", not as "Internal Server Error"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500, statusText: 'Internal Server Error' })))
    const error = await listStructures().catch((e: unknown) => e)
    expect((error as ApiError).status).toBe(500)
    expect((error as ApiError).message).toMatch(/did not answer \(HTTP 500\).*\.\/run\.sh/)
  })

  it('keeps the backend\'s own words for a real server error and for validation failures', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'index is corrupt' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: [{ loc: ['body', 'ids'], msg: 'Field required' }] }), { status: 422, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('plain refusal', { status: 400 })))
    expect(((await listStructures().catch((e: unknown) => e)) as ApiError).message).toBe('index is corrupt')
    expect(((await listStructures().catch((e: unknown) => e)) as ApiError).message).toBe('Field required')
    expect(((await listStructures().catch((e: unknown) => e)) as ApiError).message).toBe('plain refusal')
  })

  it('refuses a web page where JSON was expected, and points at the setting that causes it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })))
    const error = await listStructures().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toMatch(/Expected JSON from \/api\/structures.*VITE_API_BASE_URL/)
  })

  it('builds the URL the 3D viewer loads coordinates from', () => {
    expect(structureFileUrl('st_1')).toBe('/api/structures/st_1/file')
  })
})
