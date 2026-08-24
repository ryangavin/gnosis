/**
 * The config handed to the TARGET repo's own vitest via `--config`.
 *
 * It lives inside gnosis so that its bare imports resolve against gnosis's
 * node_modules, while everything target-specific arrives through env vars:
 *
 *   GNOSIS_TARGET_ROOT    absolute path to the target repo root
 *   GNOSIS_TARGET_CONFIG  absolute path to the target's vitest config file
 *   GNOSIS_OUT_DIR        directory to write trace NDJSON files into
 *
 * The target's config is loaded by dynamic import (Node 24 type-strips it;
 * its own `vitest/config` import resolves against the target's node_modules),
 * then extended: our instrumentation plugin is prepended, our setup file is
 * appended, and vite's cache is redirected so the target tree is never touched.
 */
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`gnosis shim config: missing env var ${name}`);
  return value;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export default async () => {
  const targetRoot = required('GNOSIS_TARGET_ROOT');
  const targetConfig = required('GNOSIS_TARGET_CONFIG');
  const outDir = required('GNOSIS_OUT_DIR');

  const mod = await import(pathToFileURL(targetConfig).href);
  const base =
    typeof mod.default === 'function'
      ? await mod.default({ mode: 'test', command: 'serve' })
      : await mod.default;

  const { gnosisTracePlugin } = await import('./plugin.ts');

  return {
    ...base,
    root: targetRoot,
    cacheDir: join(outDir, '..', 'vite-cache'),
    plugins: [gnosisTracePlugin(), ...(base.plugins ?? [])],
    test: {
      ...base.test,
      setupFiles: [
        ...toArray<string>(base.test?.setupFiles),
        fileURLToPath(new URL('./setup.ts', import.meta.url)),
      ],
    },
  };
};
