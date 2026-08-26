import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeTraces } from './merge.ts';
import type { GNode, GraphArtifact } from './schema.ts';

function graphOf(...nodes: GNode[]): GraphArtifact {
  return {
    version: 1,
    target: { root: '/x', name: 'x', scannedAt: '', limitations: [] },
    nodes,
    edges: [],
  };
}

/** One NDJSON file per worker, which is how vitest actually writes them. */
function traceDirOf(perWorker: object[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-merge-'));
  perWorker.forEach((lines, i) => {
    writeFileSync(
      join(dir, `trace-${1000 + i}.ndjson`),
      lines.map((l) => JSON.stringify(l)).join('\n'),
    );
  });
  return dir;
}

const edge = (to: string, n: number, testFile: string) => ({
  t: 'edge',
  from: '',
  to,
  n,
  tests: [`t in ${testFile}`],
  testFiles: [testFile],
});

describe('importance rollups', () => {
  const tree = () =>
    graphOf(
      { id: 'repo', kind: 'repo', name: 'r' },
      { id: 'domain:a', kind: 'domain', name: 'a', parent: 'repo' },
      { id: 'dir:a/src', kind: 'directory', name: 'src', parent: 'domain:a' },
      { id: 'file:a/src/f.ts', kind: 'file', name: 'f.ts', parent: 'dir:a/src' },
      { id: 'fn:a/src/f.ts#go', kind: 'function', name: 'go', parent: 'file:a/src/f.ts' },
    );

  it('counts breadth past the artifact test-file cap', () => {
    // 14 distinct test files, all reaching one function. The stored list is
    // capped at 10 for size; the *count* must not be.
    const workers = Array.from({ length: 14 }, (_, i) => [
      edge('fn:a/src/f.ts#go', 2, `a/src/f${i}.test.ts`),
    ]);
    const graph = tree();
    mergeTraces(graph, traceDirOf(workers));

    const fn = graph.nodes.find((n) => n.id === 'fn:a/src/f.ts#go')!;
    expect(graph.target.testFileCount).toBe(14);
    expect(fn.stats?.testFiles).toBe(14);
    expect(fn.stats?.testBreadth).toBe(1);
    expect(fn.stats?.calls).toBe(28);
    expect(fn.runtime?.testFiles).toHaveLength(10); // the artifact cap still applies
  });

  it('rolls breadth up every container, deduping test files', () => {
    const graph = graphOf(
      { id: 'repo', kind: 'repo', name: 'r' },
      { id: 'domain:a', kind: 'domain', name: 'a', parent: 'repo' },
      { id: 'dir:a/src', kind: 'directory', name: 'src', parent: 'domain:a' },
      { id: 'file:a/src/f.ts', kind: 'file', name: 'f.ts', parent: 'dir:a/src' },
      { id: 'fn:a/src/f.ts#one', kind: 'function', name: 'one', parent: 'file:a/src/f.ts' },
      { id: 'fn:a/src/f.ts#two', kind: 'function', name: 'two', parent: 'file:a/src/f.ts' },
    );
    // Both functions are hit by x.test.ts; only `two` is also hit by y.test.ts.
    mergeTraces(
      graph,
      traceDirOf([
        [edge('fn:a/src/f.ts#one', 1, 'x.test.ts'), edge('fn:a/src/f.ts#two', 1, 'x.test.ts')],
        [edge('fn:a/src/f.ts#two', 5, 'y.test.ts')],
      ]),
    );

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('fn:a/src/f.ts#one')!.stats?.testFiles).toBe(1);
    expect(byId.get('fn:a/src/f.ts#two')!.stats?.testFiles).toBe(2);
    // The union at the file, not the sum: x counted once.
    expect(byId.get('file:a/src/f.ts')!.stats?.testFiles).toBe(2);
    expect(byId.get('dir:a/src')!.stats?.testFiles).toBe(2);
    expect(byId.get('domain:a')!.stats?.testFiles).toBe(2);
    expect(byId.get('domain:a')!.stats?.calls).toBe(7);
    expect(byId.get('dir:a/src')!.stats?.coveredFunctions).toBe(2);
  });

  it('records calls with no attributable test as volume without breadth', () => {
    // A module-init call: it ran, but no test owns it.
    const graph = tree();
    mergeTraces(
      graph,
      traceDirOf([[{ t: 'edge', from: '', to: 'fn:a/src/f.ts#go', n: 9, tests: [], testFiles: [] }]]),
    );
    const fn = graph.nodes.find((n) => n.id === 'fn:a/src/f.ts#go')!;
    expect(fn.stats?.calls).toBe(9);
    expect(fn.stats?.testFiles).toBe(0);
    expect(fn.stats?.testBreadth).toBe(0);
  });
});
