import { StructureElement, StructureProperties, type Structure } from 'molstar/lib/mol-model/structure'
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra'
import { PluginContext } from 'molstar/lib/mol-plugin/context'
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec'
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms'
import type { StateObjectSelector } from 'molstar/lib/mol-state'
import { Color } from 'molstar/lib/mol-util/color'
import {
  ViewerError,
  formatFromUrl,
  type CameraState,
  type ColorScheme,
  type HighlightOptions,
  type LoadSecondOptions,
  type Matrix4x4,
  type RepresentationKind,
  type ResidueClickEvent,
  type ResidueRange,
  type StructureFormat,
  type ViewerAdapter,
} from '../adapter'
import { validateStructureText } from '../validate'
import { FS_PLDDT_THEME, FoldStudioPlddtThemeProvider } from './plddtTheme'

const VIEWER_BG = 0x0a0f1d
const UNIFORM_COLORS = [0x2dd4bf, 0xa78bfa] // teal (primary), purple (second)
const SIDE_BY_SIDE_GAP = 12 // Å

const REPR_TYPE: Record<RepresentationKind, 'cartoon' | 'ball-and-stick' | 'gaussian-surface'> = {
  cartoon: 'cartoon',
  'ball-and-stick': 'ball-and-stick',
  surface: 'gaussian-surface',
}

interface Slot {
  /** Data node; deleting it removes everything downstream. */
  data: StateObjectSelector
  /** Structure the representations are built on (the transformed one when a transform applies). */
  structure: StateObjectSelector
  /** Component nodes currently carrying representations. */
  components: StateObjectSelector[]
}

function toError(e: unknown, fallback: 'parse' | 'internal'): ViewerError {
  if (e instanceof ViewerError) return e
  return new ViewerError(fallback, e instanceof Error ? e.message : String(e))
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

export class MolstarAdapter implements ViewerAdapter {
  private plugin: PluginContext | null = null
  private canvas: HTMLCanvasElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private slots: Slot[] = []
  private repr: RepresentationKind = 'cartoon'
  private scheme: ColorScheme = 'chain'
  private disposed = false
  private busy: Promise<unknown> = Promise.resolve()

  private get p(): PluginContext {
    if (!this.plugin) throw new ViewerError('internal', 'Viewer is not initialised')
    return this.plugin
  }

  /** Serialise scene mutations so rapid UI changes cannot interleave Mol* state commits. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn)
    this.busy = run.catch(() => undefined)
    return run
  }

  async init(container: HTMLElement): Promise<void> {
    if (!webglAvailable()) {
      throw new ViewerError('webgl', 'WebGL is not available in this browser, so the 3D viewer cannot start.')
    }
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none'
    container.appendChild(canvas)
    this.canvas = canvas

    const plugin = new PluginContext(DefaultPluginSpec())
    await plugin.init()
    if (this.disposed) {
      plugin.dispose()
      return
    }
    const ok = await plugin.initViewerAsync(canvas, container as HTMLDivElement)
    if (!ok) {
      plugin.dispose()
      canvas.remove()
      throw new ViewerError('webgl', 'The 3D renderer failed to initialise (WebGL context could not be created).')
    }
    plugin.representation.structure.themes.colorThemeRegistry.add(FoldStudioPlddtThemeProvider)
    plugin.canvas3d?.setProps({ renderer: { backgroundColor: Color(VIEWER_BG) } })
    this.plugin = plugin

    this.resizeObserver = new ResizeObserver(() => this.plugin?.handleResize())
    this.resizeObserver.observe(container)
  }

  // ---- loading -----------------------------------------------------------------------------

  load(url: string, format: StructureFormat): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.clearScene()
        this.slots = [await this.addStructure(url, format)]
        await this.rebuildRepresentations()
        this.p.managers.camera.reset(undefined, 0)
      } catch (e) {
        await this.clearScene().catch(() => undefined)
        throw toError(e, 'parse')
      }
    })
  }

  loadSecond(url: string, matrix?: Matrix4x4, options: LoadSecondOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      if (this.slots.length === 0) throw new ViewerError('internal', 'loadSecond() requires load() first')
      const format = options.format ?? formatFromUrl(url)
      if (!format) throw new ViewerError('parse', `Cannot infer structure format from ${url}; pass options.format`)
      try {
        await this.removeSecond()
        const layout = options.layout ?? 'overlay'
        const slot = await this.addStructure(url, format, layout === 'overlay' ? matrix : undefined, layout === 'side-by-side')
        this.slots.push(slot)
        await this.rebuildRepresentations()
        this.p.managers.camera.reset(undefined, 0)
      } catch (e) {
        await this.removeSecond().catch(() => undefined)
        throw toError(e, 'parse')
      }
    })
  }

  unloadSecond(): Promise<void> {
    return this.enqueue(async () => {
      await this.removeSecond()
      await this.rebuildRepresentations()
      this.p.managers.camera.reset(undefined, 0)
    })
  }

  private async fetchText(url: string, format: StructureFormat): Promise<string> {
    let res: Response
    try {
      res = await fetch(url)
    } catch (e) {
      throw new ViewerError('fetch', `Could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) throw new ViewerError('fetch', `HTTP ${res.status} ${res.statusText} while fetching ${url}`)
    const text = await res.text()
    validateStructureText(text, format, url)
    return text
  }

  private async addStructure(
    url: string,
    format: StructureFormat,
    matrix?: Matrix4x4,
    sideBySide = false,
  ): Promise<Slot> {
    const text = await this.fetchText(url, format)
    const { builders } = this.p
    const data = await builders.data.rawData({ data: text, label: url }, { state: { isGhost: true } })
    const trajectory = await builders.structure.parseTrajectory(data, format)
    const model = await builders.structure.createModel(trajectory)
    const root = await builders.structure.createStructure(model)

    let transform: Mat4 | undefined
    let transpose = false
    if (matrix) {
      if (matrix.length !== 4 || matrix.some((r) => r.length !== 4)) {
        throw new ViewerError('internal', 'Superposition matrix must be 4x4')
      }
      transform = Mat4.fromArray(Mat4(), matrix.flat(), 0) // row-major data ...
      transpose = true // ... so ask Mol* to transpose into its column-major convention
    } else if (sideBySide) {
      const first = this.slots[0].structure.data as Structure
      const mine = root.data as Structure
      const c1 = first.boundary.sphere.center
      const c2 = mine.boundary.sphere.center
      const dx = first.boundary.sphere.radius + mine.boundary.sphere.radius + SIDE_BY_SIDE_GAP
      transform = Mat4.fromTranslation(
        Mat4(),
        Vec3.create(c1[0] + dx - c2[0], c1[1] - c2[1], c1[2] - c2[2]),
      )
    }

    let structure: StateObjectSelector = root
    if (transform) {
      const update = this.p
        .build()
        .to(root)
        .apply(StateTransforms.Model.TransformStructureConformation, {
          transform: { name: 'matrix', params: { data: transform, transpose } },
        })
      structure = update.selector
      await update.commit()
    }
    return { data, structure, components: [] }
  }

  private async removeSecond() {
    if (this.slots.length < 2) return
    const [, second] = this.slots.splice(1, 1)
    await this.p.build().delete(second.data).commit()
  }

  private async clearScene() {
    if (!this.plugin) return
    this.plugin.managers.structure.selection.clear()
    await this.plugin.clear()
    this.slots = []
  }

  // ---- representation / colour ---------------------------------------------------------------

  setRepresentation(kind: RepresentationKind): Promise<void> {
    this.repr = kind
    return this.enqueue(() => this.rebuildRepresentations())
  }

  colorBy(scheme: ColorScheme): Promise<void> {
    this.scheme = scheme
    return this.enqueue(() => this.rebuildRepresentations())
  }

  private colorFor(slotIndex: number): { color: string; colorParams?: Record<string, unknown> } {
    switch (this.scheme) {
      case 'chain':
        return { color: 'chain-id' }
      case 'secondary-structure':
        return { color: 'secondary-structure' }
      case 'plddt':
        return { color: FS_PLDDT_THEME }
      case 'uniform':
        return { color: 'uniform', colorParams: { value: Color(UNIFORM_COLORS[slotIndex % UNIFORM_COLORS.length]) } }
    }
  }

  private async rebuildRepresentations() {
    if (this.slots.length === 0) return
    const { builders } = this.p
    const cleanup = this.p.build()
    for (const s of this.slots) for (const c of s.components) cleanup.delete(c)
    await cleanup.commit()

    for (const [i, slot] of this.slots.entries()) {
      slot.components = []
      const polymer = await builders.structure.tryCreateComponentStatic(slot.structure, 'polymer')
      if (polymer) {
        slot.components.push(polymer)
        await builders.structure.representation.addRepresentation(polymer, {
          type: REPR_TYPE[this.repr],
          ...this.colorFor(i),
        } as never)
      }
      const ligand = await builders.structure.tryCreateComponentStatic(slot.structure, 'ligand')
      if (ligand) {
        slot.components.push(ligand)
        await builders.structure.representation.addRepresentation(ligand, { type: 'ball-and-stick', color: 'element-symbol' } as never)
      }
    }
  }

  // ---- highlighting / selection ----------------------------------------------------------------

  highlightResidues(chain: string, ranges: ResidueRange[], options: HighlightOptions = {}): void {
    const plugin = this.plugin
    const structure = this.slots[options.structureIndex ?? 0]?.structure.data as Structure | undefined
    if (!plugin || !structure) return
    if (ranges.length === 0) {
      plugin.managers.structure.selection.clear()
      return
    }
    const loci = StructureElement.Loci.fromExpression(structure, (MS) =>
      MS.struct.generator.atomGroups({
        'chain-test': MS.core.rel.eq([MS.ammp('auth_asym_id'), chain]),
        'residue-test': MS.core.logic.or(ranges.map((r) => MS.core.rel.inRange([MS.ammp('auth_seq_id'), r.start, r.end]))),
      }),
    )
    if (StructureElement.Loci.isEmpty(loci)) {
      plugin.managers.structure.selection.clear()
      return
    }
    plugin.managers.structure.selection.fromLoci('set', loci)
    if (options.focus !== false) plugin.managers.camera.focusLoci(loci)
  }

  selectChain(chain: string | null): void {
    const plugin = this.plugin
    const structure = this.slots[0]?.structure.data as Structure | undefined
    if (!plugin || !structure) return
    if (chain === null) {
      plugin.managers.structure.selection.clear()
      return
    }
    const loci = StructureElement.Loci.fromExpression(structure, (MS) =>
      MS.struct.generator.atomGroups({ 'chain-test': MS.core.rel.eq([MS.ammp('auth_asym_id'), chain]) }),
    )
    if (StructureElement.Loci.isEmpty(loci)) {
      plugin.managers.structure.selection.clear()
      return
    }
    plugin.managers.structure.selection.fromLoci('set', loci)
    plugin.managers.camera.focusLoci(loci)
  }

  clearHighlight(): void {
    this.plugin?.managers.structure.selection.clear()
  }

  // ---- camera / screenshot ---------------------------------------------------------------------

  resetCamera(): void {
    this.plugin?.managers.camera.reset()
  }

  getCamera(): CameraState {
    const cam = this.p.canvas3d?.camera
    if (!cam) throw new ViewerError('internal', 'Viewer has no camera yet')
    const s = cam.getSnapshot()
    const v = (a: ArrayLike<number>): [number, number, number] => [a[0], a[1], a[2]]
    return {
      position: v(s.position),
      target: v(s.target),
      up: v(s.up),
      radius: s.radius,
      radiusMax: s.radiusMax,
      fov: s.fov,
      mode: s.mode,
    }
  }

  setCamera(state: CameraState): void {
    this.plugin?.canvas3d?.camera.setState(
      {
        position: Vec3.create(...state.position),
        target: Vec3.create(...state.target),
        up: Vec3.create(...state.up),
        radius: state.radius,
        radiusMax: state.radiusMax,
        fov: state.fov,
        mode: state.mode,
      },
      0,
    )
  }

  async screenshot(): Promise<Blob> {
    const helper = this.p.helpers.viewportScreenshot
    if (!helper) throw new ViewerError('internal', 'Screenshot helper is unavailable')
    const uri = await helper.getImageDataUri()
    return (await fetch(uri)).blob()
  }

  // ---- events ------------------------------------------------------------------------------------

  onResidueClick(cb: (e: ResidueClickEvent) => void): () => void {
    const plugin = this.p
    const sub = plugin.behaviors.interaction.click.subscribe(({ current }) => {
      const loci = current.loci
      if (!StructureElement.Loci.is(loci) || StructureElement.Loci.isEmpty(loci)) return
      const loc = StructureElement.Loci.getFirstLocation(loci)
      if (!loc) return
      const idx = this.slots.findIndex((s) => (s.structure.data as Structure | undefined)?.root === loci.structure.root)
      cb({
        chain: StructureProperties.chain.auth_asym_id(loc),
        seqId: StructureProperties.residue.auth_seq_id(loc),
        insCode: StructureProperties.residue.pdbx_PDB_ins_code(loc),
        compId: StructureProperties.atom.auth_comp_id(loc),
        structureIndex: Math.max(idx, 0),
      })
    })
    return () => sub.unsubscribe()
  }

  dispose(): void {
    this.disposed = true
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.plugin?.dispose()
    this.plugin = null
    this.canvas?.remove()
    this.canvas = null
    this.slots = []
  }
}
