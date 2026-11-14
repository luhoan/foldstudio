import { Box, FlaskConical, GitCompare, History, LayoutDashboard, Library, Ruler, Settings, type LucideIcon } from 'lucide-react'

export type RouteId = 'dashboard' | 'explorer' | 'design' | 'library' | 'analysis' | 'comparison' | 'history' | 'settings'

export interface NavItem {
  id: RouteId
  path: string
  label: string
  icon: LucideIcon
  description: string
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboard', path: '/', label: 'Dashboard', icon: LayoutDashboard, description: 'Overview of loaded structures and experiments.' },
  { id: 'explorer', path: '/explorer', label: 'Protein Explorer', icon: Box, description: 'Inspect a structure in 3D with confidence and residue detail.' },
  { id: 'design', path: '/design', label: 'Design Workspace', icon: FlaskConical, description: 'Review computational design results.' },
  { id: 'library', path: '/library', label: 'Candidate Library', icon: Library, description: 'Curated, precomputed candidates.' },
  { id: 'analysis', path: '/analysis', label: 'Structural Analysis', icon: Ruler, description: 'Alignment, RMSD and TM-score with the aligned atoms reported.' },
  { id: 'comparison', path: '/comparison', label: 'Comparison', icon: GitCompare, description: 'Compare structures and experiments side by side or overlaid.' },
  { id: 'history', path: '/history', label: 'Experiment History', icon: History, description: 'Executed, imported and demo runs with provenance.' },
  { id: 'settings', path: '/settings', label: 'Settings', icon: Settings, description: 'Application settings.' },
]
