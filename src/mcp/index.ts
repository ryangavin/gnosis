#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { dataDirFor, graphPathFor } from '../config.ts';
import { loadGraph } from '../graph/store.ts';
import { createGnosisServer } from './server.ts';

const repo = process.argv[2];
if (!repo) {
  console.error('usage: node src/mcp/index.ts <repo>');
  process.exit(1);
}
const targetRoot = realpathSync(repo);
const graphPath = graphPathFor(dataDirFor(targetRoot));
const graph = loadGraph(graphPath);
const server = createGnosisServer({ graph, targetRoot });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`gnosis MCP server ready: ${graph.target.name} (${graph.nodes.length} nodes)`);
