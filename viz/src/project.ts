/**
 * The projection from graph artifact to cosmos.gl attribute arrays — the
 * flat-galaxy successor to the old semantic-zoom derivation. Every file and
 * every function is a point; there is no expand/collapse. Structure comes
 * from forces instead of nesting: containment springs pull functions around
 * their file's hub, folder springs hold directory siblings together, and
 * cluster forces pin each leaf domain to its own anchor — subdomains on a
 * mini-ring around their family's spot on the main ring — while color keeps
 * carrying domain identity. Pure and unit-tested — the WebGL layer just
 * uploads the result.
 *
 * Visual language:
 *   squares = files, dots = functions, diamonds = react components
 *   bright point = observed under test, ember = static only
 *   solid link = observed call, dashed = static-only call, dotted = import
 *   width = call volume
 */
import type { GraphArtifact, GNode } from '../../src/graph/schema.ts';
import { familyHue, subdomainHue, oklchToRgb } from './color.ts';

export const SPACE_SIZE = 4096;

/** PointShape values, mirrored so this module stays renderer-import-free. */
export const SHAPE_CIRCLE = 0;
export const SHAPE_SQUARE = 1;
export const SHAPE_DIAMOND = 3;

/** LinkStyle values, same reason. */
export const STYLE_SOLID = 0;
export const STYLE_DASHED = 1;
export const STYLE_DOTTED = 2;

export interface DomainLabel {
  id: string;
  name: string;
  /** Top-domain index — matches `families`, not the finer physics clusters. */
  family: number;
  color: string;
  hue: number;
}

export interface Projection {
  /** Point index → node id, and back. */
  ids: string[];
  indexOf: Map<string, number>;
  /** Deterministic seed positions: domains ringed, files jittered near their domain, functions near their file. */
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  shapes: Float32Array;
  /** Physics cluster per point — the leaf domain, one anchor per constellation. */
  clusters: (number | undefined)[];
  /** Top-domain index per point — what labels, selection, and reveal group by. */
  families: (number | undefined)[];
  clusterStrength: Float32Array;
  /** Pinned anchor per cluster (x,y pairs) — the ring the constellations hold. */
  clusterPositions: number[];
  links: Float32Array;
  linkColors: Float32Array;
  linkWidths: Float32Array;
  linkStyles: Float32Array;
  linkArrows: boolean[];
  linkStrength: Float32Array;
  domains: DomainLabel[];
}

export interface ProjectOptions {
  showTests: boolean;
}

/** Deterministic per-id jitter so reloads reproduce the same seed layout. */
function hashUnit(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function project(graph: GraphArtifact, options: ProjectOptions): Projection {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, GNode[]>();
  for (const node of graph.nodes) {
    if (!node.parent) continue;
    const list = childrenOf.get(node.parent) ?? [];
    list.push(node);
    childrenOf.set(node.parent, list);
  }

  const hidden = (node: GNode): boolean => {
    if (options.showTests) return false;
    if (node.flags?.testFile) return true;
    if (node.kind === 'function') {
      const file = byId.get(node.parent ?? '');
      return file?.flags?.testFile ?? false;
    }
    return false;
  };

  // Hue = family: golden-angle bases per top domain, subdomains nudged a few
  // degrees around their family. Physics clusters are the *leaf* domains:
  // each subdomain holds its own pinned anchor on a mini-ring around its
  // family's spot on the main ring, so directory structure shows up as
  // spatial grouping, not just hue. Labels and selection stay at the family
  // level via `families`.
  const topDomains = (childrenOf.get('repo') ?? []).filter((n) => n.kind === 'domain');
  const domainHues = new Map<string, number>();
  const familyOf = new Map<string, number>();
  const clusterOf = new Map<string, number>();
  const clusterPositions: number[] = [];

  const center = SPACE_SIZE / 2;
  const ring = SPACE_SIZE * 0.24;
  const familyAnchor = (i: number): [number, number] => {
    if (topDomains.length === 0) return [center, center];
    const angle = (i / topDomains.length) * Math.PI * 2;
    return [center + ring * Math.cos(angle), center + ring * Math.sin(angle)];
  };
  const addCluster = (x: number, y: number): number => {
    clusterPositions.push(x, y);
    return clusterPositions.length / 2 - 1;
  };

  topDomains.forEach((top, i) => {
    domainHues.set(top.id, familyHue(i));
    familyOf.set(top.id, i);
    const [ax, ay] = familyAnchor(i);
    clusterOf.set(top.id, addCluster(ax, ay));
    const subs = (childrenOf.get(top.id) ?? []).filter((c) => c.kind === 'domain');
    const mini = SPACE_SIZE * Math.min(0.075, 0.03 + 0.012 * subs.length);
    subs.forEach((sub, j) => {
      domainHues.set(sub.id, subdomainHue(familyHue(i), j, subs.length));
      familyOf.set(sub.id, i);
      const angle = (i / topDomains.length + j / Math.max(1, subs.length)) * Math.PI * 2;
      clusterOf.set(sub.id, addCluster(ax + mini * Math.cos(angle), ay + mini * Math.sin(angle)));
    });
  });

  const ancestorLookup = <T>(map: Map<string, T>, node: GNode): T | undefined => {
    let current: GNode | undefined = node;
    while (current) {
      const hit = map.get(current.id);
      if (hit !== undefined) return hit;
      current = current.parent ? byId.get(current.parent) : undefined;
    }
    return undefined;
  };

  // Call volume per function, for sizing.
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls') continue;
    const weight = edge.runtime?.count ?? 1;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + weight);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + weight);
  }

  // Points: every visible file, then every visible function.
  const files = graph.nodes.filter((n) => n.kind === 'file' && !hidden(n));
  const functions = graph.nodes.filter((n) => n.kind === 'function' && !hidden(n));
  const points = [...files, ...functions];
  const ids = points.map((n) => n.id);
  const indexOf = new Map(ids.map((id, i) => [id, i]));

  const count = points.length;
  const positions = new Float32Array(count * 2);
  const colors = new Float32Array(count * 4);
  const sizes = new Float32Array(count);
  const shapes = new Float32Array(count);
  const clusters: (number | undefined)[] = new Array<number | undefined>(count);
  const families: (number | undefined)[] = new Array<number | undefined>(count);
  const clusterStrength = new Float32Array(count);

  const anchorOf = (cluster: number | undefined): [number, number] => {
    if (cluster === undefined) return [center, center];
    return [clusterPositions[cluster * 2]!, clusterPositions[cluster * 2 + 1]!];
  };

  // Seed tight around the leaf anchor: with a one-second settle the seed has
  // to already be most of the answer — the simulation only relaxes it.
  const fileSeed = new Map<string, [number, number]>();
  points.forEach((node, i) => {
    const hue = ancestorLookup(domainHues, node) ?? 0;
    const cluster = ancestorLookup(clusterOf, node);
    clusters[i] = cluster;
    families[i] = ancestorLookup(familyOf, node);

    let x: number;
    let y: number;
    if (node.kind === 'file') {
      const [ax, ay] = anchorOf(cluster);
      x = ax + (hashUnit(node.id, 1) - 0.5) * SPACE_SIZE * 0.05;
      y = ay + (hashUnit(node.id, 2) - 0.5) * SPACE_SIZE * 0.05;
      fileSeed.set(node.id, [x, y]);
    } else {
      const [fx, fy] = fileSeed.get(node.parent ?? '') ?? anchorOf(cluster);
      x = fx + (hashUnit(node.id, 3) - 0.5) * SPACE_SIZE * 0.02;
      y = fy + (hashUnit(node.id, 4) - 0.5) * SPACE_SIZE * 0.02;
    }
    positions[i * 2] = x;
    positions[i * 2 + 1] = y;

    const observed = node.runtime !== undefined;
    let rgb: [number, number, number];
    let alpha: number;
    if (node.kind === 'file') {
      rgb = oklchToRgb(0.62, 0.09, hue);
      alpha = 0.85;
      sizes[i] = 6 + Math.min(8, Math.sqrt(node.stats?.functions ?? (childrenOf.get(node.id)?.length ?? 0)) * 1.8);
      shapes[i] = SHAPE_SQUARE;
      clusterStrength[i] = 0.8;
    } else {
      rgb = observed ? oklchToRgb(0.8, 0.14, hue) : oklchToRgb(0.52, 0.08, hue);
      alpha = observed ? 1 : 0.6;
      sizes[i] = 3 + Math.min(6, Math.sqrt(degree.get(node.id) ?? 0) * 0.8);
      shapes[i] = node.flags?.reactComponent ? SHAPE_DIAMOND : SHAPE_CIRCLE;
      clusterStrength[i] = 0.4;
    }
    colors[i * 4] = rgb[0];
    colors[i * 4 + 1] = rgb[1];
    colors[i * 4 + 2] = rgb[2];
    colors[i * 4 + 3] = alpha;
  });

  // Links: containment springs (function ↔ its file, the structural glue),
  // then the artifact's call and import edges between visible points.
  const linkPairs: number[] = [];
  const linkColors: number[] = [];
  const linkWidths: number[] = [];
  const linkStyles: number[] = [];
  const linkArrows: boolean[] = [];
  const linkStrength: number[] = [];

  const pushLink = (
    from: number,
    to: number,
    rgba: [number, number, number, number],
    width: number,
    style: number,
    arrow: boolean,
    strength: number,
  ): void => {
    linkPairs.push(from, to);
    linkColors.push(...rgba);
    linkWidths.push(width);
    linkStyles.push(style);
    linkArrows.push(arrow);
    linkStrength.push(strength);
  };

  for (const fn of functions) {
    const fileIndex = indexOf.get(fn.parent ?? '');
    if (fileIndex === undefined) continue;
    const i = indexOf.get(fn.id)!;
    const hue = ancestorLookup(domainHues, fn) ?? 0;
    const [r, g, b] = oklchToRgb(0.5, 0.06, hue);
    pushLink(i, fileIndex, [r, g, b, 0.1], 0.4, STYLE_SOLID, false, 0.5);
  }

  // Folder springs: files sharing a directory bind to the directory's first
  // file — faint threads that give each constellation its folder texture,
  // one level finer than the domain layer can see.
  const byDir = new Map<string, number[]>();
  for (const file of files) {
    const rel = file.id.slice('file:'.length);
    const slash = rel.lastIndexOf('/');
    const dir = slash === -1 ? '' : rel.slice(0, slash);
    const list = byDir.get(dir) ?? [];
    list.push(indexOf.get(file.id)!);
    byDir.set(dir, list);
  }
  for (const members of byDir.values()) {
    if (members.length < 2) continue;
    const hub = members[0]!;
    const hue = ancestorLookup(domainHues, points[hub]!) ?? 0;
    const [r, g, b] = oklchToRgb(0.55, 0.06, hue);
    for (let m = 1; m < members.length; m += 1) {
      pushLink(members[m]!, hub, [r, g, b, 0.08], 0.35, STYLE_SOLID, false, 0.4);
    }
  }

  for (const edge of graph.edges) {
    const from = indexOf.get(edge.from);
    const to = indexOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const source = byId.get(edge.from)!;
    const hue = ancestorLookup(domainHues, source) ?? 0;
    if (edge.kind === 'imports') {
      const [r, g, b] = oklchToRgb(0.6, 0.07, hue);
      pushLink(from, to, [r, g, b, 0.18], 0.6, STYLE_DOTTED, false, 0.08);
    } else {
      const observed = edge.runtime !== undefined;
      const volume = edge.runtime?.count ?? 0;
      const [r, g, b] = observed ? oklchToRgb(0.75, 0.12, hue) : oklchToRgb(0.55, 0.07, hue);
      pushLink(
        from,
        to,
        [r, g, b, observed ? 0.5 : 0.22],
        observed ? 0.7 + Math.min(1.6, Math.log2(1 + volume) * 0.35) : 0.6,
        observed ? STYLE_SOLID : STYLE_DASHED,
        true,
        0.15,
      );
    }
  }

  const domains: DomainLabel[] = topDomains.map((d, i) => ({
    id: d.id,
    name: d.name,
    family: i,
    color: `#${oklchToRgb(0.82, 0.1, familyHue(i))
      .map((c) => Math.round(c * 255).toString(16).padStart(2, '0'))
      .join('')}`,
    hue: familyHue(i),
  }));

  return {
    ids,
    indexOf,
    positions,
    colors,
    sizes,
    shapes,
    clusters,
    families,
    clusterStrength,
    clusterPositions,
    links: new Float32Array(linkPairs),
    linkColors: new Float32Array(linkColors),
    linkWidths: new Float32Array(linkWidths),
    linkStyles: new Float32Array(linkStyles),
    linkArrows,
    linkStrength: new Float32Array(linkStrength),
    domains,
  };
}
