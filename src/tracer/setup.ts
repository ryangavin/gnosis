/**
 * Vitest setup file appended to the target's config by the shim. Runs once
 * per worker process, before any test module loads: installs the collector
 * globals the instrumented code calls, records test attribution via
 * vitest's own hooks, and flushes aggregates per finished test file plus at
 * process exit. flush() resets the aggregates, so the appended NDJSON lines
 * are increments that merge simply sums.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeEach } from 'vitest';
import { createCollector } from './runtime.ts';

const outDir = process.env.GNOSIS_OUT_DIR!;
const targetRoot = process.env.GNOSIS_TARGET_ROOT!;
mkdirSync(outDir, { recursive: true });

const collector = createCollector();
const g = globalThis as unknown as {
  __gnosisEnter?: (id: string) => void;
  __gnosisExit?: () => void;
};
g.__gnosisEnter = collector.enter;
g.__gnosisExit = collector.exit;

const outPath = join(outDir, `trace-${process.pid}.ndjson`);
const flush = (): void => {
  const lines = collector.flush();
  if (lines.length > 0) {
    appendFileSync(outPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
};

beforeEach((ctx) => {
  const filepath = ctx.task.file?.filepath;
  collector.setCurrentTest(
    ctx.task.name,
    filepath ? relative(targetRoot, filepath).split(sep).join('/') : '',
  );
});

afterAll(flush);
process.on('exit', flush);
