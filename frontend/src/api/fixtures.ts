/**
 * Real backend responses, captured by `scripts/export_api_fixtures.py`.
 *
 * The dataset behind them is synthetic (an idealised helix with made-up B-factors, and experiment
 * records that say so), so these are fixtures for response SHAPES only. They back the tests and the
 * `VITE_USE_MOCKS=true` demo mode. Do not edit the JSON by hand: regenerate it, so it stays what the
 * server returns.
 */
import align from './__fixtures__/align.json'
import compare from './__fixtures__/compare.json'
import experiments from './__fixtures__/experiments.json'
import explainExperimental from './__fixtures__/explain_experimental.json'
import explainPredicted from './__fixtures__/explain_predicted.json'
import explainResidue from './__fixtures__/explain_residue.json'
import explainUploaded from './__fixtures__/explain_uploaded.json'
import health from './__fixtures__/health.json'
import interfaces from './__fixtures__/interfaces.json'
import pae from './__fixtures__/pae.json'
import paeAttached from './__fixtures__/pae_attached.json'
import paeUnavailable from './__fixtures__/pae_unavailable.json'
import plddt from './__fixtures__/plddt.json'
import plddtRefused from './__fixtures__/plddt_refused.json'
import reindex from './__fixtures__/reindex.json'
import report from './__fixtures__/report.json'
import residues from './__fixtures__/residues.json'
import structures from './__fixtures__/structures.json'
import upload from './__fixtures__/upload.json'
import type {
  AlignmentResponse,
  ApiErrorBody,
  CompareResponse,
  Experiment,
  ExplainResponse,
  HealthResponse,
  InterfacesResponse,
  PaeAttachResponse,
  PaeResponse,
  PlddtResponse,
  ReindexReport,
  ReportResponse,
  ResiduesResponse,
  Structure,
} from './types'

// JSON modules widen string literals to `string`, so the unions in the types cannot be checked by
// assignment. The shapes are checked at runtime instead, in fixtures.test.ts.
export const fixtures = {
  structures: structures as unknown as Structure[],
  residues: residues as unknown as ResiduesResponse,
  plddt: plddt as unknown as PlddtResponse,
  plddt_refused: plddtRefused as ApiErrorBody,
  pae: pae as unknown as PaeResponse,
  pae_unavailable: paeUnavailable as ApiErrorBody,
  pae_attached: paeAttached as PaeAttachResponse,
  interfaces: interfaces as unknown as InterfacesResponse,
  explain_predicted: explainPredicted as unknown as ExplainResponse,
  explain_residue: explainResidue as unknown as ExplainResponse,
  explain_experimental: explainExperimental as unknown as ExplainResponse,
  explain_uploaded: explainUploaded as unknown as ExplainResponse,
  align: align as unknown as AlignmentResponse,
  experiments: experiments as unknown as Experiment[],
  compare: compare as unknown as CompareResponse,
  report: report as unknown as ReportResponse,
  upload: upload as unknown as Structure,
  health: health as unknown as HealthResponse,
  reindex: reindex as unknown as ReindexReport,
} as const

export type FixtureName = keyof typeof fixtures

/** Ids in the fixture dataset, named for what they are. */
export const fixtureIds = {
  backbone: 'st_fixture01',
  design: 'st_fixture02',
  complex: 'st_fixture03',
  predicted: 'st_fixture04',
  pipelineRun: 'hpc_fixture_run',
  importedPredicted: 'imported-fixture-predicted',
  importedComplex: 'imported-fixture-complex',
} as const
