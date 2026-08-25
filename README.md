# gnosis

A self-maintaining knowledge graph for codebases. Point it at a repo and it
builds a graph of domains, files, functions, and call edges; layers the
repo's own documentation onto the nodes; runs the repo's test suite with
every function instrumented to mark which parts of the graph *actually
execute*; and serves the result three ways — an interactive force-directed
galaxy for humans, an MCP server for agents, and emitted markdown
architecture docs.

The goal: understand the architecture of a project you have seen zero lines
of, in minutes.

## Quickstart

```
npm install
node bin/gnosis.ts scan   <repo>    # static analysis → graph.json
node bin/gnosis.ts trace  <repo>    # run the repo's tests instrumented; overlay observations
node bin/gnosis.ts serve  <repo>    # open http://localhost:4400
node bin/gnosis.ts export <repo>    # static site (viz + graph.json) for any static host
node bin/gnosis.ts emit   <repo>    # markdown architecture docs
node bin/gnosis.ts mcp    <repo>    # MCP server over stdio, for agent configs
```

No build step — Node ≥ 24 runs the TypeScript directly. All state lives in
`~/.gnosis/<repo>-<hash>/`; the target repo is never written to.

## Installing into another repo

gnosis is also an installable package, so a repo can build its own graph as
part of its test pipeline:

```
npm install -D github:ryangavin/gnosis
```

```jsonc
// package.json of the target repo
"scripts": {
  "graph": "gnosis scan . && gnosis trace .",
  "graph:serve": "gnosis serve .",
  "posttest": "npm run graph"
}
```

Installed this way, `prepare` compiles bin+src to `dist/` — Node refuses to
type-strip `.ts` under `node_modules`, so the installed artifact is plain JS
while the checkout keeps running source directly. The CLI is identical; the
target repo is still never written to.

For CI, `gnosis export <repo> --out _site` emits the visualization as a
fully static site (relative asset paths, the graph served as `./graph.json`)
that deploys to GitHub Pages or any static host — the graph rebuilds on
every push, traced against that commit's own test run.

There is a programmatic surface too: `import { loadGraph, contextOf,
overview } from 'gnosis'` gives you the same query layer the MCP server and
markdown emitter are built on.

## How the graph is made

**Static skeleton.** Every `tsconfig*.json` in the target becomes a
`ts.Program` (deepest configs claim files first, so module configs beat
root extends-fragments). Function nodes come from a stable-ID walk —
`fn:<relPath>#<qualifiedName>` — that names function declarations, arrows
bound to variables, class members, and object-literal methods, and
deliberately skips anonymous callbacks: their calls attribute to the
nearest named enclosing function. Call edges resolve through the type
checker (alias-chasing included, so a renamed import still joins), JSX
elements resolve to their components, and workspace symlinks are realpath'd
away. TSDoc, file headers, `docs/*.md` basename mirrors, and READMEs attach
to the nodes they describe.

**Runtime overlay.** `gnosis trace` runs the *target's own* vitest via a
shim config that dynamically imports the target's config and prepends a
vite plugin. The plugin wraps every named function body in
`enter/try/finally/exit` calls via magic-string, before esbuild strips
types, so spans and IDs match the static walk by construction. A per-worker
collector aggregates caller→callee edges with test attribution and flushes
NDJSON; the merge attaches runtime facets to static edges, adds
`static: false` edges for dynamic dispatch the checker could not see, and
rolls coverage up onto domains. A trace is refused if instrumented pass/fail
counts differ from a baseline run.

**Layers.** Domains are mechanical in v1: workspace entries plus first-level
directories with their own package.json; large domains split by second-level
source directory. A `gnosis.yaml` in the data dir can rename and describe
domains (`domains:`), remap nothing yet, and exclude files from tracing
(`trace: { exclude: [...] }`).

## Reading the visualization

The viz is a single force-directed galaxy rendered by
[cosmos.gl](https://github.com/cosmosgl/graph) — every file a square,
every function a dot, React components diamonds — with the layout emerging
from GPU physics: containment springs hold a file's functions around it,
cluster forces gather each top-level domain into its own labeled
constellation, repulsion does the rest. Color always means domain
identity, nothing else. Bright points ran under the test suite, dim ones
are static-only; solid links were observed under tests (width is call
volume), dashed links are static-only calls, dotted links are imports.

Click a point for its documentation and edges in the inspector; click a
domain label to light its constellation; search reveals and flies to
anything. Drag sculpts the layout, and positions persist per browser in
localStorage — `reset layout` reseeds and re-simulates, `settle`/`pause`
control the simulation, `fit` reframes the camera.

## Honest limitations

- Calls through interface members and callback-typed parameters are dynamic
  dispatch; they appear only when a test run observes them.
- Calls into npm packages and node builtins are not recorded.
- Global declared namespaces (types used without imports) leave no import
  edges.
- The runtime collector uses a plain stack, not AsyncLocalStorage:
  concurrently interleaved async functions can attribute a caller one frame
  off. Counts stay correct.
- v1 analyzes TypeScript and traces vitest. The graph schema itself is
  language-neutral; other analyzers can feed it.
