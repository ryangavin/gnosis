/**
 * The cheapest thing that answers the open questions: are the folder
 * boundaries legible, and does importance read at a glance? One
 * self-contained HTML file, inline SVG, no build step and no dev server.
 *
 * Deliberately throwaway — the parts worth keeping are model.ts and
 * layout.ts. Colour is domain identity; height and fill are importance;
 * nesting is the folder tree.
 */
import type { GraphArtifact } from '../src/graph/schema.ts';
import { domainOf, type Index, type LiftedEdge } from './model.ts';
import type { Layout } from './layout.ts';

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Golden-angle hues so adjacent domains never land on neighbouring colors. */
const hueFor = (i: number) => Math.round((i * 137.508) % 360);

function edgeStyle(edge: LiftedEdge): { dash: string; opacity: number; width: number } {
  if (edge.kind === 'imports') return { dash: '1 5', opacity: 0.16, width: 1 };
  if (edge.calls > 0) {
    return { dash: '', opacity: 0.5, width: Math.min(3.5, 0.7 + Math.log10(edge.calls + 1)) };
  }
  return { dash: '5 4', opacity: 0.26, width: 1 };
}

export function renderHtml(
  graph: GraphArtifact,
  index: Index,
  layout: Layout,
  edges: LiftedEdge[],
  meta: { openCount: number; visibleCount: number },
): string {
  const domainIndex = new Map(index.roots.map((r, i) => [r.id, i]));
  const hueOf = (id: string) => {
    const domain = domainOf(index, id);
    return domain === undefined ? 220 : hueFor(domainIndex.get(domain) ?? 0);
  };
  const pct = (n: number | undefined) => (n === undefined ? null : Math.round(n * 100));

  const containers = layout.boxes.filter((b) => b.isContainer);
  const leaves = layout.boxes.filter((b) => !b.isContainer);

  const containerSvg = containers
    .map((b) => {
      const hue = hueOf(b.id);
      const breadth = b.node.stats?.testBreadth ?? 0;
      const isDomain = b.node.kind === 'domain';
      const label = `${b.node.name}${pct(b.node.stats?.testBreadth) === null ? '' : `  ${pct(b.node.stats?.testBreadth)}%`}`;
      // A breadth rail down the left edge: how much of the suite reaches in.
      const rail = Math.max(0, (b.height - 8) * breadth);
      return `<g class="container ${isDomain ? 'domain' : 'dir'}" data-id="${xml(b.id)}">
  <rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="9"
        fill="hsl(${hue} 55% 55% / ${isDomain ? 0.08 : 0.045})"
        stroke="hsl(${hue} 62% 64% / ${isDomain ? 0.6 : 0.3})"
        stroke-width="${isDomain ? 1.4 : 1}"/>
  ${rail > 2 ? `<rect class="rail" x="${b.x + 2}" y="${b.y + b.height - 4 - rail}" width="3" height="${rail.toFixed(0)}" rx="1.5" fill="hsl(${hue} 70% 62%)" opacity=".55"/>` : ''}
  <text class="clabel" x="${b.x + 11}" y="${b.y + 17}" fill="hsl(${hue} 72% 78%)">${xml(label)}</text>
</g>`;
    })
    .join('\n');

  const leafSvg = leaves
    .map((b) => {
      const hue = hueOf(b.id);
      const breadth = b.node.stats?.testBreadth ?? 0;
      const ran = (b.node.runtime?.calls ?? 0) > 0 || breadth > 0;
      const isFn = b.node.kind === 'function';
      const react = b.node.flags?.reactComponent;
      const isTest = b.node.flags?.testFile;
      // A test file is the instrument, not the subject: it ran, but breadth
      // is not the right scale for it. Outline only, so it reads as apparatus.
      const fill = isTest
        ? 'none'
        : ran
          ? `hsl(${hue} ${(48 + breadth * 30).toFixed(0)}% ${(30 + breadth * 30).toFixed(0)}%)`
          : `hsl(${hue} 18% 22%)`;
      const stroke = isTest
        ? `hsl(${hue} 45% 52%)`
        : ran
          ? `hsl(${hue} 75% ${(60 + breadth * 20).toFixed(0)}%)`
          : `hsl(${hue} 22% 36%)`;
      const dash = isTest ? '4 3' : react ? '3 2' : '';

      // With the test boxes gone, coverage has to live on the code itself: a
      // rule along the bottom edge, its length the share of this file's
      // functions that ran. Solid means a test calls in here on purpose;
      // hollow means it is only reached through something else.
      const total = b.node.stats?.functions ?? 0;
      const covered = b.node.stats?.coveredFunctions ?? 0;
      const direct = (b.node.stats?.directTests ?? 0) > 0;
      let bar = '';
      if (!isTest && total > 0) {
        const inset = 4;
        const full = b.width - inset * 2;
        const len = Math.max(0, full * (covered / total));
        bar =
          `<rect x="${b.x + inset}" y="${b.y + b.height - 3.5}" width="${full.toFixed(1)}" height="2" rx="1"
             fill="#000" opacity=".35"/>` +
          (len > 0.5
            ? `<rect x="${b.x + inset}" y="${b.y + b.height - 3.5}" width="${len.toFixed(1)}" height="2" rx="1"
                 fill="hsl(${hue} 85% ${direct ? 74 : 58}%)" opacity="${direct ? 0.95 : 0.5}"/>`
            : '');
      }
      return `<g class="leaf ${isFn ? 'fn' : 'file'}${ran ? ' ran' : ''}${isTest ? ' test' : ''}${direct ? ' direct' : ''}" data-id="${xml(b.id)}">
  <rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${isFn ? 11 : 3}"
        fill="${fill}" stroke="${stroke}" stroke-width="${react || isTest ? 1.5 : 1}"
        ${dash ? `stroke-dasharray="${dash}"` : ''}/>${bar}
  <text class="llabel" x="${b.x + b.width / 2}" y="${b.y + b.height / 2 + 4}"
        text-anchor="middle" fill="${isTest ? `hsl(${hue} 40% 68%)` : ran ? '#f4f7ff' : '#8b98ab'}">${xml(b.node.name)}</text>
</g>`;
    })
    .join('\n');

  const routeSvg = layout.routes
    .map(({ edge, points, approximate }) => {
      const { dash, opacity, width } = edgeStyle(edge);
      const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      // Our own elbows are drawn fainter, so a real route never gets confused
      // with an approximate one.
      return `<path class="edge${edge.kind === 'imports' ? ' imp' : ''}${approximate ? ' approx' : ''}"
        d="${d}" fill="none" stroke="hsl(${hueOf(edge.from)} 62% 72%)"
        stroke-opacity="${(approximate ? opacity * 0.62 : opacity).toFixed(2)}"
        stroke-width="${width.toFixed(1)}" ${dash ? `stroke-dasharray="${dash}"` : ''}
        marker-end="url(#arrow)"/>`;
    })
    .join('\n');
  const approxCount = layout.routes.filter((r) => r.approximate).length;

  const nodeInfo = JSON.stringify(
    Object.fromEntries(
      layout.boxes.map((b) => [
        b.id,
        {
          name: b.node.name,
          kind: b.node.kind,
          id: b.id,
          summary: b.node.doc?.summary ?? null,
          stats: b.node.stats ?? null,
          runtime: b.node.runtime ? { calls: b.node.runtime.calls, testFiles: b.node.runtime.testFiles } : null,
          flags: b.node.flags ?? null,
        },
      ]),
    ),
  );

  const folders = layout.boxes.filter(
    (b) => b.node.kind === 'directory' || b.node.kind === 'domain',
  ).length;
  const runtimeEdges = edges.filter((e) => e.calls > 0).length;
  const suite = graph.target.testFileCount ?? 0;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>gnosis · ${xml(graph.target.name)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#080b11; color:#c3cddb; overflow:hidden;
         font:13px/1.45 ui-sans-serif,-apple-system,"SF Pro Text",system-ui,sans-serif; }
  #stage { position:fixed; inset:0; cursor:grab; }
  #stage.drag { cursor:grabbing; }
  svg { display:block; width:100%; height:100%; }
  text { font:inherit; pointer-events:none; user-select:none; }
  .clabel { font-size:12px; font-weight:600; letter-spacing:.01em; }
  .dir .clabel { font-size:11px; font-weight:500; opacity:.82; }
  .llabel { font-size:10.5px; }
  /* Level of detail: names arrive as you get close, not all at once. */
  svg.far .llabel, svg.far .dir .clabel { display:none; }
  svg.veryfar .clabel { font-size:16px; }
  svg.veryfar .edge.imp { display:none; }
  .leaf, .container { cursor:pointer; }
  .leaf:hover rect { stroke:#fff; stroke-width:2; }
  .container:hover > rect { stroke-opacity:.95; }
  header { position:fixed; top:0; left:0; right:0; padding:9px 14px; z-index:5;
           background:linear-gradient(#080b11f5,#080b11cc 70%,transparent);
           display:flex; gap:15px; align-items:baseline; flex-wrap:wrap; }
  header b { color:#e6edf6; font-weight:600; }
  header span { color:#5d6a7d; }
  header em { color:#8fbcff; font-style:normal; font-weight:600; }
  kbd { background:#1a2433; border-radius:3px; padding:1px 5px; font-size:11px; color:#8b98ab; }
  #legend { position:fixed; left:14px; bottom:12px; z-index:5; display:flex; gap:14px;
            align-items:center; background:#0d131cdd; border:1px solid #1b2534;
            border-radius:9px; padding:7px 12px; font-size:11px; color:#7d8a9c; }
  #legend i { display:inline-block; width:26px; height:9px; border-radius:2px;
              vertical-align:-1px; margin-right:5px; }
  #panel { position:fixed; right:12px; top:52px; width:320px; max-height:76vh; overflow:auto;
           background:#0d131cf7; border:1px solid #1e2937; border-radius:11px; padding:13px 15px;
           display:none; z-index:6; box-shadow:0 14px 44px #000a; }
  #panel.on { display:block; }
  #panel h3 { margin:0 0 2px; font-size:14px; color:#eef3fa; word-break:break-word; }
  #panel .kind { color:#8fbcff; font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; }
  #panel .sum { margin:9px 0 0; color:#94a2b5; }
  #panel dl { display:grid; grid-template-columns:auto 1fr; gap:3px 12px; margin:11px 0 0; font-size:12px; }
  #panel dt { color:#5d6a7d; } #panel dd { margin:0; color:#c3cddb; }
  #panel .bar { height:5px; background:#1b2534; border-radius:3px; margin:9px 0 2px; overflow:hidden; }
  #panel .bar u { display:block; height:100%; background:linear-gradient(90deg,#3f7fd0,#7cc4ff); }
  #panel ul { margin:7px 0 0; padding-left:16px; color:#8b98ab; font-size:11.5px; }
  #panel code { font:11px ui-monospace,SFMono-Regular,Menlo,monospace; color:#5d6a7d;
                word-break:break-all; display:block; margin-top:10px; }
</style></head><body>
<header>
  <b>${xml(graph.target.name)}</b>
  <span><em>${meta.visibleCount}</em> of ${graph.nodes.length} nodes</span>
  <span><em>${folders}</em> folders drawn</span>
  <span><em>${edges.length}</em> edges (${runtimeEdges} observed${approxCount ? `, ${approxCount} approximated` : ''})</span>
  <span>suite <em>${suite}</em> files</span>
  <span>ELK <em>${layout.ms.toFixed(0)} ms</em></span>
  <span><kbd>scroll</kbd> zoom <kbd>drag</kbd> pan <kbd>f</kbd> fit</span>
</header>
<div id="stage"><svg id="svg">
  <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5"
    orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="#8b98ab" fill-opacity=".55"/></marker></defs>
  <g id="cam">
    <g id="containers">${containerSvg}</g>
    <g id="routes">${routeSvg}</g>
    <g id="leaves">${leafSvg}</g>
  </g>
</svg></div>
<div id="legend">
  <span><i style="background:linear-gradient(90deg,hsl(210 48% 30%),hsl(210 78% 60%))"></i>taller &amp; brighter = more of the suite reaches it</span>
  <span><i style="background:hsl(210 18% 22%)"></i>never observed</span>
  <span><i style="background:none;border-bottom:2px solid hsl(210 85% 74%)"></i>covered, tested on purpose</span>
  <span><i style="background:none;border-bottom:2px solid hsl(210 85% 58%);opacity:.5"></i>covered incidentally</span>
  <span>— observed call · – – static only · ⋯ import</span>
</div>
<div id="panel"></div>
<script>
const INFO = ${nodeInfo};
const SUITE = ${suite};
const svg = document.getElementById('svg'), cam = document.getElementById('cam');
const stage = document.getElementById('stage'), panel = document.getElementById('panel');
const W = ${layout.width}, H = ${layout.height};
let scale = 1, tx = 0, ty = 0;

function apply() {
  cam.setAttribute('transform', \`translate(\${tx} \${ty}) scale(\${scale})\`);
  svg.classList.toggle('far', scale < 0.5);
  svg.classList.toggle('veryfar', scale < 0.26);
}
function fit() {
  const r = stage.getBoundingClientRect();
  scale = Math.min(r.width / (W + 60), r.height / (H + 100)) || 1;
  tx = (r.width - W * scale) / 2;
  ty = (r.height - H * scale) / 2 + 12;
  apply();
}
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const next = Math.max(0.02, Math.min(16, scale * Math.exp(-e.deltaY * 0.0016)));
  tx = mx - (mx - tx) * (next / scale);
  ty = my - (my - ty) * (next / scale);
  scale = next; apply();
}, { passive: false });

let dragging = false, px = 0, py = 0;
stage.addEventListener('pointerdown', (e) => {
  dragging = true; px = e.clientX; py = e.clientY;
  stage.classList.add('drag'); stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  tx += e.clientX - px; ty += e.clientY - py; px = e.clientX; py = e.clientY; apply();
});
stage.addEventListener('pointerup', (e) => {
  dragging = false; stage.classList.remove('drag'); stage.releasePointerCapture(e.pointerId);
});
addEventListener('keydown', (e) => {
  if (e.key === 'f') fit();
  if (e.key === 'Escape') panel.classList.remove('on');
});

stage.addEventListener('click', (e) => {
  const g = e.target.closest('[data-id]');
  if (!g) { panel.classList.remove('on'); return; }
  const n = INFO[g.dataset.id];
  if (!n) return;
  const s = n.stats || {};
  const rows = [];
  if (s.testBreadth !== undefined) rows.push(['reached by', s.testFiles + ' of ' + SUITE + ' test files']);
  rows.push(['tested', s.directTests ? s.directTests + ' test file(s) call in directly' : 'only incidentally']);
  if (s.calls !== undefined) rows.push(['calls observed', s.calls.toLocaleString()]);
  if (s.coveredFunctions !== undefined && s.functions !== undefined)
    rows.push(['functions covered', s.coveredFunctions + ' / ' + s.functions]);
  if (s.files !== undefined) rows.push(['files', s.files]);
  if (s.loc !== undefined) rows.push(['lines', s.loc.toLocaleString()]);
  if (n.flags) for (const [k, v] of Object.entries(n.flags)) if (v) rows.push([k, 'yes']);
  const b = s.testBreadth ?? 0;
  panel.innerHTML =
    '<div class="kind">' + n.kind + '</div><h3>' + n.name + '</h3>' +
    (n.summary ? '<p class="sum">' + n.summary + '</p>' : '') +
    (s.testBreadth !== undefined
      ? '<div class="bar"><u style="width:' + (b * 100).toFixed(1) + '%"></u></div>' +
        '<div style="font-size:11px;color:#5d6a7d">' + (b * 100).toFixed(0) + '% of the suite reaches this</div>'
      : '') +
    (rows.length ? '<dl>' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('') + '</dl>' : '') +
    (n.runtime && n.runtime.testFiles.length
      ? '<ul>' + n.runtime.testFiles.slice(0, 6).map((f) => '<li>' + f + '</li>').join('') + '</ul>'
      : '') +
    '<code>' + n.id + '</code>';
  panel.classList.add('on');
});
fit();
</script></body></html>`;
}
