import type { GNode } from '../../src/graph/schema.ts';
import type { GraphIndexes } from '../../src/graph/indexes.ts';

interface Props {
  indexes: GraphIndexes;
  selected?: string;
  expanded: Set<string>;
  onReveal: (id: string) => void;
  onToggle: (id: string) => void;
}

function shortName(indexes: GraphIndexes, id: string): { name: string; ctx: string } {
  const node = indexes.byId.get(id);
  if (!node) return { name: id, ctx: '' };
  if (node.kind === 'function') {
    const file = node.parent?.slice('file:'.length) ?? '';
    return { name: node.name, ctx: file };
  }
  if (node.kind === 'file') return { name: id.slice('file:'.length), ctx: '' };
  if (node.kind === 'domain') return { name: id.slice('domain:'.length), ctx: 'domain' };
  return { name: node.name, ctx: '' };
}

function EdgeList({
  indexes,
  ids,
  counts,
  onReveal,
}: {
  indexes: GraphIndexes;
  ids: string[];
  counts: Map<string, number>;
  onReveal: (id: string) => void;
}) {
  return (
    <>
      {ids.map((id) => {
        const { name, ctx } = shortName(indexes, id);
        return (
          <button key={id} className="edge-row" onClick={() => onReveal(id)}>
            <span className="count">{counts.get(id)}×</span>
            <span className="name">{name}</span>
            <span className="ctx">{ctx}</span>
          </button>
        );
      })}
    </>
  );
}

function Overview({ indexes, onReveal }: { indexes: GraphIndexes; onReveal: (id: string) => void }) {
  const repo = indexes.byId.get('repo');
  const domains = (indexes.childrenOf.get('repo') ?? []).filter((n) => n.kind === 'domain');
  return (
    <div>
      <p className="eyebrow">repository</p>
      <h1>{repo?.name}</h1>
      <p className="statline">
        {repo?.stats?.files} files · {repo?.stats?.functions} functions · {repo?.stats?.loc} lines
      </p>
      {repo?.doc?.docFiles?.slice(0, 2).map((d) => (
        <div key={d.path} className="docfile">
          <div className="title">{d.title}</div>
          <p className="path">{d.path}</p>
          <div className="excerpt">{d.excerpt}</div>
        </div>
      ))}
      <p className="section-label">domains</p>
      {domains.map((d) => (
        <button key={d.id} className="child-row" onClick={() => onReveal(d.id)}>
          <span className="name">{d.name}</span>
          <span className="ctx">
            {d.stats?.files ?? 0} files · {d.stats?.functions ?? 0} fns
          </span>
        </button>
      ))}
      <p className="section-label">how to read this</p>
      <p className="empty">
        Double-click a domain to open it into files, a file into functions. Solid edges were
        observed during a test run; dashed edges are static analysis only. Click anything for
        its documentation.
      </p>
    </div>
  );
}

export function Inspector({ indexes, selected, expanded, onReveal, onToggle }: Props) {
  const node = selected ? indexes.byId.get(selected) : undefined;
  if (!node) return <div className="inspector">{<Overview indexes={indexes} onReveal={onReveal} />}</div>;

  const children = indexes.childrenOf.get(node.id) ?? [];
  const outs = indexes.outEdges.get(node.id) ?? [];
  const ins = indexes.inEdges.get(node.id) ?? [];
  const aggregate = (edges: typeof outs, pick: (e: (typeof outs)[number]) => string) => {
    const counts = new Map<string, number>();
    for (const e of edges) {
      counts.set(pick(e), (counts.get(pick(e)) ?? 0) + (e.meta?.lines?.length || 1));
    }
    return { ids: [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!), counts };
  };
  const out = aggregate(outs, (e) => e.to);
  const inn = aggregate(ins, (e) => e.from);

  const path =
    node.kind === 'function'
      ? `${node.parent?.slice('file:'.length)}:${node.span?.line}`
      : node.kind === 'file'
        ? node.id.slice('file:'.length)
        : node.id.replace(/^domain:/, '');

  const flagText = [
    node.flags?.exported && 'exported',
    node.flags?.async && 'async',
    node.flags?.reactComponent && 'react component',
    node.flags?.testFile && 'test file',
    node.runtime
      ? `observed ${node.runtime.calls}× under test`
      : node.kind === 'function'
        ? 'not observed under test'
        : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="inspector">
      <p className="eyebrow">{node.kind}</p>
      <h1>{node.name}</h1>
      <p className="path">{path}</p>
      {(node.stats || flagText) && (
        <p className="statline">
          {node.stats
            ? `${node.stats.files ?? ''}${node.stats.files ? ' files · ' : ''}${
                node.stats.functions ?? ''
              }${node.stats.functions ? ' fns · ' : ''}${node.stats.loc ?? 0} lines`
            : flagText}
          {node.stats && flagText ? ` · ${flagText}` : ''}
        </p>
      )}
      {node.doc?.tsdoc ? (
        <div className="docblock">{node.doc.tsdoc}</div>
      ) : node.doc?.summary ? (
        <div className="docblock">{node.doc.summary}</div>
      ) : null}
      {node.doc?.docFiles?.map((d) => (
        <div key={d.path} className="docfile">
          <div className="title">{d.title}</div>
          <p className="path">{d.path}</p>
          <div className="excerpt">{d.excerpt}</div>
        </div>
      ))}
      {children.length > 0 && (
        <div className="actions">
          <button onClick={() => onToggle(node.id)}>
            {expanded.has(node.id) ? 'collapse' : 'expand'}
          </button>
        </div>
      )}
      {out.ids.length > 0 && (
        <>
          <p className="section-label">calls / imports →</p>
          <EdgeList indexes={indexes} ids={out.ids.slice(0, 30)} counts={out.counts} onReveal={onReveal} />
        </>
      )}
      {inn.ids.length > 0 && (
        <>
          <p className="section-label">← called / imported by</p>
          <EdgeList indexes={indexes} ids={inn.ids.slice(0, 30)} counts={inn.counts} onReveal={onReveal} />
        </>
      )}
      {node.runtime && node.runtime.testFiles.length > 0 && (
        <>
          <p className="section-label">exercised by</p>
          {node.runtime.testFiles.map((tf) => (
            <div key={tf} className="child-row">
              <span className="name">{tf}</span>
            </div>
          ))}
        </>
      )}
      {children.length > 0 && (
        <>
          <p className="section-label">contains</p>
          {children.slice(0, 60).map((c) => {
            const { name } = shortName(indexes, c.id);
            return (
              <button key={c.id} className="child-row" onClick={() => onReveal(c.id)}>
                <span className="name">{name}</span>
                <span className="ctx">{c.kind}</span>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}
