/**
 * Runs the target's own test suite twice — a clean baseline, then
 * instrumented through the shim config — and refuses to accept a trace
 * whose pass/fail counts differ from baseline: a trace that changes test
 * behavior is worse than no trace. Reports the overhead honestly.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GnosisConfig } from '../config.ts';
import { ownSibling } from '../paths.ts';

export interface RunCounts {
  passed: number;
  failed: number;
  total: number;
  wallMs: number;
}

export interface TraceRunResult {
  baseline: RunCounts;
  instrumented: RunCounts;
  traceDir: string;
}

const CONFIG_CANDIDATES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vite.config.ts',
];

export function findTargetConfig(targetRoot: string): string {
  for (const name of CONFIG_CANDIDATES) {
    const path = join(targetRoot, name);
    if (existsSync(path)) return path;
  }
  throw new Error(`no vitest config found at the root of ${targetRoot}`);
}

function runVitest(
  targetRoot: string,
  jsonOut: string,
  extraArgs: string[],
  env: Record<string, string>,
): RunCounts {
  const started = Date.now();
  const result = spawnSync(
    'npx',
    [
      'vitest',
      'run',
      '--reporter=basic',
      '--reporter=json',
      `--outputFile=${jsonOut}`,
      ...extraArgs,
    ],
    {
      cwd: targetRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...env },
    },
  );
  const wallMs = Date.now() - started;
  if (result.error) throw result.error;
  if (!existsSync(jsonOut)) {
    throw new Error('vitest produced no JSON report — the run likely failed to start');
  }
  const report = JSON.parse(readFileSync(jsonOut, 'utf8')) as {
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
  };
  return {
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    total: report.numTotalTests,
    wallMs,
  };
}

export function traceTarget(
  targetRoot: string,
  dataDir: string,
  config: GnosisConfig,
): TraceRunResult {
  const targetConfig = findTargetConfig(targetRoot);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const traceDir = join(dataDir, 'traces', runId);
  mkdirSync(traceDir, { recursive: true });

  process.stdout.write('baseline run…\n');
  const baseline = runVitest(targetRoot, join(traceDir, 'baseline.json'), [], {});

  process.stdout.write('instrumented run…\n');
  const shim = ownSibling(import.meta.url, 'shim.vitest.config');
  const instrumented = runVitest(targetRoot, join(traceDir, 'run.json'), ['--config', shim], {
    GNOSIS_TARGET_ROOT: targetRoot,
    GNOSIS_TARGET_CONFIG: targetConfig,
    GNOSIS_OUT_DIR: traceDir,
    GNOSIS_TRACE_EXCLUDE: JSON.stringify(config.trace?.exclude ?? []),
  });

  if (baseline.passed !== instrumented.passed || baseline.failed !== instrumented.failed) {
    throw new Error(
      `instrumentation changed test results — baseline ${baseline.passed} passed / ${baseline.failed} failed, ` +
        `instrumented ${instrumented.passed} passed / ${instrumented.failed} failed. ` +
        `Trace kept for inspection at ${traceDir}, but not merged.`,
    );
  }
  return { baseline, instrumented, traceDir };
}
