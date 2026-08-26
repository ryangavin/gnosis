/**
 * Reference render. Same cut, same lifted edges, but handed to Graphviz —
 * which does its own clustering and edge routing end to end, so nothing of
 * ours sits between the data and the picture.
 *
 * If this looks right and the ELK render does not, the bug is in our ELK
 * plumbing. If this looks wrong too, the bug is in model.ts.
 *
 *   node poc/dot.ts ../better-session-view --open domain:chart
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Graphviz } from '@hpcc-js/wasm-graphviz';
import { dataDirFor, graphPathFor } from '../src/config.ts';
import type { GNode, GraphArtifact, NodeKind } from '../src/graph/schema.ts';
import { childrenOf, cut, domainOf, indexGraph, liftEdges, openToDepth } from '../src/graph/cut.ts';

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

const visible = cut(index, open);
const edges = liftEdges(graph, index, visible);

const hue = (id: string) => {
  const domains = index.roots.map((r) => r.id);
  const d = domainOf(index, id);
  return Math.round((domains.indexOf(d ?? '') * 137.508) % 360) / 360;
};
const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

const lines = [
  'digraph gnosis {',
  '  graph [compound=true, rankdir=LR, bgcolor="#0b0f16", fontcolor="#cbd5e1", fontname="Helvetica", newrank=true];',
  '  node  [shape=box, style="filled,rounded", fontname="Helvetica", fontsize=10, color="#94a3b8", fontcolor="#f1f5f9", height=0.28];',
  '  edge  [color="#94a3b880", arrowsize=0.6];',
];

let clusterN = 0;
const emit = (node: GNode, pad: string) => {
  const kids = childrenOf(index, node.id).filter((c) => visible.has(c.id));
  const h = hue(node.id).toFixed(3);
  if (kids.length) {
    lines.push(`${pad}subgraph cluster_${clusterN++} {`);
    lines.push(`${pad}  label=${q(node.name)}; fontcolor="${h} 0.5 0.85"; color="${h} 0.5 0.6"; style=rounded; penwidth=1.4;`);
    for (const kid of kids) emit(kid, pad + '  ');
    lines.push(`${pad}}`);
  } else {
    const ran = (node.runtime?.calls ?? 0) > 0;
    lines.push(`${pad}${q(node.id)} [label=${q(node.name)}, fillcolor="${h} ${ran ? '0.55 0.5' : '0.2 0.28'}"];`);
  }
};
for (const root of index.roots) if (visible.has(root.id)) emit(root, '  ');

// Graphviz cannot terminate an edge on a cluster, so an edge touching an open
// container is drawn to any node inside it and clipped back with lhead/ltail.
const clusterAnchor = new Map<string, string>();
const anchorFor = (id: string): string => {
  const cached = clusterAnchor.get(id);
  if (cached) return cached;
  let node = index.byId.get(id)!;
  while (true) {
    const kids = childrenOf(index, node.id).filter((c) => visible.has(c.id));
    if (!kids.length) break;
    node = kids[0]!;
  }
  clusterAnchor.set(id, node.id);
  return node.id;
};
const clusterIdOf = new Map<string, number>();
clusterN = 0;
const numberClusters = (node: GNode) => {
  const kids = childrenOf(index, node.id).filter((c) => visible.has(c.id));
  if (kids.length) {
    clusterIdOf.set(node.id, clusterN++);
    for (const kid of kids) numberClusters(kid);
  }
};
for (const root of index.roots) if (visible.has(root.id)) numberClusters(root);

for (const edge of edges) {
  const attrs: string[] = [];
  if (edge.kind === 'imports') attrs.push('style=dotted');
  else if (edge.calls === 0) attrs.push('style=dashed');
  else attrs.push(`penwidth=${Math.min(3.5, 0.8 + Math.log10(edge.calls + 1)).toFixed(1)}`);
  attrs.push(`color="${hue(edge.from).toFixed(3)} 0.5 0.75"`);
  const tail = clusterIdOf.get(edge.from);
  const head = clusterIdOf.get(edge.to);
  if (tail !== undefined) attrs.push(`ltail=cluster_${tail}`);
  if (head !== undefined) attrs.push(`lhead=cluster_${head}`);
  lines.push(`  ${q(anchorFor(edge.from))} -> ${q(anchorFor(edge.to))} [${attrs.join(', ')}];`);
}
lines.push('}');

const dot = lines.join('\n');
const out = resolve(flag('out') ?? 'poc/reference.svg');
const started = performance.now();
const svg = (await Graphviz.load()).layout(dot, 'svg', 'dot');
console.log(`cut      ${visible.size} of ${graph.nodes.length} nodes, ${open.size} open`);
console.log(`edges    ${edges.length} lifted from ${graph.edges.length}`);
console.log(`graphviz ${(performance.now() - started).toFixed(0)} ms`);
writeFileSync(out, svg);
writeFileSync(out.replace(/\.svg$/, '.dot'), dot);
console.log(`wrote    ${out}\n         ${out.replace(/\.svg$/, '.dot')}`);
