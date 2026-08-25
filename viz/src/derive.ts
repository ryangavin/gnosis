/**
 * Semantic zoom, owned by gnosis rather than a cytoscape extension: given
 * the artifact and the set of expanded node ids, derive exactly the
 * elements to render. A node is shown iff every ancestor is expanded; every
 * underlying call/import edge is re-homed to each endpoint's deepest
 * visible ancestor; parallel re-homed edges aggregate into one meta-edge.
 * Pure and unit-tested — the cytoscape layer just renders the result.
 */
import type { GraphArtifact, GNode } from '../../src/graph/schema.ts';

export interface VisibleNode {
  id: string;
  label: string;
  kind: GNode['kind'];
  parent?: string;
  /** Rendered as a compound holding visible children. */
  open: boolean;
  /** Has children it could show. */
  expandable: boolean;
  domainHue: number;
  confirmed: boolean;
  reactComponent: boolean;
  testFile: boolean;
  exported: boolean;
}

export interface VisibleEdge {
  id: string;
  source: string;
  target: string;
  calls: number;
  imports: number;
  runtime: number;
  jsx: boolean;
}

export interface DerivedView {
  nodes: VisibleNode[];
  edges: VisibleEdge[];
  /** Total visible elements, for the soft cap. */
  size: number;
}

export interface DeriveOptions {
  showTests: boolean;
}

export function deriveView(
  graph: GraphArtifact,
  expanded: Set<string>,
  options: DeriveOptions,
): DerivedView {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, GNode[]>();
  for (const node of graph.nodes) {
    if (!node.parent) continue;
    const list = childrenOf.get(node.parent) ?? [];
    list.push(node);
    childrenOf.set(node.parent, list);
  }

  const hidden = (node: GNode): boolean => {
    if (options.showTests) return false;
    if (node.flags?.testFile) return true;
    if (node.kind === 'function') {
      const file = byId.get(node.parent ?? '');
      return file?.flags?.testFile ?? false;
    }
    return false;
  };

  const domainHues = new Map<string, number>();
  const topDomains = (childrenOf.get('repo') ?? []).filter((n) => n.kind === 'domain');
  topDomains.forEach((d, i) => domainHues.set(d.id, (i * 47) % 360));

  const hueFor = (node: GNode): number => {
    let current: GNode | undefined = node;
    while (current) {
      const hue = domainHues.get(current.id);
      if (hue !== undefined) return hue;
      current = current.parent ? byId.get(current.parent) : undefined;
    }
    return 0;
  };

  // Visible set: descend from repo through expanded nodes.
  const visible = new Map<string, VisibleNode>();
  const walk = (node: GNode, parentVisible: string | undefined): void => {
    if (hidden(node)) return;
    const children = (childrenOf.get(node.id) ?? []).filter((c) => !hidden(c));
    const open = expanded.has(node.id) && children.length > 0;
    visible.set(node.id, {
      id: node.id,
      label: node.name,
      kind: node.kind,
      parent: parentVisible,
      open,
      expandable: children.length > 0,
      domainHue: hueFor(node),
      confirmed: node.runtime !== undefined,
      reactComponent: node.flags?.reactComponent ?? false,
      testFile: node.flags?.testFile ?? false,
      exported: node.flags?.exported ?? false,
    });
    if (open) for (const child of children) walk(child, node.id);
  };
  for (const domain of childrenOf.get('repo') ?? []) walk(domain, undefined);

  // Deepest visible ancestor per underlying endpoint. A hidden endpoint
  // (a test file while tests are off) drops its edges entirely — climbing
  // past it would pin edges onto the enclosing compound as arcs.
  const repCache = new Map<string, string | undefined>();
  const representative = (id: string): string | undefined => {
    if (repCache.has(id)) return repCache.get(id);
    const chain: string[] = [];
    let current = byId.get(id);
    let dropped = false;
    while (current && current.id !== 'repo') {
      if (hidden(current)) dropped = true;
      chain.push(current.id);
      current = current.parent ? byId.get(current.parent) : undefined;
    }
    let rep: string | undefined;
    if (!dropped) {
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        if (visible.has(chain[i]!)) rep = chain[i]!;
        else break;
      }
    }
    repCache.set(id, rep);
    return rep;
  };

  const isAncestorOf = (maybeAncestor: string, id: string): boolean => {
    let current = byId.get(id);
    while (current?.parent) {
      if (current.parent === maybeAncestor) return true;
      current = byId.get(current.parent);
    }
    return false;
  };

  const edgeMap = new Map<string, VisibleEdge>();
  for (const edge of graph.edges) {
    const source = representative(edge.from);
    const target = representative(edge.to);
    if (!source || !target || source === target) continue;
    if (isAncestorOf(source, target) || isAncestorOf(target, source)) continue;
    const key = `${source}→${target}`;
    let agg = edgeMap.get(key);
    if (!agg) {
      agg = { id: key, source, target, calls: 0, imports: 0, runtime: 0, jsx: false };
      edgeMap.set(key, agg);
    }
    if (edge.kind === 'calls') agg.calls += 1;
    else agg.imports += 1;
    if (edge.runtime) agg.runtime += 1;
    if (edge.meta?.jsx) agg.jsx = true;
  }

  const nodes = [...visible.values()];
  const edges = [...edgeMap.values()];
  return { nodes, edges, size: nodes.length + edges.length };
}

/** All ancestor ids that must be expanded for `id` to be visible. */
export function ancestorsToExpand(graph: GraphArtifact, id: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  let current = byId.get(id);
  current = current?.parent ? byId.get(current.parent) : undefined;
  while (current && current.id !== 'repo') {
    out.push(current.id);
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return out;
}
