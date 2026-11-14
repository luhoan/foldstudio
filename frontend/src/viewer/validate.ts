import { ViewerError, type StructureFormat } from './adapter'

/**
 * Cheap sanity checks on fetched text before handing it to the parser, so the user sees a clear
 * message (e.g. dev server answering a missing /samples file with index.html) instead of a
 * parser stack trace.
 */
export function validateStructureText(text: string, format: StructureFormat, url: string): void {
  const head = text.trimStart().slice(0, 200).toLowerCase()
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    throw new ViewerError('fetch', `Expected a ${format.toUpperCase()} file but received an HTML page from ${url}. Check that the file exists.`)
  }
  if (format === 'pdb') {
    if (!/^(ATOM {2}|HETATM)/m.test(text)) {
      throw new ViewerError('parse', `No ATOM/HETATM records found in ${url}; is this a PDB-format file?`)
    }
  } else if (!/^data_/m.test(text) || !/^_atom_site\./m.test(text)) {
    throw new ViewerError('parse', `No data_ block with _atom_site records found in ${url}; is this an mmCIF file?`)
  }
}
