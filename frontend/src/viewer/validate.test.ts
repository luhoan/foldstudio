import { ViewerError } from './adapter'
import { validateStructureText } from './validate'

const PDB_LINE = 'ATOM      1  N   THR A   1      17.047  14.099   3.625  1.00 13.79           N  \n'

describe('validateStructureText', () => {
  it('rejects an HTML page (dev-server fallback for a missing file) as a fetch error', () => {
    expect.assertions(2)
    try {
      validateStructureText('<!doctype html><html></html>', 'pdb', '/samples/x.pdb')
    } catch (e) {
      expect(e).toBeInstanceOf(ViewerError)
      expect((e as ViewerError).code).toBe('fetch')
    }
  })

  it('rejects PDB text without ATOM/HETATM records as a parse error', () => {
    expect(() => validateStructureText('HEADER only\n', 'pdb', 'u')).toThrowError(/No ATOM\/HETATM/)
  })

  it('accepts text that has PDB atom records', () => {
    expect(() => validateStructureText(PDB_LINE, 'pdb', 'u')).not.toThrow()
  })

  it('requires a data_ block and _atom_site loop for mmCIF', () => {
    expect(() => validateStructureText('data_x\n_cell.length_a 1\n', 'mmcif', 'u')).toThrowError(/_atom_site/)
    expect(() => validateStructureText('data_x\nloop_\n_atom_site.id\n1\n', 'mmcif', 'u')).not.toThrow()
  })
})
