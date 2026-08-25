/**
 * Persistence for the graph artifact. One pretty-printed JSON file per
 * target; every consumer loads the whole graph and works from the indexes
 * in indexes.ts. Swapping the storage later only touches this file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { GraphArtifact } from './schema.ts';

export function loadGraph(path: string): GraphArtifact {
  return JSON.parse(readFileSync(path, 'utf8')) as GraphArtifact;
}

export function saveGraph(path: string, graph: GraphArtifact): void {
  writeFileSync(path, JSON.stringify(graph, null, 1));
}
