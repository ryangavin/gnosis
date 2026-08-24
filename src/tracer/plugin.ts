/**
 * Vite plugin that instruments target source files at transform time.
 *
 * `enforce: 'pre'` places the transform before esbuild's type stripping, so
 * the code seen here is the original .ts/.tsx source with original spans.
 *
 * SPIKE VERSION: logs which files would be instrumented instead of
 * instrumenting them, to prove the injection path end to end.
 */
import { appendFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

function isInstrumentable(id: string, targetRoot: string): boolean {
  const path = id.split('?')[0]!;
  if (!path.startsWith(targetRoot + sep)) return false;
  if (path.includes(`${sep}node_modules${sep}`)) return false;
  if (!/\.tsx?$/.test(path)) return false;
  if (/\.test\.tsx?$/.test(path)) return false;
  return true;
}

export function gnosisTracePlugin(): Plugin {
  const targetRoot = process.env.GNOSIS_TARGET_ROOT!;
  const outDir = process.env.GNOSIS_OUT_DIR!;
  return {
    name: 'gnosis-trace',
    enforce: 'pre',
    transform(_code, id) {
      if (!isInstrumentable(id, targetRoot)) return null;
      const rel = relative(targetRoot, id.split('?')[0]!).split(sep).join('/');
      appendFileSync(join(outDir, `transform-${process.pid}.log`), `${rel}\n`);
      return null;
    },
  };
}
