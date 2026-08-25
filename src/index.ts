/**
 * The programmatic surface, for consumers who want the graph without the
 * CLI: run a scan in-process, load a graph.json, index it, query it. The
 * CLI and MCP server are thin layers over exactly these calls.
 */
export type { GraphArtifact, GNode, GEdge, NodeKind, EdgeKind } from './graph/schema.ts';
export { edgeId, fileId, functionId, domainId } from './graph/schema.ts';
export { loadGraph, saveGraph } from './graph/store.ts';
export { buildIndexes, type GraphIndexes } from './graph/indexes.ts';
export {
  contextOf,
  overview,
  domainSummaries,
  domainDetail,
  readingOrder,
  whoCalls,
  calleesOf,
  tracePath,
  search,
  type Ctx,
  type DomainSummary,
  type DomainDetail,
  type OverviewData,
  type EdgeStep,
  type SearchHit,
} from './graph/queries.ts';
export { scanTarget } from './analyzer/scan.ts';
export type { GnosisConfig } from './config.ts';
