/**
 * The whole app: a cut through the graph, laid out as a treemap, drawn by
 * React Flow. `open` is the only state that matters — everything else is
 * derived from it, so expanding a folder is one set mutation and a relayout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GNode, GraphArtifact } from '../../src/graph/schema.ts';
import {
  childrenOf,
  cut,
  domainOf,
  indexGraph,
  liftEdges,
  openPassThrough,
  type Index,
  type LiftedEdge,
} from '../../src/graph/cut.ts';
import { runLayout } from './layout.ts';
import { nodeTypes, type NodeData } from './GraphNode.tsx';
import { Inspector } from './Inspector.tsx';

/** Golden angle, so adjacent domains never land on neighbouring colours. */
const hueFor = (i: number) => Math.round((i * 137.508) % 360);

function edgeStyle(edge: LiftedEdge): React.CSSProperties {
  if (edge.kind === 'imports') return { strokeDasharray: '1 5', strokeOpacity: 0.22, strokeWidth: 1 };
  if (edge.calls > 0) {
    return { strokeOpacity: 0.6, strokeWidth: Math.min(3.5, 0.8 + Math.log10(edge.calls + 1)) };
  }
  return { strokeDasharray: '5 4', strokeOpacity: 0.32, strokeWidth: 1 };
}

function Graph({ graph }: { graph: GraphArtifact }) {
  const index = useMemo(() => indexGraph(graph), [graph]);
  const hueOf = useMemo(() => {
    const order = new Map(index.roots.map((r, i) => [r.id, i]));
    return (id: string) => {
      const domain = domainOf(index, id);
      return domain === undefined ? 220 : hueFor(order.get(domain) ?? 0);
    };
  }, [index]);

  const [open, setOpen] = useState<Set<string>>(() => openPassThrough(index, new Set()));
  const [selected, setSelected] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [lifted, setLifted] = useState<LiftedEdge[]>([]);
  const [ms, setMs] = useState(0);
  const [busy, setBusy] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [frame, setFrame] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const { setViewport } = useReactFlow();
  const stageRef = useRef<HTMLDivElement>(null);
  const run = useRef(0);
  // Held in a ref so the layout effect never depends on it — the callback
  // baked into node data must not be what triggers a relayout.
  const toggleRef = useRef<(id: string) => void>(() => {});

  useEffect(() => {
    const ticket = ++run.current;
    setBusy(true);
    const visible = cut(index, open);
    const liftedEdges = liftEdges(graph, index, visible);

    runLayout(index, visible, liftedEdges).then((result) => {
      if (ticket !== run.current) return; // a newer expand already landed

      // Parents must precede children, or React Flow cannot resolve parentId.
      const ordered = [...result.nodes].sort((a, b) => a.depth - b.depth);
      setNodes(
        ordered.map((box) => ({
          id: box.id,
          type: box.isContainer ? 'container' : 'leaf',
          position: { x: box.x, y: box.y },
          ...(box.parent ? { parentId: box.parent, extent: 'parent' as const } : {}),
          // Both, so React Flow can measure without waiting on a resize pass.
          width: box.width,
          height: box.height,
          style: { width: box.width, height: box.height },
          draggable: false,
          data: {
            node: box.node,
            hue: hueOf(box.id),
            open: open.has(box.id),
            hasChildren: childrenOf(index, box.id).length > 0,
            dimmed: false,
            onToggle: toggleRef.current,
          } satisfies NodeData,
        })),
      );
      setLifted(liftedEdges);
      setMs(result.ms);
      setBusy(false);
      setFrame(result.bounds);
    });
  }, [graph, index, open, hueOf]);

  /**
   * Framing, computed rather than delegated.
   *
   * Three things had to go. `fitView` measures the DOM and runs a frame
   * behind a relayout, so it framed the previous cut. `fitBounds` applied
   * once and then ignored every later call. And `setViewport`'s own
   * `duration` option is a silent no-op when the pane's zoom behaviour is
   * not ready yet — which it is not on first paint, so the very call that
   * sets the opening view did nothing.
   *
   * What is left is arithmetic: the stage size is known, the treemap reports
   * its exact extent, and the transform follows. Applied instantly: a CSS
   * transition on the viewport fights React Flow for the same property and
   * leaves the computed transform stuck at identity.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!frame || !stage) return;
    const { width: vw, height: vh } = stage.getBoundingClientRect();
    if (!vw || !vh) return;

    const margin = 0.94;
    const zoom = Math.min((vw * margin) / frame.width, (vh * margin) / frame.height);
    setViewport({
      x: (vw - frame.width * zoom) / 2 - frame.x * zoom,
      y: (vh - frame.height * zoom) / 2 - frame.y * zoom,
      zoom,
    });
  }, [frame, setViewport]);

  /**
   * Sourcetrail's rule: never draw the whole graph. With nothing selected you
   * get structure and coverage — which is what "read the architecture"
   * actually wants — and picking a box brings up only the edges touching it.
   * Drawing every relation at every level is what makes a dense cut
   * unreadable, and no amount of routing fixes that.
   *
   * `showAll` puts the hairball back when you want to judge density.
   */
  const edges = useMemo<Edge[]>(() => {
    const shown = showAll
      ? lifted
      : selected === null
        ? []
        : lifted.filter((e) => e.from === selected || e.to === selected);

    return shown.map((edge) => {
      const focused = selected !== null && (edge.from === selected || edge.to === selected);
      const base = edgeStyle(edge);
      return {
        id: `${edge.kind}|${edge.from}|${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: 'smoothstep',
        style: {
          stroke: focused ? '#eaf2ff' : `hsl(${hueOf(edge.from)} 62% 72%)`,
          ...base,
          strokeOpacity: focused ? 0.95 : base.strokeOpacity,
          strokeWidth: focused ? Math.max(2, Number(base.strokeWidth) || 1) : base.strokeWidth,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: focused ? '#eaf2ff' : '#8b98ab',
        },
        // No zIndex: setting one lifts the edge into a layer above the nodes,
        // where it paints over the controls. And every edge carries a 20px
        // invisible hit path by default, which swallowed clicks aimed at
        // whatever sat underneath. We never click an edge.
        interactionWidth: 0,
        focusable: false,
      };
    });
  }, [lifted, selected, hueOf, showAll]);

  const toggle = useCallback(
    (id: string) => {
      if (!childrenOf(index, id).length) return;
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          // Collapsing takes the whole subtree with it, or reopening the
          // parent would spring the old depth back unasked.
          for (const openId of next) if (openId === id || openId.startsWith(`${id}/`)) next.delete(openId);
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    },
    [index],
  );
  toggleRef.current = toggle;

  // Opening is easy, closing is deliberate. A collapsed box opens anywhere
  // you hit it — a big target, nothing to aim at. An open container closes
  // only from its title bar, so that brushing its background while reading
  // what is inside does not fold the whole thing away.
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelected(node.id);
      if (!open.has(node.id)) toggle(node.id); // no-op for a childless leaf
    },
    [toggle, open],
  );

  const selectedNode: GNode | null = selected ? (index.byId.get(selected) ?? null) : null;
  const nameOf = useCallback((id: string) => index.byId.get(id)?.name ?? id, [index]);
  const folders = nodes.filter((n) => n.type === 'container').length;

  return (
    <>
      <header className="topbar">
        <b>{graph.target.name}</b>
        <span>
          <em>{nodes.length}</em> of {graph.nodes.length} nodes
        </span>
        <span>
          <em>{folders}</em> folders open
        </span>
        <span>
          <em>{edges.length}</em> of {lifted.length} edges
        </span>
        <span>
          suite <em>{graph.target.testFileCount ?? 0}</em> files
        </span>
        <span className={busy ? 'busy' : ''}>layout <em>{ms.toFixed(1)} ms</em></span>
        <span className="hint">click a box to open it · its title bar to close</span>
        <button className={showAll ? 'on' : ''} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'all edges' : 'edges on focus'}
        </button>
        <button onClick={() => { setOpen(openPassThrough(index, new Set())); setSelected(null); }}>reset</button>
      </header>

      {/* The canvas sits below the top bar rather than under it. The bar is
          fixed and opaque, so anything framed into that strip was both
          invisible and unclickable — it ate the clicks aimed at it. */}
      <div className="stage" ref={stageRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={() => setSelected(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        elevateEdgesOnSelect
        minZoom={0.02}
        maxZoom={4}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="#1b2534" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => `hsl(${(n.data as NodeData).hue} 55% 45%)`}
          maskColor="#080b11cc"
        />
      </ReactFlow>
      </div>

      <Inspector
        node={selectedNode}
        suite={graph.target.testFileCount ?? 0}
        edges={lifted}
        nameOf={nameOf}
        onClose={() => setSelected(null)}
        onSelect={setSelected}
      />

      <footer className="legend">
        <span><i className="swatch grad" />taller &amp; brighter = more of the suite reaches it</span>
        <span><i className="swatch dead" />never observed</span>
        <span><i className="swatch rule-direct" />covered, tested on purpose</span>
        <span><i className="swatch rule-incidental" />covered incidentally</span>
        <span>— observed call · – – static only · ⋯ import</span>
      </footer>
    </>
  );
}

export function App() {
  const [graph, setGraph] = useState<GraphArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('./graph.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then(setGraph)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="splash">
        <h1>no graph</h1>
        <p>{error}</p>
        <code>gnosis scan &lt;repo&gt; &amp;&amp; gnosis test &lt;repo&gt;</code>
      </div>
    );
  }
  if (!graph) return <div className="splash"><h1>reading the graph…</h1></div>;

  return (
    <ReactFlowProvider>
      <Graph graph={graph} />
    </ReactFlowProvider>
  );
}
