import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphArtifact } from '../graph/schema.ts';
import { createGnosisServer } from './server.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureGraph(): GraphArtifact {
  return {
    version: 1,
    target: {
      root: '/r',
      name: 'fix',
      scannedAt: 'now',
      tracedAt: 'later',
      limitations: ['a known blind spot'],
    },
    nodes: [
      { id: 'repo', kind: 'repo', name: 'fix', stats: { files: 2, functions: 3, loc: 60, coveredFunctions: 1 } },
      {
        id: 'domain:core',
        kind: 'domain',
        name: 'core',
        parent: 'repo',
        stats: { files: 1, functions: 2, loc: 40, coveredFunctions: 1 },
        doc: { docFiles: [{ path: 'core/README.md', title: 'core', excerpt: 'Pure logic.' }] },
      },
      {
        id: 'domain:ui',
        kind: 'domain',
        name: 'ui',
        parent: 'repo',
        stats: { files: 1, functions: 1, loc: 20, coveredFunctions: 0 },
      },
      {
        id: 'file:core/a.ts',
        kind: 'file',
        name: 'a.ts',
        parent: 'domain:core',
        stats: { loc: 40 },
        doc: { summary: 'Holds ops.', docFiles: [{ path: 'core/docs/a.md', title: 'a', excerpt: 'The ops file.' }] },
      },
      { id: 'file:ui/b.ts', kind: 'file', name: 'b.ts', parent: 'domain:ui', stats: { loc: 20 } },
      {
        id: 'fn:core/a.ts#one',
        kind: 'function',
        name: 'one',
        parent: 'file:core/a.ts',
        flags: { exported: true },
        doc: { summary: 'Does one thing.' },
      },
      {
        id: 'fn:core/a.ts#two',
        kind: 'function',
        name: 'two',
        parent: 'file:core/a.ts',
        flags: { exported: true },
        runtime: { calls: 7, testFiles: ['core/a.test.ts'] },
      },
      { id: 'fn:ui/b.ts#use', kind: 'function', name: 'use', parent: 'file:ui/b.ts', flags: { exported: true } },
    ],
    edges: [
      { id: 'calls|fn:ui/b.ts#use|fn:core/a.ts#one', kind: 'calls', from: 'fn:ui/b.ts#use', to: 'fn:core/a.ts#one', static: true },
      {
        id: 'calls|fn:core/a.ts#one|fn:core/a.ts#two',
        kind: 'calls',
        from: 'fn:core/a.ts#one',
        to: 'fn:core/a.ts#two',
        static: true,
        runtime: { count: 7, tests: ['does the thing'], testFiles: ['core/a.test.ts'] },
      },
    ],
  };
}

async function connect(graph: GraphArtifact, targetRoot: string) {
  const server = createGnosisServer({ graph, targetRoot });
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('the gnosis MCP boundary', () => {
  it('serves the overview with domains, reading order, and limitations', async () => {
    const client = await connect(fixtureGraph(), '/nowhere');
    const result = await client.callTool({ name: 'overview', arguments: {} });
    const data = result.structuredContent as {
      domains: { path: string; dependsOn: { domain: string }[] }[];
      readingOrder: string[];
      limitations: string[];
    };
    expect(data.domains.map((d) => d.path).sort()).toEqual(['core', 'ui']);
    expect(data.readingOrder).toEqual(['core', 'ui']);
    expect(data.domains.find((d) => d.path === 'ui')?.dependsOn[0]?.domain).toBe('core');
    expect(data.limitations).toContain('a known blind spot');
  });

  it('answers who_calls with static and observed facets', async () => {
    const client = await connect(fixtureGraph(), '/nowhere');
    const result = await client.callTool({
      name: 'who_calls',
      arguments: { id: 'fn:core/a.ts#two', depth: 2 },
    });
    const { edges } = result.structuredContent as {
      edges: { from: string; static: boolean; count?: number }[];
    };
    expect(edges[0]).toMatchObject({ from: 'fn:core/a.ts#one', static: true, count: 7 });
    // Depth 2 reaches the ui caller of `one`.
    expect(edges.some((e) => e.from === 'fn:ui/b.ts#use')).toBe(true);
  });

  it('traces the shortest call path across domains', async () => {
    const client = await connect(fixtureGraph(), '/nowhere');
    const result = await client.callTool({
      name: 'trace_path',
      arguments: { from: 'fn:ui/b.ts#use', to: 'fn:core/a.ts#two' },
    });
    const { path } = result.structuredContent as { path: { to: string }[] };
    expect(path.map((s) => s.to)).toEqual(['fn:core/a.ts#one', 'fn:core/a.ts#two']);
  });

  it('reads full doc bodies from the target for docs_for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnosis-mcp-'));
    made.push(dir);
    mkdirSync(join(dir, 'core', 'docs'), { recursive: true });
    writeFileSync(join(dir, 'core', 'docs', 'a.md'), '# a\n\nThe full body of the ops doc.\n');
    writeFileSync(join(dir, 'core', 'README.md'), '# core\n\nPure logic, at length.\n');

    const client = await connect(fixtureGraph(), dir);
    const result = await client.callTool({
      name: 'docs_for',
      arguments: { id: 'fn:core/a.ts#one' },
    });
    const data = result.structuredContent as { documents: { path: string; body: string }[] };
    const paths = data.documents.map((d) => d.path).sort();
    expect(paths).toEqual(['core/README.md', 'core/docs/a.md']);
    expect(data.documents.find((d) => d.path === 'core/docs/a.md')?.body).toContain('full body');
  });

  it('reports coverage honestly, including untouched files', async () => {
    const client = await connect(fixtureGraph(), '/nowhere');
    const result = await client.callTool({ name: 'coverage_of', arguments: { domain: 'ui' } });
    expect(result.structuredContent).toMatchObject({
      domain: 'ui',
      functions: 1,
      observed: 0,
      untestedFiles: ['ui/b.ts'],
    });
  });

  it('searches by name and fails cleanly on unknown ids', async () => {
    const client = await connect(fixtureGraph(), '/nowhere');
    const found = await client.callTool({ name: 'search', arguments: { query: 'two' } });
    expect((found.structuredContent as { hits: { id: string }[] }).hits[0]?.id).toBe('fn:core/a.ts#two');

    const missing = await client.callTool({
      name: 'who_calls',
      arguments: { id: 'fn:nope.ts#gone' },
    });
    expect(missing.isError).toBe(true);
  });
});
