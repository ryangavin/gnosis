/**
 * The two rules that make a compound graph readable: render a *cut* through
 * the hierarchy rather than the whole tree, and *lift* every edge to the
 * nearest visible ancestor of each endpoint.
 *
 * Nothing here knows about ELK or about rendering — this is the part that
 * survives whatever we draw with. `open` is the only state the UI owns.
 */
import type { GEdge, GNode, GraphArtifact, NodeKind } from '../src/graph/schema.ts';

export interface Index {
  byId: Map<string, GNode>;
  children: Map<string, GNode[]>;
  /** The repo node, if the graph has one; its children are the top level. */
  repo?: GNode;
  roots: GNode[];
}

export function indexGraph(graph: GraphArtifact): Index {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, GNode[]>();
  for (const node of graph.nodes) {
    if (!node.parent) continue;
    const siblings = children.get(node.parent);
    if (siblings) siblings.push(node);
    else children.set(node.parent, [node]);
  }
  const repo = graph.nodes.find((n) => n.kind === 'repo');
  const roots = repo ? (children.get(repo.id) ?? []) : graph.nodes.filter((n) => !n.parent);
  return { byId, children, repo, roots };
}

export function childrenOf(index: Index, id: string): GNode[] {
  return index.children.get(id) ?? [];
}

/** Is this node a test file, or anything declared inside one? */
export function isTestNode(index: Index, id: string): boolean {
  let node = index.byId.get(id);
  while (node && node.kind !== 'file') node = node.parent ? index.byId.get(node.parent) : undefined;
  return node?.flags?.testFile === true;
}

/**
 * The visible set. A node is drawn when its parent is open; its own children
 * are drawn only when it too is open. The repo node is implicitly open — we
 * never draw a box around the whole world.
 *
 * Tests are excluded by default. A test is an *observation* of the code, not
 * a peer of it: drawing it as a sibling box doubles the population of half
 * the folders and adds arrows that are not architectural dependencies. What
 * the test node was saying — "this code is exercised" — is already carried
 * on the code node as coverage, which is why nothing is lost by hiding it.
 */
export function cut(
  index: Index,
  open: ReadonlySet<string>,
  options: { includeTests?: boolean } = {},
): Set<string> {
  const visible = new Set<string>();
  const walk = (nodes: GNode[]) => {
    for (const node of nodes) {
      if (!options.includeTests && node.flags?.testFile) continue;
      visible.add(node.id);
      if (open.has(node.id)) walk(childrenOf(index, node.id));
    }
  };
  walk(index.roots);
  return visible;
}

/** Expand every container down to (and including) the given kind. */
export function openToDepth(index: Index, leaf: NodeKind): Set<string> {
  const open = new Set<string>();
  const walk = (nodes: GNode[]) => {
    for (const node of nodes) {
      if (node.kind === leaf) continue;
      open.add(node.id);
      walk(childrenOf(index, node.id));
    }
  };
  walk(index.roots);
  return open;
}

/**
 * A container holding exactly one child container and nothing else draws a
 * box that says nothing — `visuals` wrapping only `src` wrapping only
 * `render`. Opening those chains costs no legibility and buys a level.
 */
export function openPassThrough(index: Index, open: Set<string>): Set<string> {
  const walk = (nodes: GNode[]) => {
    for (const node of nodes) {
      const kids = childrenOf(index, node.id);
      if (kids.length === 1 && kids[0]!.kind !== 'function' && childrenOf(index, kids[0]!.id).length) {
        open.add(node.id);
      }
      if (open.has(node.id)) walk(kids);
    }
  };
  walk(index.roots);
  return open;
}

/**
 * How much this node matters, 0..1 — the share of the test suite that
 * reaches it. Absent means no trace run has confirmed it at all, which is a
 * different thing from "reached by zero tests" and reads differently.
 */
export function importanceOf(node: GNode): number | undefined {
  return node.stats?.testBreadth;
}

/** The nearest ancestor-or-self that is being drawn. */
function liftTo(index: Index, id: string, visible: ReadonlySet<string>): string | undefined {
  let node = index.byId.get(id);
  while (node && !visible.has(node.id)) {
    node = node.parent ? index.byId.get(node.parent) : undefined;
  }
  return node?.id;
}

function isAncestor(index: Index, ancestor: string, of: string): boolean {
  let node = index.byId.get(of);
  while (node?.parent) {
    if (node.parent === ancestor) return true;
    node = index.byId.get(node.parent);
  }
  return false;
}

export interface LiftedEdge {
  from: string;
  to: string;
  kind: GEdge['kind'];
  /** How many underlying edges collapsed into this one. */
  fanIn: number;
  /** Summed runtime call count; 0 means no test run ever observed it. */
  calls: number;
  /** True when at least one underlying edge was seen by the static analyzer. */
  static: boolean;
}

/**
 * Every edge, lifted to the visible cut and aggregated. Self-loops and
 * containment-implied edges (a child pointing at its own ancestor box) are
 * dropped — they carry no information the nesting doesn't already show.
 *
 * By default an import edge is also dropped when the same pair already has a
 * call edge: it draws a second line saying something weaker than the first.
 * On a real cut that removed 161 of 453 edges and a third of the canvas.
 */
export function liftEdges(
  graph: GraphArtifact,
  index: Index,
  visible: ReadonlySet<string>,
  options: { keepRedundantImports?: boolean; includeTests?: boolean } = {},
): LiftedEdge[] {
  const merged = new Map<string, LiftedEdge>();
  for (const edge of graph.edges) {
    // Dropped, never lifted. Lifting `lab.test.ts → lab.ts` to the hidden
    // test's parent folder would invent a `server → lab.ts` dependency that
    // does not exist — a phantom arrow between two real boxes is worse than
    // a missing one.
    if (!options.includeTests && (isTestNode(index, edge.from) || isTestNode(index, edge.to))) {
      continue;
    }
    const from = liftTo(index, edge.from, visible);
    const to = liftTo(index, edge.to, visible);
    if (!from || !to || from === to) continue;
    if (isAncestor(index, from, to) || isAncestor(index, to, from)) continue;

    const key = `${edge.kind}|${from}|${to}`;
    const existing = merged.get(key);
    if (existing) {
      existing.fanIn += 1;
      existing.calls += edge.runtime?.count ?? 0;
      existing.static ||= edge.static;
    } else {
      merged.set(key, {
        from,
        to,
        kind: edge.kind,
        fanIn: 1,
        calls: edge.runtime?.count ?? 0,
        static: edge.static,
      });
    }
  }
  const lifted = [...merged.values()];
  if (options.keepRedundantImports) return lifted;

  const callPairs = new Set(
    lifted.filter((e) => e.kind === 'calls').map((e) => `${e.from}|${e.to}`),
  );
  return lifted.filter((e) => e.kind === 'calls' || !callPairs.has(`${e.from}|${e.to}`));
}

/** Domain identity for color: the top-level ancestor a node belongs to. */
export function domainOf(index: Index, id: string): string | undefined {
  let node = index.byId.get(id);
  const topLevel = new Set(index.roots.map((r) => r.id));
  while (node) {
    if (topLevel.has(node.id)) return node.id;
    node = node.parent ? index.byId.get(node.parent) : undefined;
  }
  return undefined;
}
