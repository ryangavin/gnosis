import { copyFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { dataDirFor, graphPathFor, loadConfig } from '../../config.ts';
import { scanTarget } from '../../analyzer/scan.ts';
import { saveGraph } from '../../graph/store.ts';
import { packageRoot } from '../../paths.ts';

/**
 * Static export: the viz built for file-relative hosting (base './', graph
 * fetched as ./graph.json) plus the target's graph artifact, ready for any
 * static host — GitHub Pages included.
 */
export async function runExport(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, config: { type: 'string' } },
  });
  const repo = positionals[0];
  if (!repo) throw new Error('usage: gnosis export <repo> [--out <dir>]');

  const targetRoot = realpathSync(repo);
  const dataDir = dataDirFor(targetRoot);
  const graphPath = graphPathFor(dataDir);
  if (!existsSync(graphPath)) {
    process.stdout.write('no graph yet — scanning first\n');
    saveGraph(graphPath, scanTarget(targetRoot, loadConfig(dataDir, values.config)));
  }

  // The build empties outDir; refuse a directory that isn't a previous export.
  const outDir = resolve(values.out ?? join(dataDir, 'site'));
  if (existsSync(outDir) && readdirSync(outDir).length > 0 && !existsSync(join(outDir, 'index.html'))) {
    throw new Error(`refusing to export into ${outDir}: it has contents that are not a previous export`);
  }

  await build({
    root: join(packageRoot(), 'viz'),
    configFile: false,
    base: './',
    plugins: [react()],
    build: { outDir, emptyOutDir: true },
  });
  copyFileSync(graphPath, join(outDir, 'graph.json'));
  process.stdout.write(`static site → ${outDir}\n`);
}
