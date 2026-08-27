/**
 * A squarified treemap, not a graph layout.
 *
 * Three attempts got us here. `layered` treats containment as dataflow and
 * left 85–90% of the canvas empty. `rectpacking` searches for an arrangement
 * of fixed-size boxes and got to ~21%. A treemap *subdivides* the space
 * instead of packing into it, so density is ~100% by construction — there is
 * no gap to leave. It is what NDepend, CodeScene, CodeCharta and CodeCity all
 * use, and it is the answer the software-visualisation literature settled on
 * decades ago for exactly this shape of data.
 *
 * The second, better consequence: in a treemap **area is a measurement**.
 * Box width used to be driven by the length of the node's name — noise
 * sitting in the most salient visual channel available. Now area is lines of
 * code, so a folder looks as big as it is.
 *
 * Edges are not ELK's problem and never were; React Flow draws them.
 */
import { hierarchy, treemap, treemapSquarify, type HierarchyNode } from 'd3-hierarchy';
import type { GNode } from '../../src/graph/schema.ts';
import { childrenOf, type Index, type LiftedEdge } from '../../src/graph/cut.ts';

/** Room for a container's title bar, carved off the top of its rectangle. */
const LABEL_BAR = 26;
const GAP = 6;

/**
 * Roughly how much canvas one leaf deserves. The treemap subdivides a fixed
 * rectangle, so the rectangle has to grow with the population or a large cut
 * turns everything into slivers.
 */
const AREA_PER_LEAF = 46_000;
const ASPECT = 1.6;

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
  bounds: { x: number; y: number; width: number; height: number };
  ms: number;
}

interface Datum {
  node: GNode;
  children?: Datum[];
}

/**
 * What a box's area means: lines of code, which every container already
 * carries rolled up. Functions have no line count, so their character span
 * stands in. The floor keeps a one-line file from becoming unclickable.
 */
function areaOf(node: GNode): number {
  const loc = node.stats?.loc;
  if (loc !== undefined) return Math.max(12, loc);
  if (node.span) return Math.max(12, Math.round((node.span.end - node.span.start) / 40));
  return 12;
}

export async function runLayout(
  index: Index,
  visible: ReadonlySet<string>,
  _edges: LiftedEdge[],
): Promise<LayoutResult> {
  const started = performance.now();

  let leaves = 0;
  const toDatum = (node: GNode): Datum => {
    const kids = childrenOf(index, node.id).filter((c) => visible.has(c.id));
    if (!kids.length) {
      leaves += 1;
      return { node };
    }
    return { node, children: kids.map(toDatum) };
  };

  // A virtual root so d3 has a single tree; it is never drawn.
  const virtualRoot: GNode = { id: '__root__', kind: 'repo', name: '' };
  const data: Datum = {
    node: virtualRoot,
    children: index.roots.filter((n) => visible.has(n.id)).map(toDatum),
  };

  const width = Math.round(Math.sqrt(Math.max(1, leaves) * AREA_PER_LEAF * ASPECT));
  const height = Math.round(width / ASPECT);

  const root = hierarchy<Datum>(data, (d) => d.children)
    .sum((d) => (d.children?.length ? 0 : areaOf(d.node)))
    // Biggest first, which is what makes squarify produce square-ish cells.
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  treemap<Datum>()
    .size([width, height])
    .tile(treemapSquarify)
    // Order matters: paddingOuter sets all four sides, so it has to come
    // before paddingTop or it silently wipes the title bar back to GAP.
    .paddingOuter(GAP / 2)
    .paddingInner(GAP)
    // The virtual root gets no title bar; every real container does.
    .paddingTop((d) => (d.depth === 0 ? GAP / 2 : LABEL_BAR))
    .round(true)(root);

  const nodes: PositionedNode[] = [];
  // Measured, not assumed. A container whose rectangle is smaller than its
  // own title bar gets children that spill past its edges, so the extent d3
  // actually produced can exceed the rectangle we asked it for — and framing
  // the rectangle then leaves part of the drawing off screen.
  let maxX = 0;
  let maxY = 0;
  const collect = (d3node: HierarchyNode<Datum> & { x0?: number; y0?: number; x1?: number; y1?: number }) => {
    for (const child of d3node.children ?? []) {
      const c = child as typeof d3node;
      const parentIsVirtual = d3node.depth === 0;
      maxX = Math.max(maxX, c.x1 ?? 0);
      maxY = Math.max(maxY, c.y1 ?? 0);
      nodes.push({
        id: c.data.node.id,
        node: c.data.node,
        parent: parentIsVirtual ? undefined : d3node.data.node.id,
        // d3 answers in absolutes; React Flow wants a child positioned
        // against its parent's origin.
        x: Math.round((c.x0 ?? 0) - (parentIsVirtual ? 0 : (d3node.x0 ?? 0))),
        y: Math.round((c.y0 ?? 0) - (parentIsVirtual ? 0 : (d3node.y0 ?? 0))),
        width: Math.max(1, Math.round((c.x1 ?? 0) - (c.x0 ?? 0))),
        height: Math.max(1, Math.round((c.y1 ?? 0) - (c.y0 ?? 0))),
        depth: c.depth - 1,
        isContainer: (c.children ?? []).length > 0,
      });
      collect(c);
    }
  };
  collect(root as HierarchyNode<Datum> & { x0: number; y0: number; x1: number; y1: number });

  return {
    nodes,
    bounds: {
      x: 0,
      y: 0,
      width: Math.max(width, Math.ceil(maxX)),
      height: Math.max(height, Math.ceil(maxY)),
    },
    ms: performance.now() - started,
  };
}
