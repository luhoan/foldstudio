import { registerPanel } from '@/layout'
import { AlignmentPanel } from './AlignmentPanel'
import { CandidateLibrary } from './CandidateLibrary'
import { Dashboard } from './Dashboard'
import { ExperimentComparison } from './ExperimentComparison'
import { ExperimentHistory } from './ExperimentHistory'
import { PAEHeatmap } from './PAEHeatmap'
import { RightSidebar } from './RightSidebar'
import { SequencePanel } from './SequencePanel'
import { SettingsPanel } from './SettingsPanel'
import { StructureExplorer } from './StructureExplorer'
import { WorkflowStepper } from './WorkflowStepper'

// One panel per page, plus the three that make up the Protein Explorer and the sidebar that
// follows the active structure on every page.
registerPanel({ id: 'dashboard', slot: 'dashboard.main', title: 'Overview', order: 20, component: Dashboard })
registerPanel({ id: 'structure-explorer', slot: 'explorer.main', title: '3D structure', order: 10, component: StructureExplorer })
registerPanel({ id: 'sequence', slot: 'explorer.below', title: 'Sequence', order: 10, component: SequencePanel })
registerPanel({ id: 'pae', slot: 'explorer.below', title: 'Predicted aligned error', order: 30, component: PAEHeatmap })
registerPanel({ id: 'design-workspace', slot: 'design.main', title: 'Design run', order: 20, component: WorkflowStepper })
registerPanel({ id: 'candidate-library', slot: 'library.main', title: 'Interface review', order: 20, component: CandidateLibrary })
registerPanel({ id: 'alignment', slot: 'analysis.main', title: 'Structural alignment', order: 20, component: AlignmentPanel })
registerPanel({ id: 'experiment-comparison', slot: 'comparison.main', title: 'Experiment comparison', order: 20, component: ExperimentComparison })
registerPanel({ id: 'experiment-history', slot: 'history.main', title: 'Experiment records', order: 20, component: ExperimentHistory })
registerPanel({ id: 'settings', slot: 'settings.main', title: 'Settings', order: 20, component: SettingsPanel })
registerPanel({ id: 'structure-details', slot: 'right', title: 'Structure details', order: 20, component: RightSidebar })
