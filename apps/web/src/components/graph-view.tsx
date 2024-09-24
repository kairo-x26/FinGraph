'use client';

import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Building2, User } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import type { GraphEdge, GraphNode } from '@/lib/types';

type EntityData = { node: GraphNode; subject: boolean; selected: boolean };

function EntityNode({ data }: NodeProps<Node<EntityData>>) {
  const org = data.node.kind === 'organization';
  return (
    <div
      className={cn(
        'flex max-w-[210px] items-center gap-2 border bg-sheet px-3 py-2 text-xs shadow-sm',
        org ? 'rounded-[4px]' : 'rounded-full',
        data.subject ? 'border-register border-2 font-semibold' : 'border-rule-strong',
        data.selected && 'ring-2 ring-register/40',
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-rule-strong" />
      {org ? <Building2 className="size-3.5 shrink-0 text-ink-muted" /> : <User className="size-3.5 shrink-0 text-ink-muted" />}
      <span className="leading-tight">{data.node.display_name}</span>
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-rule-strong" />
    </div>
  );
}

const nodeTypes = { entity: EntityNode };

const LABEL: Record<string, string> = { DIRECTOR_OF: 'Director', OFFICER_OF: 'Officer', SIGNATORY_OF: 'Signatory', SUBSIDIARY_OF: 'Subsidiary' };

export function edgeColor(status: string) {
  return status === 'verified' ? 'var(--verified)' : status === 'conflicting' || status === 'rejected' ? 'var(--conflict)' : 'var(--candidate)';
}

/**
 * Layered layout: owners sit above what they own, so ultimate beneficial owners end
 * up at the top; directors and officers sit below the company they serve.
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[], rootId: string | null) {
  const level = new Map<string, number>();
  if (rootId) level.set(rootId, 0);
  const ownership = edges.filter((e) => e.relationship_type === 'OWNED_BY' || e.relationship_type === 'SUBSIDIARY_OF');
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of ownership) {
      // both predicates point from the held entity to its holder
      const owned = e.source_entity_id;
      const owner = e.target_entity_id;
      const l = level.get(owned);
      if (l !== undefined && (level.get(owner) ?? -Infinity) < l + 1) {
        level.set(owner, l + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const e of edges.filter((x) => !ownership.includes(x))) {
    if (!level.has(e.source_entity_id)) level.set(e.source_entity_id, (level.get(e.target_entity_id) ?? 0) - 1);
  }
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, 0);
  const rows = new Map<number, string[]>();
  for (const [id, l] of level) rows.set(l, [...(rows.get(l) ?? []), id]);
  const pos = new Map<string, { x: number; y: number }>();
  const maxLevel = Math.max(...rows.keys());
  for (const [l, ids] of rows) {
    ids.sort();
    ids.forEach((id, i) => pos.set(id, { x: (i - (ids.length - 1) / 2) * 240, y: (maxLevel - l) * 130 }));
  }
  return pos;
}

export function GraphView({
  nodes,
  edges,
  rootId,
  selectedEdge,
  selectedNode,
  onEdge,
  onNode,
  height = 520,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootId: string | null;
  selectedEdge?: string | null;
  selectedNode?: string | null;
  onEdge?: (e: GraphEdge) => void;
  onNode?: (n: GraphNode) => void;
  height?: number;
}) {
  const { rfNodes, rfEdges } = useMemo(() => {
    const pos = layout(nodes, edges, rootId);
    const rfNodes: Node<EntityData>[] = nodes.map((n) => ({
      id: n.id,
      type: 'entity',
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: { node: n, subject: n.id === rootId, selected: n.id === selectedNode },
    }));
    // a person who both owns and holds a role in a company gets one line, labelled with both
    const ownerPairs = new Set(edges.filter((e) => e.relationship_type === 'OWNED_BY').map((e) => `${e.source_entity_id}|${e.target_entity_id}`));
    const rolesFor = (owned: string, owner: string) =>
      edges
        .filter((r) => r.relationship_type !== 'OWNED_BY' && r.source_entity_id === owner && r.target_entity_id === owned)
        .map((r) => (LABEL[r.relationship_type] ?? r.relationship_type).toLowerCase());
    const drawn = edges.filter((e) => e.relationship_type === 'OWNED_BY' || !ownerPairs.has(`${e.target_entity_id}|${e.source_entity_id}`));
    const rfEdges: Edge[] = drawn.map((e) => {
      const owner = e.relationship_type === 'OWNED_BY';
      const roles = owner ? rolesFor(e.source_entity_id, e.target_entity_id) : [];
      const color = edgeColor(e.review_status);
      return {
        id: e.id,
        // owners are drawn above what they own; people in roles hang below their company
        source: e.target_entity_id,
        target: e.source_entity_id,
        label: owner
          ? [e.ownership_pct !== null ? `${Number(e.ownership_pct)}%` : 'Owner', ...roles].join(', ')
          : (LABEL[e.relationship_type] ?? e.relationship_type),
        labelStyle: { fontSize: 11, fontWeight: 600, fill: 'var(--ink)' },
        labelBgStyle: { fill: 'var(--sheet)' },
        labelBgPadding: [4, 2] as [number, number],
        style: {
          stroke: color,
          strokeWidth: e.id === selectedEdge ? 3 : 1.6,
          strokeDasharray: e.review_status === 'verified' ? undefined : '6 4',
          opacity: e.valid_to ? 0.45 : 1,
        },
        markerEnd: owner ? { type: MarkerType.ArrowClosed, color, width: 16, height: 16 } : undefined,
        data: { edge: e },
      };
    });
    return { rfNodes, rfEdges };
  }, [nodes, edges, rootId, selectedEdge, selectedNode]);

  return (
    <div style={{ height }} className="overflow-hidden rounded-[var(--radius-sheet)] border border-rule bg-sheet-sunk">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        minZoom={0.2}
        nodesConnectable={false}
        nodesDraggable
        onEdgeClick={(_, e) => onEdge?.((e.data as { edge: GraphEdge }).edge)}
        onNodeClick={(_, n) => onNode?.((n.data as EntityData).node)}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--rule)" gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function GraphLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-ink-muted" aria-label="Legend">
      <li className="flex items-center gap-1.5">
        <span className="h-0.5 w-6 bg-verified" /> Verified by a reviewer
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-0 w-6 border-t-2 border-dashed border-candidate" /> Proposed from a document
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-0 w-6 border-t-2 border-dashed border-conflict" /> Conflicting claims
      </li>
      <li className="flex items-center gap-1.5">
        <Building2 className="size-3" /> Organization
      </li>
      <li className="flex items-center gap-1.5">
        <User className="size-3" /> Individual
      </li>
    </ul>
  );
}
