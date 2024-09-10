'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CASE_TYPES, CASE_TYPE_LABELS, RISK_LEVELS } from '@fingraph/shared';
import { Lock, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { caseStatusLabel, caseStatusTone, caseTypeLabel, fmtDate, fmtRelative, riskTone } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { CaseSummary, Paged } from '@/lib/types';
import { Badge, Button, Checkbox, Dialog, EmptyState, Field, Input, LoadingRows, Notice, Select, Sheet, Table, Tabs, Td, Th, Tr } from '@/ui';

type View = 'mine' | 'unassigned' | 'approval' | 'open' | 'closed';

const VIEWS: Record<View, Record<string, string | string[]>> = {
  mine: { assignee: 'me', open: 'true' },
  unassigned: { assignee: 'none', open: 'true' },
  approval: { status: ['pending_approval', 'escalated'] },
  open: { open: 'true' },
  closed: { open: 'false' },
};

function NewCaseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const [form, setForm] = useState({ case_type: 'kyb_onboarding', subject_name: '', customer_ref: '', risk_level: 'medium', assignee_id: '', restricted: false });
  const directory = useQuery({
    queryKey: ['directory'],
    queryFn: () => api<{ items: { id: string; display_name: string; roles: string[] }[] }>('/v1/users/directory'),
    enabled: open && s.can('case:assign'),
  });
  const create = useMutation({
    mutationFn: () =>
      api<CaseSummary>('/v1/cases', {
        body: {
          case_type: form.case_type,
          subject_name: form.subject_name,
          customer_ref: form.customer_ref || undefined,
          risk_level: form.risk_level,
          assignee_id: form.assignee_id || undefined,
          restricted: form.restricted,
        },
      }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['cases'] });
      onClose();
      router.push(`/cases/${c.id}`);
    },
  });
  const reviewers = (directory.data?.items ?? []).filter((u) => u.roles.some((r) => r === 'analyst' || r === 'risk_manager'));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open={open} onClose={onClose} title="New case" description="Open a review for a business or individual customer.">
      <form id="new-case" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Customer legal name" className="sm:col-span-2">
          {(id) => <Input id={id} required minLength={2} value={form.subject_name} onChange={(e) => setForm({ ...form, subject_name: e.target.value })} autoFocus />}
        </Field>
        <Field label="Case type">
          {(id) => (
            <Select id={id} value={form.case_type} onChange={(e) => setForm({ ...form, case_type: e.target.value })}>
              {CASE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CASE_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Risk level">
          {(id) => (
            <Select id={id} value={form.risk_level} onChange={(e) => setForm({ ...form, risk_level: e.target.value })}>
              {RISK_LEVELS.map((r) => (
                <option key={r} value={r}>
                  {r[0]!.toUpperCase() + r.slice(1)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Customer reference" hint="Your internal customer ID (optional).">
          {(id, d) => <Input id={id} aria-describedby={d} value={form.customer_ref} onChange={(e) => setForm({ ...form, customer_ref: e.target.value })} />}
        </Field>
        {s.can('case:assign') && (
          <Field label="Reviewer">
            {(id) => (
              <Select id={id} value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
                <option value="">Leave unassigned</option>
                {reviewers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {s.can('case:assign') && (
          <div className="sm:col-span-2">
            <Checkbox
              label="Restrict access"
              hint="Only you, the reviewer and people you add can see this case."
              checked={form.restricted}
              onChange={(e) => setForm({ ...form, restricted: e.target.checked })}
            />
          </div>
        )}
        {create.error && (
          <div className="sm:col-span-2">
            <Notice tone="conflict">{errorMessage(create.error)}</Notice>
          </div>
        )}
      </form>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="new-case" busy={create.isPending}>
          Create case
        </Button>
      </div>
    </Dialog>
  );
}

export default function CasesPage() {
  const s = useSession();
  const router = useRouter();
  const canReview = s.can('case:review');
  const [view, setView] = useState<View>(canReview ? 'mine' : 'open');
  const [q, setQ] = useState('');
  const [risk, setRisk] = useState('');
  const [creating, setCreating] = useState(false);

  const counts = useQuery({
    queryKey: ['cases', 'counts'],
    queryFn: async () => {
      const get = (v: View) => api<Paged<CaseSummary>>('/v1/cases', { query: { ...VIEWS[v], limit: 200 } }).then((r) => r.items.length);
      const [mine, unassigned, approval] = await Promise.all([get('mine'), get('unassigned'), get('approval')]);
      return { mine, unassigned, approval };
    },
  });

  const list = useInfiniteQuery({
    queryKey: ['cases', view, q, risk],
    queryFn: ({ pageParam }) =>
      api<Paged<CaseSummary>>('/v1/cases', { query: { ...VIEWS[view], q: q || undefined, risk_level: risk || undefined, cursor: pageParam ?? undefined, limit: 50 } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const tabs: { id: View; label: string; count?: number }[] = [
    ...(canReview ? [{ id: 'mine' as const, label: 'Assigned to me', count: counts.data?.mine }] : []),
    { id: 'unassigned', label: 'Unassigned', count: counts.data?.unassigned },
    { id: 'approval', label: 'Awaiting approval', count: counts.data?.approval },
    { id: 'open', label: 'All open' },
    { id: 'closed', label: 'Closed' },
  ];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Cases</h1>
        {s.can('case:create') && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            New case
          </Button>
        )}
      </div>

      <Tabs label="Case views" tabs={tabs} value={view} onChange={setView} />

      <div className="flex flex-wrap gap-2">
        <Input aria-label="Filter by name or reference" placeholder="Filter by customer, reference or customer ID" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Select aria-label="Risk level" value={risk} onChange={(e) => setRisk(e.target.value)} className="w-36">
          <option value="">Any risk</option>
          {RISK_LEVELS.map((r) => (
            <option key={r} value={r}>
              {r[0]!.toUpperCase() + r.slice(1)} risk
            </option>
          ))}
        </Select>
      </div>

      <Sheet>
        {list.isLoading ? (
          <LoadingRows />
        ) : list.error ? (
          <div className="p-4">
            <Notice tone="conflict">{errorMessage(list.error)}</Notice>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title={view === 'mine' ? 'No cases are assigned to you' : 'No cases match'}>
              {view === 'mine' ? 'Pick one from the unassigned queue to start reviewing.' : 'Try a different view or clear the filters.'}
            </EmptyState>
          </div>
        ) : (
          <Table caption="Cases">
            <thead>
              <tr>
                <Th>Reference</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th>Risk</Th>
                <Th>Reviewer</Th>
                <Th numeric>Documents</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const overdue = c.due_at && !c.closed_at && new Date(c.due_at) < new Date();
                return (
                  <Tr key={c.id} interactive onClick={() => router.push(`/cases/${c.id}`)}>
                    <Td className="font-medium whitespace-nowrap tabular-nums">
                      <a href={`/cases/${c.id}`} onClick={(e) => e.preventDefault()} className="hover:text-register">
                        {c.reference}
                      </a>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        {c.restricted && <Lock className="size-3 text-ink-muted" aria-label="Restricted" />}
                        <span className="font-medium">{c.subject_name}</span>
                      </div>
                      <div className="text-2xs text-ink-muted">
                        {caseTypeLabel(c.case_type)}
                        {c.customer_ref ? `, ${c.customer_ref}` : ''}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={caseStatusTone(c.status)}>{caseStatusLabel(c.status)}</Badge>
                      {overdue && <div className="mt-1 text-2xs text-conflict">Due {fmtDate(c.due_at)}</div>}
                    </Td>
                    <Td>
                      <Badge tone={riskTone(c.risk_level)}>{c.risk_level[0]!.toUpperCase() + c.risk_level.slice(1)}</Badge>
                    </Td>
                    <Td className="text-xs">{c.assignee_name ?? <span className="text-ink-faint">Unassigned</span>}</Td>
                    <Td numeric>{c.document_count}</Td>
                    <Td className="text-xs whitespace-nowrap text-ink-muted">{fmtRelative(c.updated_at)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {list.hasNextPage && (
          <div className="border-t border-rule p-3">
            <Button size="sm" onClick={() => list.fetchNextPage()} busy={list.isFetchingNextPage}>
              Show more
            </Button>
          </div>
        )}
      </Sheet>

      <NewCaseDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
