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
const TESTS_CAP = 20;

export interface MergeStats {
  edgesMatched: number;
  edgesAdded: number;
  joinMisses: number;
  functionsConfirmed: number;
}

/**
 * One edge summed across every worker. Sets, not capped arrays: a worker
 * only ever sees its own test file (vitest runs one per file), so the whole
 * cross-worker union is what tells us how much of the suite reaches an
 * edge. Truncating here would silently cap `testBreadth` — the cap belongs
 * at artifact-write time, where it is only about file size.
 */
export interface AggregatedEdge {
  from: string;
  to: string;
  n: number;
  tests: Set<string>;
  testFiles: Set<string>;
}

export function readTraceLines(traceDir: string): Map<string, AggregatedEdge> {
  const summed = new Map<string, AggregatedEdge>();
  for (const entry of readdirSync(traceDir)) {
    if (!/^trace-\d+\.ndjson$/.test(entry)) continue;
    for (const raw of readFileSync(join(traceDir, entry), 'utf8').split('\n')) {
      if (!raw) continue;
      const line = JSON.parse(raw) as EdgeLine;
      if (line.t !== 'edge') continue;
      const key = `${line.from} ${line.to}`;
      let agg = summed.get(key);
      if (!agg) {
        agg = { from: line.from, to: line.to, n: 0, tests: new Set(), testFiles: new Set() };
        summed.set(key, agg);
      }
      agg.n += line.n;
      for (const t of line.tests) agg.tests.add(t);
      for (const f of line.testFiles) agg.testFiles.add(f);
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

  // Capping happens here, on the way into the artifact, not during summation.
  const capped = (set: Set<string>, limit: number): string[] => [...set].slice(0, limit);

  const bumpNode = (id: string, count: number, testFiles: Set<string>): void => {
    const node = nodesById.get(id);
    if (!node) return;
    node.runtime ??= { calls: 0, testFiles: [] };
    node.runtime.calls += count;
    for (const f of testFiles) {
      if (node.runtime.testFiles.length >= TEST_FILES_CAP) break;
      if (!node.runtime.testFiles.includes(f)) node.runtime.testFiles.push(f);
    }
  };

  const traceLines = [...readTraceLines(traceDir).values()];
  for (const line of traceLines) {
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
    const runtime = {
      count: line.n,
      tests: capped(line.tests, TESTS_CAP),
      testFiles: capped(line.testFiles, TEST_FILES_CAP),
    };
    const id = edgeId('calls', line.from, line.to);
    const existing = edgesById.get(id);
    if (existing) {
      existing.runtime = runtime;
      stats.edgesMatched += 1;
    } else {
      const added = {
        id,
        kind: 'calls' as const,
        from: line.from,
        to: line.to,
        static: false,
        runtime,
      };
      graph.edges.push(added);
      edgesById.set(id, added);
      stats.edgesAdded += 1;
    }
  }

  // --- Importance rollups ---
  // Every container gets the coverage, call volume, and *breadth* of what
  // sits beneath it. Breadth — the share of the suite that reaches a node —
  // is the useful importance signal: a function called a million times by
  // one test matters less than one touched by half the suite.
  //
  // The per-node testFiles list is capped for artifact size, so breadth is
  // counted from the uncapped trace here rather than from that list.
  const reachedBy = new Map<string, Set<string>>();
  const callsUnder = new Map<string, number>();
  const coveredUnder = new Map<string, number>();
  const allTestFiles = new Set<string>();

  const ancestorsOf = (id: string): string[] => {
    const chain: string[] = [];
    let current = nodesById.get(id)?.parent;
    while (current) {
      chain.push(current);
      current = nodesById.get(current)?.parent;
    }
    return chain;
  };

  const credit = (id: string, testFiles: Iterable<string>, n: number): void => {
    for (const target of [id, ...ancestorsOf(id)]) {
      let seen = reachedBy.get(target);
      if (!seen) reachedBy.set(target, (seen = new Set()));
      for (const f of testFiles) seen.add(f);
      callsUnder.set(target, (callsUnder.get(target) ?? 0) + n);
    }
  };

  for (const line of traceLines) {
    for (const f of line.testFiles) allTestFiles.add(f);
    if (!nodesById.has(line.to)) continue;
    credit(line.to, line.testFiles, line.n);
  }

  // A test file is the origin of calls, never their target, so the loop above
  // leaves it looking like dead code. It demonstrably ran: credit it for the
  // calls it made, and count it as reached by itself.
  //
  // Deliberately not rolled up to its folder — "tests live here" is not the
  // same claim as "the code here is exercised", and breadth means the second.
  for (const line of traceLines) {
    if (!line.from.startsWith('file:')) continue;
    const origin = nodesById.get(line.from);
    if (!origin?.flags?.testFile) continue;
    origin.runtime ??= { calls: 0, testFiles: [] };
    origin.runtime.calls += line.n;
    const own = origin.id.slice('file:'.length);
    if (!origin.runtime.testFiles.includes(own)) origin.runtime.testFiles.unshift(own);
    let seen = reachedBy.get(origin.id);
    if (!seen) reachedBy.set(origin.id, (seen = new Set()));
    seen.add(own);
    callsUnder.set(origin.id, (callsUnder.get(origin.id) ?? 0) + line.n);
  }

  for (const node of graph.nodes) {
    if (node.kind !== 'function' || !node.runtime) continue;
    stats.functionsConfirmed += 1;
    for (const id of ancestorsOf(node.id)) {
      coveredUnder.set(id, (coveredUnder.get(id) ?? 0) + 1);
    }
  }

  // Deliberately tested vs incidentally covered. A test subgraph is strictly
  // outgoing — nothing in the codebase depends on a test — so "a test calls
  // in here" is a property of the target, and the only thing the test nodes
  // were ever really saying.
  const fileOf = (id: string) => {
    let node = nodesById.get(id);
    while (node && node.kind !== 'file') node = node.parent ? nodesById.get(node.parent) : undefined;
    return node;
  };
  const directTests = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const origin = fileOf(edge.from);
    if (!origin?.flags?.testFile) continue;
    const target = fileOf(edge.to);
    if (!target || target.flags?.testFile) continue;
    const name = origin.id.slice('file:'.length);
    for (const id of [edge.to, ...ancestorsOf(edge.to)]) {
      let seen = directTests.get(id);
      if (!seen) directTests.set(id, (seen = new Set()));
      seen.add(name);
    }
  }

  const total = allTestFiles.size;
  for (const node of graph.nodes) {
    const reached = reachedBy.get(node.id);
    const covered = coveredUnder.get(node.id);
    const direct = directTests.get(node.id);
    if (!reached && covered === undefined && !direct) continue;
    node.stats = {
      ...node.stats,
      ...(covered !== undefined || node.kind !== 'function' ? { coveredFunctions: covered ?? 0 } : {}),
      ...(direct ? { directTests: direct.size } : {}),
      ...(reached
        ? {
            testFiles: reached.size,
            testBreadth: total > 0 ? Number((reached.size / total).toFixed(4)) : 0,
            calls: callsUnder.get(node.id) ?? 0,
          }
        : {}),
    };
  }

  graph.edges.sort((a, b) => (a.id < b.id ? -1 : 1));
  graph.target.tracedAt = new Date().toISOString();
  graph.target.testFileCount = total;
  return stats;
}
