/**
 * The four node kinds, as React components rather than drawn shapes — the
 * reason React Flow won over a canvas renderer. A node here can carry a
 * coverage rule, a breadth reading, and a doc summary because it is markup.
 *
 * Colour is domain identity and nothing else. Height and fill are
 * importance. The rule along the bottom is coverage: solid where a test
 * aims at this code, hollow where it is only reached in passing.
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GNode } from '../../src/graph/schema.ts';

export interface NodeData extends Record<string, unknown> {
  node: GNode;
  hue: number;
  open: boolean;
  hasChildren: boolean;
  dimmed: boolean;
  onToggle: (id: string) => void;
}

const pct = (n: number | undefined) => (n === undefined ? null : Math.round(n * 100));

/**
 * The expand control. A visible affordance rather than a double-click you
 * have to be told about — and it stops propagation so opening a folder is
 * not also a selection.
 */
function Caret({ id, open, onToggle }: { id: string; open: boolean; onToggle: (id: string) => void }) {
  return (
    <button
      className="caret nodrag"
      title={open ? 'collapse' : 'expand'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(id);
      }}
    >
      {open ? '▾' : '▸'}
    </button>
  );
}

/** Invisible ports; React Flow needs them to anchor an edge. */
function Ports() {
  return (
    <>
      <Handle type="target" position={Position.Left} className="port" />
      <Handle type="source" position={Position.Right} className="port" />
    </>
  );
}

/** Coverage as a rule along the bottom edge. */
function CoverageRule({ node, hue }: { node: GNode; hue: number }) {
  const total = node.stats?.functions ?? 0;
  if (!total) return null;
  const covered = node.stats?.coveredFunctions ?? 0;
  const direct = (node.stats?.directTests ?? 0) > 0;
  return (
    <span className="rule" title={`${covered}/${total} functions covered`}>
      <span
        className={direct ? 'rule-fill direct' : 'rule-fill'}
        style={{ width: `${(covered / total) * 100}%`, background: `hsl(${hue} 85% ${direct ? 74 : 58}%)` }}
      />
    </span>
  );
}

export const ContainerNode = memo(function ContainerNode({ data, selected }: NodeProps) {
  const { node, hue, open, dimmed, onToggle } = data as NodeData;
  const breadth = pct(node.stats?.testBreadth);
  const isDomain = node.kind === 'domain';
  return (
    <div
      className={`box container ${isDomain ? 'domain' : 'dir'}${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`}
      style={{
        borderColor: `hsl(${hue} 62% 64% / ${isDomain ? 0.62 : 0.32})`,
        background: `hsl(${hue} 55% 55% / ${isDomain ? 0.08 : 0.045})`,
      }}
    >
      <Ports />
      <header style={{ color: `hsl(${hue} 72% 78%)` }}>
        <Caret id={node.id} open={open} onToggle={onToggle} />
        <span className="name">{node.name}</span>
        {breadth !== null && <span className="breadth">{breadth}%</span>}
      </header>
      <CoverageRule node={node} hue={hue} />
    </div>
  );
});

export const LeafNode = memo(function LeafNode({ data, selected }: NodeProps) {
  const { node, hue, hasChildren, dimmed, onToggle } = data as NodeData;
  const breadth = node.stats?.testBreadth ?? 0;
  const ran = (node.runtime?.calls ?? 0) > 0 || breadth > 0;
  const isFn = node.kind === 'function';
  return (
    <div
      className={`box leaf ${isFn ? 'fn' : 'file'}${ran ? ' ran' : ''}${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}${node.flags?.reactComponent ? ' react' : ''}`}
      style={{
        background: ran
          ? `hsl(${hue} ${48 + breadth * 30}% ${30 + breadth * 30}%)`
          : `hsl(${hue} 18% 21%)`,
        borderColor: ran ? `hsl(${hue} 75% ${60 + breadth * 20}%)` : `hsl(${hue} 22% 35%)`,
      }}
    >
      <Ports />
      <span className="name">
        {hasChildren && <Caret id={node.id} open={false} onToggle={onToggle} />}
        {node.name}
      </span>
      <CoverageRule node={node} hue={hue} />
    </div>
  );
});

export const nodeTypes = { container: ContainerNode, leaf: LeafNode };
