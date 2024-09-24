'use client';

import Link from 'next/link';
import { useState } from 'react';
import { GraphLegend, GraphView } from '@/components/graph-view';
import { useSource } from '@/components/source-viewer';
import { api } from '@/lib/api';
import { fmtDate, pct } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { CaseSummary, GraphEdge } from '@/lib/types';
import { Badge, Button, Checkbox, EmptyState, EvidenceQuote, Field, LoadingRows, SectionHeader, Sheet, Textarea } from '@/ui';
import { useCaseMutation, useGraph } from './hooks';

const TYPE_TEXT: Record<string, string> = { OWNED_BY: 'is owned by', DIRECTOR_OF: 'is a director of', OFFICER_OF: 'is an officer of', SUBSIDIARY_OF: 'is a subsidiary of', SIGNATORY_OF: 'is a signatory of' };

function EdgePanel({ c, e, names, onClose }: { c: CaseSummary; e: GraphEdge; names: Map<string, string>; onClose: () => void }) {
  const s = useSession();
  const open = useSource();
  const [comment, setComment] = useState('');
  const review = useCaseMutation(c.id, (action: string) => api(`/v1/relationships/${e.id}/reviews`, { body: { action, comment: comment || undefined } }), 'Relationship updated');
  const editable = s.can('graph:edit') && !c.closed_at;
  return (
    <Sheet className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm">
          <span className="font-semibold">{names.get(e.source_entity_id)}</span> {TYPE_TEXT[e.relationship_type] ?? e.relationship_type}{' '}
          <span className="font-semibold">{names.get(e.target_entity_id)}</span>
          {e.ownership_pct !== null && <span className="font-semibold"> ({Number(e.ownership_pct)}%)</span>}
          {e.role_title && <span className="text-ink-muted"> as {e.role_title}</span>}
        </p>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="flex flex-wrap gap-2 text-2xs text-ink-muted">
        <Badge tone={e.review_status === 'verified' ? 'verified' : e.review_status === 'candidate' ? 'candidate' : 'conflict'} dashed={e.review_status !== 'verified'}>
          {e.review_status === 'candidate' ? 'Not verified' : e.review_status[0]!.toUpperCase() + e.review_status.slice(1)}
        </Badge>
        {e.valid_from && <span>From {fmtDate(e.valid_from)}</span>}
        {e.valid_to && <span>Superseded {fmtDate(e.valid_to)}</span>}
        {e.confidence !== null && <span>Extraction confidence {pct(e.confidence)}</span>}
        {e.origin === 'manual' && <span>Recorded manually</span>}
      </div>
      {e.evidence_quote && (
        <EvidenceQuote
          quote={e.evidence_quote}
          source={`${e.evidence_document_title ?? 'Document'}${e.evidence_page ? `, page ${e.evidence_page}` : ''}`}
          onOpen={() => open({ documentId: e.evidence_document_id, versionId: e.evidence_document_version_id, quote: e.evidence_quote })}
        />
      )}
      {editable && (
        <div className="flex flex-col gap-2 border-t border-rule pt-3">
          <Field label="Comment" hint="Required to reject or reopen.">
            {(id, d) => <Textarea id={id} aria-describedby={d} rows={2} value={comment} onChange={(ev) => setComment(ev.target.value)} />}
          </Field>
          <div className="flex flex-wrap gap-2">
            {e.review_status !== 'verified' && (
              <Button size="sm" variant="primary" busy={review.isPending} onClick={() => review.mutate('verify', { onSuccess: onClose })}>
                Verify relationship
              </Button>
            )}
            {e.review_status !== 'rejected' && (
              <Button size="sm" variant="danger" disabled={comment.trim().length < 3} onClick={() => review.mutate('reject', { onSuccess: onClose })}>
                Reject
              </Button>
            )}
            {e.review_status !== 'candidate' && (
              <Button size="sm" disabled={comment.trim().length < 3} onClick={() => review.mutate('reopen', { onSuccess: onClose })}>
                Reopen
              </Button>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}

export function GraphTab({ c }: { c: CaseSummary }) {
  const [historical, setHistorical] = useState(false);
  const q = useGraph(c.id, historical);
  const [selected, setSelected] = useState<string | null>(null);
  if (q.isLoading) return <LoadingRows rows={8} />;
  const g = q.data!;
  const names = new Map(g.nodes.map((n) => [n.id, n.display_name]));
  const edge = g.edges.find((e) => e.id === selected);
  return (
    <div className="flex flex-col gap-3">
      <SectionHeader
        title="Relationships"
        description="Owners sit above what they own. Select a line to see the document that supports it."
        actions={<Checkbox label="Show superseded claims" checked={historical} onChange={(e) => setHistorical(e.target.checked)} />}
      />
      <GraphLegend />
      {g.edges.length === 0 ? (
        <EmptyState title="No relationships yet">Ownership declarations, director registers and structure charts add people and companies here.</EmptyState>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <GraphView nodes={g.nodes} edges={g.edges} rootId={g.subject_entity_id} selectedEdge={selected} onEdge={(e) => setSelected(e.id)} height={560} />
          <div className="flex flex-col gap-3">
            {edge ? (
              <EdgePanel key={edge.id} c={c} e={edge} names={names} onClose={() => setSelected(null)} />
            ) : (
              <Sheet className="p-4 text-xs text-ink-muted">Select a relationship line to inspect its evidence and verify it.</Sheet>
            )}
            <Sheet className="p-4">
              <p className="mb-2 text-xs font-semibold">People and companies</p>
              <ul className="flex flex-col gap-1 text-xs">
                {g.nodes.map((n) => (
                  <li key={n.id}>
                    <Link href={`/entities/${n.id}`} className="text-register hover:underline">
                      {n.display_name}
                    </Link>
                    <span className="text-ink-muted"> {n.kind === 'organization' ? 'organization' : 'individual'}</span>
                  </li>
                ))}
              </ul>
            </Sheet>
          </div>
        </div>
      )}
    </div>
  );
}
