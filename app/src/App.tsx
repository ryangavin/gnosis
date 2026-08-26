/**
 * The whole app: a cut through the graph, laid out by ELK, drawn by React
 * Flow. `open` is the only state that matters — everything else is derived
 * from it, so expanding a folder is one set mutation and a relayout.
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
  const [edges, setEdges] = useState<Edge[]>([]);
  const [lifted, setLifted] = useState<LiftedEdge[]>([]);
  const [ms, setMs] = useState(0);
  const [busy, setBusy] = useState(true);
  const { fitBounds } = useReactFlow();
  const run = useRef(0);
  // Held in a ref so the layout effect never has to depend on it — the
  // callback baked into node data must not be what triggers a relayout.
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
      setEdges(
        liftedEdges.map((edge, i) => ({
          id: `e${i}`,
          source: edge.from,
          target: edge.to,
          type: 'smoothstep',
          style: { stroke: `hsl(${hueOf(edge.from)} 62% 72%)`, ...edgeStyle(edge) },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#8b98ab' },
          zIndex: 1,
        })),
      );
      setLifted(liftedEdges);
      setMs(result.ms);
      setBusy(false);

      // fitView waits on React Flow measuring the DOM, which is a frame or
      // two behind a relayout — it kept framing the *previous* cut. ELK
      // already told us the exact bounds, so frame those instead.
      requestAnimationFrame(() =>
        fitBounds(
          { x: 0, y: 0, width: result.width, height: result.height },
          { duration: 400, padding: 0.12 },
        ),
      );
    });
  }, [graph, index, open, hueOf, fitBounds]);

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

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => setSelected(node.id),
    [],
  );
  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => toggle(node.id),
    [toggle],
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
          <em>{edges.length}</em> edges
        </span>
        <span>
          suite <em>{graph.target.testFileCount ?? 0}</em> files
        </span>
        <span className={busy ? 'busy' : ''}>ELK <em>{ms.toFixed(0)} ms</em></span>
        <span className="hint">click ▸ to open a folder · click a box for its numbers</span>
        <button onClick={() => setOpen(openPassThrough(index, new Set()))}>reset</button>
      </header>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => setSelected(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        elevateEdgesOnSelect
        minZoom={0.03}
        maxZoom={4}
        fitView
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
