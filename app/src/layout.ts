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
  /**
   * The real extent of the drawing, measured from the top-level boxes rather
   * than taken from ELK's root size — under rectpacking the two disagree,
   * and framing the wrong one leaves half the picture off screen.
   */
  bounds: { x: number; y: number; width: number; height: number };
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

/**
 * Packing, not layering.
 *
 * `layered` gives one layer per call-chain step, which reads beautifully for
 * a handful of nodes and turns into scattered islands separated by corridors
 * of nothing as soon as a folder opens. Measured across three real cuts it
 * left 85–90% of the canvas empty. `rectpacking` fills 21–24% — roughly
 * 1.7x the ink, in a third of the time — because it is solving the problem
 * we actually have here, which is "arrange these boxes tidily", not "route
 * this dataflow".
 *
 * The trade is that packing ignores edges, so nothing orders left-to-right
 * by dependency any more. That is affordable precisely because React Flow
 * draws the edges itself: the connections are still all there to follow, they
 * just no longer dictate where a box sits. A hybrid — packed root, layered
 * insides — measured *worse* than either, because the sprawl was coming from
 * layering within the containers rather than between them.
 */
export async function runLayout(
  index: Index,
  visible: ReadonlySet<string>,
  _edges: LiftedEdge[],
): Promise<LayoutResult> {
  const packing = {
    'elk.algorithm': 'rectpacking',
    'elk.spacing.nodeNode': '12',
    'elk.aspectRatio': '1.7',
    'elk.rectpacking.packing.strategy': 'MAX_SCALE_DRIVEN',
    'elk.contentAlignment': 'H_LEFT V_TOP',
  };

  const toElk = (node: GNode): ElkNode => {
    const kids = childrenOf(index, node.id).filter((c) => visible.has(c.id));
    if (!kids.length) return { id: node.id, ...leafSize(node) };
    return {
      id: node.id,
      children: kids.map(toElk),
      layoutOptions: {
        ...packing,
        'elk.padding': `[top=${LABEL_BAR},left=12,bottom=12,right=12]`,
      },
    };
  };

  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      ...packing,
      'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
      'elk.spacing.nodeNode': '14',
    },
    children: index.roots.filter((n) => visible.has(n.id)).map(toElk),
    // No edges handed to ELK at all: rectpacking cannot route them, and
    // giving it edges it cannot honour is how the UnsupportedGraphException
    // shows up. React Flow is the one drawing them.
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

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of nodes) {
    if (box.parent) continue; // top level only; children are inside these
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  const bounds = nodes.length
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : { x: 0, y: 0, width: 1, height: 1 };

  return { nodes, bounds, ms };
}
