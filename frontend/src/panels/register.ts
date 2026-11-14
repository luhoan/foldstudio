import { registerPanel } from '@/layout'
import { RightSidebar } from './RightSidebar'
import { PAEHeatmap } from './PAEHeatmap'
import { ComparisonView } from './ComparisonView'
import { ExperimentHistory } from './ExperimentHistory'
import { WorkflowStepper } from './WorkflowStepper'
import { CandidateLibrary } from './CandidateLibrary'

registerPanel({ id: 'stream5-right-sidebar', slot: 'right', title: 'Structure details', order: 20, component: RightSidebar })
registerPanel({ id: 'stream5-pae', slot: 'explorer.below', title: 'PAE heatmap', order: 30, component: PAEHeatmap })
registerPanel({ id: 'stream5-analysis-comparison', slot: 'analysis.main', title: 'Structural comparison', order: 20, component: ComparisonView })
registerPanel({ id: 'stream5-comparison', slot: 'comparison.main', title: 'Structure comparison', order: 20, component: ComparisonView })
registerPanel({ id: 'stream5-history', slot: 'history.main', title: 'Experiment history', order: 20, component: ExperimentHistory })
registerPanel({ id: 'stream5-workflow', slot: 'design.main', title: 'Workflow', order: 20, component: WorkflowStepper })
registerPanel({ id: 'stream5-candidate-library', slot: 'library.main', title: 'Curated candidate library', order: 20, component: CandidateLibrary })
