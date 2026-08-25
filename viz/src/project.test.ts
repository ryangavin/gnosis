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
    // containment (4 fn→file) + 3 calls + 1 import
    expect(p.links.length / 2).toBe(8);
  });

  it('clusters points under their top-level domain', () => {
    const p = project(fixture(), { showTests: false });
    expect(p.clusters[p.indexOf.get('fn:core/a.ts#f')!]).toBe(0);
    expect(p.clusters[p.indexOf.get('file:ui/B.tsx')!]).toBe(1);
    expect(p.domains.map((d) => d.name)).toEqual(['core', 'ui']);
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
