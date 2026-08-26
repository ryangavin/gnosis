/**
 * POC driver: cut the graph, lift the edges, hand it to ELK, dump one
 * self-contained HTML file.
 *
 *   node poc/run.ts ../better-session-view
 *   node poc/run.ts ../better-session-view --open core --open cli
 *   node poc/run.ts ../better-session-view --depth file --dir DOWN
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDirFor, graphPathFor } from '../src/config.ts';
import type { GraphArtifact, NodeKind } from '../src/graph/schema.ts';
import { cut, indexGraph, liftEdges, openPassThrough, openToDepth } from './model.ts';
import { layout, type LayoutOptions } from './layout.ts';
import { renderHtml } from './render.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const all = (name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
  return out;
};

const target = realpathSync(resolve(argv.find((a) => !a.startsWith('--')) ?? '../better-session-view'));
const graphPath = graphPathFor(dataDirFor(target));
const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as GraphArtifact;
const index = indexGraph(graph);

// Which containers are open: a depth sweep, plus anything named on the CLI
// (with its ancestors, so it is actually reachable in the cut).
const depth = flag('depth') as NodeKind | undefined;
const open = depth ? openToDepth(index, depth) : new Set<string>();
for (const needle of all('open')) {
  const hits = graph.nodes.filter(
    (n) => n.kind !== 'function' && (n.name === needle || n.id.includes(needle)),
  );
  if (!hits.length) console.warn(`  ! --open ${needle} matched nothing`);
  for (const hit of hits) {
    open.add(hit.id);
    let up = hit.parent ? index.byId.get(hit.parent) : undefined;
    while (up) {
      open.add(up.id);
      up = up.parent ? index.byId.get(up.parent) : undefined;
    }
  }
}

// A box that holds one box and nothing else is a wasted level.
if (!argv.includes('--no-compress')) openPassThrough(index, open);

// Tests are an overlay on the architecture, not part of it. `--with-tests`
// puts them back as boxes when you want to see the scaffolding itself.
const includeTests = argv.includes('--with-tests');
const visible = cut(index, open, { includeTests });
const edges = liftEdges(graph, index, visible, { includeTests });

const options: LayoutOptions = {
  direction: (flag('dir') as LayoutOptions['direction']) ?? 'RIGHT',
  edgeRouting: (flag('routing') as LayoutOptions['edgeRouting']) ?? 'ORTHOGONAL',
  // Measured on a 150-node cut: SEPARATE_CHILDREN is 7.5x smaller and 6x
  // faster. The cost is that a cross-container edge meets the boundary rather
  // than the exact node — `--precise-edges` buys that back.
  hierarchy: argv.includes('--precise-edges') ? 'INCLUDE_CHILDREN' : 'SEPARATE_CHILDREN',
};

console.log(`graph    ${graphPath}`);
console.log(`cut      ${visible.size} of ${graph.nodes.length} nodes, ${open.size} containers open`);
console.log(`edges    ${edges.length} lifted from ${graph.edges.length}`);

const result = await layout(index, visible, edges, options);
console.log(`elk      ${result.ms.toFixed(0)} ms  →  ${Math.round(result.width)}×${Math.round(result.height)}`);
console.log(`routes   ${result.routes.length} drawn`);

const out = resolve(flag('out') ?? 'poc/out.html');
writeFileSync(out, renderHtml(graph, index, result, edges, { openCount: open.size, visibleCount: visible.size }));
console.log(`\nwrote    ${out}`);
