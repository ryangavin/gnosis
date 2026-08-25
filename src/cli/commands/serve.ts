import { existsSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dataDirFor, graphPathFor, loadConfig } from '../../config.ts';
import { scanTarget } from '../../analyzer/scan.ts';
import { saveGraph } from '../../graph/store.ts';
import { serveGraph } from '../../serve/server.ts';

export async function runServe(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { port: { type: 'string' }, config: { type: 'string' } },
  });
  const repo = positionals[0];
  if (!repo) throw new Error('usage: gnosis serve <repo> [--port 4400]');

  const targetRoot = realpathSync(repo);
  const dataDir = dataDirFor(targetRoot);
  const graphPath = graphPathFor(dataDir);
  if (!existsSync(graphPath)) {
    process.stdout.write('no graph yet — scanning first\n');
    saveGraph(graphPath, scanTarget(targetRoot, loadConfig(dataDir, values.config)));
  }
  await serveGraph(graphPath, values.port ? Number(values.port) : 4400);
}
