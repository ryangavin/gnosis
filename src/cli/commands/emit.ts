import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dataDirFor, graphPathFor, loadConfig } from '../../config.ts';
import { scanTarget } from '../../analyzer/scan.ts';
import { emitMarkdown } from '../../emit/markdown.ts';
import { loadGraph, saveGraph } from '../../graph/store.ts';

export async function runEmit(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, config: { type: 'string' } },
  });
  const repo = positionals[0];
  if (!repo) throw new Error('usage: gnosis emit <repo> [--out <dir>]');

  const targetRoot = realpathSync(repo);
  const dataDir = dataDirFor(targetRoot);
  const graphPath = graphPathFor(dataDir);
  if (!existsSync(graphPath)) {
    process.stdout.write('no graph yet — scanning first\n');
    saveGraph(graphPath, scanTarget(targetRoot, loadConfig(dataDir, values.config)));
  }
  const graph = loadGraph(graphPath);
  const outDir = values.out ?? join(dataDir, 'emit');
  const written = emitMarkdown(graph, outDir);
  process.stdout.write(written.map((p) => `wrote ${p}`).join('\n') + '\n');
}
