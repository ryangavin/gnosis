/**
 * Associates the target's own markdown with graph nodes, mechanically:
 *
 *   <module>/docs/X.md   → the source file named X in that module,
 *                          else the subdomain named X, else the module
 *   <module>/README.md   → the module's domain node
 *   root README/CONTRIBUTING/DESIGN/AGENTS/docs/*.md → the repo node
 *
 * Only title and first-paragraph excerpt are stored; consumers read full
 * bodies from the target on demand.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface DocFileRef {
  path: string;
  title: string;
  excerpt: string;
}

export interface DocAssociations {
  /** Keyed by source file relPath. */
  forFiles: Map<string, DocFileRef[]>;
  /** Keyed by domain path (e.g. "visuals" or "visuals/render"). */
  forDomains: Map<string, DocFileRef[]>;
  forRepo: DocFileRef[];
}

export function readDocRef(targetRoot: string, relPath: string): DocFileRef | undefined {
  let text: string;
  try {
    text = readFileSync(join(targetRoot, relPath), 'utf8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  const heading = lines.find((l) => /^#\s/.test(l));
  const title = heading ? heading.replace(/^#+\s*/, '').trim() : basename(relPath, '.md');

  const paragraphs = text.split(/\n\s*\n/);
  const body = paragraphs.find((p) => {
    const t = p.trim();
    return t && !t.startsWith('#') && !t.startsWith('```') && !t.startsWith('|');
  });
  const excerpt = (body ?? '').trim().replace(/\s+/g, ' ').slice(0, 400);
  return { path: relPath, title, excerpt };
}

const ROOT_DOCS = ['README.md', 'CONTRIBUTING.md', 'DESIGN.md', 'AGENTS.md'];

export function harvestDocs(
  targetRoot: string,
  domainPaths: string[],
  fileRelPaths: string[],
  subdomainPaths: string[],
): DocAssociations {
  const forFiles = new Map<string, DocFileRef[]>();
  const forDomains = new Map<string, DocFileRef[]>();
  const forRepo: DocFileRef[] = [];

  const attach = (map: Map<string, DocFileRef[]>, key: string, ref: DocFileRef): void => {
    const list = map.get(key) ?? [];
    list.push(ref);
    map.set(key, list);
  };

  const filesByStem = new Map<string, string[]>();
  for (const rel of fileRelPaths) {
    const stem = basename(rel).replace(/\.(ts|tsx)$/, '');
    const list = filesByStem.get(stem) ?? [];
    list.push(rel);
    filesByStem.set(stem, list);
  }

  for (const name of ROOT_DOCS) {
    const ref = readDocRef(targetRoot, name);
    if (ref) forRepo.push(ref);
  }
  const rootDocsDir = join(targetRoot, 'docs');
  if (existsSync(rootDocsDir)) {
    for (const entry of readdirSync(rootDocsDir)) {
      if (!entry.endsWith('.md')) continue;
      const ref = readDocRef(targetRoot, `docs/${entry}`);
      if (ref) forRepo.push(ref);
    }
  }

  for (const domain of domainPaths) {
    const readme = readDocRef(targetRoot, `${domain}/README.md`);
    if (readme) attach(forDomains, domain, readme);

    const docsDir = join(targetRoot, domain, 'docs');
    if (!existsSync(docsDir)) continue;
    for (const entry of readdirSync(docsDir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const ref = readDocRef(targetRoot, `${domain}/docs/${entry}`);
      if (!ref) continue;
      const stem = basename(entry, '.md');
      const inDomain = (filesByStem.get(stem) ?? []).filter((rel) => rel.startsWith(domain + '/'));
      const subdomain = subdomainPaths.find((s) => s === `${domain}/${stem}`);
      if (inDomain.length > 0) {
        for (const rel of inDomain) attach(forFiles, rel, ref);
      } else if (subdomain) {
        attach(forDomains, subdomain, ref);
      } else {
        attach(forDomains, domain, ref);
      }
    }
  }

  return { forFiles, forDomains, forRepo };
}
