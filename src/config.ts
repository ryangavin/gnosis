/**
 * Where gnosis keeps its per-target state, and the optional gnosis.yaml.
 *
 * Everything lives outside the target — `~/.gnosis/<basename>-<hash>/` —
 * so scanning never dirties the repo under study. The yaml is a side
 * channel for domain names/descriptions and trace excludes; `--config`
 * can point at one elsewhere.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface GnosisConfig {
  domains?: Record<string, { name?: string; description?: string }>;
  trace?: { exclude?: string[] };
}

export function dataDirFor(targetRoot: string): string {
  const hash = createHash('sha256').update(targetRoot).digest('hex').slice(0, 8);
  const dir = join(homedir(), '.gnosis', `${basename(targetRoot)}-${hash}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function graphPathFor(dataDir: string): string {
  return join(dataDir, 'graph.json');
}

export function loadConfig(dataDir: string, explicitPath?: string): GnosisConfig {
  const path = explicitPath ?? join(dataDir, 'gnosis.yaml');
  if (!existsSync(path)) return {};
  const parsed = parseYaml(readFileSync(path, 'utf8')) as GnosisConfig | null;
  return parsed ?? {};
}
