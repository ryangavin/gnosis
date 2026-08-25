/**
 * The gnosis MCP server: read-only graph queries for agents. Transport-
 * independent so tests exercise the exact tools stdio serves, mirroring the
 * house pattern. Every answer comes from the same query layer the markdown
 * emitter renders, plus docs_for, which reads full doc bodies live from the
 * target so the artifact can stay excerpt-sized.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { GraphArtifact } from '../graph/schema.ts';
import {
  calleesOf,
  contextOf,
  domainDetail,
  overview,
  search,
  tracePath,
  whoCalls,
} from '../graph/queries.ts';

const annotations = {
  read: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

const success = <T extends object>(value: T) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

const failure = (error: unknown) => ({
  isError: true,
  content: [
    {
      type: 'text' as const,
      text: error instanceof Error ? error.message : String(error),
    },
  ],
});

const NodeIdSchema = z
  .string()
  .min(1)
  .describe(
    "A graph node id: 'domain:visuals/render', 'file:core/src/ops.ts', or 'fn:core/src/ops.ts#applyOps'.",
  );

const DOC_BYTES_CAP = 60_000;

export interface GnosisServerOptions {
  graph: GraphArtifact;
  targetRoot: string;
}

export function createGnosisServer({ graph, targetRoot }: GnosisServerOptions): McpServer {
  const ctx = contextOf(graph);
  const server = new McpServer(
    { name: 'gnosis', version: '0.1.0' },
    {
      instructions:
        'A knowledge graph of this codebase: domains, files, functions, call edges, and which of them ' +
        'test runs actually observed. Start with overview to learn the shape, describe_domain to go ' +
        'deeper, and who_calls/callees_of before changing any function. Edges marked static-only were ' +
        'never observed running; treat them as claims, not proof.',
    },
  );

  server.registerResource(
    'overview',
    'gnosis://overview',
    {
      title: 'Architecture overview',
      description: 'Domains, their sizes and dependencies, reading order, and coverage.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(overview(ctx), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    'overview',
    {
      title: 'Repository overview',
      description:
        'The architecture at a glance: every domain with size, coverage, and dependencies, plus a suggested reading order and entry points.',
      inputSchema: z.object({}),
      annotations: annotations.read,
    },
    async () => success(overview(ctx)),
  );

  server.registerTool(
    'describe_domain',
    {
      title: 'Describe a domain',
      description:
        'One domain in depth: its files with summaries, public surface, hottest functions, untested files, and concrete cross-domain call edges.',
      inputSchema: z.object({
        domain: z.string().min(1).describe("Domain path, e.g. 'core' or 'visuals/render'."),
      }),
      annotations: annotations.read,
    },
    async ({ domain }) => {
      const detail = domainDetail(ctx, domain);
      return detail ? success(detail) : failure(new Error(`no domain named '${domain}'`));
    },
  );

  server.registerTool(
    'describe_node',
    {
      title: 'Describe a file or function',
      description:
        'Everything the graph knows about one node: docs, flags, span, runtime observations, callers and callees, contained functions.',
      inputSchema: z.object({ id: NodeIdSchema }),
      annotations: annotations.read,
    },
    async ({ id }) => {
      const node = ctx.indexes.byId.get(id);
      if (!node) return failure(new Error(`no node with id '${id}'`));
      const children = (ctx.indexes.childrenOf.get(id) ?? []).map((c) => ({
        id: c.id,
        kind: c.kind,
        summary: c.doc?.summary,
      }));
      return success({
        ...node,
        children,
        callers: whoCalls(ctx, id, 1),
        callees: calleesOf(ctx, id, 1),
      });
    },
  );

  server.registerTool(
    'who_calls',
    {
      title: 'Who calls this',
      description:
        'Incoming call edges up to a depth. Each edge says whether it is static-only or was observed under test, with counts and exercising tests.',
      inputSchema: z.object({
        id: NodeIdSchema,
        depth: z.number().int().min(1).max(3).default(1),
      }),
      annotations: annotations.read,
    },
    async ({ id, depth }) => {
      if (!ctx.indexes.byId.has(id)) return failure(new Error(`no node with id '${id}'`));
      return success({ edges: whoCalls(ctx, id, depth) });
    },
  );

  server.registerTool(
    'callees_of',
    {
      title: 'What this calls',
      description: 'Outgoing call edges up to a depth, with static/observed facets.',
      inputSchema: z.object({
        id: NodeIdSchema,
        depth: z.number().int().min(1).max(3).default(1),
      }),
      annotations: annotations.read,
    },
    async ({ id, depth }) => {
      if (!ctx.indexes.byId.has(id)) return failure(new Error(`no node with id '${id}'`));
      return success({ edges: calleesOf(ctx, id, depth) });
    },
  );

  server.registerTool(
    'trace_path',
    {
      title: 'Path between two nodes',
      description:
        'Shortest chain of call edges from one node to another, noting which hops were observed under test.',
      inputSchema: z.object({ from: NodeIdSchema, to: NodeIdSchema }),
      annotations: annotations.read,
    },
    async ({ from, to }) => {
      if (!ctx.indexes.byId.has(from)) return failure(new Error(`no node with id '${from}'`));
      if (!ctx.indexes.byId.has(to)) return failure(new Error(`no node with id '${to}'`));
      const path = tracePath(ctx, from, to);
      return path
        ? success({ path })
        : success({ path: null, note: 'no directed call path found' });
    },
  );

  server.registerTool(
    'docs_for',
    {
      title: 'Full documentation for a node',
      description:
        "A node's complete documentation: its doc comment plus the full bodies of associated markdown files, read live from the repo.",
      inputSchema: z.object({ id: NodeIdSchema }),
      annotations: annotations.read,
    },
    async ({ id }) => {
      const node = ctx.indexes.byId.get(id);
      if (!node) return failure(new Error(`no node with id '${id}'`));
      const docPaths = new Set<string>();
      let cursor = node;
      while (true) {
        for (const ref of cursor.doc?.docFiles ?? []) docPaths.add(ref.path);
        const parent = cursor.parent ? ctx.indexes.byId.get(cursor.parent) : undefined;
        if (!parent) break;
        cursor = parent;
      }
      let budget = DOC_BYTES_CAP;
      const documents: { path: string; body: string }[] = [];
      for (const path of docPaths) {
        if (budget <= 0) break;
        try {
          const body = readFileSync(join(targetRoot, path), 'utf8').slice(0, budget);
          budget -= body.length;
          documents.push({ path, body });
        } catch {
          documents.push({ path, body: '(file no longer readable)' });
        }
      }
      return success({ id, docComment: node.doc?.tsdoc ?? null, documents });
    },
  );

  server.registerTool(
    'coverage_of',
    {
      title: 'Test coverage picture',
      description:
        'For a domain: which functions test runs observed, which files no test touches. Absence of runtime data means unobserved, not broken.',
      inputSchema: z.object({
        domain: z.string().min(1).describe("Domain path, e.g. 'core'."),
      }),
      annotations: annotations.read,
    },
    async ({ domain }) => {
      const detail = domainDetail(ctx, domain);
      if (!detail) return failure(new Error(`no domain named '${domain}'`));
      return success({
        domain: detail.path,
        functions: detail.functions,
        observed: detail.coveredFunctions,
        untestedFiles: detail.untestedFiles,
        hottest: detail.mostCalled,
        traced: ctx.graph.target.tracedAt ?? null,
      });
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search the graph',
      description: 'Find domains, files, or functions by name or doc summary.',
      inputSchema: z.object({
        query: z.string().min(2),
        kind: z.enum(['domain', 'file', 'function']).optional(),
      }),
      annotations: annotations.read,
    },
    async ({ query, kind }) => success({ hits: search(ctx, query, kind) }),
  );

  return server;
}
