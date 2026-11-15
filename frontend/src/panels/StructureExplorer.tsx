import { Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom'
import { structureFileUrl } from '@/api'
import type { Structure } from '@/api'
import { Button } from '@/components/ui/button'
import { ViewerPanel, useSampleStructures } from '@/viewer'
import type { ResidueClickEvent } from '@/viewer'
import { AddStructure } from './AddStructure'
import { formatRanges, inputClass, sourceLabel } from './format'
import { useLibrary } from './library'
import { parseHighlight } from './links'
import { getPanelState, selectFromViewer, setActiveStructure, showSample, usePanelState } from './panelState'
import { Card, Code, EmptyState, ErrorNote, Loading, Note, SourceBadge } from './ui'

const LIBRARY_PREFIX = 'library:'
const SAMPLE_PREFIX = 'sample:'

/**
 * The Protein Explorer's main panel: which structure is on screen, and the 3D view of it.
 *
 * The choice lives in the shared panel state, so the sidebar and the panels below follow it. The
 * address bar mirrors it (`?structure=<id>`), which is what makes "open in 3D" links from other
 * pages work; a link may also ask for residues to be highlighted (`&chain=A&ranges=12-40,55`).
 */
export function StructureExplorer() {
  const library = useLibrary()
  const samples = useSampleStructures()
  const { activeStructureId, sampleUrl } = usePanelState()
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const location = useLocation()
  const navigationType = useNavigationType()
  /** Key of the last history entry the sync effect looked at (null until the library is ready). */
  const seenKey = useRef<string | null>(null)

  const urlId = params.get('structure')
  const chainParam = params.get('chain')
  const rangesParam = params.get('ranges')
  const { structures } = library
  const ready = library.status === 'ready'
  const known = (id: string | null): id is string => !!id && structures.some((s) => s.id === id)

  const sample = sampleUrl ? samples.samples.find((s) => s.url === sampleUrl) ?? null : null
  const structure: Structure | null = sample ? null : structures.find((s) => s.id === activeStructureId) ?? null
  const unknownInUrl = ready && urlId !== null && !known(urlId)

  /** Put a structure (or none) in the address. Always a replace, so it never adds a history entry. */
  function writeAddress(id: string | null) {
    setParams(id ? { structure: id } : {}, { replace: true })
  }

  // Keep three things in step: the address bar, the shared selection, and the default choice.
  //
  // The address is updated in a transition, so it can lag behind the selection, and two of this
  // panel's own updates can land out of order. What tells "someone followed a link" apart from
  // "our own update just landed" is the navigation type: this panel only ever replaces, while a
  // link pushes and back/forward pops.
  useEffect(() => {
    if (!ready) return
    // 1. Arriving on the page, or following a link while on it: the structure it names wins.
    if (location.key !== seenKey.current) {
      const arriving = seenKey.current === null
      seenKey.current = location.key
      if ((arriving || navigationType !== 'REPLACE') && known(urlId)) setActiveStructure(urlId)
    }
    // 2. Nothing chosen yet, and no sample file on screen: start with the first structure.
    let now = getPanelState()
    if (!known(now.activeStructureId) && !now.sampleUrl && structures.length > 0) {
      setActiveStructure(structures[0].id)
      now = getPanelState()
    }
    // 3. The address follows the selection (which may have been changed by the picker, the
    //    sidebar, or a sample file). A highlight that belonged to another structure is dropped.
    //    A link to a structure that does not exist is left alone, so the note about it stays.
    const wanted = now.sampleUrl ? null : known(now.activeStructureId) ? now.activeStructureId : null
    if (wanted !== urlId && !(urlId !== null && !known(urlId))) writeAddress(wanted)
    // `known`, `structures` and `writeAddress` are derived from values already in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, location.key, navigationType, urlId, activeStructureId, library.structures, sampleUrl])

  const highlight = useMemo(() => {
    if (!structure || urlId !== structure.id) return null
    return parseHighlight(new URLSearchParams({ chain: chainParam ?? '', ranges: rangesParam ?? '' }))
  }, [structure, urlId, chainParam, rangesParam])

  function choose(value: string) {
    if (value.startsWith(SAMPLE_PREFIX)) {
      showSample(value.slice(SAMPLE_PREFIX.length))
      writeAddress(null)
    } else if (value.startsWith(LIBRARY_PREFIX)) {
      const id = value.slice(LIBRARY_PREFIX.length)
      setActiveStructure(id)
      writeAddress(id)
    }
  }

  function onAdded(added: Structure) {
    setActiveStructure(added.id)
    writeAddress(added.id)
  }

  function onResidueClick(event: ResidueClickEvent) {
    if (structure && event.structureIndex === 0) selectFromViewer(structure.id, event)
  }

  const nothingToShow = ready && structures.length === 0 && samples.samples.length === 0
  const selectValue = sample ? `${SAMPLE_PREFIX}${sample.url}` : structure ? `${LIBRARY_PREFIX}${structure.id}` : ''
  const viewable = structure ? structure.format !== 'fasta' : sample !== null

  return (
    <Card
      title="3D structure"
      actions={
        <Button variant="outline" size="sm" onClick={() => setAdding((open) => !open)} aria-expanded={adding || nothingToShow}>
          {adding ? <X /> : <Plus />}
          {adding ? 'Close' : 'Add structure'}
        </Button>
      }
    >
      <div className="space-y-4">
        {(adding || nothingToShow) && <AddStructure onAdded={onAdded} />}

        {!ready && <Loading>Loading structures…</Loading>}
        {library.error && <ErrorNote>{library.error}</ErrorNote>}

        {nothingToShow ? (
          <EmptyState title="No structures yet">
            Fetch an entry or upload a file above. Pipeline bundles placed in <Code>data/experiments/</Code> are
            registered automatically when the backend starts, and <Code>python3 scripts/fetch_demo_data.py</Code> downloads
            a small reference set.
          </EmptyState>
        ) : ready && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
                <span className="shrink-0 text-muted-foreground">Structure</span>
                <select
                  aria-label="Structure"
                  value={selectValue}
                  onChange={(e) => choose(e.target.value)}
                  className={`${inputClass} w-full max-w-xl`}
                >
                  {selectValue === '' && <option value="">Choose a structure</option>}
                  {structures.length > 0 && (
                    <optgroup label="Library">
                      {structures.map((s) => (
                        <option key={s.id} value={`${LIBRARY_PREFIX}${s.id}`}>{s.label} ({sourceLabel(s.source)})</option>
                      ))}
                    </optgroup>
                  )}
                  {samples.samples.length > 0 && (
                    <optgroup label="Local sample files (not in the library)">
                      {samples.samples.map((s) => (
                        <option key={s.url} value={`${SAMPLE_PREFIX}${s.url}`}>{s.file}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              {structure && (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <SourceBadge source={structure.source} />
                  <span>
                    {structure.n_residues} residue{structure.n_residues === 1 ? '' : 's'} in {structure.chains.length} chain{structure.chains.length === 1 ? '' : 's'}
                  </span>
                </div>
              )}
            </div>

            {unknownInUrl && (
              <ErrorNote>
                This link points to structure <Code>{urlId}</Code>, which is not in the library. It may have been removed
                together with its bundle. Showing {structure ? structure.label : 'nothing'} instead.
              </ErrorNote>
            )}

            {sample && (
              <Note>
                {sample.file} is a file from <Code>frontend/public/samples/</Code>. It is not in the library, so the
                backend has no residues, confidence or provenance for it.
              </Note>
            )}

            {highlight && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-md bg-muted px-2.5 py-1">
                  Highlighted: chain {highlight.chain}, residues {formatRanges(highlight.ranges)}
                </span>
                <button type="button" className="fs-link" onClick={() => structure && writeAddress(structure.id)}>
                  Clear highlight
                </button>
              </div>
            )}

            {structure && !viewable ? (
              <EmptyState title="This record has no coordinates">
                {structure.label} is a FASTA sequence, so there is nothing to draw in 3D.
              </EmptyState>
            ) : (
              <div className="h-[32rem] min-h-[420px]">
                <ViewerPanel
                  url={sample ? sample.url : structure ? structureFileUrl(structure.id) : null}
                  format={sample ? sample.format : structure?.format === 'mmcif' ? 'mmcif' : 'pdb'}
                  label={sample ? sample.file : structure?.label}
                  structureKind={structure?.source}
                  defaultColorScheme={structure?.source === 'predicted' ? 'plddt' : 'chain'}
                  highlight={highlight}
                  onResidueClick={onResidueClick}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
