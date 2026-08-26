/**
 * Layout tuning harness. Runs the *real* cut through several ELK option sets
 * and reports how big the canvas comes out, so spacing decisions are measured
 * rather than guessed.
 *
 *   node poc/sweep.ts ../better-session-view --open domain:visuals --open dir:visuals/src
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDirFor, graphPathFor } from '../src/config.ts';
import type { GraphArtifact, NodeKind } from '../src/graph/schema.ts';
import { cut, indexGraph, liftEdges, openPassThrough, openToDepth } from '../src/graph/cut.ts';
import { layout, type LayoutOptions } from './layout.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};
const all = (n: string) => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${n}` && argv[i + 1]) out.push(argv[i + 1]!);
  return out;
};

const target = realpathSync(resolve(argv.find((a) => !a.startsWith('--')) ?? '../better-session-view'));
const graph = JSON.parse(readFileSync(graphPathFor(dataDirFor(target)), 'utf8')) as GraphArtifact;
const index = indexGraph(graph);

const depth = flag('depth') as NodeKind | undefined;
const open = depth ? openToDepth(index, depth) : new Set<string>();
for (const needle of all('open')) {
  for (const hit of graph.nodes.filter((n) => n.kind !== 'function' && (n.name === needle || n.id.includes(needle)))) {
    open.add(hit.id);
    let up = hit.parent ? index.byId.get(hit.parent) : undefined;
    while (up) { open.add(up.id); up = up.parent ? index.byId.get(up.parent) : undefined; }
  }
}
openPassThrough(index, open);
const visible = cut(index, open);
const edges = liftEdges(graph, index, visible);

// An import edge between a pair that already has a call edge says nothing
// the call edge did not; dropping those is free noise reduction.
const callPairs = new Set(edges.filter((e) => e.kind === 'calls').map((e) => `${e.from}|${e.to}`));
const deduped = edges.filter((e) => e.kind === 'calls' || !callPairs.has(`${e.from}|${e.to}`));
const callsOnly = edges.filter((e) => e.kind === 'calls');

const variants: [string, LayoutOptions, typeof edges][] = [
  ['RIGHT, all edges (current)', { direction: 'RIGHT' }, edges],
  ['DOWN, all edges', { direction: 'DOWN' }, edges],
  ['RIGHT + wrap MULTI_EDGE', { direction: 'RIGHT', wrapping: 'MULTI_EDGE' }, edges],
  ['RIGHT, redundant imports cut', { direction: 'RIGHT' }, deduped],
  ['RIGHT, calls only', { direction: 'RIGHT' }, callsOnly],
  ['SEPARATE_CHILDREN, all', { direction: 'RIGHT', hierarchy: 'SEPARATE_CHILDREN' }, edges],
  ['SEPARATE_CHILDREN, calls only', { direction: 'RIGHT', hierarchy: 'SEPARATE_CHILDREN' }, callsOnly],
  ['SEPARATE + DOWN, calls only', { direction: 'DOWN', hierarchy: 'SEPARATE_CHILDREN' }, callsOnly],
];

const kinds = (list: typeof edges) =>
  `${list.filter((e) => e.kind === 'calls').length}c/${list.filter((e) => e.kind === 'imports').length}i`;
console.log(`${visible.size} visible nodes, ${edges.length} lifted edges (${kinds(edges)})`);
console.log(`  redundant imports cut → ${deduped.length} (${kinds(deduped)}); calls only → ${callsOnly.length}\n`);
console.log(
  'variant'.padEnd(31),
  'ms'.padStart(6),
  'canvas'.padStart(13),
  'Mpx'.padStart(7),
  'aspect'.padStart(7),
  'fit@1440'.padStart(9),
);
for (const [label, options, edgeSet] of variants) {
  try {
    const r = await layout(index, visible, edgeSet, options);
    const area = (r.width * r.height) / 1e6;
    // The scale a 1440x820 viewport would need; below ~0.5 labels vanish.
    const fit = Math.min(1440 / r.width, 820 / r.height);
    console.log(
      label.padEnd(31),
      r.ms.toFixed(0).padStart(6),
      `${Math.round(r.width)}x${Math.round(r.height)}`.padStart(13),
      area.toFixed(1).padStart(7),
      (r.width / r.height).toFixed(2).padStart(7),
      fit.toFixed(2).padStart(9),
    );
  } catch (err) {
    console.log(label.padEnd(31), "  FAILED", String(err).slice(0, 60));
  }
}
