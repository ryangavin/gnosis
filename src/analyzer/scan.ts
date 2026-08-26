/**
 * The static scan: programs → function records → call/import edges →
 * domains → one GraphArtifact. Programs are processed one at a time and
 * released; a file contributes nodes exactly once (its claiming config,
 * else first loader), so overlapping monorepo configs don't duplicate.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { GnosisConfig } from '../config.ts';
import { containersFor, discoverDomains, domainDisplay, parentPath } from '../graph/domains.ts';
import {
  directoryId,
  domainId,
  edgeId,
  fileId,
  type GEdge,
  type GNode,
  type GraphArtifact,
} from '../graph/schema.ts';
import { analyzeCalls, createFileRecordCache, type CallSite } from './calls.ts';
import { analyzeImports } from './imports.ts';
import { harvestDocs } from './docs.ts';
import { docForFile, docForFunction, firstSentence } from './tsdoc.ts';
import {
  buildClaims,
  createProgramFor,
  discoverTsconfigs,
  isInTarget,
  safeRealpath,
  toRelPath,
} from './programs.ts';

const MAX_EDGE_LINES = 10;

interface FileInfo {
  relPath: string;
  loc: number;
  doc?: string;
  testFile: boolean;
}

interface FunctionInfo {
  id: string;
  relPath: string;
  name: string;
  span: { start: number; end: number; line: number };
  exported: boolean;
  isAsync: boolean;
  reactComponent: boolean;
  doc?: string;
}

function gitInfo(targetRoot: string): { commit: string; branch: string } | undefined {
  const run = (args: string[]): string | undefined => {
    const result = spawnSync('git', ['-C', targetRoot, ...args], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  const commit = run(['rev-parse', 'HEAD']);
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  return commit && branch ? { commit, branch } : undefined;
}

export function scanTarget(targetRootInput: string, config: GnosisConfig): GraphArtifact {
  const targetRoot = realpathSync(targetRootInput);

  const tsconfigs = discoverTsconfigs(targetRoot);
  if (tsconfigs.length === 0) {
    throw new Error(`no usable tsconfig found under ${targetRoot}`);
  }
  const claims = buildClaims(targetRoot, tsconfigs);
  const declaredDomains = discoverDomains(targetRoot);

  const files: FileInfo[] = [];
  const functions: FunctionInfo[] = [];
  const callSites: CallSite[] = [];
  const importPairs: { from: string; to: string; line: number }[] = [];
  const processed = new Set<string>();

  for (const tsconfig of tsconfigs) {
    const program = createProgramFor(tsconfig);
    const checker = program.getTypeChecker();
    const cache = createFileRecordCache(targetRoot);

    for (const sf of program.getSourceFiles()) {
      const real = safeRealpath(sf.fileName);
      if (!isInTarget(targetRoot, real)) continue;
      const claimedBy = claims.get(real);
      if (claimedBy !== undefined && claimedBy !== tsconfig.configPath) continue;
      if (processed.has(real)) continue;
      processed.add(real);

      const relPath = toRelPath(targetRoot, real);
      const testFile = /\.test\.tsx?$/.test(relPath);
      files.push({
        relPath,
        loc: sf.getLineStarts().length,
        doc: docForFile(sf),
        testFile,
      });

      if (sf.isDeclarationFile) continue;

      const { records } = cache.recordsFor(sf);
      for (const r of records) {
        functions.push({
          id: r.id,
          relPath,
          name: r.qualifiedName,
          span: r.span,
          exported: r.isExported,
          isAsync: r.isAsync,
          reactComponent: /^[A-Z]/.test(r.name) && relPath.endsWith('.tsx'),
          doc: docForFunction(r.node),
        });
      }
      callSites.push(...analyzeCalls(sf, checker, fileId(relPath), targetRoot, cache));
      for (const imp of analyzeImports(sf, program.getCompilerOptions(), targetRoot)) {
        const toRel = toRelPath(targetRoot, imp.toRealPath);
        if (toRel !== relPath) {
          importPairs.push({ from: fileId(relPath), to: fileId(toRel), line: imp.line });
        }
      }
    }
  }

  // --- Domains and directories ---
  const assignments = new Map(files.map((f) => [f.relPath, containersFor(f.relPath)]));
  const domainPaths = [
    ...new Set([...assignments.values()].flatMap((a) => (a.domain ? [a.domain] : []))),
  ].sort();
  const directoryPaths = [
    ...new Set([...assignments.values()].flatMap((a) => a.directories)),
  ].sort();

  const docs = harvestDocs(targetRoot, domainPaths, files.map((f) => f.relPath), directoryPaths);

  // --- Nodes ---
  let repoName = basename(targetRoot);
  try {
    const pkg = JSON.parse(readFileSync(join(targetRoot, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name) repoName = pkg.name;
  } catch {
    // Directory name stands in.
  }

  const nodes: GNode[] = [];
  nodes.push({
    id: 'repo',
    kind: 'repo',
    name: repoName,
    doc: docs.forRepo.length > 0 ? { docFiles: docs.forRepo } : undefined,
  });

  for (const path of domainPaths) {
    const display = domainDisplay(path, config);
    const refs = docs.forDomains.get(path);
    nodes.push({
      id: domainId(path),
      kind: 'domain',
      name: display.name,
      parent: 'repo',
      doc:
        refs || display.description
          ? { summary: display.description, docFiles: refs }
          : undefined,
    });
  }
  // A directory's parent is the next folder up, which is a domain once we
  // reach the first path segment.
  const containerId = (path: string): string =>
    path.includes('/') ? directoryId(path) : domainId(path);
  for (const path of directoryPaths) {
    const display = domainDisplay(path, config);
    const refs = docs.forDomains.get(path);
    nodes.push({
      id: directoryId(path),
      kind: 'directory',
      name: display.name,
      parent: containerId(parentPath(path)!),
      doc:
        refs || display.description
          ? { summary: display.description, docFiles: refs }
          : undefined,
    });
  }

  for (const f of files) {
    const assignment = assignments.get(f.relPath)!;
    const deepest = assignment.directories.at(-1);
    const parent = deepest
      ? directoryId(deepest)
      : assignment.domain
        ? domainId(assignment.domain)
        : 'repo';
    const refs = docs.forFiles.get(f.relPath);
    nodes.push({
      id: fileId(f.relPath),
      kind: 'file',
      name: basename(f.relPath),
      parent,
      flags: f.testFile ? { testFile: true } : undefined,
      stats: { loc: f.loc },
      doc:
        f.doc || refs
          ? { summary: f.doc ? firstSentence(f.doc) : undefined, tsdoc: f.doc, docFiles: refs }
          : undefined,
    });
  }

  for (const fn of functions) {
    nodes.push({
      id: fn.id,
      kind: 'function',
      name: fn.name,
      parent: fileId(fn.relPath),
      span: fn.span,
      flags:
        fn.exported || fn.isAsync || fn.reactComponent
          ? {
              exported: fn.exported || undefined,
              async: fn.isAsync || undefined,
              reactComponent: fn.reactComponent || undefined,
            }
          : undefined,
      doc: fn.doc ? { summary: firstSentence(fn.doc), tsdoc: fn.doc } : undefined,
    });
  }

  // --- Edges ---
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = new Map<string, GEdge>();
  let dangling = 0;

  for (const site of callSites) {
    if (!nodeIds.has(site.fromId) || !nodeIds.has(site.toId)) {
      dangling += 1;
      continue;
    }
    const id = edgeId('calls', site.fromId, site.toId);
    let edge = edges.get(id);
    if (!edge) {
      edge = { id, kind: 'calls', from: site.fromId, to: site.toId, static: true, meta: { lines: [] } };
      edges.set(id, edge);
    }
    if (edge.meta!.lines!.length < MAX_EDGE_LINES) edge.meta!.lines!.push(site.line);
    if (site.jsx) edge.meta!.jsx = true;
  }
  for (const imp of importPairs) {
    if (!nodeIds.has(imp.from) || !nodeIds.has(imp.to)) {
      dangling += 1;
      continue;
    }
    const id = edgeId('imports', imp.from, imp.to);
    let edge = edges.get(id);
    if (!edge) {
      edge = { id, kind: 'imports', from: imp.from, to: imp.to, static: true, meta: { lines: [] } };
      edges.set(id, edge);
    }
    if (edge.meta!.lines!.length < MAX_EDGE_LINES) edge.meta!.lines!.push(imp.line);
  }

  // --- Rollups: every container accumulates what sits beneath it, at any
  // depth, by walking the parent chain rather than knowing the layer names.
  const parentOf = new Map(nodes.flatMap((n) => (n.parent ? [[n.id, n.parent] as const] : [])));
  const rolled = new Map<string, { files: number; functions: number; loc: number }>();
  const fnCountByFile = new Map<string, number>();
  for (const fn of functions) {
    fnCountByFile.set(fn.relPath, (fnCountByFile.get(fn.relPath) ?? 0) + 1);
  }
  for (const f of files) {
    const fns = fnCountByFile.get(f.relPath) ?? 0;
    let current = parentOf.get(fileId(f.relPath));
    while (current) {
      const entry = rolled.get(current) ?? { files: 0, functions: 0, loc: 0 };
      entry.files += 1;
      entry.functions += fns;
      entry.loc += f.loc;
      rolled.set(current, entry);
      current = parentOf.get(current);
    }
  }
  for (const node of nodes) {
    const stats = rolled.get(node.id);
    if (stats) node.stats = stats;
  }
  // A file carries its own function count too, so "how much of this file is
  // covered" is answerable without walking its children.
  for (const node of nodes) {
    if (node.kind !== 'file') continue;
    const fns = fnCountByFile.get(node.id.slice('file:'.length)) ?? 0;
    if (fns) node.stats = { ...node.stats, functions: fns };
  }

  const limitations = [
    'Calls through interface members and callback-typed parameters are dynamic dispatch; they appear only when a test run traces them.',
    'Calls into npm packages and node builtins are not recorded.',
    'Types used via global declared namespaces leave no import edges.',
  ];
  if (dangling > 0) limitations.push(`${dangling} resolved call/import sites pointed outside the graph and were dropped.`);

  const kindOrder: Record<GNode['kind'], number> = {
    repo: 0,
    domain: 1,
    directory: 2,
    file: 3,
    function: 4,
  };
  nodes.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (a.id < b.id ? -1 : 1));
  const sortedEdges = [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    version: 1,
    target: {
      root: targetRoot,
      name: repoName,
      scannedAt: new Date().toISOString(),
      git: gitInfo(targetRoot),
      limitations,
    },
    nodes,
    edges: sortedEdges,
  };
}
