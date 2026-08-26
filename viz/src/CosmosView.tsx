/**
 * The WebGL layer: uploads the projection to cosmos.gl and wires its events
 * back into app state. All layout is physics — containment springs, cluster
 * forces, repulsion — running on the GPU; this component owns the graph
 * lifecycle, the domain labels (HTML overlay tracking live cluster
 * centroids), the hover tooltip, and layout persistence (positions restored
 * by node id from localStorage; a mostly-restored layout renders settled
 * instead of re-simulating).
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Graph } from '@cosmos.gl/graph';
import type { GraphArtifact } from '../../src/graph/schema.ts';
import type { Projection } from './project.ts';
import { SPACE_SIZE } from './project.ts';
import { clearLayout, loadLayout, saveLayout } from './layout-store.ts';

export interface CosmosHandle {
  pause(): void;
  /** Reheat a paused or settled simulation. */
  reheat(): void;
  fit(): void;
  /** Forget the saved layout, reseed, and simulate from scratch. */
  reshuffle(): void;
}

interface Props {
  graph: GraphArtifact;
  projection: Projection;
  selected?: string;
  focus?: string;
  focusNonce: number;
  onSelect: (id?: string) => void;
  onRunningChange: (running: boolean) => void;
}

interface Hover {
  x: number;
  y: number;
  name: string;
  ctx: string;
}

export const CosmosView = forwardRef<CosmosHandle, Props>(function CosmosView(
  { graph, projection, selected, focus, focusNonce, onSelect, onRunningChange },
  handle,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph>(null);
  const labelRefs = useRef(new Map<number, HTMLButtonElement>());
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const userZoomed = useRef(false);
  const followArmed = useRef(false);
  const followUntil = useRef(0);
  const lastFollowFit = useRef(0);
  const [hover, setHover] = useState<Hover>();

  // Follow the expanding simulation with the camera until the user takes
  // over. Anchored to simulation ticks, not wall clock — on a cold load the
  // WebGL device can take longer to init than any timer, and a fit queued
  // before the first tick frames nothing. The window opens at the first
  // tick after arming.
  const followSettling = (): void => {
    userZoomed.current = false;
    followArmed.current = true;
    followUntil.current = 0;
    lastFollowFit.current = 0;
  };

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  // Latest values for the stable event closures created at graph init.
  const live = useRef({ projection, onSelect, onRunningChange, target: graph.target.name });
  live.current = { projection, onSelect, onRunningChange, target: graph.target.name };

  const save = (): void => {
    const g = graphRef.current;
    if (!g?.isReady) return;
    saveLayout(live.current.target, live.current.projection.ids, g.getPointPositions());
  };
  const scheduleSave = (): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 400);
  };

  useEffect(() => {
    const g = new Graph(containerRef.current!, {
      spaceSize: SPACE_SIZE,
      backgroundColor: '#16181d',
      // No data-update transitions: a position upload whose transition is in
      // flight pauses the simulation and leaves it paused — which on a cold
      // load kills the very first settle. Camera moves pass explicit
      // durations and are unaffected.
      transitionDuration: 0,
      rescalePositions: false,
      fitViewOnInit: false,
      randomSeed: 'gnosis',
      enableDrag: true,
      scalePointsOnZoom: true,
      renderHoveredPointRing: true,
      hoveredPointRingColor: '#e8e6df',
      focusedPointRingColor: '#ffffff',
      hoveredPointCursor: 'pointer',
      pointGreyoutOpacity: 0.08,
      linkGreyoutOpacity: 0.02,
      linkArrowsSizeScale: 0.7,
      linkDashLength: 5,
      linkDashGap: 4,
      curvedLinks: true,
      simulationDecay: 4000,
      simulationGravity: 0.08,
      simulationCenter: 0.05,
      simulationRepulsion: 2.5,
      simulationRepulsionTheta: 1.7,
      simulationLinkSpring: 0.3,
      simulationLinkDistance: 10,
      simulationFriction: 0.85,
      simulationCluster: 0.45,
      onPointClick: (index) => live.current.onSelect(live.current.projection.ids[index]),
      onBackgroundClick: () => live.current.onSelect(undefined),
      onPointMouseOver: (index, pointPosition) => {
        const id = live.current.projection.ids[index];
        const node = id ? byId.get(id) : undefined;
        if (!node) return;
        const [x, y] = g.spaceToScreenPosition([pointPosition[0], pointPosition[1]]);
        const ctx =
          node.kind === 'function'
            ? (node.parent?.slice('file:'.length) ?? '')
            : node.id.slice('file:'.length);
        setHover({ x, y, name: node.name, ctx });
      },
      onPointMouseOut: () => setHover(undefined),
      onDragStart: () => setHover(undefined),
      onZoomStart: (_e, userDriven) => {
        if (userDriven) userZoomed.current = true;
      },
      onSimulationTick: () => {
        if (!followArmed.current) return;
        const now = Date.now();
        if (followUntil.current === 0) followUntil.current = now + 4500;
        if (userZoomed.current || now >= followUntil.current) {
          followArmed.current = false;
          return;
        }
        if (now - lastFollowFit.current < 450) return;
        lastFollowFit.current = now;
        // enableSimulation: a camera transition otherwise suspends the
        // simulation — and with it these very ticks.
        graphRef.current?.fitView(400, undefined, true);
      },
      onDragEnd: () => scheduleSave(),
      onSimulationStart: () => live.current.onRunningChange(true),
      onSimulationUnpause: () => live.current.onRunningChange(true),
      onSimulationPause: () => {
        live.current.onRunningChange(false);
        scheduleSave();
      },
      onSimulationEnd: () => {
        live.current.onRunningChange(false);
        scheduleSave();
      },
    });
    graphRef.current = g;
    // No save on unload or unmount: the meaningful states (simulation
    // ended, paused, a drag finished) already save themselves, and saving a
    // never-simulated seed layout would pin it as "restored" forever.
    return () => {
      g.destroy();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Upload the projection; restore saved positions by id where they exist.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;

    const positions = new Float32Array(projection.positions);
    const saved = loadLayout(graph.target.name);
    let restored = 0;
    if (saved) {
      projection.ids.forEach((id, i) => {
        const p = saved.get(id);
        if (p) {
          positions[i * 2] = p[0];
          positions[i * 2 + 1] = p[1];
          restored += 1;
        }
      });
    }

    g.setPointPositions(positions, true);
    g.setPointColors(projection.colors);
    g.setPointSizes(projection.sizes);
    g.setPointShapes(projection.shapes);
    g.setPointClusters(projection.clusters);
    g.setPointClusterStrength(projection.clusterStrength);
    g.setLinks(projection.links);
    g.setLinkColors(projection.linkColors);
    g.setLinkWidths(projection.linkWidths);
    g.setLinkStyles(projection.linkStyles);
    g.setLinkArrows(projection.linkArrows);
    g.setLinkStrength(projection.linkStrength);
    g.render(undefined, 0);

    const mostlyRestored = restored >= projection.ids.length * 0.5;
    if (mostlyRestored) {
      onRunningChange(false);
      g.fitView(0);
    } else {
      g.start(1);
      followSettling();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projection, graph]);

  // Selection: focus ring on the point, neighborhood highlighted, everything
  // else greyed. A domain selection highlights its whole constellation.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const idx = selected ? projection.indexOf.get(selected) : undefined;
    if (idx !== undefined) {
      const neighbors = g.getNeighboringPointIndices(idx);
      g.setConfigPartial({
        focusedPointIndex: idx,
        highlightedPointIndices: [idx, ...neighbors],
      });
    } else {
      const domain = selected
        ? projection.domains.find((d) => d.id === selected)
        : undefined;
      if (domain) {
        const members: number[] = [];
        projection.clusters.forEach((c, i) => {
          if (c === domain.cluster) members.push(i);
        });
        g.setConfigPartial({ focusedPointIndex: undefined, highlightedPointIndices: members });
      } else {
        g.setConfigPartial({ focusedPointIndex: undefined, highlightedPointIndices: undefined });
      }
    }
    g.render();
  }, [selected, projection]);

  // Camera travel on reveal: points get a zoom, domains get their extent.
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !focus) return;
    const idx = projection.indexOf.get(focus);
    if (idx !== undefined) {
      g.zoomToPointByIndex(idx, 700, undefined, true);
      return;
    }
    const domain = projection.domains.find((d) => d.id === focus);
    if (domain) {
      const members: number[] = [];
      projection.clusters.forEach((c, i) => {
        if (c === domain.cluster) members.push(i);
      });
      if (members.length > 0) g.fitViewByPointIndices(members, 700, 0.4);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, focusNonce]);

  // Domain labels ride their constellation centroids, updated outside React.
  // Centroids are averaged from real point positions on a slow clock (the
  // read syncs with the GPU); the space→screen transform runs every frame so
  // labels stay glued through pan and zoom.
  useEffect(() => {
    const centroids = new Map<number, [number, number]>();
    const recompute = (): void => {
      const g = graphRef.current;
      if (!g?.isReady) return;
      const pos = g.getPointPositions();
      const sums = new Map<number, [number, number, number]>();
      projection.clusters.forEach((c, i) => {
        if (c === undefined) return;
        const x = pos[i * 2];
        const y = pos[i * 2 + 1];
        if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) return;
        const s = sums.get(c) ?? [0, 0, 0];
        s[0] += x;
        s[1] += y;
        s[2] += 1;
        sums.set(c, s);
      });
      centroids.clear();
      for (const [c, [sx, sy, n]] of sums) centroids.set(c, [sx / n, sy / n]);
    };

    let raf = 0;
    const tick = (): void => {
      const g = graphRef.current;
      if (g?.isReady) {
        for (const d of projection.domains) {
          const el = labelRefs.current.get(d.cluster);
          if (!el) continue;
          const center = centroids.get(d.cluster);
          if (!center) {
            el.style.opacity = '0';
            continue;
          }
          const [sx, sy] = g.spaceToScreenPosition(center);
          el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
          el.style.opacity = '1';
        }
      }
      raf = requestAnimationFrame(tick);
    };

    recompute();
    const interval = setInterval(recompute, 400);
    raf = requestAnimationFrame(tick);
    return () => {
      clearInterval(interval);
      cancelAnimationFrame(raf);
    };
  }, [projection]);

  useImperativeHandle(handle, () => ({
    pause() {
      graphRef.current?.pause();
    },
    reheat() {
      graphRef.current?.start(0.6);
    },
    fit() {
      graphRef.current?.fitView(600);
    },
    reshuffle() {
      const g = graphRef.current;
      if (!g) return;
      clearLayout(live.current.target);
      g.setPointPositions(new Float32Array(live.current.projection.positions), true);
      g.start(1);
      followSettling();
    },
  }));

  return (
    <div className="stage" ref={containerRef}>
      <div className="labels">
        {projection.domains.map((d) => (
          <button
            key={d.id}
            className="cluster-label"
            style={{ color: d.color }}
            ref={(el) => {
              if (el) labelRefs.current.set(d.cluster, el);
              else labelRefs.current.delete(d.cluster);
            }}
            onClick={() => onSelect(d.id)}
          >
            {d.name}
          </button>
        ))}
      </div>
      {hover && (
        <div
          className="tooltip"
          style={{ transform: `translate(${hover.x}px, ${hover.y + 14}px) translateX(-50%)` }}
        >
          <span className="name">{hover.name}</span>
          {hover.ctx && <span className="ctx">{hover.ctx}</span>}
        </div>
      )}
    </div>
  );
});
