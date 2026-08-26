/**
 * `gnosis test <repo>` — middleware mode. The single instrumented run IS
 * the pipeline's test run: vitest output streams through, its exit status
 * becomes this command's exit status, and the graph overlay is read off
 * that one run. Use it in place of `vitest run` wherever the pipeline
 * should build the graph without paying for the suite twice; `gnosis
 * trace` remains the careful double-run that verifies instrumentation
 * against a baseline.
 */
import { existsSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dataDirFor, graphPathFor, loadConfig } from '../../config.ts';
import { scanTarget } from '../../analyzer/scan.ts';
import { mergeTraces } from '../../graph/merge.ts';
import { loadGraph, saveGraph } from '../../graph/store.ts';
import { instrumentTarget } from '../../tracer/run.ts';

/** Split `gnosis`'s own args from everything after `--`, which goes to vitest. */
export function splitVitestArgs(argv: string[]): { own: string[]; vitest: string[] } {
  const sep = argv.indexOf('--');
  if (sep === -1) return { own: argv, vitest: [] };
  return { own: argv.slice(0, sep), vitest: argv.slice(sep + 1) };
}

export async function runTest(argv: string[]): Promise<void> {
  const { own, vitest } = splitVitestArgs(argv);
  const { positionals, values } = parseArgs({
    args: own,
    allowPositionals: true,
    options: { config: { type: 'string' } },
  });
  const repo = positionals[0];
  if (!repo) throw new Error('usage: gnosis test <repo> [-- vitest args]');

  const targetRoot = realpathSync(repo);
  const dataDir = dataDirFor(targetRoot);
  const config = loadConfig(dataDir, values.config);
  const graphPath = graphPathFor(dataDir);

  if (!existsSync(graphPath)) {
    process.stdout.write('no graph yet — scanning first\n');
    saveGraph(graphPath, scanTarget(targetRoot, config));
  }

  const run = instrumentTarget(targetRoot, dataDir, config, vitest);
  const graph = loadGraph(graphPath);
  const stats = mergeTraces(graph, run.traceDir);
  saveGraph(graphPath, graph);

  const functions = graph.nodes.filter((n) => n.kind === 'function').length;
  const { passed, failed, total } = run.instrumented;
  process.stdout.write(
    `${passed}/${total} tests passed${failed > 0 ? ` — ${failed} FAILED` : ''} ` +
      `(${(run.instrumented.wallMs / 1000).toFixed(1)}s, instrumented)\n` +
      `  ${stats.edgesMatched} static edges confirmed, ${stats.edgesAdded} runtime-only edges added, ` +
      `${stats.joinMisses} join misses\n` +
      `  ${stats.functionsConfirmed}/${functions} functions observed under test\n` +
      `  → ${graphPath}\n`,
  );

  // The graph is updated either way — a failing test still executes real
  // code — but the pipeline must see the suite's verdict.
  if (run.instrumented.status !== 0) process.exitCode = run.instrumented.status;
}
