/**
 * Vite plugin that instruments target source files at transform time.
 *
 * `enforce: 'pre'` places the transform before esbuild's type stripping, so
 * the code seen here is the original .ts/.tsx source with original spans —
 * which is what keeps the baked-in IDs identical to the static analyzer's.
 * Vite resolves workspace symlinks by default, but ids are realpath'd
 * anyway so an aliased import can never mint a second identity for a file.
 */
import { relative, sep } from 'node:path';
import type { Plugin } from 'vite';
import { instrument } from './instrument.ts';
import { safeRealpath } from '../analyzer/programs.ts';

export function gnosisTracePlugin(): Plugin {
  const targetRoot = safeRealpath(process.env.GNOSIS_TARGET_ROOT!);
  const excludes = JSON.parse(process.env.GNOSIS_TRACE_EXCLUDE ?? '[]') as string[];
  return {
    name: 'gnosis-trace',
    enforce: 'pre',
    transform(code, id) {
      const path = safeRealpath(id.split('?')[0]!);
      if (!path.startsWith(targetRoot + sep)) return null;
      if (path.includes(`${sep}node_modules${sep}`)) return null;
      if (!/\.tsx?$/.test(path)) return null;
      if (/\.test\.tsx?$/.test(path)) return null;
      const rel = relative(targetRoot, path).split(sep).join('/');
      if (excludes.some((pattern) => rel.includes(pattern))) return null;
      const result = instrument(code, rel);
      return result ? { code: result.code, map: result.map } : null;
    },
  };
}
