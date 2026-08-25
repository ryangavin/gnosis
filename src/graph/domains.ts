/**
 * Layer-2 grouping, purely mechanical: top-level domains are the target's
 * workspace entries plus any first-level directory carrying its own
 * package.json (which catches non-workspace packages). A domain holding
 * more than SPLIT_THRESHOLD files splits into subdomains by its second-level
 * source directory, with `src/` treated as transparent.
 *
 * A gnosis.yaml can override display names and descriptions; the future
 * LLM-labeling pass writes into that same slot.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GnosisConfig } from '../config.ts';

export const SPLIT_THRESHOLD = 30;

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

export interface DomainAssignment {
  domain?: string;
  subdomain?: string;
}

/**
 * Assign a file to its domain, and — when the domain is large enough to
 * split — its subdomain. A first-level directory that isn't a declared
 * domain still groups its files as an implicit one. `fileCounts` maps
 * domain → total file count. Files at the repo root belong to no domain.
 */
export function assignDomain(relPath: string, fileCounts: Map<string, number>): DomainAssignment {
  const parts = relPath.split('/');
  if (parts.length < 2) return {};
  const domain = parts[0]!;
  if ((fileCounts.get(domain) ?? 0) <= SPLIT_THRESHOLD) return { domain };

  const rest = parts.slice(1);
  const visible = rest[0] === 'src' ? rest.slice(1) : rest;
  if (visible.length >= 2) return { domain, subdomain: `${domain}/${visible[0]!}` };
  return { domain };
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
