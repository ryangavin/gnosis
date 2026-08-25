/**
 * The graph artifact contract shared by the analyzer, tracer, viz, MCP
 * server, and markdown emitter.
 *
 * Nothing here mentions TypeScript: a future analyzer for another language
 * feeds the same shapes. Containment is the `parent` field, not edges — the
 * viz builds its compound nodes straight from it. Static and runtime
 * observations of a call are two facets of one edge, never two edges.
 */

export interface GraphArtifact {
  version: 1;
  target: {
    /** Absolute realpath of the scanned repo root. */
    root: string;
    name: string;
    scannedAt: string;
    tracedAt?: string;
    git?: { commit: string; branch: string };
    /** Honest notes about what this graph cannot see. */
    limitations: string[];
  };
  nodes: GNode[];
  edges: GEdge[];
}

export type NodeKind = 'repo' | 'domain' | 'file' | 'function';

export interface GNode {
  /**
   * "repo" | "domain:visuals/render" | "file:core/src/ops.ts"
   * | "fn:core/src/ops.ts#SnapshotStore.applyOps"
   */
  id: string;
  kind: NodeKind;
  /** Display name: basename, symbol name, or domain name. */
  name: string;
  /** Containment: repo → domain → [subdomain] → file → function. */
  parent?: string;
  /** Function nodes: character span and 1-based start line in the file. */
  span?: { start: number; end: number; line: number };
  flags?: {
    exported?: boolean;
    reactComponent?: boolean;
    testFile?: boolean;
    async?: boolean;
  };
  doc?: {
    /** First sentence of the doc comment. */
    summary?: string;
    /** The full doc comment text. */
    tsdoc?: string;
    /** Associated markdown files; excerpts only, full bodies read on demand. */
    docFiles?: { path: string; title: string; excerpt: string }[];
  };
  /** Rolled up onto domain and repo nodes at scan time. */
  stats?: { loc?: number; files?: number; functions?: number; coveredFunctions?: number };
  /** Runtime observation; absent means unconfirmed by any test run. */
  runtime?: { calls: number; testFiles: string[] };
}

export type EdgeKind = 'imports' | 'calls';

export interface GEdge {
  /** `${kind}|${from}|${to}` */
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  /** Seen by the static analyzer. False means runtime-only (dynamic dispatch). */
  static: boolean;
  runtime?: { count: number; tests: string[]; testFiles: string[] };
  meta?: { lines?: number[]; jsx?: boolean };
}

export function edgeId(kind: EdgeKind, from: string, to: string): string {
  return `${kind}|${from}|${to}`;
}

export function fileId(relPath: string): string {
  return `file:${relPath}`;
}

export function functionId(relPath: string, qualifiedName: string): string {
  return `fn:${relPath}#${qualifiedName}`;
}

export function domainId(path: string): string {
  return `domain:${path}`;
}
