import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listSamples } from './samples-manifest.ts'

describe('listSamples', () => {
  it('lists only structure files, with formats, sorted', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'samples-'))
    try {
      for (const f of ['b.cif', 'a.pdb', 'notes.txt', 'c.ENT', '.gitkeep']) writeFileSync(path.join(dir, f), '')
      expect(listSamples(dir)).toEqual([
        { file: 'a.pdb', url: '/samples/a.pdb', format: 'pdb' },
        { file: 'b.cif', url: '/samples/b.cif', format: 'mmcif' },
        { file: 'c.ENT', url: '/samples/c.ENT', format: 'pdb' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty list when the directory is missing', () => {
    expect(listSamples('/nonexistent/dir/for/test')).toEqual([])
  })
})
