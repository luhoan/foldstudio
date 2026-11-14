// Reads every source file as raw text via Vite (no Node APIs needed in the browser-typed project).
const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const MOLSTAR_IMPORT = /(from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"]molstar(\/|['"])/

describe('Mol* isolation', () => {
  it('finds source files to scan (guards against a vacuous pass)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    expect(Object.keys(sources)).toContain('/src/viewer/molstar/MolstarAdapter.ts')
  })

  it("no module outside src/viewer/molstar/ imports 'molstar'", () => {
    const offenders = Object.entries(sources)
      .filter(([f]) => !f.startsWith('/src/viewer/molstar/') && !f.endsWith('no-direct-molstar.test.ts'))
      .filter(([, text]) => MOLSTAR_IMPORT.test(text))
      .map(([f]) => f)
    expect(offenders).toEqual([])
  })

  it('the Mol* implementation does import molstar (so the scan can detect it)', () => {
    expect(MOLSTAR_IMPORT.test(sources['/src/viewer/molstar/MolstarAdapter.ts'])).toBe(true)
  })

  it('adapter.ts (the interface) contains no molstar import at all', () => {
    expect(sources['/src/viewer/adapter.ts']).not.toMatch(/['"]molstar/)
  })
})
