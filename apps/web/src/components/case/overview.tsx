'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Circle, Clock, FileQuestion, MinusCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { caseTypeLabel, fmtDate, fmtDateTime, fmtRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { CaseSummary, ChecklistItem } from '@/lib/types';
import { Badge, Button, DefinitionList, Dialog, EmptyState, Field, LoadingRows, Notice, SectionHeader, Sheet, Table, Td, Textarea, Th } from '@/ui';
import { keys, useCaseMutation, useChecklist, useOwnership, useReadiness } from './hooks';

const ITEM: Record<ChecklistItem['status'], { icon: React.ReactNode; label: string; tone: string }> = {
  satisfied: { icon: <CheckCircle2 className="size-4 text-verified" />, label: 'Received', tone: 'text-verified' },
  waived: { icon: <MinusCircle className="size-4 text-ink-muted" />, label: 'Waived', tone: 'text-ink-muted' },
  pending: { icon: <Clock className="size-4 text-register" />, label: 'Processing', tone: 'text-register' },
  expired: { icon: <AlertTriangle className="size-4 text-candidate" />, label: 'Out of date', tone: 'text-candidate' },
  requested: { icon: <FileQuestion className="size-4 text-candidate" />, label: 'Requested from customer', tone: 'text-candidate' },
  missing: { icon: <Circle className="size-4 text-ink-faint" />, label: 'Missing', tone: 'text-ink-muted' },
};

function Checklist({ c }: { c: CaseSummary }) {
  const s = useSession();
  const q = useChecklist(c.id);
  const [dialog, setDialog] = useState<{ item: ChecklistItem; kind: 'waive' | 'request' } | null>(null);
  const [text, setText] = useState('');
  const act = useCaseMutation(
    c.id,
    ({ item, kind, text }: { item: ChecklistItem; kind: 'waive' | 'request'; text: string }) =>
      kind === 'waive'
        ? api(`/v1/cases/${c.id}/checklist/${item.key}/waive`, { body: { reason: text } })
        : api(`/v1/cases/${c.id}/requests`, { body: { item_key: item.key, message: text } }),
    'Checklist updated',
  );
  const closed = !!c.closed_at;
  const done = q.data?.items.filter((i) => i.status === 'satisfied' || i.status === 'waived').length ?? 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dialog) return;
    act.mutate({ ...dialog, text }, { onSuccess: () => setDialog(null) });
  };
  return (
    <Sheet>
      <div className="border-b border-rule px-4 py-3">
        <SectionHeader
          title="Required documents"
          description={q.data?.template ? `${done} of ${q.data.items.length} in place. Checklist version ${q.data.template.version}.` : undefined}
        />
      </div>
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <ul>
          {q.data?.items.map((item) => {
            const meta = ITEM[item.status];
            return (
              <li key={item.key} className="flex flex-wrap items-start gap-3 border-b border-rule/70 px-4 py-2.5 last:border-0">
                <span className="mt-0.5">{meta.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {item.label}
                    {!item.required && <span className="ml-1.5 text-2xs text-ink-muted">(optional)</span>}
                  </p>
                  <p className={cn('text-2xs', meta.tone)}>
                    {meta.label}
                    {item.max_age_days ? `, must be under ${item.max_age_days} days old` : ''}
                  </p>
                  {item.waiver && <p className="mt-0.5 text-2xs text-ink-muted">Waiver: {item.waiver.reason}</p>}
                  {item.request && <p className="mt-0.5 text-2xs text-ink-muted">Asked {fmtRelative(item.request.created_at)}: {item.request.message}</p>}
                </div>
                {!closed && !['satisfied', 'waived', 'pending'].includes(item.status) && (
                  <div className="flex gap-1.5">
                    {s.can('case:update') && item.status !== 'requested' && (
                      <Button size="sm" onClick={() => (setText(''), setDialog({ item, kind: 'request' }))}>
                        Request
                      </Button>
                    )}
                    {s.can('case:review') && (
                      <Button size="sm" variant="ghost" onClick={() => (setText(''), setDialog({ item, kind: 'waive' }))}>
                        Waive
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'waive' ? `Waive "${dialog.item.label}"` : `Request "${dialog?.item.label}"`}
        description={dialog?.kind === 'waive' ? 'The reason is recorded with the case and appears in audit exports.' : 'The onboarding team uses this message to contact the customer.'}
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label={dialog?.kind === 'waive' ? 'Reason for waiving' : 'Message'}>
            {(id) => <Textarea id={id} required minLength={dialog?.kind === 'waive' ? 10 : 5} value={text} onChange={(e) => setText(e.target.value)} autoFocus />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button type="submit" variant="primary" busy={act.isPending}>
              {dialog?.kind === 'waive' ? 'Waive item' : 'Send request'}
            </Button>
          </div>
        </form>
      </Dialog>
    </Sheet>
  );
}

function Findings({ c }: { c: CaseSummary }) {
  const q = useReadiness(c.id);
  const r = q.data;
  return (
    <Sheet>
      <div className="border-b border-rule px-4 py-3">
        <SectionHeader
          title="Findings and policy checks"
          description={r ? `Evaluated against ${r.policy.name}, version ${r.policy.version}.` : undefined}
        />
      </div>
      {q.isLoading || !r ? (
        <LoadingRows />
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <ul className="flex flex-col gap-1.5">
            {r.checks.map((x) => (
              <li key={x.key} className="flex items-start gap-2 text-xs">
                {x.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0 text-verified" /> : <AlertTriangle className="mt-px size-3.5 shrink-0 text-candidate" />}
                <span>{x.detail}</span>
              </li>
            ))}
          </ul>
          {r.findings.length === 0 ? (
            <p className="text-xs text-ink-muted">No discrepancies found in the evidence you can see.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {r.findings.map((f) => (
                <li
                  key={f.id}
                  className={cn(
                    'rounded-[var(--radius-control)] border-l-[3px] bg-sheet-sunk px-3 py-2',
                    f.severity === 'high' ? 'border-conflict' : f.severity === 'medium' ? 'border-candidate' : 'border-rule-strong',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{f.title}</p>
                    {r.escalation_findings.some((e) => e.id === f.id) && <Badge tone="candidate">Requires escalation</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">{f.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Sheet>
  );
}

function Ownership({ c }: { c: CaseSummary }) {
  const q = useOwnership(c.id);
  const owners = q.data?.owners.filter((o) => o.kind === 'individual') ?? [];
  return (
    <Sheet>
      <div className="border-b border-rule px-4 py-3">
        <SectionHeader title="Beneficial ownership" description={q.data ? `Individuals holding ${q.data.threshold}% or more, directly or indirectly, are beneficial owners.` : undefined} />
      </div>
      {q.isLoading ? (
        <LoadingRows rows={3} />
      ) : owners.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No ownership information yet">Upload an ownership declaration or a group structure chart.</EmptyState>
        </div>
      ) : (
        <Table caption="Effective ownership">
          <thead>
            <tr>
              <Th>Individual</Th>
              <Th numeric>Effective</Th>
              <Th>Declared</Th>
            </tr>
          </thead>
          <tbody>
            {owners.map((o) => {
              const above = o.effective_pct >= (q.data?.threshold ?? 25);
              return (
                <tr key={o.entity_id}>
                  <Td>
                    <span className={cn(above && 'font-medium')}>{o.display_name}</span>
                    {o.chains.some((ch) => ch.path.length > 1) && <span className="block text-2xs text-ink-muted">Includes indirect holdings</span>}
                  </Td>
                  <Td numeric className={cn(above && 'font-semibold')}>
                    {o.effective_pct}%
                  </Td>
                  <Td>
                    {o.declared ? (
                      <Badge tone="verified">Declared</Badge>
                    ) : above ? (
                      <Badge tone="conflict">Not declared</Badge>
                    ) : (
                      <span className="text-2xs text-ink-muted">Below threshold</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Sheet>
  );
}

function Notes({ c }: { c: CaseSummary }) {
  const s = useSession();
  const q = useQuery({
    queryKey: [...keys.case(c.id), 'notes'],
    queryFn: () => api<{ items: { id: string; body: string; author_name: string; created_at: string }[] }>(`/v1/cases/${c.id}/notes`),
  });
  const [body, setBody] = useState('');
  const add = useCaseMutation(c.id, (b: string) => api(`/v1/cases/${c.id}/notes`, { body: { body: b } }));
  return (
    <Sheet>
      <div className="border-b border-rule px-4 py-3">
        <SectionHeader title="Notes" />
      </div>
      <ul className="flex flex-col">
        {q.data?.items.map((n) => (
          <li key={n.id} className="border-b border-rule/70 px-4 py-2.5">
            <p className="text-sm whitespace-pre-wrap">{n.body}</p>
            <p className="mt-1 text-2xs text-ink-muted">
              {n.author_name}, {fmtDateTime(n.created_at)}
            </p>
          </li>
        ))}
      </ul>
      {s.can('case:update') && !c.closed_at && (
        <form
          className="flex flex-col gap-2 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(body, { onSuccess: () => setBody('') });
          }}
        >
          <Textarea aria-label="Add a note" placeholder="Add a note for the team" value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
          <div>
            <Button size="sm" type="submit" disabled={!body.trim()} busy={add.isPending}>
              Add note
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

export function Overview({ c }: { c: CaseSummary }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <Findings c={c} />
        <Checklist c={c} />
      </div>
      <div className="flex flex-col gap-4">
        <Ownership c={c} />
        <Sheet className="p-4">
          <SectionHeader title="Case details" level={3} />
          <div className="mt-3">
            <DefinitionList
              items={[
                ['Reference', <span key="r" className="tabular-nums">{c.reference}</span>],
                ['Type', caseTypeLabel(c.case_type)],
                ['Customer ID', c.customer_ref ?? 'None'],
                ['Opened', `${fmtDate(c.created_at)} by ${c.created_by_name ?? 'API'}`],
                ['Review started', c.review_started_at ? fmtDateTime(c.review_started_at) : 'Not yet'],
                ['Closed', c.closed_at ? fmtDateTime(c.closed_at) : 'Open'],
                ['Members', c.members?.length ? c.members.map((m) => `${m.display_name} (${m.role})`).join(', ') : 'None'],
              ]}
            />
          </div>
          {c.restricted && (
            <div className="mt-3">
              <Notice tone="candidate">Restricted case. Only the creator, reviewer and members can open it.</Notice>
            </div>
          )}
        </Sheet>
        <Notes c={c} />
      </div>
    </div>
  );
}
