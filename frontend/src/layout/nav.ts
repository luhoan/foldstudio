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
  { id: 'dashboard', path: '/', label: 'Dashboard', icon: LayoutDashboard, description: 'What is loaded, where it came from, and how the latest pipeline run ended.' },
  { id: 'explorer', path: '/explorer', label: 'Protein Explorer', icon: Box, description: 'Look at a structure in 3D, residue by residue, with its confidence where it has one.' },
  { id: 'design', path: '/design', label: 'Design Workspace', icon: FlaskConical, description: 'Follow a design run stage by stage: backbone, sequence, predicted structure, evaluation.' },
  { id: 'library', path: '/library', label: 'Candidate Library', icon: Library, description: 'Review the chain interfaces of multi-chain structures. Nothing here is generated.' },
  { id: 'analysis', path: '/analysis', label: 'Structural Analysis', icon: Ruler, description: 'Superpose two structures and read RMSD and TM-score together with exactly which atoms were used.' },
  { id: 'comparison', path: '/comparison', label: 'Comparison', icon: GitCompare, description: 'Put experiment records side by side: settings, metrics and provenance.' },
  { id: 'history', path: '/history', label: 'Experiment History', icon: History, description: 'Every record, labelled by whether it ran here, was imported, or is a demo.' },
  { id: 'settings', path: '/settings', label: 'Settings', icon: Settings, description: 'What this app is connected to and what the backend loaded.' },
]
