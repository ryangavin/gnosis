/**
 * ELK positions, React Flow draws.
 *
 * The static POC had to flatten ELK's answer to absolutes because SVG wanted
 * them. React Flow wants the opposite — a child's position relative to its
 * parent, which is exactly what ELK already returns — so the flatten is gone
 * and the nested result passes through nearly untouched.
 *
 * Only nodes come from ELK. Edges are handed to React Flow directly and it
 * routes them itself, which sidesteps both problems the POC hit: no edge
 * coordinate system to get wrong, and no edges silently dropped when
 * SEPARATE_CHILDREN declines to route across a container wall. That leaves
 * SEPARATE_CHILDREN usable purely for its compactness — measured at 7.5x
 * smaller and 6x faster than laying the whole tree out in one pass.
 */
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { GNode } from '../../src/graph/schema.ts';
import { childrenOf, type Index, type LiftedEdge } from '../../src/graph/cut.ts';

const elk = new ELK();

const CHAR_WIDTH = 7.2;
const LEAF_HEIGHT = 30;
const LABEL_BAR = 30;

export interface PositionedNode {
  id: string;
  node: GNode;
  parent?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  isContainer: boolean;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  width: number;
  height: number;
  ms: number;
}

/** Height carries importance; width only has to fit the name. */
function leafSize(node: GNode): { width: number; height: number } {
  const breadth = node.stats?.testBreadth ?? 0;
  return {
    width: Math.max(64, Math.round(node.name.length * CHAR_WIDTH) + 26),
    height: Math.round(LEAF_HEIGHT + breadth * 40),
  };
}

export async function runLayout(
  index: Index,
  visible: ReadonlySet<string>,
  edges: LiftedEdge[],
): Promise<LayoutResult> {
  const toElk = (node: GNode): ElkNode => {
    const kids = childrenOf(index, node.id).filter((c) => visible.has(c.id));
    if (!kids.length) return { id: node.id, ...leafSize(node) };
    return {
      id: node.id,
      children: kids.map(toElk),
      layoutOptions: {
        'elk.padding': `[top=${LABEL_BAR},left=12,bottom=12,right=12]`,
        'elk.spacing.nodeNode': '12',
        'elk.layered.spacing.nodeNodeBetweenLayers': '26',
      },
    };
  };

  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.compaction.postCompaction.strategy': 'LEFT',
      'elk.spacing.nodeNode': '14',
      'elk.layered.spacing.nodeNodeBetweenLayers': '30',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '30',
    },
    children: index.roots.filter((n) => visible.has(n.id)).map(toElk),
    // ELK still needs the edges to order the layers sensibly, even though it
    // is not the one drawing them.
    edges: edges.map((edge, i) => ({ id: `e${i}`, sources: [edge.from], targets: [edge.to] })),
  };

  const started = performance.now();
  const result = await elk.layout(root);
  const ms = performance.now() - started;

  const nodes: PositionedNode[] = [];
  const walk = (elkNode: ElkNode, parent: string | undefined, depth: number) => {
    for (const child of elkNode.children ?? []) {
      const node = index.byId.get(child.id);
      if (node) {
        nodes.push({
          id: child.id,
          node,
          parent,
          // Already parent-relative. This is the line the POC had to fight.
          x: child.x ?? 0,
          y: child.y ?? 0,
          width: child.width ?? 0,
          height: child.height ?? 0,
          depth,
          isContainer: (child.children ?? []).length > 0,
        });
      }
      walk(child, child.id, depth + 1);
    }
  };
  walk(result, undefined, 0);

  return { nodes, width: result.width ?? 0, height: result.height ?? 0, ms };
}
