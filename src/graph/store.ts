/**
 * Persistence and in-memory indexes for the graph artifact. One
 * pretty-printed JSON file per target; every consumer loads the whole
 * graph and works from these indexes. Swapping the storage later only
 * touches this file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { GEdge, GNode, GraphArtifact } from './schema.ts';

export function loadGraph(path: string): GraphArtifact {
  return JSON.parse(readFileSync(path, 'utf8')) as GraphArtifact;
}

export function saveGraph(path: string, graph: GraphArtifact): void {
  writeFileSync(path, JSON.stringify(graph, null, 1));
}

export interface GraphIndexes {
  byId: Map<string, GNode>;
  childrenOf: Map<string, GNode[]>;
  inEdges: Map<string, GEdge[]>;
  outEdges: Map<string, GEdge[]>;
}

export function buildIndexes(graph: GraphArtifact): GraphIndexes {
  const byId = new Map<string, GNode>();
  const childrenOf = new Map<string, GNode[]>();
  const inEdges = new Map<string, GEdge[]>();
  const outEdges = new Map<string, GEdge[]>();

  for (const node of graph.nodes) {
    byId.set(node.id, node);
    if (node.parent) {
      const siblings = childrenOf.get(node.parent) ?? [];
      siblings.push(node);
      childrenOf.set(node.parent, siblings);
    }
  }
  for (const edge of graph.edges) {
    const outs = outEdges.get(edge.from) ?? [];
    outs.push(edge);
    outEdges.set(edge.from, outs);
    const ins = inEdges.get(edge.to) ?? [];
    ins.push(edge);
    inEdges.set(edge.to, ins);
  }
  return { byId, childrenOf, inEdges, outEdges };
}

/** Walk up the parent chain to the enclosing node of the given kind. */
export function ancestorOfKind(
  indexes: GraphIndexes,
  id: string,
  kind: GNode['kind'],
): GNode | undefined {
  let current = indexes.byId.get(id);
  while (current) {
    if (current.kind === kind) return current;
    current = current.parent ? indexes.byId.get(current.parent) : undefined;
  }
  return undefined;
}
