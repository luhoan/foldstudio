/**
 * Auto-discovers Stream 5 panels. Any file matching frontend/src/panels/**\/register.{ts,tsx}
 * is imported for its side effects and is expected to call `registerPanel(...)` from '@/layout'.
 * No edits to layout/ or main.tsx are needed to mount a new panel.
 */
export function loadPanelRegistrations(): string[] {
  const modules = import.meta.glob('../panels/**/register.{ts,tsx}', { eager: true })
  return Object.keys(modules)
}
