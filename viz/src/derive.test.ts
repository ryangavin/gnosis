import { describe, expect, it } from 'vitest';
import type { GraphArtifact } from '../../src/graph/schema.ts';
import { ancestorsToExpand, deriveView } from './derive.ts';

function fixture(): GraphArtifact {
  return {
    version: 1,
    target: { root: '/r', name: 'fix', scannedAt: 'now', limitations: [] },
    nodes: [
      { id: 'repo', kind: 'repo', name: 'fix' },
      { id: 'domain:core', kind: 'domain', name: 'core', parent: 'repo' },
      { id: 'domain:ui', kind: 'domain', name: 'ui', parent: 'repo' },
      { id: 'file:core/a.ts', kind: 'file', name: 'a.ts', parent: 'domain:core' },
      { id: 'file:core/a.test.ts', kind: 'file', name: 'a.test.ts', parent: 'domain:core', flags: { testFile: true } },
      { id: 'file:ui/b.ts', kind: 'file', name: 'b.ts', parent: 'domain:ui' },
      { id: 'fn:core/a.ts#one', kind: 'function', name: 'one', parent: 'file:core/a.ts' },
      { id: 'fn:core/a.ts#two', kind: 'function', name: 'two', parent: 'file:core/a.ts', runtime: { calls: 5, testFiles: [] } },
      { id: 'fn:ui/b.ts#use', kind: 'function', name: 'use', parent: 'file:ui/b.ts' },
    ],
    edges: [
      { id: 'calls|fn:ui/b.ts#use|fn:core/a.ts#one', kind: 'calls', from: 'fn:ui/b.ts#use', to: 'fn:core/a.ts#one', static: true },
      { id: 'calls|fn:ui/b.ts#use|fn:core/a.ts#two', kind: 'calls', from: 'fn:ui/b.ts#use', to: 'fn:core/a.ts#two', static: true, runtime: { count: 3, tests: [], testFiles: [] } },
      { id: 'imports|file:ui/b.ts|file:core/a.ts', kind: 'imports', from: 'file:ui/b.ts', to: 'file:core/a.ts', static: true },
      { id: 'calls|fn:core/a.ts#one|fn:core/a.ts#two', kind: 'calls', from: 'fn:core/a.ts#one', to: 'fn:core/a.ts#two', static: true },
      { id: 'calls|file:core/a.test.ts|fn:core/a.ts#two', kind: 'calls', from: 'file:core/a.test.ts', to: 'fn:core/a.ts#two', static: true },
    ],
  };
}

describe('deriveView', () => {
  it('collapsed default view shows only domains with aggregated edges', () => {
    const view = deriveView(fixture(), new Set(), { showTests: false });
    expect(view.nodes.map((n) => n.id).sort()).toEqual(['domain:core', 'domain:ui']);
    expect(view.edges).toHaveLength(1);
    const edge = view.edges[0]!;
    expect(edge.source).toBe('domain:ui');
    expect(edge.target).toBe('domain:core');
    expect(edge.calls).toBe(2);
    expect(edge.imports).toBe(1);
    expect(edge.runtime).toBe(1);
  });

  it('does not aggregate edges internal to a collapsed compound', () => {
    const view = deriveView(fixture(), new Set(), { showTests: false });
    expect(view.edges.every((e) => e.source !== e.target)).toBe(true);
  });

  it('expanding a domain shows its files and re-homes edges to them', () => {
    const view = deriveView(fixture(), new Set(['domain:core']), { showTests: false });
    expect(view.nodes.map((n) => n.id).sort()).toEqual([
      'domain:core',
      'domain:ui',
      'file:core/a.ts',
    ]);
    const edge = view.edges.find((e) => e.source === 'domain:ui')!;
    expect(edge.target).toBe('file:core/a.ts');
  });

  it('expanding down to functions keeps distinct edges distinct', () => {
    const view = deriveView(
      fixture(),
      new Set(['domain:core', 'domain:ui', 'file:core/a.ts', 'file:ui/b.ts']),
      { showTests: false },
    );
    const fnEdges = view.edges.filter((e) => e.source === 'fn:ui/b.ts#use');
    expect(fnEdges).toHaveLength(2);
    const internal = view.edges.find((e) => e.source === 'fn:core/a.ts#one');
    expect(internal?.target).toBe('fn:core/a.ts#two');
  });

  it('hides test files and their edges unless asked', () => {
    const hiddenView = deriveView(fixture(), new Set(['domain:core']), { showTests: false });
    expect(hiddenView.nodes.some((n) => n.id.includes('test'))).toBe(false);
    const shownView = deriveView(fixture(), new Set(['domain:core']), { showTests: true });
    expect(shownView.nodes.some((n) => n.id.includes('test'))).toBe(true);
    const testEdge = shownView.edges.find((e) => e.source === 'file:core/a.test.ts');
    expect(testEdge?.target).toBe('file:core/a.ts');
  });

  it('marks runtime-confirmed nodes and expandability', () => {
    const view = deriveView(fixture(), new Set(['domain:core', 'file:core/a.ts']), {
      showTests: false,
    });
    const two = view.nodes.find((n) => n.id === 'fn:core/a.ts#two')!;
    expect(two.confirmed).toBe(true);
    expect(two.expandable).toBe(false);
    const core = view.nodes.find((n) => n.id === 'domain:core')!;
    expect(core.open).toBe(true);
  });
});

describe('ancestorsToExpand', () => {
  it('lists the chain a function needs opened', () => {
    expect(ancestorsToExpand(fixture(), 'fn:core/a.ts#one').sort()).toEqual([
      'domain:core',
      'file:core/a.ts',
    ]);
  });
});
