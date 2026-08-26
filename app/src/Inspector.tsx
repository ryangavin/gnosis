/**
 * What a selected node knows about itself. The numbers that matter are the
 * ones a trace produced: how much of the suite reaches this, whether anyone
 * tests it on purpose, and how hard it actually works.
 */
import type { GNode } from '../../src/graph/schema.ts';
import type { LiftedEdge } from '../../src/graph/cut.ts';

interface Props {
  node: GNode | null;
  suite: number;
  edges: LiftedEdge[];
  nameOf: (id: string) => string;
  onClose: () => void;
  onSelect: (id: string) => void;
}

export function Inspector({ node, suite, edges, nameOf, onClose, onSelect }: Props) {
  if (!node) return null;
  const s = node.stats ?? {};
  const breadth = s.testBreadth ?? 0;
  const incoming = edges.filter((e) => e.to === node.id);
  const outgoing = edges.filter((e) => e.from === node.id);

  const rows: [string, string][] = [];
  if (s.testBreadth !== undefined) rows.push(['reached by', `${s.testFiles} of ${suite} test files`]);
  rows.push([
    'tested',
    s.directTests ? `${s.directTests} test file${s.directTests > 1 ? 's' : ''} call in directly` : 'only incidentally',
  ]);
  if (s.calls !== undefined) rows.push(['calls observed', s.calls.toLocaleString()]);
  if (s.coveredFunctions !== undefined && s.functions !== undefined) {
    rows.push(['functions covered', `${s.coveredFunctions} / ${s.functions}`]);
  }
  if (s.files !== undefined) rows.push(['files', String(s.files)]);
  if (s.loc !== undefined) rows.push(['lines', s.loc.toLocaleString()]);
  for (const [flag, on] of Object.entries(node.flags ?? {})) if (on) rows.push([flag, 'yes']);

  return (
    <aside className="inspector">
      <button className="close" onClick={onClose} aria-label="close">
        ×
      </button>
      <div className="kind">{node.kind}</div>
      <h3>{node.name}</h3>
      {node.doc?.summary && <p className="summary">{node.doc.summary}</p>}

      {s.testBreadth !== undefined && (
        <>
          <div className="bar">
            <span style={{ width: `${breadth * 100}%` }} />
          </div>
          <div className="caption">{Math.round(breadth * 100)}% of the suite reaches this</div>
        </>
      )}

      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      {node.runtime?.testFiles.length ? (
        <>
          <h4>exercised by</h4>
          <ul className="plain">
            {node.runtime.testFiles.slice(0, 6).map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </>
      ) : null}

      {(incoming.length > 0 || outgoing.length > 0) && (
        <>
          <h4>
            edges here <span className="muted">({incoming.length} in · {outgoing.length} out)</span>
          </h4>
          <ul className="links">
            {outgoing.slice(0, 8).map((e) => (
              <li key={`o${e.to}`}>
                <button onClick={() => onSelect(e.to)}>
                  → {nameOf(e.to)}
                  {e.calls > 0 && <span className="muted"> {e.calls.toLocaleString()}</span>}
                </button>
              </li>
            ))}
            {incoming.slice(0, 8).map((e) => (
              <li key={`i${e.from}`}>
                <button onClick={() => onSelect(e.from)}>
                  ← {nameOf(e.from)}
                  {e.calls > 0 && <span className="muted"> {e.calls.toLocaleString()}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <code>{node.id}</code>
    </aside>
  );
}
