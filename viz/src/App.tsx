import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { GraphArtifact } from '../../src/graph/schema.ts';
import { buildIndexes } from '../../src/graph/indexes.ts';
import { project } from './project.ts';
import { initialState, reduce } from './state.ts';
import { CosmosView, type CosmosHandle } from './CosmosView.tsx';
import { Inspector } from './Inspector.tsx';
import { Search } from './Search.tsx';

function Legend() {
  return (
    <div className="legend">
      <span className="item">
        <svg width="26" height="6">
          <line x1="0" y1="3" x2="26" y2="3" stroke="#4fae9c" strokeWidth="2" />
        </svg>
        observed under test
      </span>
      <span className="item">
        <svg width="26" height="6">
          <line x1="0" y1="3" x2="26" y2="3" stroke="#6a707c" strokeWidth="1.5" strokeDasharray="4 3" />
        </svg>
        static-only call
      </span>
      <span className="item">
        <svg width="26" height="6">
          <line x1="0" y1="3" x2="26" y2="3" stroke="#6a707c" strokeWidth="1.5" strokeDasharray="1.5 3" />
        </svg>
        import
      </span>
      <span className="item">hue = domain</span>
      <span className="item">■ file</span>
      <span className="item">● function</span>
      <span className="item">◆ react component</span>
      <span className="item">width = call volume</span>
      <span className="item">drag sculpts · layout saved locally</span>
    </div>
  );
}

export function App() {
  const [graph, setGraph] = useState<GraphArtifact>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [state, dispatch] = useReducer(reduce, initialState);
  const cosmos = useRef<CosmosHandle>(null);

  useEffect(() => {
    fetch('graph.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((g: GraphArtifact) => setGraph(g))
      .catch((e: Error) => setError(`could not load the graph: ${e.message}`));
  }, []);

  const indexes = useMemo(() => (graph ? buildIndexes(graph) : undefined), [graph]);
  const projection = useMemo(
    () => (graph ? project(graph, { showTests: state.showTests }) : undefined),
    [graph, state.showTests],
  );

  if (error) return <div className="app"><p className="empty" style={{ padding: 20 }}>{error} — run `gnosis scan` first.</p></div>;
  if (!graph || !indexes || !projection) return null;

  const reveal = (id: string): void => dispatch({ type: 'reveal', id });

  return (
    <div className="app">
      <div className="topbar">
        <span className="wordmark">
          gnosis <span>· {graph.target.name}</span>
        </span>
        <span className="topstats">
          {projection.domains.length} domains ·{' '}
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
        <button
          className="topbtn"
          onClick={() => (running ? cosmos.current?.pause() : cosmos.current?.reheat())}
        >
          {running ? 'pause' : 'settle'}
        </button>
        <button className="topbtn" onClick={() => cosmos.current?.fit()}>
          fit
        </button>
        <button className="topbtn" onClick={() => cosmos.current?.reshuffle()}>
          reset layout
        </button>
      </div>
      <div className="canvas">
        <CosmosView
          ref={cosmos}
          graph={graph}
          projection={projection}
          selected={state.selected}
          focus={state.focus}
          focusNonce={state.focusNonce}
          onSelect={(id) => dispatch({ type: 'select', id })}
          onRunningChange={setRunning}
        />
      </div>
      <Inspector indexes={indexes} selected={state.selected} onReveal={reveal} />
      <Legend />
    </div>
  );
}
