/**
 * Layer-2 grouping, purely mechanical: top-level domains are the target's
 * workspace entries plus any first-level directory carrying its own
 * package.json (which catches non-workspace packages). Everything below a
 * domain is the directory tree itself, one node per folder.
 *
 * v1 split large domains by second-level source directory once they passed a
 * file-count threshold, which meant a folder was a visible boundary only if
 * its domain happened to be big — `set/lib` got a box, `chart/server` did
 * not. The directory tree is the honest answer and needs no threshold.
 *
 * A gnosis.yaml can override display names and descriptions for any
 * container path, domain or directory alike; the future LLM-labeling pass
 * writes into that same slot.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GnosisConfig } from '../config.ts';

export function discoverDomains(targetRoot: string): string[] {
  const domains = new Set<string>();
  try {
    const pkg = JSON.parse(readFileSync(join(targetRoot, 'package.json'), 'utf8')) as {
      workspaces?: string[];
    };
    for (const entry of pkg.workspaces ?? []) {
      if (!entry.includes('*') && existsSync(join(targetRoot, entry))) domains.add(entry);
    }
  } catch {
    // No root package.json is fine; directories carry it from here.
  }
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (existsSync(join(targetRoot, entry.name, 'package.json'))) domains.add(entry.name);
  }
  return [...domains].sort();
}

export interface Containers {
  /** First path segment; absent for a file sitting at the repo root. */
  domain?: string;
  /** Every directory between the domain and the file, outermost first. */
  directories: string[];
}

/**
 * The containers a file sits inside. A first-level directory is the domain
 * whether or not it declared itself one; each deeper folder is a directory.
 *
 *   "chart/server/bassline.ts" → { domain: "chart", directories: ["chart/server"] }
 *   "core/ops.ts"             → { domain: "core",  directories: [] }
 *   "vitest.config.ts"        → { directories: [] }
 */
export function containersFor(relPath: string): Containers {
  const parts = relPath.split('/');
  if (parts.length < 2) return { directories: [] };
  const directories: string[] = [];
  for (let i = 1; i < parts.length - 1; i++) {
    directories.push(parts.slice(0, i + 1).join('/'));
  }
  return { domain: parts[0]!, directories };
}

/** The container one level up, or undefined at the top. */
export function parentPath(path: string): string | undefined {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? undefined : path.slice(0, cut);
}

export function domainDisplay(
  path: string,
  config: GnosisConfig,
): { name: string; description?: string } {
  const override = config.domains?.[path];
  return {
    name: override?.name ?? path.split('/').pop()!,
    description: override?.description,
  };
}
