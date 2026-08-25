/**
 * gnosis executes from two places: the checkout (src/*.ts, Node type-strips
 * directly) and an installed package (dist/*.js — Node refuses to strip
 * types under node_modules, so the installed artifact is compiled by
 * `prepare`). These helpers make self-references resolve identically from
 * both trees.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root of the gnosis package itself, whether running from src/ or dist/. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name;
      if (name === 'gnosis') return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('cannot locate the gnosis package root');
    dir = parent;
  }
}

/**
 * A sibling module of the calling file, carrying the caller's own extension —
 * so a compiled caller names the compiled sibling, and a source caller the
 * source one. For paths handed to other tools (vitest --config, setupFiles),
 * which tsc's import rewriting never sees.
 */
export function ownSibling(metaUrl: string, stem: string): string {
  const self = fileURLToPath(metaUrl);
  return join(dirname(self), stem + extname(self));
}
