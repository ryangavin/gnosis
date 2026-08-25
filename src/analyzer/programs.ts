/**
 * Discovers the target's tsconfigs and hands out one ts.Program at a time.
 *
 * A monorepo has overlapping configs (bridge compiles the same files twice;
 * every module can pull in shared files), so files are claimed: a file
 * belongs to the first config, in sorted order, whose include matched it.
 * Later programs still use it for resolution but don't re-emit its nodes.
 * Files no config includes but some program loads (rare) fall to whichever
 * program sees them first.
 *
 * All paths are realpath'd before use: workspace symlinks mean the same
 * file has several names, and IDs must use the real one.
 */
import { readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export interface DiscoveredConfig {
  configPath: string;
  parsed: ts.ParsedCommandLine;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'wiki', 'dist']);

export function discoverTsconfigs(targetRoot: string): DiscoveredConfig[] {
  const configPaths: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(join(dir, entry.name));
        }
      } else if (/^tsconfig.*\.json$/.test(entry.name)) {
        configPaths.push(join(dir, entry.name));
      }
    }
  };
  walk(targetRoot);
  // Deepest first: a module's own config out-claims a root config. A root
  // extends-fragment (compilerOptions only, no include) default-includes the
  // whole tree and would otherwise swallow every module's files into a
  // program with the wrong resolution settings.
  const depth = (p: string): number => p.split(sep).length;
  configPaths.sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1));

  const configs: DiscoveredConfig[] = [];
  for (const configPath of configPaths) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) continue;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, join(configPath, '..'));
    if (parsed.fileNames.length > 0) configs.push({ configPath, parsed });
  }
  return configs;
}

export function toRelPath(targetRoot: string, absPath: string): string {
  return relative(targetRoot, absPath).split(sep).join('/');
}

/** realpath that tolerates missing files (returns the input). */
export function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when a realpath'd file should contribute nodes: inside the target,
 * not vendored, not generated-into-dist, not the wiki.
 */
export function isInTarget(targetRoot: string, realPath: string): boolean {
  if (!realPath.startsWith(targetRoot + sep)) return false;
  const rel = toRelPath(targetRoot, realPath);
  return !rel.split('/').some((part) => SKIP_DIRS.has(part));
}

/** Maps each claimable realpath to the config that owns it, in sorted config order. */
export function buildClaims(targetRoot: string, configs: DiscoveredConfig[]): Map<string, string> {
  const claims = new Map<string, string>();
  for (const { configPath, parsed } of configs) {
    for (const fileName of parsed.fileNames) {
      const real = safeRealpath(fileName);
      if (!isInTarget(targetRoot, real)) continue;
      if (!claims.has(real)) claims.set(real, configPath);
    }
  }
  return claims;
}

export function createProgramFor(config: DiscoveredConfig): ts.Program {
  return ts.createProgram(config.parsed.fileNames, config.parsed.options);
}
