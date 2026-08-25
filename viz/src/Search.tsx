import { useMemo, useState } from 'react';
import type { GraphArtifact, GNode } from '../../src/graph/schema.ts';

interface Props {
  graph: GraphArtifact;
  onReveal: (id: string) => void;
}

const KIND_GLYPH: Record<GNode['kind'], string> = {
  repo: '◉',
  domain: '◆',
  file: '▤',
  function: '●',
};

function whereOf(node: GNode): string {
  if (node.kind === 'function') return node.parent?.slice('file:'.length) ?? '';
  if (node.kind === 'file') return node.id.slice('file:'.length);
  return '';
}

export function Search({ graph, onReveal }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const scored: { node: GNode; score: number }[] = [];
    for (const node of graph.nodes) {
      if (node.kind === 'repo') continue;
      const name = node.name.toLowerCase();
      const id = node.id.toLowerCase();
      let score = 0;
      if (name === q) score = 4;
      else if (name.startsWith(q)) score = 3;
      else if (name.includes(q)) score = 2;
      else if (id.includes(q)) score = 1;
      if (score > 0) scored.push({ node, score });
    }
    scored.sort((a, b) => b.score - a.score || a.node.name.length - b.node.name.length);
    return scored.slice(0, 20).map((s) => s.node);
  }, [graph, query]);

  const choose = (node: GNode): void => {
    onReveal(node.id);
    setQuery('');
    setActive(0);
  };

  return (
    <div className="search">
      <input
        placeholder="find a domain, file, or function…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter' && results[active]) choose(results[active]);
          else if (e.key === 'Escape') setQuery('');
        }}
      />
      {results.length > 0 && (
        <div className="results">
          {results.map((node, i) => (
            <button
              key={node.id}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(node)}
            >
              <span className="kind">{KIND_GLYPH[node.kind]}</span>
              <span>{node.name}</span>
              <span className="where">{whereOf(node)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
