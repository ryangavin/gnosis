import { describe, expect, it } from 'vitest';
import type { GraphArtifact } from '../../src/graph/schema.ts';
import { project, STYLE_DASHED, STYLE_DOTTED, STYLE_SOLID, SHAPE_DIAMOND, SHAPE_SQUARE } from './project.ts';

function fixture(): GraphArtifact {
  return {
    version: 1,
    target: { root: '/r', name: 'fx', scannedAt: 'now', limitations: [] },
    nodes: [
      { id: 'repo', kind: 'repo', name: 'fx' },
      { id: 'domain:core', kind: 'domain', name: 'core', parent: 'repo' },
      { id: 'domain:ui', kind: 'domain', name: 'ui', parent: 'repo' },
      { id: 'file:core/a.ts', kind: 'file', name: 'a.ts', parent: 'domain:core' },
      { id: 'file:ui/B.tsx', kind: 'file', name: 'B.tsx', parent: 'domain:ui' },
      { id: 'file:core/a.test.ts', kind: 'file', name: 'a.test.ts', parent: 'domain:core', flags: { testFile: true } },
      { id: 'fn:core/a.ts#f', kind: 'function', name: 'f', parent: 'file:core/a.ts', runtime: { calls: 3, testFiles: ['core/a.test.ts'] } },
      { id: 'fn:core/a.ts#g', kind: 'function', name: 'g', parent: 'file:core/a.ts' },
      { id: 'fn:ui/B.tsx#C', kind: 'function', name: 'C', parent: 'file:ui/B.tsx', flags: { reactComponent: true } },
      { id: 'fn:core/a.test.ts#t', kind: 'function', name: 't', parent: 'file:core/a.test.ts' },
    ],
    edges: [
      { id: 'calls|fn:core/a.ts#f|fn:core/a.ts#g', kind: 'calls', from: 'fn:core/a.ts#f', to: 'fn:core/a.ts#g', static: true, runtime: { count: 5, tests: ['t'], testFiles: ['core/a.test.ts'] } },
      { id: 'calls|fn:ui/B.tsx#C|fn:core/a.ts#f', kind: 'calls', from: 'fn:ui/B.tsx#C', to: 'fn:core/a.ts#f', static: true },
      { id: 'imports|file:ui/B.tsx|file:core/a.ts', kind: 'imports', from: 'file:ui/B.tsx', to: 'file:core/a.ts', static: true },
      { id: 'calls|fn:core/a.test.ts#t|fn:core/a.ts#f', kind: 'calls', from: 'fn:core/a.test.ts#t', to: 'fn:core/a.ts#f', static: true },
    ],
  };
}

describe('project', () => {
  it('points are every visible file and function, test files hidden by default', () => {
    const p = project(fixture(), { showTests: false });
    expect(p.ids).toEqual([
      'file:core/a.ts',
      'file:ui/B.tsx',
      'fn:core/a.ts#f',
      'fn:core/a.ts#g',
      'fn:ui/B.tsx#C',
    ]);
    p.ids.forEach((id, i) => expect(p.indexOf.get(id)).toBe(i));
  });

  it('showTests brings test files, their functions, and their edges back', () => {
    const p = project(fixture(), { showTests: true });
    expect(p.ids).toContain('file:core/a.test.ts');
    expect(p.ids).toContain('fn:core/a.test.ts#t');
    // containment (4 fn→file) + folder spring (a.ts ~ a.test.ts) + 3 calls + 1 import
    expect(p.links.length / 2).toBe(9);
  });

  it('clusters points under their top-level domain', () => {
    const p = project(fixture(), { showTests: false });
    expect(p.clusters[p.indexOf.get('fn:core/a.ts#f')!]).toBe(0);
    expect(p.clusters[p.indexOf.get('file:ui/B.tsx')!]).toBe(1);
    expect(p.families[p.indexOf.get('fn:core/a.ts#f')!]).toBe(0);
    expect(p.families[p.indexOf.get('file:ui/B.tsx')!]).toBe(1);
    expect(p.domains.map((d) => d.name)).toEqual(['core', 'ui']);
  });

  it('pins one anchor per domain, spread apart on the ring', () => {
    const p = project(fixture(), { showTests: false });
    expect(p.clusterPositions.length).toBe(p.domains.length * 2);
    const [ax, ay, bx, by] = p.clusterPositions as [number, number, number, number];
    expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThan(1000);
  });

  it('a subdomain holds its own cluster on a mini-ring near its family', () => {
    const g: GraphArtifact = {
      version: 1,
      target: { root: '/r', name: 'fx', scannedAt: 'now', limitations: [] },
      nodes: [
        { id: 'repo', kind: 'repo', name: 'fx' },
        { id: 'domain:app', kind: 'domain', name: 'app', parent: 'repo' },
        { id: 'domain:app/ui', kind: 'domain', name: 'app/ui', parent: 'domain:app' },
        { id: 'domain:app/core', kind: 'domain', name: 'app/core', parent: 'domain:app' },
        { id: 'file:app/root.ts', kind: 'file', name: 'root.ts', parent: 'domain:app' },
        { id: 'file:app/ui/a.tsx', kind: 'file', name: 'a.tsx', parent: 'domain:app/ui' },
        { id: 'file:app/core/b.ts', kind: 'file', name: 'b.ts', parent: 'domain:app/core' },
      ],
      edges: [],
    };
    const p = project(g, { showTests: false });
    const root = p.clusters[p.indexOf.get('file:app/root.ts')!]!;
    const ui = p.clusters[p.indexOf.get('file:app/ui/a.tsx')!]!;
    const core = p.clusters[p.indexOf.get('file:app/core/b.ts')!]!;
    // three distinct constellations, one family
    expect(new Set([root, ui, core]).size).toBe(3);
    expect(p.families.every((f) => f === 0)).toBe(true);
    // sub anchors orbit the family anchor, far closer than the main ring
    const dist = (a: number, b: number): number =>
      Math.hypot(
        p.clusterPositions[a * 2]! - p.clusterPositions[b * 2]!,
        p.clusterPositions[a * 2 + 1]! - p.clusterPositions[b * 2 + 1]!,
      );
    expect(dist(root, ui)).toBeGreaterThan(0);
    expect(dist(root, ui)).toBeLessThan(500);
    expect(dist(root, core)).toBeLessThan(500);
  });

  it('files sharing a directory are bound by a folder spring', () => {
    const g: GraphArtifact = {
      version: 1,
      target: { root: '/r', name: 'fx', scannedAt: 'now', limitations: [] },
      nodes: [
        { id: 'repo', kind: 'repo', name: 'fx' },
        { id: 'domain:core', kind: 'domain', name: 'core', parent: 'repo' },
        { id: 'file:core/x/a.ts', kind: 'file', name: 'a.ts', parent: 'domain:core' },
        { id: 'file:core/x/b.ts', kind: 'file', name: 'b.ts', parent: 'domain:core' },
        { id: 'file:core/y/c.ts', kind: 'file', name: 'c.ts', parent: 'domain:core' },
      ],
      edges: [],
    };
    const p = project(g, { showTests: false });
    // exactly one spring: a.ts ~ b.ts share core/x, c.ts sits alone in core/y
    expect(p.links.length / 2).toBe(1);
    const [from, to] = [p.links[0]!, p.links[1]!];
    const pair = new Set([p.ids[from]!, p.ids[to]!]);
    expect(pair).toEqual(new Set(['file:core/x/a.ts', 'file:core/x/b.ts']));
    expect(p.linkArrows[0]).toBe(false);
  });

  it('an edge with a hidden endpoint is dropped entirely', () => {
    const p = project(fixture(), { showTests: false });
    // containment (3 visible fns) + observed call + static call + import
    expect(p.links.length / 2).toBe(6);
  });

  it('speaks the language: solid observed, dashed static-only, dotted import', () => {
    const p = project(fixture(), { showTests: false });
    const containment = 3;
    const styles = [...p.linkStyles.slice(containment)];
    expect(styles).toContain(STYLE_SOLID);
    expect(styles).toContain(STYLE_DASHED);
    expect(styles).toContain(STYLE_DOTTED);
    // calls carry arrows, containment and imports do not
    expect(p.linkArrows.slice(0, containment)).toEqual([false, false, false]);
    // observed call is wider than the static-only one
    const observedWidth = p.linkWidths[containment]!;
    const staticWidth = p.linkWidths[containment + 1]!;
    expect(observedWidth).toBeGreaterThan(staticWidth);
  });

  it('files are squares, react components diamonds, observed functions brighter', () => {
    const p = project(fixture(), { showTests: false });
    expect(p.shapes[p.indexOf.get('file:core/a.ts')!]).toBe(SHAPE_SQUARE);
    expect(p.shapes[p.indexOf.get('fn:ui/B.tsx#C')!]).toBe(SHAPE_DIAMOND);
    const alphaOf = (id: string): number => p.colors[p.indexOf.get(id)! * 4 + 3]!;
    expect(alphaOf('fn:core/a.ts#f')).toBeGreaterThan(alphaOf('fn:core/a.ts#g'));
  });

  it('seed positions are deterministic and functions seed near their file', () => {
    const a = project(fixture(), { showTests: false });
    const b = project(fixture(), { showTests: false });
    expect([...a.positions]).toEqual([...b.positions]);

    const file = a.indexOf.get('file:core/a.ts')!;
    const fn = a.indexOf.get('fn:core/a.ts#f')!;
    const other = a.indexOf.get('file:ui/B.tsx')!;
    const dist = (i: number, j: number): number =>
      Math.hypot(a.positions[i * 2]! - a.positions[j * 2]!, a.positions[i * 2 + 1]! - a.positions[j * 2 + 1]!);
    expect(dist(fn, file)).toBeLessThan(dist(fn, other));
  });
});
