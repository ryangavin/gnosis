import { useEffect, useMemo, useReducer, useState } from 'react';
import type { GraphArtifact } from '../../src/graph/schema.ts';
import { buildIndexes } from '../../src/graph/indexes.ts';
import { ancestorsToExpand, deriveView } from './derive.ts';
import { initialState, reduce } from './state.ts';
import { GraphView } from './GraphView.tsx';
import { Inspector } from './Inspector.tsx';
import { Search } from './Search.tsx';

const SOFT_CAP = 1500;

function Legend() {
  const stroke = '#a9b0bc';
  return (
    <div className="legend">
      <span className="item">
        <svg width="26" height="6">
          <line x1="0" y1="3" x2="26" y2="3" stroke={stroke} strokeWidth="2" />
        </svg>
        observed under test
      </span>
      <span className="item">
        <svg width="26" height="6">
          <line x1="0" y1="3" x2="26" y2="3" stroke="#6a707c" strokeWidth="1.5" strokeDasharray="4 4" />
        </svg>
        static only
      </span>
      <span className="item">◆ domain</span>
      <span className="item">▤ file</span>
      <span className="item">● function</span>
      <span className="item">◇ react component</span>
      <span className="item">width = call volume</span>
    </div>
  );
}

export function App() {
  const [graph, setGraph] = useState<GraphArtifact>();
  const [error, setError] = useState<string>();
  const [state, dispatch] = useReducer(reduce, initialState);

  useEffect(() => {
    fetch('/api/graph')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((g: GraphArtifact) => setGraph(g))
      .catch((e: Error) => setError(`could not load the graph: ${e.message}`));
  }, []);

  const indexes = useMemo(() => (graph ? buildIndexes(graph) : undefined), [graph]);
  const view = useMemo(
    () => (graph ? deriveView(graph, state.expanded, { showTests: state.showTests }) : undefined),
    [graph, state.expanded, state.showTests],
  );

  if (error) return <div className="app"><p className="empty" style={{ padding: 20 }}>{error} — run `gnosis scan` first.</p></div>;
  if (!graph || !indexes || !view) return null;

  const reveal = (id: string): void =>
    dispatch({ type: 'reveal', id, ancestors: ancestorsToExpand(graph, id) });

  return (
    <div className="app">
      <div className="topbar">
        <span className="wordmark">
          gnosis <span>· {graph.target.name}</span>
        </span>
        <span className="topstats">
          {graph.nodes.filter((n) => n.kind === 'domain' && n.parent === 'repo').length} domains ·{' '}
          {graph.target.git?.branch ?? ''} {graph.target.git?.commit.slice(0, 7) ?? ''}
        </span>
        <div className="spacer" />
        <Search graph={graph} onReveal={reveal} />
        <label className="toggle">
          <input
            type="checkbox"
            checked={state.showTests}
            onChange={(e) => dispatch({ type: 'showTests', value: e.target.checked })}
          />
          tests
        </label>
        <label className="toggle" onClick={() => dispatch({ type: 'collapseAll' })} style={{ cursor: 'pointer' }}>
          reset
        </label>
      </div>
      <div className="canvas">
        <GraphView
          view={view}
          selected={state.selected}
          focus={state.focus}
          onSelect={(id) => dispatch({ type: 'select', id })}
          onToggle={(id) => dispatch({ type: 'toggle', id })}
        />
        {view.size > SOFT_CAP && (
          <div className="cap-warning">
            {view.size} elements on screen — collapse something, or use search instead
          </div>
        )}
      </div>
      <Inspector
        indexes={indexes}
        selected={state.selected}
        expanded={state.expanded}
        onReveal={reveal}
        onToggle={(id) => dispatch({ type: 'toggle', id })}
      />
      <Legend />
    </div>
  );
}
