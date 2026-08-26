import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dataDirFor, graphPathFor, loadConfig } from '../../config.ts';
import { scanTarget } from '../../analyzer/scan.ts';
import { saveGraph } from '../../graph/store.ts';

export async function runScan(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { config: { type: 'string' } },
  });
  const repo = positionals[0];
  if (!repo) throw new Error('usage: gnosis scan <repo>');

  const targetRoot = realpathSync(repo);
  const dataDir = dataDirFor(targetRoot);
  const config = loadConfig(dataDir, values.config);

  const started = Date.now();
  const graph = scanTarget(targetRoot, config);
  const path = graphPathFor(dataDir);
  saveGraph(path, graph);

  const count = (kind: string): number => graph.nodes.filter((n) => n.kind === kind).length;
  process.stdout.write(
    `scanned ${graph.target.name} in ${((Date.now() - started) / 1000).toFixed(1)}s\n` +
      `  ${count('domain')} domains, ${count('directory')} directories, ` +
      `${count('file')} files, ${count('function')} functions\n` +
      `  ${graph.edges.filter((e) => e.kind === 'calls').length} call edges, ` +
      `${graph.edges.filter((e) => e.kind === 'imports').length} import edges\n` +
      `  → ${path}\n`,
  );
}
