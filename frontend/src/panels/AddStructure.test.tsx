import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { fixtures } from '@/api/fixtures'
import { fixtureRoutes, installFetch } from '@/test/mockFetch'
import { AddStructure } from './AddStructure'

const pdb = () => new File(['ATOM      1  CA  ALA A   1'], 'model.pdb', { type: 'chemical/x-pdb' })

describe('AddStructure', () => {
  it('fetches a database entry by id and hands back what the backend registered', async () => {
    const net = installFetch(fixtureRoutes())
    const onAdded = vi.fn()
    render(<AddStructure onAdded={onAdded} />)

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Database' }), 'afdb')
    await userEvent.type(screen.getByLabelText('UniProt accession'), ' P42212 ')
    await userEvent.click(screen.getByRole('button', { name: 'Fetch entry' }))

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(fixtures.upload))
    expect(net.callsTo('POST /structures/fetch')[0].body).toEqual({ source: 'afdb', id: 'P42212' })
    // The shared library is reloaded, so every panel sees the new structure.
    expect(net.callsTo('GET /structures').length).toBeGreaterThan(0)
    expect(screen.getByRole('status')).toHaveTextContent(`Added ${fixtures.upload.label} from AlphaFold DB.`)
  })

  it('does not send an empty id', async () => {
    const net = installFetch(fixtureRoutes())
    render(<AddStructure onAdded={() => undefined} />)
    await userEvent.click(screen.getByRole('button', { name: 'Fetch entry' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Type a PDB id first.')
    expect(net.callsTo('POST /structures/fetch')).toHaveLength(0)
  })

  it('shows the backend\'s reason when an entry cannot be fetched', async () => {
    installFetch(fixtureRoutes({ 'POST /structures/fetch': { status: 502, body: { detail: 'fetch_failed: RCSB answered 404 for 9ZZZ' } } }))
    const onAdded = vi.fn()
    render(<AddStructure onAdded={onAdded} />)
    await userEvent.type(screen.getByLabelText('PDB id'), '9zzz')
    await userEvent.click(screen.getByRole('button', { name: 'Fetch entry' }))
    await screen.findByText('fetch_failed: RCSB answered 404 for 9ZZZ')
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('uploads a file with no declared source unless the person says what it is', async () => {
    const net = installFetch(fixtureRoutes())
    render(<AddStructure onAdded={() => undefined} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Upload a file' }))
    // The safe choice is preselected: nothing is read as confidence unless declared.
    expect(screen.getByRole('radio', { name: /Something else, or not sure/ })).toBeChecked()
    await userEvent.upload(screen.getByLabelText(/Structure file/), pdb())
    await userEvent.click(screen.getByRole('button', { name: 'Upload structure' }))

    await waitFor(() => expect(net.callsTo('POST /structures/upload')).toHaveLength(1))
    const form = net.callsTo('POST /structures/upload')[0].body as FormData
    expect(form.get('source')).toBe('uploaded')
    expect(form.has('label')).toBe(false)
    expect((form.get('file') as File).name).toBe('model.pdb')
  })

  it('uploads a declared predicted model and attaches its PAE file', async () => {
    const net = installFetch(fixtureRoutes({ [`POST /structures/${fixtures.upload.id}/pae`]: { status: 201, body: fixtures.pae_attached } }))
    const onAdded = vi.fn()
    render(<AddStructure onAdded={onAdded} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Upload a file' }))
    expect(screen.queryByLabelText(/PAE file from the same prediction/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('radio', { name: /A predicted model/ }))
    await userEvent.upload(screen.getByLabelText(/Structure file/), pdb())
    await userEvent.type(screen.getByLabelText('Name to show (optional)'), 'My model')
    await userEvent.upload(screen.getByLabelText(/PAE file from the same prediction/), new File(['[]'], 'model.pae.json', { type: 'application/json' }))
    await userEvent.click(screen.getByRole('button', { name: 'Upload structure' }))

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    const form = net.callsTo('POST /structures/upload')[0].body as FormData
    expect(form.get('source')).toBe('predicted')
    expect(form.get('label')).toBe('My model')
    expect(net.callsTo(`POST /structures/${fixtures.upload.id}/pae`)).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(`PAE attached (${fixtures.pae_attached.size} × ${fixtures.pae_attached.size}).`)
  })

  it('keeps the structure and says so when only the PAE file is refused', async () => {
    installFetch(fixtureRoutes({ [`POST /structures/${fixtures.upload.id}/pae`]: { status: 400, body: { detail: 'pae_mismatch: wrong size' } } }))
    const onAdded = vi.fn()
    render(<AddStructure onAdded={onAdded} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Upload a file' }))
    await userEvent.click(screen.getByRole('radio', { name: /A predicted model/ }))
    await userEvent.upload(screen.getByLabelText(/Structure file/), pdb())
    await userEvent.upload(screen.getByLabelText(/PAE file from the same prediction/), new File(['[]'], 'wrong.json', { type: 'application/json' }))
    await userEvent.click(screen.getByRole('button', { name: 'Upload structure' }))

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(fixtures.upload))
    expect(screen.getByRole('status')).toHaveTextContent(`Added ${fixtures.upload.label}.`)
    expect(screen.getByRole('alert')).toHaveTextContent('The PAE file was not attached: pae_mismatch: wrong size')
  })

  it('clears the file inputs after an upload, so the next one cannot silently reuse a stale file', async () => {
    const net = installFetch(fixtureRoutes({ [`POST /structures/${fixtures.upload.id}/pae`]: { status: 201, body: fixtures.pae_attached } }))
    render(<AddStructure onAdded={() => undefined} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Upload a file' }))
    await userEvent.click(screen.getByRole('radio', { name: /A predicted model/ }))
    await userEvent.upload(screen.getByLabelText(/Structure file/), pdb())
    await userEvent.upload(screen.getByLabelText(/PAE file from the same prediction/), new File(['[]'], 'model.pae.json', { type: 'application/json' }))
    await userEvent.click(screen.getByRole('button', { name: 'Upload structure' }))
    await waitFor(() => expect(net.callsTo('POST /structures/upload')).toHaveLength(1))

    await waitFor(() => expect((screen.getByLabelText(/Structure file/) as HTMLInputElement).files).toHaveLength(0))
    expect((screen.getByLabelText(/PAE file from the same prediction/) as HTMLInputElement).files).toHaveLength(0)
    // With nothing chosen again, a second submit asks for a file instead of sending the old one.
    await userEvent.click(screen.getByRole('button', { name: 'Upload structure' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a structure file first.')
    expect(net.callsTo('POST /structures/upload')).toHaveLength(1)
  })

  it('asks for a file before uploading, and reports a refused upload', async () => {
    installFetch(fixtureRoutes({ 'POST /structures/upload': { status: 400, body: { detail: 'parse_error: no ATOM records' } } }))
    render(<AddStructure onAdded={() => undefined} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Upload a file' }))
    await userEvent.click(screen.getByRole('button', { name: 'Upload structure' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a structure file first.')
    await userEvent.upload(screen.getByLabelText(/Structure file/), pdb())
    await userEvent.click(screen.getByRole('button', { name: 'Upload structure' }))
    await screen.findByText('parse_error: no ATOM records')
  })
})
