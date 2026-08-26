/**
 * The question-answering layer over a graph artifact. Every consumer that
 * explains the codebase — MCP tools, the markdown emitter — pulls from
 * these functions, so the two can't drift apart. Pure and JSON-shaped.
 */
import type { GEdge, GNode, GraphArtifact } from './schema.ts';
import { buildIndexes, type GraphIndexes } from './indexes.ts';

export interface Ctx {
  graph: GraphArtifact;
  indexes: GraphIndexes;
}

export function contextOf(graph: GraphArtifact): Ctx {
  return { graph, indexes: buildIndexes(graph) };
}

/** The top-level domain a node belongs to, if any. */
export function topDomainOf(ctx: Ctx, id: string): GNode | undefined {
  let current = ctx.indexes.byId.get(id);
  let lastDomain: GNode | undefined;
  while (current) {
    if (current.kind === 'domain') lastDomain = current;
    current = current.parent ? ctx.indexes.byId.get(current.parent) : undefined;
  }
  return lastDomain;
}

export interface DomainDependency {
  domain: string;
  calls: number;
  imports: number;
  /** Underlying edges observed during a test run. */
  confirmed: number;
}

export interface DomainSummary {
  path: string;
  name: string;
  description?: string;
  files: number;
  functions: number;
  coveredFunctions: number;
  loc: number;
  docPaths: string[];
  dependsOn: DomainDependency[];
  dependedOnBy: DomainDependency[];
}

function aggregateDomainEdges(ctx: Ctx): Map<string, Map<string, DomainDependency>> {
  const out = new Map<string, Map<string, DomainDependency>>();
  for (const edge of ctx.graph.edges) {
    const from = topDomainOf(ctx, edge.from);
    const to = topDomainOf(ctx, edge.to);
    if (!from || !to || from.id === to.id) continue;
    const fromPath = from.id.slice('domain:'.length);
    const toPath = to.id.slice('domain:'.length);
    let deps = out.get(fromPath);
    if (!deps) {
      deps = new Map();
      out.set(fromPath, deps);
    }
    let dep = deps.get(toPath);
    if (!dep) {
      dep = { domain: toPath, calls: 0, imports: 0, confirmed: 0 };
      deps.set(toPath, dep);
    }
    if (edge.kind === 'calls') dep.calls += 1;
    else dep.imports += 1;
    if (edge.runtime) dep.confirmed += 1;
  }
  return out;
}

export function domainSummaries(ctx: Ctx): DomainSummary[] {
  const topDomains = (ctx.indexes.childrenOf.get('repo') ?? []).filter((n) => n.kind === 'domain');
  const outgoing = aggregateDomainEdges(ctx);
  const incoming = new Map<string, DomainDependency[]>();
  for (const [fromPath, deps] of outgoing) {
    for (const dep of deps.values()) {
      const list = incoming.get(dep.domain) ?? [];
      list.push({ ...dep, domain: fromPath });
      incoming.set(dep.domain, list);
    }
  }
  return topDomains.map((d) => {
    const path = d.id.slice('domain:'.length);
    return {
      path,
      name: d.name,
      description: d.doc?.summary ?? d.doc?.docFiles?.[0]?.excerpt,
      files: d.stats?.files ?? 0,
      functions: d.stats?.functions ?? 0,
      coveredFunctions: d.stats?.coveredFunctions ?? 0,
      loc: d.stats?.loc ?? 0,
      docPaths: (d.doc?.docFiles ?? []).map((f) => f.path),
      dependsOn: [...(outgoing.get(path)?.values() ?? [])].sort((a, b) => b.calls + b.imports - (a.calls + a.imports)),
      dependedOnBy: (incoming.get(path) ?? []).sort((a, b) => b.calls + b.imports - (a.calls + a.imports)),
    };
  });
}

/** Domains ordered so the least-dependent come first: a reading order. */
export function readingOrder(summaries: DomainSummary[]): string[] {
  const remaining = new Map(summaries.map((s) => [s.path, new Set(s.dependsOn.map((d) => d.domain))]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((d) => order.includes(d) || !remaining.has(d)))
      .map(([path]) => path)
      .sort();
    if (ready.length === 0) {
      order.push(...[...remaining.keys()].sort());
      break;
    }
    for (const path of ready) {
      order.push(path);
      remaining.delete(path);
    }
  }
  return order;
}

export interface OverviewData {
  name: string;
  description?: string;
  stats: { files: number; functions: number; coveredFunctions: number; loc: number };
  domains: DomainSummary[];
  readingOrder: string[];
  entryPoints: { id: string; summary?: string }[];
  limitations: string[];
  scannedAt: string;
  tracedAt?: string;
}

export function overview(ctx: Ctx): OverviewData {
  const repo = ctx.indexes.byId.get('repo')!;
  const summaries = domainSummaries(ctx);
  const entryPoints = ctx.graph.nodes
    .filter(
      (n) =>
        n.kind === 'function' &&
        n.flags?.exported &&
        (ctx.indexes.inEdges.get(n.id) ?? []).length === 0 &&
        !n.parent?.includes('.test.'),
    )
    .slice(0, 20)
    .map((n) => ({ id: n.id, summary: n.doc?.summary }));
  return {
    name: ctx.graph.target.name,
    description: repo.doc?.docFiles?.find((d) => d.path === 'README.md')?.excerpt,
    stats: {
      files: repo.stats?.files ?? 0,
      functions: repo.stats?.functions ?? 0,
      coveredFunctions: repo.stats?.coveredFunctions ?? 0,
      loc: repo.stats?.loc ?? 0,
    },
    domains: summaries,
    readingOrder: readingOrder(summaries),
    entryPoints,
    limitations: ctx.graph.target.limitations,
    scannedAt: ctx.graph.target.scannedAt,
    tracedAt: ctx.graph.target.tracedAt,
  };
}

export interface FileRow {
  path: string;
  loc: number;
  functions: number;
  coveredFunctions: number;
  testFile: boolean;
  summary?: string;
}

export interface DomainDetail extends DomainSummary {
  fileRows: FileRow[];
  publicSurface: { id: string; summary?: string; confirmed: boolean }[];
  mostCalled: { id: string; calls: number }[];
  untestedFiles: string[];
  topEdgesOut: { from: string; to: string; confirmed: boolean }[];
}

export function domainDetail(ctx: Ctx, path: string): DomainDetail | undefined {
  const summary = domainSummaries(ctx).find((s) => s.path === path);
  if (!summary) return undefined;
  const domainId = `domain:${path}`;

  const fileNodes: GNode[] = [];
  const collect = (id: string): void => {
    for (const child of ctx.indexes.childrenOf.get(id) ?? []) {
      if (child.kind === 'file') fileNodes.push(child);
      else if (child.kind === 'domain' || child.kind === 'directory') collect(child.id);
    }
  };
  collect(domainId);

  const functionsOf = (file: GNode): GNode[] =>
    (ctx.indexes.childrenOf.get(file.id) ?? []).filter((n) => n.kind === 'function');

  const fileRows: FileRow[] = fileNodes
    .map((f) => {
      const fns = functionsOf(f);
      return {
        path: f.id.slice('file:'.length),
        loc: f.stats?.loc ?? 0,
        functions: fns.length,
        coveredFunctions: fns.filter((n) => n.runtime).length,
        testFile: f.flags?.testFile ?? false,
        summary: f.doc?.summary,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const allFns = fileNodes.flatMap(functionsOf);
  const publicSurface = allFns
    .filter((n) => n.flags?.exported)
    .map((n) => ({ id: n.id, summary: n.doc?.summary, confirmed: n.runtime !== undefined }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const mostCalled = allFns
    .filter((n) => n.runtime)
    .sort((a, b) => (b.runtime?.calls ?? 0) - (a.runtime?.calls ?? 0))
    .slice(0, 10)
    .map((n) => ({ id: n.id, calls: n.runtime!.calls }));

  const untestedFiles = fileRows
    .filter((f) => !f.testFile && f.functions > 0 && f.coveredFunctions === 0)
    .map((f) => f.path);

  const topEdgesOut = ctx.graph.edges
    .filter((e) => {
      const from = topDomainOf(ctx, e.from);
      const to = topDomainOf(ctx, e.to);
      return from?.id === domainId && to && to.id !== domainId && e.kind === 'calls';
    })
    .sort((a, b) => (b.runtime?.count ?? b.meta?.lines?.length ?? 0) - (a.runtime?.count ?? a.meta?.lines?.length ?? 0))
    .slice(0, 10)
    .map((e) => ({ from: e.from, to: e.to, confirmed: e.runtime !== undefined }));

  return { ...summary, fileRows, publicSurface, mostCalled, untestedFiles, topEdgesOut };
}

export interface EdgeStep {
  from: string;
  to: string;
  kind: GEdge['kind'];
  static: boolean;
  count?: number;
  tests?: string[];
}

function stepOf(edge: GEdge): EdgeStep {
  return {
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    static: edge.static,
    count: edge.runtime?.count,
    tests: edge.runtime?.tests?.slice(0, 5),
  };
}

export function whoCalls(ctx: Ctx, id: string, depth: number): EdgeStep[] {
  return walkEdges(ctx, id, depth, 'in');
}

export function calleesOf(ctx: Ctx, id: string, depth: number): EdgeStep[] {
  return walkEdges(ctx, id, depth, 'out');
}

function walkEdges(ctx: Ctx, id: string, depth: number, direction: 'in' | 'out'): EdgeStep[] {
  const steps: EdgeStep[] = [];
  const seen = new Set<string>([id]);
  let frontier = [id];
  for (let d = 0; d < depth && frontier.length > 0; d += 1) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const edges =
        direction === 'in'
          ? (ctx.indexes.inEdges.get(nodeId) ?? [])
          : (ctx.indexes.outEdges.get(nodeId) ?? []);
      for (const edge of edges) {
        if (edge.kind !== 'calls') continue;
        steps.push(stepOf(edge));
        const other = direction === 'in' ? edge.from : edge.to;
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
        if (steps.length >= 200) return steps;
      }
    }
    frontier = next;
  }
  return steps;
}

/** Shortest call path between two nodes, breadth-first over call edges. */
export function tracePath(ctx: Ctx, from: string, to: string): EdgeStep[] | undefined {
  const cameBy = new Map<string, GEdge>();
  let frontier = [from];
  const seen = new Set<string>([from]);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const edge of ctx.indexes.outEdges.get(nodeId) ?? []) {
        if (edge.kind !== 'calls') continue;
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        cameBy.set(edge.to, edge);
        if (edge.to === to) {
          const path: EdgeStep[] = [];
          let cursor = to;
          while (cursor !== from) {
            const step = cameBy.get(cursor)!;
            path.unshift(stepOf(step));
            cursor = step.from;
          }
          return path;
        }
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  return undefined;
}

export interface SearchHit {
  id: string;
  kind: GNode['kind'];
  name: string;
  summary?: string;
}

export function search(ctx: Ctx, query: string, kind?: GNode['kind']): SearchHit[] {
  const q = query.toLowerCase();
  const scored: { node: GNode; score: number }[] = [];
  for (const node of ctx.graph.nodes) {
    if (node.kind === 'repo') continue;
    if (kind && node.kind !== kind) continue;
    const name = node.name.toLowerCase();
    const id = node.id.toLowerCase();
    let score = 0;
    if (name === q) score = 5;
    else if (name.startsWith(q)) score = 4;
    else if (name.includes(q)) score = 3;
    else if (id.includes(q)) score = 2;
    else if (node.doc?.summary?.toLowerCase().includes(q)) score = 1;
    if (score > 0) scored.push({ node, score });
  }
  scored.sort((a, b) => b.score - a.score || a.node.name.length - b.node.name.length);
  return scored.slice(0, 25).map(({ node }) => ({
    id: node.id,
    kind: node.kind,
    name: node.name,
    summary: node.doc?.summary,
  }));
}
