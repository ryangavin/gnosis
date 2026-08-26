/**
 * Runs the target's own test suite through the instrumentation shim. Two
 * entry points share the machinery:
 *
 * - `instrumentTarget` is middleware mode: ONE instrumented run that is
 *   meant to *be* the pipeline's test run — output streams through, the
 *   vitest exit status is reported back, and the trace is read off that
 *   single run, SonarQube-style.
 * - `traceTarget` is the careful mode: a clean baseline first, then the
 *   instrumented run, refusing to accept a trace whose pass/fail counts
 *   differ from baseline — a trace that changes test behavior is worse
 *   than no trace. Reports the overhead honestly.
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
  /** vitest's exit status — non-zero when the suite failed. */
  status: number;
}

export interface InstrumentedRunResult {
  instrumented: RunCounts;
  traceDir: string;
}

export interface TraceRunResult extends InstrumentedRunResult {
  baseline: RunCounts;
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
      // `basic` was removed in vitest 3; `default` has existed throughout and
      // streams the target's own output the same way.
      '--reporter=default',
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
    status: result.status ?? 1,
  };
}

function newTraceDir(dataDir: string): string {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const traceDir = join(dataDir, 'traces', runId);
  mkdirSync(traceDir, { recursive: true });
  return traceDir;
}

function runInstrumented(
  targetRoot: string,
  traceDir: string,
  config: GnosisConfig,
  vitestArgs: string[],
): RunCounts {
  const targetConfig = findTargetConfig(targetRoot);
  const shim = ownSibling(import.meta.url, 'shim.vitest.config');
  return runVitest(
    targetRoot,
    join(traceDir, 'run.json'),
    ['--config', shim, ...vitestArgs],
    {
      GNOSIS_TARGET_ROOT: targetRoot,
      GNOSIS_TARGET_CONFIG: targetConfig,
      GNOSIS_OUT_DIR: traceDir,
      GNOSIS_TRACE_EXCLUDE: JSON.stringify(config.trace?.exclude ?? []),
    },
  );
}

/** Middleware mode: one instrumented run, no baseline. */
export function instrumentTarget(
  targetRoot: string,
  dataDir: string,
  config: GnosisConfig,
  vitestArgs: string[] = [],
): InstrumentedRunResult {
  const traceDir = newTraceDir(dataDir);
  const instrumented = runInstrumented(targetRoot, traceDir, config, vitestArgs);
  return { instrumented, traceDir };
}

/** Careful mode: baseline first, then instrumented, refusing a divergent trace. */
export function traceTarget(
  targetRoot: string,
  dataDir: string,
  config: GnosisConfig,
  vitestArgs: string[] = [],
): TraceRunResult {
  const traceDir = newTraceDir(dataDir);

  process.stdout.write('baseline run…\n');
  const baseline = runVitest(targetRoot, join(traceDir, 'baseline.json'), vitestArgs, {});

  process.stdout.write('instrumented run…\n');
  const instrumented = runInstrumented(targetRoot, traceDir, config, vitestArgs);

  if (baseline.passed !== instrumented.passed || baseline.failed !== instrumented.failed) {
    throw new Error(
      `instrumentation changed test results — baseline ${baseline.passed} passed / ${baseline.failed} failed, ` +
        `instrumented ${instrumented.passed} passed / ${instrumented.failed} failed. ` +
        `Trace kept for inspection at ${traceDir}, but not merged.`,
    );
  }
  return { baseline, instrumented, traceDir };
}
