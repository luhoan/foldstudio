import { useState, type FormEvent } from 'react'
import { attachPae, fetchStructure, uploadStructure } from '@/api'
import type { Structure, StructureSource } from '@/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { errorMessage, inputClass } from './format'
import { refreshLibrary } from './library'
import { ErrorNote, Field, Note } from './ui'

type Mode = 'fetch' | 'upload'
type Database = 'rcsb' | 'afdb'

const DATABASES: Record<Database, { name: string; placeholder: string; what: string }> = {
  rcsb: { name: 'RCSB PDB', placeholder: '1UBQ', what: 'A deposited experimental entry, by its four-character PDB id.' },
  afdb: { name: 'AlphaFold DB', placeholder: 'P42212', what: 'A precomputed predicted model, by UniProt accession. Its PAE comes with it when the database has one.' },
}

/**
 * What the uploaded file is. This is a statement by the person uploading, never a guess: only
 * "predicted" makes the backend read the B-factor column as pLDDT.
 */
const SOURCES: Array<{ value: StructureSource; label: string; consequence: string }> = [
  { value: 'predicted', label: 'A predicted model', consequence: 'Its B-factor column is read as pLDDT.' },
  { value: 'experimental', label: 'An experimental structure', consequence: 'No confidence is read from it.' },
  { value: 'uploaded', label: 'Something else, or not sure', consequence: 'No confidence is read from it.' },
]

/**
 * Bring a structure into the library: download a database entry as it is, or upload a file.
 * Nothing is predicted or generated here.
 */
export function AddStructure({ onAdded }: { onAdded: (structure: Structure) => void }) {
  const [mode, setMode] = useState<Mode>('fetch')
  const [database, setDatabase] = useState<Database>('rcsb')
  const [entryId, setEntryId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [label, setLabel] = useState('')
  const [source, setSource] = useState<StructureSource>('uploaded')
  const [paeFile, setPaeFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // File inputs keep their file after a submit unless they are recreated. Bumping this remounts
  // the upload form, so what the inputs show and what this component holds never disagree.
  const [formRound, setFormRound] = useState(0)

  async function finish(structure: Structure, message: string, problem: string | null = null) {
    await refreshLibrary()
    setNotice(message)
    setError(problem)
    onAdded(structure)
  }

  async function submitFetch(event: FormEvent) {
    event.preventDefault()
    const id = entryId.trim()
    if (!id) {
      setNotice(null)
      setError(`Type ${database === 'rcsb' ? 'a PDB id' : 'a UniProt accession'} first.`)
      return
    }
    setBusy(true); setError(null); setNotice(null)
    try {
      const structure = await fetchStructure({ source: database, id })
      setEntryId('')
      await finish(structure, `Added ${structure.label} from ${DATABASES[database].name}.`)
    } catch (e) {
      setError(errorMessage(e, 'The entry could not be fetched.'))
    } finally {
      setBusy(false)
    }
  }

  async function submitUpload(event: FormEvent) {
    event.preventDefault()
    if (!file) {
      setNotice(null)
      setError('Choose a structure file first.')
      return
    }
    setBusy(true); setError(null); setNotice(null)
    try {
      const structure = await uploadStructure(file, { label: label.trim() || undefined, source })
      let message = `Added ${structure.label}.`
      let problem: string | null = null
      if (paeFile && source === 'predicted') {
        try {
          const attached = await attachPae(structure.id, paeFile)
          message += ` PAE attached (${attached.size} × ${attached.size}).`
        } catch (e) {
          // The structure is in; only its PAE file was refused. Both facts are shown.
          problem = `The PAE file was not attached: ${errorMessage(e, 'it could not be read')}`
        }
      }
      setFile(null); setPaeFile(null); setLabel('')
      setFormRound((round) => round + 1)
      await finish(structure, message, problem)
    } catch (e) {
      setError(errorMessage(e, 'The file could not be uploaded.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-input bg-background/60 p-4">
      <div role="tablist" aria-label="How to add a structure" className="mb-4 inline-flex rounded-md border border-input p-0.5">
        {([['fetch', 'Fetch from a database'], ['upload', 'Upload a file']] as const).map(([value, text]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => { setMode(value); setError(null) }}
            className={cn('rounded px-3 py-1.5 text-sm transition-colors', mode === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {text}
          </button>
        ))}
      </div>

      {mode === 'fetch' ? (
        <form onSubmit={submitFetch} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Database">
              <select value={database} onChange={(e) => setDatabase(e.target.value as Database)} className={inputClass}>
                <option value="rcsb">RCSB PDB (experimental)</option>
                <option value="afdb">AlphaFold DB (predicted)</option>
              </select>
            </Field>
            <Field label={database === 'rcsb' ? 'PDB id' : 'UniProt accession'}>
              <input
                value={entryId}
                onChange={(e) => setEntryId(e.target.value)}
                placeholder={DATABASES[database].placeholder}
                autoComplete="off"
                spellCheck={false}
                className={cn(inputClass, 'w-44 font-mono')}
              />
            </Field>
            <Button type="submit" disabled={busy}>{busy ? 'Fetching…' : 'Fetch entry'}</Button>
          </div>
          <Note>
            {DATABASES[database].what} The backend downloads the file as it is and records where it came from; it needs
            internet access to do so.
          </Note>
        </form>
      ) : (
        <form key={formRound} onSubmit={submitUpload} className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Structure file" hint="PDB or mmCIF. A FASTA file is stored as a sequence with no 3D view.">
              <input
                type="file"
                accept=".pdb,.ent,.cif,.mmcif,.fasta,.fa"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-muted file:px-3 file:py-1.5 file:text-sm file:text-foreground"
              />
            </Field>
            <Field label="Name to show (optional)">
              <input value={label} onChange={(e) => setLabel(e.target.value)} className={cn(inputClass, 'w-64')} />
            </Field>
          </div>

          <fieldset>
            <legend className="mb-1.5 text-sm text-muted-foreground">What is this file?</legend>
            <div className="flex flex-wrap gap-2">
              {SOURCES.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                    source === option.value ? 'border-primary/60 bg-primary/5' : 'border-input hover:border-muted-foreground/60',
                  )}
                >
                  <input
                    type="radio"
                    name="structure-source"
                    value={option.value}
                    checked={source === option.value}
                    onChange={() => setSource(option.value)}
                    className="mt-1 accent-[var(--primary)]"
                  />
                  <span>
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.consequence}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {source === 'predicted' && (
            <Field label="PAE file from the same prediction (optional)" hint="JSON, as AlphaFold DB or ESMFold writes it. Its size must match the structure's residue count.">
              <input
                type="file"
                accept=".json"
                onChange={(e) => setPaeFile(e.target.files?.[0] ?? null)}
                className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-muted file:px-3 file:py-1.5 file:text-sm file:text-foreground"
              />
            </Field>
          )}

          <Button type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Upload structure'}</Button>
        </form>
      )}

      {notice && <p role="status" className="mt-3 text-sm text-good">{notice}</p>}
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </div>
  )
}
