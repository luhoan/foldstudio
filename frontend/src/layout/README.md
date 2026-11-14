# Layout, slots and the viewer (Stream 2)

## Mounting a panel (Stream 5)
Create `frontend/src/panels/<anything>/register.tsx` (auto-discovered; no edits to `layout/` or `main.tsx`):

```tsx
import { registerPanel } from '@/layout'
import { MyPanel } from './MyPanel'

registerPanel({ id: 'residue-table', slot: 'explorer.below', title: 'Residues', order: 10, component: MyPanel })
```

Slots: `<route>.main` for `dashboard | explorer | design | library | analysis | comparison | history | settings`,
plus `explorer.below` (under the viewer) and `right` (collapsible right sidebar, every route).
A panel that throws is isolated by an error boundary; siblings keep rendering. Same `id` replaces (HMR-safe).

## Driving the viewer from a panel
```ts
import { viewerActions, useViewerState } from '@/viewer'
viewerActions.setStructure({ url: `/api/structures/${id}/file`, format: 'pdb', label, source: 'predicted' })
const { adapter } = useViewerState()           // null until the viewer is ready
adapter?.highlightResidues('A', [{ start: 10, end: 20 }])
```
Residue numbering is author numbering (`auth_asym_id` / `auth_seq_id`). `source` drives the pLDDT-vs-B-factor caveat.
Only `src/viewer/molstar/**` may import `molstar` (enforced by a test). Use `ViewerAdapter` types from `@/viewer`.

## Samples
Real structure files placed in `frontend/public/samples/` (`.pdb .ent .cif .mmcif`) are listed live at
`/samples/manifest.json` and appear in the Protein Explorer selector. Nothing is generated.
