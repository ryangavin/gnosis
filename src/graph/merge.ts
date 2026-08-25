/**
 * Joins a trace run's NDJSON aggregates onto the static graph. A merge
 * replaces the previous runtime picture entirely — runtime facets are
 * cleared, runtime-only edges dropped, then the new observations applied:
 * an edge with a static counterpart gains its runtime facet; one without
 * (dynamic dispatch the checker couldn't see) is added as `static: false`;
 * an endpoint the graph doesn't know is a join miss, counted and reported.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EdgeLine } from '../tracer/runtime.ts';
import { edgeId, type GraphArtifact } from './schema.ts';

const TEST_FILES_CAP = 10;

export interface MergeStats {
  edgesMatched: number;
  edgesAdded: number;
  joinMisses: number;
  functionsConfirmed: number;
}

export function readTraceLines(traceDir: string): Map<string, EdgeLine> {
  const summed = new Map<string, EdgeLine>();
  for (const entry of readdirSync(traceDir)) {
    if (!/^trace-\d+\.ndjson$/.test(entry)) continue;
    for (const raw of readFileSync(join(traceDir, entry), 'utf8').split('\n')) {
      if (!raw) continue;
      const line = JSON.parse(raw) as EdgeLine;
      if (line.t !== 'edge') continue;
      const key = `${line.from} ${line.to}`;
      const existing = summed.get(key);
      if (existing) {
        existing.n += line.n;
        for (const t of line.tests) if (existing.tests.length < 20 && !existing.tests.includes(t)) existing.tests.push(t);
        for (const f of line.testFiles) if (existing.testFiles.length < TEST_FILES_CAP && !existing.testFiles.includes(f)) existing.testFiles.push(f);
      } else {
        summed.set(key, { ...line, tests: [...line.tests], testFiles: [...line.testFiles] });
      }
    }
  }
  return summed;
}

export function mergeTraces(graph: GraphArtifact, traceDir: string): MergeStats {
  // A fresh observation replaces the old one.
  graph.edges = graph.edges.filter((e) => e.static);
  for (const edge of graph.edges) delete edge.runtime;
  for (const node of graph.nodes) delete node.runtime;

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgesById = new Map(graph.edges.map((e) => [e.id, e]));
  const stats: MergeStats = { edgesMatched: 0, edgesAdded: 0, joinMisses: 0, functionsConfirmed: 0 };

  const bumpNode = (id: string, count: number, testFiles: string[]): void => {
    const node = nodesById.get(id);
    if (!node) return;
    node.runtime ??= { calls: 0, testFiles: [] };
    node.runtime.calls += count;
    for (const f of testFiles) {
      if (node.runtime.testFiles.length >= TEST_FILES_CAP) break;
      if (!node.runtime.testFiles.includes(f)) node.runtime.testFiles.push(f);
    }
  };

  for (const line of readTraceLines(traceDir).values()) {
    const toKnown = nodesById.has(line.to);
    if (!toKnown) {
      stats.joinMisses += 1;
      continue;
    }
    bumpNode(line.to, line.n, line.testFiles);

    if (!line.from) continue; // module-init call: node hit without attributable edge
    if (!nodesById.has(line.from)) {
      stats.joinMisses += 1;
      continue;
    }
    const id = edgeId('calls', line.from, line.to);
    const existing = edgesById.get(id);
    if (existing) {
      existing.runtime = { count: line.n, tests: line.tests, testFiles: line.testFiles };
      stats.edgesMatched += 1;
    } else {
      const added = {
        id,
        kind: 'calls' as const,
        from: line.from,
        to: line.to,
        static: false,
        runtime: { count: line.n, tests: line.tests, testFiles: line.testFiles },
      };
      graph.edges.push(added);
      edgesById.set(id, added);
      stats.edgesAdded += 1;
    }
  }

  // Coverage rollups on domains and the repo.
  const coveredByParent = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind !== 'function') continue;
    if (!node.runtime) continue;
    stats.functionsConfirmed += 1;
    let current = node.parent ? nodesById.get(node.parent) : undefined;
    while (current) {
      if (current.kind === 'domain' || current.kind === 'repo') {
        coveredByParent.set(current.id, (coveredByParent.get(current.id) ?? 0) + 1);
      }
      current = current.parent ? nodesById.get(current.parent) : undefined;
    }
  }
  const repoCovered = stats.functionsConfirmed;
  for (const node of graph.nodes) {
    if (node.kind === 'domain') {
      node.stats = { ...node.stats, coveredFunctions: coveredByParent.get(node.id) ?? 0 };
    } else if (node.kind === 'repo') {
      node.stats = { ...node.stats, coveredFunctions: repoCovered };
    }
  }

  graph.edges.sort((a, b) => (a.id < b.id ? -1 : 1));
  graph.target.tracedAt = new Date().toISOString();
  return stats;
}
