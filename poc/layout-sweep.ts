/**
 * Temporary harness for tuning node placement. Reports *density* — the share
 * of the canvas that is actually a box — because "messy" here mostly means
 * whitespace between things that should sit near each other.
 *
 *   node poc/layout-sweep.ts
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import { dataDirFor, graphPathFor } from '../src/config.ts';
import type { GNode, GraphArtifact } from '../src/graph/schema.ts';
import {
  childrenOf,
  cut,
  indexGraph,
  liftEdges,
  openPassThrough,
  type Index,
  type LiftedEdge,
} from '../src/graph/cut.ts';

const target = realpathSync(resolve('../better-session-view'));
const graph = JSON.parse(readFileSync(graphPathFor(dataDirFor(target)), 'utf8')) as GraphArtifact;
const index = indexGraph(graph);
const elk = new ELK();

const leafSize = (node: GNode) => ({
  width: Math.max(64, Math.round(node.name.length * 7.2) + 26),
  height: Math.round(30 + (node.stats?.testBreadth ?? 0) * 40),
});

function build(
  visible: ReadonlySet<string>,
  edges: LiftedEdge[],
  rootOptions: Record<string, string>,
  withEdges: boolean,
  /** Hybrid: pack the containers, but lay each one out internally by flow. */
  innerLayered = false,
): ElkNode {
  // An edge can only influence ordering where both ends are siblings. Bucket
  // by the parent that owns both; everything crossing a wall is left out
  // entirely, since React Flow draws it regardless of what ELK thinks.
  const parentOf = (id: string) => index.byId.get(id)?.parent;
  const internal = new Map<string, LiftedEdge[]>();
  for (const edge of edges) {
    const p = parentOf(edge.from);
    if (!p || p !== parentOf(edge.to)) continue;
    const list = internal.get(p);
    if (list) list.push(edge);
    else internal.set(p, [edge]);
  }

  let n = 0;
  const toElk = (node: GNode): ElkNode => {
    const kids = childrenOf(index, node.id).filter((c) => visible.has(c.id));
    if (!kids.length) return { id: node.id, ...leafSize(node) };
    const own = internal.get(node.id) ?? [];
    return {
      id: node.id,
      children: kids.map(toElk),
      layoutOptions: {
        'elk.padding': '[top=30,left=12,bottom=12,right=12]',
        'elk.spacing.nodeNode': '12',
        ...(innerLayered
          ? {
              'elk.algorithm': 'layered',
              'elk.direction': 'RIGHT',
              'elk.layered.spacing.nodeNodeBetweenLayers': '26',
              'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
              'elk.layered.compaction.postCompaction.strategy': 'LEFT',
            }
          : { 'elk.layered.spacing.nodeNodeBetweenLayers': '26' }),
      },
      ...(innerLayered && own.length
        ? { edges: own.map((e) => ({ id: `i${n++}`, sources: [e.from], targets: [e.to] })) }
        : {}),
    };
  };
  const rootEdges = internal.get(index.repo?.id ?? 'repo') ?? [];
  return {
    id: 'root',
    layoutOptions: { 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', ...rootOptions },
    children: index.roots.filter((n) => visible.has(n.id)).map(toElk),
    ...(withEdges
      ? { edges: edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })) }
      : innerLayered && rootEdges.length
        ? { edges: rootEdges.map((e, i) => ({ id: `r${i}`, sources: [e.from], targets: [e.to] })) }
        : {}),
  };
}

/** Ink over canvas: how much of the picture is a box rather than a gap. */
function density(result: ElkNode): { ink: number; leaves: number } {
  let ink = 0;
  let leaves = 0;
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      if (!(c.children ?? []).length) {
        ink += (c.width ?? 0) * (c.height ?? 0);
        leaves += 1;
      }
      walk(c);
    }
  };
  walk(result);
  return { ink: ink / ((result.width ?? 1) * (result.height ?? 1)), leaves };
}

const LAYERED = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.compaction.postCompaction.strategy': 'LEFT',
  'elk.spacing.nodeNode': '14',
  'elk.layered.spacing.nodeNodeBetweenLayers': '30',
};

const variants: [string, Record<string, string>, boolean, boolean?][] = [
  ['layered RIGHT + separate comps (current)', { ...LAYERED, 'elk.separateConnectedComponents': 'true', 'elk.spacing.componentComponent': '30' }, true],
  ['layered RIGHT, comps NOT separated', { ...LAYERED, 'elk.separateConnectedComponents': 'false' }, true],
  ['layered DOWN', { ...LAYERED, 'elk.direction': 'DOWN', 'elk.separateConnectedComponents': 'false' }, true],
  ['layered RIGHT + brandes koepf', { ...LAYERED, 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.separateConnectedComponents': 'false' }, true],
  ['rectpacking (no edges)', { 'elk.algorithm': 'rectpacking', 'elk.spacing.nodeNode': '14', 'elk.aspectRatio': '1.7' }, false],
  ['box packing (no edges)', { 'elk.algorithm': 'box', 'elk.spacing.nodeNode': '14', 'elk.aspectRatio': '1.7' }, false],
  ['stress (edges)', { 'elk.algorithm': 'stress', 'elk.spacing.nodeNode': '30' }, true],
  ['mrtree (edges)', { 'elk.algorithm': 'mrtree', 'elk.spacing.nodeNode': '20' }, true],
  ['HYBRID rectpack root + layered inner', { 'elk.algorithm': 'rectpacking', 'elk.spacing.nodeNode': '14', 'elk.aspectRatio': '1.7' }, false, true],
  ['HYBRID box root + layered inner', { 'elk.algorithm': 'box', 'elk.spacing.nodeNode': '14', 'elk.aspectRatio': '1.7' }, false, true],
];

const cuts: [string, Set<string>][] = [
  ['overview', new Set<string>()],
  ['visuals open', new Set(['domain:visuals'])],
  ['visuals + server', new Set(['domain:visuals', 'dir:visuals/server'])],
];

for (const [cutName, seed] of cuts) {
  const openSet = openPassThrough(index, new Set(seed));
  const visible = cut(index, openSet);
  const edges = liftEdges(graph, index, visible);
  console.log(`\n=== ${cutName}: ${visible.size} nodes, ${edges.length} edges ===`);
  console.log('  variant'.padEnd(44), 'ms'.padStart(5), 'canvas'.padStart(12), 'aspect'.padStart(7), 'density'.padStart(8));
  for (const [label, options, withEdges, innerLayered] of variants) {
    const started = performance.now();
    try {
      const result = await elk.layout(build(visible, edges, options, withEdges, innerLayered));
      const ms = performance.now() - started;
      const { ink } = density(result);
      console.log(
        '  ' + label.padEnd(42),
        ms.toFixed(0).padStart(5),
        `${Math.round(result.width ?? 0)}x${Math.round(result.height ?? 0)}`.padStart(12),
        ((result.width ?? 1) / (result.height ?? 1)).toFixed(2).padStart(7),
        `${(ink * 100).toFixed(1)}%`.padStart(8),
      );
    } catch (err) {
      console.log('  ' + label.padEnd(42), '  FAILED', String(err).slice(0, 46));
    }
  }
}
