import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { DerivedView } from './derive.ts';

cytoscape.use(fcose);

interface Props {
  view: DerivedView;
  selected?: string;
  /** Fit the camera to this node's neighborhood after the next relayout. */
  focus?: string;
  onSelect: (id?: string) => void;
  onToggle: (id: string) => void;
}

const hsl = (h: number, s: number, l: number): string => `hsl(${h}, ${s}%, ${l}%)`;

function buildStyle(): cytoscape.StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        color: '#c9cbd1',
        'font-family': 'IBM Plex Mono, Menlo, monospace',
        'text-wrap': 'ellipsis',
        'text-max-width': '160px',
        'border-width': 1,
      },
    },
    {
      selector: 'node[kind = "domain"]',
      style: {
        shape: 'round-rectangle',
        width: 'data(nw)',
        height: 30,
        'font-size': 12,
        'font-weight': 500,
        'text-valign': 'center',
        'text-halign': 'center',
        'background-color': (ele: cytoscape.NodeSingular) => hsl(ele.data('hue'), 30, 16),
        'border-color': (ele: cytoscape.NodeSingular) => hsl(ele.data('hue'), 40, 42),
      },
    },
    {
      selector: 'node[kind = "file"]',
      style: {
        shape: 'round-rectangle',
        width: 'data(nw)',
        height: 22,
        'font-size': 10,
        'min-zoomed-font-size': 7,
        'text-valign': 'center',
        'text-halign': 'center',
        'background-color': (ele: cytoscape.NodeSingular) => hsl(ele.data('hue'), 22, 14),
        'border-color': (ele: cytoscape.NodeSingular) => hsl(ele.data('hue'), 30, 34),
      },
    },
    {
      selector: 'node[kind = "function"]',
      style: {
        shape: 'ellipse',
        width: 14,
        height: 14,
        'font-size': 9,
        'min-zoomed-font-size': 7,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 3,
        'background-color': (ele: cytoscape.NodeSingular) =>
          ele.data('confirmed') ? hsl(ele.data('hue'), 55, 55) : hsl(ele.data('hue'), 25, 12),
        'background-opacity': (ele: cytoscape.NodeSingular) => (ele.data('confirmed') ? 1 : 0.4),
        'border-color': (ele: cytoscape.NodeSingular) => hsl(ele.data('hue'), 45, 50),
      },
    },
    {
      selector: 'node[?reactComponent]',
      style: { shape: 'diamond', width: 16, height: 16 },
    },
    {
      selector: 'node[?testFile]',
      style: { 'border-style': 'dotted' },
    },
    {
      selector: ':parent',
      style: {
        'background-color': (ele: cytoscape.NodeSingular) => hsl(ele.data('hue'), 30, 20),
        'background-opacity': 0.08,
        'border-color': (ele: cytoscape.NodeSingular) => hsl(ele.data('hue'), 30, 32),
        'border-width': 1,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -4,
        'font-size': 11,
        padding: '30px',
        shape: 'round-rectangle',
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': 2,
        'border-color': '#e8e6df',
      },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        width: 'data(w)',
        'line-color': '#6a707c',
        'target-arrow-color': '#6a707c',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.55,
        'line-style': 'dashed',
        'line-dash-pattern': [2, 5],
        opacity: 0.28,
      },
    },
    {
      selector: 'edge[runtime > 0]',
      style: {
        'line-style': 'solid',
        'line-color': '#a9b0bc',
        'target-arrow-color': '#a9b0bc',
        opacity: 0.65,
      },
    },
    {
      selector: 'edge:selected',
      style: { 'line-color': '#e8e6df', 'target-arrow-color': '#e8e6df', opacity: 1 },
    },
  ];
}

export function GraphView({ view, selected, focus, onSelect, onToggle }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core>(null);
  const firstLayout = useRef(true);
  const callbacks = useRef({ onSelect, onToggle });
  callbacks.current = { onSelect, onToggle };
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      style: buildStyle(),
      wheelSensitivity: 0.2,
    });
    cy.on('tap', 'node', (event) => callbacks.current.onSelect(event.target.id()));
    cy.on('dbltap', 'node', (event) => {
      if (event.target.data('expandable')) callbacks.current.onToggle(event.target.id());
    });
    cy.on('tap', (event) => {
      if (event.target === cy) callbacks.current.onSelect(undefined);
    });
    cyRef.current = cy;
    (window as unknown as { __cy?: cytoscape.Core }).__cy = cy;
    return () => cy.destroy();
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const positions = new Map(cy.nodes().map((n) => [n.id(), { ...n.position() }]));

    cy.elements().remove();
    cy.add(
      view.nodes.map((n) => {
        const data: Record<string, unknown> = {
          id: n.id,
          label: n.label,
          nw: Math.min(170, 18 + n.label.length * (n.kind === 'domain' ? 7.8 : 6.4)),
          kind: n.kind,
          hue: n.domainHue,
          confirmed: n.confirmed ? 1 : 0,
          expandable: n.expandable,
          reactComponent: n.reactComponent ? 1 : 0,
          testFile: n.testFile ? 1 : 0,
        };
        if (n.parent) data.parent = n.parent;
        const position = positions.get(n.id);
        return position
          ? { group: 'nodes' as const, data, position }
          : { group: 'nodes' as const, data };
      }),
    );
    cy.add(
      view.edges.map((e) => ({
        group: 'edges' as const,
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          w: Math.min(3, 0.7 + 0.55 * Math.log2(1 + e.calls + e.imports)),
          runtime: e.runtime,
        },
      })),
    );

    // fcose with animate:true never emits layoutstop, so positions are
    // computed synchronously and the camera provides the motion instead.
    const layout = cy.layout({
      name: 'fcose',
      animate: false,
      randomize: firstLayout.current,
      fit: false,
      quality: 'proof',
      nodeRepulsion: 30000,
      idealEdgeLength: 170,
      nodeSeparation: 140,
      nestingFactor: 0.6,
      gravity: 0.08,
      gravityCompound: 0.6,
      tile: true,
      tilingPaddingVertical: 40,
      tilingPaddingHorizontal: 40,
    } as cytoscape.LayoutOptions);
    layout.run();

    // The fit is instant, never animated: an occluded window gets no rAF
    // ticks, and a camera move that depends on animation frames silently
    // never lands there.
    if (firstLayout.current) {
      cy.fit(undefined, 40);
    } else {
      const focusNode = focusRef.current ? cy.getElementById(focusRef.current) : undefined;
      const region =
        focusNode && focusNode.nonempty()
          ? focusNode.closedNeighborhood().union(focusNode.descendants())
          : cy.elements();
      cy.fit(region, 60);
    }
    firstLayout.current = false;
  }, [view]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements(':selected').unselect();
    if (selected) {
      const node = cy.getElementById(selected);
      if (node.nonempty()) {
        node.select();
        if (!node.visible()) return;
      }
    }
  }, [selected, view]);

  return <div className="stage" ref={containerRef} />;
}
