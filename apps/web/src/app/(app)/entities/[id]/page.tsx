'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { GraphLegend, GraphView } from '@/components/graph-view';
import { useSource } from '@/components/source-viewer';
import { api } from '@/lib/api';
import type { GraphEdge, GraphNode } from '@/lib/types';
import { DefinitionList, LoadingRows, Notice, SectionHeader, Select, Sheet, Table, Td, Th } from '@/ui';

interface Entity extends GraphNode {
  mentions: { id: string; case_id: string; case_reference: string; document_id: string; document_title: string; version_id: string; mention_text: string; role: string | null; page_no: number | null }[];
}

export default function EntityPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const open = useSource();
  const [depth, setDepth] = useState(2);
  const e = useQuery({ queryKey: ['entity', id], queryFn: () => api<Entity>(`/v1/entities/${id}`) });
  const g = useQuery({
    queryKey: ['entity', id, 'graph', depth],
    queryFn: () => api<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>(`/v1/entities/${id}/relationships`, { query: { depth } }),
  });
  if (e.isLoading) return <LoadingRows />;
  if (!e.data) return <Notice tone="conflict">This entity does not exist, or you cannot see any document that mentions it.</Notice>;
  const ent = e.data;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div>
        <nav className="text-xs text-ink-muted">
          <Link href="/entities" className="hover:text-ink">
            Entities
          </Link>
        </nav>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{ent.display_name}</h1>
        <p className="text-xs text-ink-muted">{ent.kind === 'organization' ? 'Organization' : 'Individual'}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-3">
          <SectionHeader
            title="Connections"
            actions={
              <Select aria-label="Depth" value={depth} onChange={(ev) => setDepth(Number(ev.target.value))} className="h-7 w-36 text-xs">
                {[1, 2, 3, 4].map((d) => (
                  <option key={d} value={d}>
                    {d} step{d > 1 ? 's' : ''} away
                  </option>
                ))}
              </Select>
            }
          />
          <GraphLegend />
          {g.data ? (
            <>
              <GraphView nodes={g.data.nodes} edges={g.data.edges} rootId={id} selectedNode={id} onNode={(n) => n.id !== id && router.push(`/entities/${n.id}`)} height={460} />
              {g.data.truncated && <Notice tone="candidate">The network is large; only part of it is shown. Reduce the depth for a complete view.</Notice>}
            </>
          ) : (
            <LoadingRows rows={6} />
          )}
        </div>
        <Sheet className="h-fit p-4">
          <DefinitionList
            items={[
              ['Jurisdiction', ent.jurisdiction ?? 'Unknown'],
              ...Object.entries(ent.identifiers).map(([k, v]) => [k.replace('_', ' '), v] as [string, string]),
              ...Object.entries(ent.attributes)
                .filter(([k]) => ['formation_date', 'dob', 'address'].includes(k))
                .map(([k, v]) => [k === 'dob' ? 'Date of birth' : k.replace('_', ' '), String(v)] as [string, string]),
            ]}
          />
        </Sheet>
      </div>
      <Sheet>
        <div className="border-b border-rule px-4 py-3">
          <SectionHeader title="Mentioned in" />
        </div>
        <Table caption="Mentions">
          <thead>
            <tr>
              <Th>Document</Th>
              <Th>Case</Th>
              <Th>As</Th>
            </tr>
          </thead>
          <tbody>
            {ent.mentions.map((m) => (
              <tr key={m.id}>
                <Td>
                  <button className="text-left text-register hover:underline" onClick={() => open({ documentId: m.document_id, versionId: m.version_id, quote: m.mention_text })}>
                    {m.document_title}
                    {m.page_no ? `, page ${m.page_no}` : ''}
                  </button>
                </Td>
                <Td className="tabular-nums">
                  <Link href={`/cases/${m.case_id}`} className="hover:text-register">
                    {m.case_reference}
                  </Link>
                </Td>
                <Td className="text-xs text-ink-muted">{m.role?.replace('_', ' ')}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Sheet>
    </div>
  );
}
