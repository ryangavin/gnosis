import { existsSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dataDirFor, graphPathFor, loadConfig } from '../../config.ts';
import { scanTarget } from '../../analyzer/scan.ts';
import { loadGraph, saveGraph } from '../../graph/store.ts';
import { createGnosisServer } from '../../mcp/server.ts';

export async function runMcp(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { config: { type: 'string' } },
  });
  const repo = positionals[0];
  if (!repo) throw new Error('usage: gnosis mcp <repo>');

  const targetRoot = realpathSync(repo);
  const dataDir = dataDirFor(targetRoot);
  const graphPath = graphPathFor(dataDir);
  if (!existsSync(graphPath)) {
    console.error('no graph yet — scanning first');
    saveGraph(graphPath, scanTarget(targetRoot, loadConfig(dataDir, values.config)));
  }
  const graph = loadGraph(graphPath);
  const server = createGnosisServer({ graph, targetRoot });
  await server.connect(new StdioServerTransport());
  console.error(`gnosis MCP server ready: ${graph.target.name} (${graph.nodes.length} nodes)`);
}
