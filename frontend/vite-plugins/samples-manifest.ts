import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

export interface SampleEntry {
  file: string
  url: string
  format: 'pdb' | 'mmcif'
}

const EXT_FORMAT: Record<string, SampleEntry['format']> = {
  '.pdb': 'pdb',
  '.ent': 'pdb',
  '.cif': 'mmcif',
  '.mmcif': 'mmcif',
}

/** List real structure files dropped into a samples directory. Never generates files. */
export function listSamples(dir: string): SampleEntry[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => path.extname(f).toLowerCase() in EXT_FORMAT)
    .sort()
    .map((file) => ({
      file,
      url: `/samples/${file}`,
      format: EXT_FORMAT[path.extname(file).toLowerCase()],
    }))
}

/**
 * Serves /samples/manifest.json listing frontend/public/samples/*.{pdb,ent,cif,mmcif}
 * (dev: live; build: emitted at build time) so the viewer needs no hand-kept index.
 */
export function samplesManifest(samplesDir: string): Plugin {
  return {
    name: 'foldstudio-samples-manifest',
    configureServer(server) {
      server.middlewares.use('/samples/manifest.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(listSamples(samplesDir)))
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'samples/manifest.json',
        source: JSON.stringify(listSamples(samplesDir)),
      })
    },
  }
}
