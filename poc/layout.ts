/**
 * ELK does the part we are never writing ourselves: cycle breaking, layer
 * assignment, crossing minimisation, node placement, and — the rare one —
 * routing edges that cross container boundaries while sizing each container
 * around its children.
 *
 * ELK answers in parent-relative coordinates. We flatten to absolute here
 * because SVG wants absolute; React Flow will want the nested form back, so
 * `positioned` keeps the parent link rather than throwing it away.
 */
import ELK from 'elkjs';
import type { ElkNode } from 'elkjs';
import type { GNode } from '../src/graph/schema.ts';
import { childrenOf, type Index, type LiftedEdge } from '../src/graph/cut.ts';

export interface Box {
  id: string;
  node: GNode;
  parent?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Nesting depth in the drawn cut, 0 for top level. */
  depth: number;
  isContainer: boolean;
}

export interface Route {
  edge: LiftedEdge;
  points: { x: number; y: number }[];
  /**
   * True when we routed this ourselves because ELK declined to. Under
   * SEPARATE_CHILDREN it only routes edges whose endpoints are siblings, so a
   * cross-container call comes back with no sections at all. Drawing a plain
   * elbow keeps the edge honest; the flag lets the renderer admit it is not
   * a real route.
   */
  approximate?: boolean;
}

export interface Layout {
  boxes: Box[];
  routes: Route[];
  width: number;
  height: number;
  ms: number;
}

const CHAR_WIDTH = 7.1;
const LEAF_HEIGHT = 26;
const LABEL_BAR = 26;

/**
 * Height carries importance: a node touched by half the suite stands up off
 * the page next to one touched by nothing. Width still has to fit the name,
 * so importance is the only thing height means.
 */
function leafSize(node: GNode): { width: number; height: number } {
  const breadth = node.stats?.testBreadth ?? 0;
  return {
    width: Math.max(56, Math.round(node.name.length * CHAR_WIDTH) + 22),
    height: Math.round(LEAF_HEIGHT + breadth * 44),
  };
}

export interface LayoutOptions {
  direction?: 'RIGHT' | 'DOWN';
  edgeRouting?: 'ORTHOGONAL' | 'POLYLINE' | 'SPLINES';
  /**
   * Layered layouts get one layer per call-chain step, so a deep graph comes
   * out absurdly wide. Wrapping cuts the drawing into stacked bands instead.
   */
  wrapping?: 'OFF' | 'SINGLE_EDGE' | 'MULTI_EDGE';
  aspectRatio?: number;
  /**
   * INCLUDE_CHILDREN lays the whole tree out in one global pass, so a
   * container ends up as wide as the deepest call chain running through it.
   * SEPARATE_CHILDREN lays each container out on its own and packs the
   * results, which is far more compact but routes cross-container edges to
   * the boundary rather than to the exact node.
   */
  hierarchy?: 'INCLUDE_CHILDREN' | 'SEPARATE_CHILDREN';
}

export async function layout(
  index: Index,
  visible: ReadonlySet<string>,
  edges: LiftedEdge[],
  options: LayoutOptions = {},
): Promise<Layout> {
  const {
    direction = 'RIGHT',
    edgeRouting = 'ORTHOGONAL',
    wrapping = 'OFF',
    aspectRatio,
    hierarchy = 'INCLUDE_CHILDREN',
  } = options;

  const toElk = (node: GNode): ElkNode => {
    const kids = childrenOf(index, node.id).filter((c) => visible.has(c.id));
    if (!kids.length) return { id: node.id, ...leafSize(node) };
    return {
      id: node.id,
      children: kids.map(toElk),
      layoutOptions: {
        // Top padding is the container's own name tag.
        'elk.padding': `[top=${LABEL_BAR},left=11,bottom=11,right=11]`,
        'elk.spacing.nodeNode': '11',
        'elk.layered.spacing.nodeNodeBetweenLayers': '24',
      },
    };
  };

  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      // The rare capability: edges that cross container walls get routed,
      // and parents are sized around their children.
      'elk.hierarchyHandling': hierarchy,
      'elk.edgeRouting': edgeRouting,
      // Without this, an edge is *stored* on root but its coordinates are
      // relative to the lowest common ancestor of its endpoints — so every
      // intra-container edge comes back offset by its container's position.
      // ROOT makes every section absolute. (React Flow will want PARENT.)
      'elk.json.edgeCoords': 'ROOT',
      // NETWORK_SIMPLEX packs tighter than BRANDES_KOEPF here, and post
      // compaction claws back the whitespace layered layouts leave behind.
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.compaction.postCompaction.strategy': 'LEFT',
      'elk.layered.mergeEdges': 'true',
      'elk.spacing.nodeNode': '12',
      'elk.layered.spacing.nodeNodeBetweenLayers': '24',
      'elk.spacing.edgeNode': '8',
      'elk.spacing.edgeEdge': '5',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '28',
      ...(wrapping === 'OFF'
        ? {}
        : {
            'elk.layered.wrapping.strategy': wrapping,
            'elk.layered.wrapping.additionalEdgeSpacing': '12',
          }),
      ...(aspectRatio ? { 'elk.aspectRatio': String(aspectRatio) } : {}),
    },
    children: index.roots.filter((n) => visible.has(n.id)).map(toElk),
    edges: edges.map((edge, i) => ({
      id: `e${i}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
  };

  const started = performance.now();
  const result = await new ELK().layout(root);
  const ms = performance.now() - started;

  // Flatten: a child's x/y is relative to its parent's origin. Edges need no
  // such accumulation — edgeCoords=ROOT already answered them in absolutes.
  const boxes: Box[] = [];
  const routes: Route[] = [];

  const walk = (elk: ElkNode, parentId: string | undefined, ox: number, oy: number, depth: number) => {
    const kids = elk.children ?? [];
    for (const child of kids) {
      const x = ox + (child.x ?? 0);
      const y = oy + (child.y ?? 0);
      const node = index.byId.get(child.id);
      if (node) {
        boxes.push({
          id: child.id,
          node,
          parent: parentId,
          x,
          y,
          width: child.width ?? 0,
          height: child.height ?? 0,
          depth,
          isContainer: (child.children ?? []).length > 0,
        });
      }
      walk(child, child.id, x, y, depth + 1);
    }
    // edgeCoords=ROOT above means sections are already absolute; an edge can
    // still be stored on any node, so we collect them wherever they appear.
    for (const edge of elk.edges ?? []) {
      const lifted = edges[Number(edge.id.slice(1))];
      if (!lifted) continue;
      for (const section of edge.sections ?? []) {
        routes.push({
          edge: lifted,
          points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
            .map((p) => ({ x: p.x, y: p.y })),
        });
      }
    }
  };
  walk(result, undefined, 0, 0, 0);

  // Whatever ELK declined to route, we route — an edge that exists in the
  // data must appear on screen, even as an approximation.
  const routedEdges = new Set(routes.map((r) => r.edge));
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  for (const edge of edges) {
    if (routedEdges.has(edge)) continue;
    const from = boxById.get(edge.from);
    const to = boxById.get(edge.to);
    if (!from || !to) continue;
    routes.push({ edge, points: elbow(from, to), approximate: true });
  }

  return { boxes, routes, width: result.width ?? 0, height: result.height ?? 0, ms };
}

/** A three-segment orthogonal connector between the facing sides of two boxes. */
function elbow(a: Box, b: Box): { x: number; y: number }[] {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const start = { x: dx >= 0 ? a.x + a.width : a.x, y: ac.y };
    const end = { x: dx >= 0 ? b.x : b.x + b.width, y: bc.y };
    const mid = (start.x + end.x) / 2;
    return [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end];
  }
  const start = { x: ac.x, y: dy >= 0 ? a.y + a.height : a.y };
  const end = { x: bc.x, y: dy >= 0 ? b.y : b.y + b.height };
  const mid = (start.y + end.y) / 2;
  return [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end];
}
