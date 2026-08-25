import { existsSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dataDirFor, graphPathFor, loadConfig } from '../../config.ts';
import { scanTarget } from '../../analyzer/scan.ts';
import { mergeTraces } from '../../graph/merge.ts';
import { loadGraph, saveGraph } from '../../graph/store.ts';
import { traceTarget } from '../../tracer/run.ts';

export async function runTrace(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { config: { type: 'string' } },
  });
  const repo = positionals[0];
  if (!repo) throw new Error('usage: gnosis trace <repo>');

  const targetRoot = realpathSync(repo);
  const dataDir = dataDirFor(targetRoot);
  const config = loadConfig(dataDir, values.config);
  const graphPath = graphPathFor(dataDir);

  if (!existsSync(graphPath)) {
    process.stdout.write('no graph yet — scanning first\n');
    saveGraph(graphPath, scanTarget(targetRoot, config));
  }

  const run = traceTarget(targetRoot, dataDir, config);
  const graph = loadGraph(graphPath);
  const stats = mergeTraces(graph, run.traceDir);
  saveGraph(graphPath, graph);

  const overhead = run.instrumented.wallMs / Math.max(1, run.baseline.wallMs);
  const functions = graph.nodes.filter((n) => n.kind === 'function').length;
  process.stdout.write(
    `trace merged: ${run.instrumented.passed}/${run.instrumented.total} tests passed, matching baseline\n` +
      `  overhead ${overhead.toFixed(2)}x (${(run.baseline.wallMs / 1000).toFixed(1)}s → ${(
        run.instrumented.wallMs / 1000
      ).toFixed(1)}s)\n` +
      `  ${stats.edgesMatched} static edges confirmed, ${stats.edgesAdded} runtime-only edges added, ` +
      `${stats.joinMisses} join misses\n` +
      `  ${stats.functionsConfirmed}/${functions} functions observed under test\n` +
      `  → ${graphPath}\n`,
  );
}
