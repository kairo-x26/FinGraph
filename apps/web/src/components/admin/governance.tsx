'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { CaseSummary, Paged } from '@/lib/types';
import { Badge, Button, Dialog, EmptyState, Field, LoadingRows, Notice, SectionHeader, Select, Sheet, Table, Td, Textarea, Th, useToast } from '@/ui';

interface Hold {
  id: string;
  case_id: string;
  case_reference: string;
  document_title: string | null;
  reason: string;
  created_by_name: string | null;
  created_at: string;
}

interface Alerts {
  alerts: { level: 'critical' | 'warning'; code: string; message: string }[];
  jobs: { dead: number; failed_24h: number; backlog: number; oldest_queued_s: number | null };
  outbox: { pending: number };
  dead_jobs: { id: string; kind: string; attempts: number; last_error: { type: string; message: string } | null; finished_at: string }[];
}

export function GovernanceAdmin() {
  const s = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const holds = useQuery({ queryKey: ['holds'], queryFn: () => api<{ items: Hold[] }>('/v1/legal-holds'), enabled: s.can('admin:retention') });
  const retention = useQuery({
    queryKey: ['retention'],
    queryFn: () => api<{ retention_days: number; eligible: { id: string; reference: string; closed_at: string }[]; held: { id: string; reference: string }[] }>('/v1/admin/retention'),
    enabled: s.can('admin:retention'),
  });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api<Alerts>('/v1/admin/alerts'), enabled: s.can('admin:settings'), refetchInterval: 15_000 });
  const cases = useQuery({ queryKey: ['cases', 'all-for-hold'], queryFn: () => api<Paged<CaseSummary>>('/v1/cases', { query: { limit: 200 } }) });
  const [placing, setPlacing] = useState(false);
  const [form, setForm] = useState({ case_id: '', reason: '' });
  const place = useMutation({
    mutationFn: () => api('/v1/legal-holds', { body: form }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['holds'] });
      qc.invalidateQueries({ queryKey: ['retention'] });
      setPlacing(false);
      toast({ tone: 'success', message: 'Legal hold placed' });
    },
  });
  const release = useMutation({
    mutationFn: (id: string) => {
      const reason = prompt('Why is the hold being released?');
      if (!reason || reason.length < 10) throw new Error('Give a reason of at least 10 characters.');
      return api(`/v1/legal-holds/${id}/release`, { body: { reason } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holds'] }),
    onError: (e) => toast({ tone: 'error', message: errorMessage(e) }),
  });
  const sweep = useMutation({
    mutationFn: () => api('/v1/admin/retention/run', { method: 'POST' }),
    onSuccess: () => toast({ tone: 'success', message: 'Retention sweep started' }),
    onError: (e) => toast({ tone: 'error', message: errorMessage(e) }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    place.mutate();
  };
  return (
    <div className="flex flex-col gap-5">
      {alerts.data && (
        <Sheet className="flex flex-col gap-3 p-4">
          <SectionHeader title="Operational health" />
          {alerts.data.alerts.length === 0 ? (
            <Notice tone="verified">Background processing is healthy.</Notice>
          ) : (
            alerts.data.alerts.map((a) => (
              <Notice key={a.code} tone={a.level === 'critical' ? 'conflict' : 'candidate'}>
                {a.message}
              </Notice>
            ))
          )}
          <p className="text-2xs text-ink-muted">
            {alerts.data.jobs.failed_24h} failed jobs in 24 hours, {alerts.data.jobs.backlog} waiting over 5 minutes, {alerts.data.outbox.pending} events waiting for delivery.
          </p>
          {alerts.data.dead_jobs.length > 0 && (
            <Table caption="Jobs that gave up">
              <thead>
                <tr>
                  <Th>Job</Th>
                  <Th>Error</Th>
                  <Th numeric>Attempts</Th>
                  <Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {alerts.data.dead_jobs.map((j) => (
                  <tr key={j.id}>
                    <Td className="text-xs">{j.kind.replace('_', ' ')}</Td>
                    <Td className="text-xs text-ink-muted">{j.last_error?.message}</Td>
                    <Td numeric>{j.attempts}</Td>
                    <Td className="text-xs text-ink-muted">{fmtRelative(j.finished_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Sheet>
      )}
      {s.can('admin:retention') && (
        <>
          <Sheet>
            <div className="border-b border-rule px-4 py-3">
              <SectionHeader
                title="Legal holds"
                description="Held cases and documents cannot be deleted, manually or by the retention schedule."
                actions={
                  <Button variant="primary" onClick={() => (setForm({ case_id: '', reason: '' }), setPlacing(true))}>
                    Place hold
                  </Button>
                }
              />
            </div>
            {holds.isLoading ? (
              <LoadingRows />
            ) : !holds.data?.items.length ? (
              <div className="p-4">
                <EmptyState title="No active holds" />
              </div>
            ) : (
              <Table caption="Legal holds">
                <thead>
                  <tr>
                    <Th>Case</Th>
                    <Th>Reason</Th>
                    <Th>Placed</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {holds.data.items.map((h) => (
                    <tr key={h.id}>
                      <Td className="tabular-nums">
                        {h.case_reference}
                        {h.document_title && <span className="block text-2xs text-ink-muted">{h.document_title}</span>}
                      </Td>
                      <Td className="text-xs">{h.reason}</Td>
                      <Td className="text-xs text-ink-muted">
                        {fmtDate(h.created_at)}
                        {h.created_by_name ? `, ${h.created_by_name}` : ''}
                      </Td>
                      <Td className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => release.mutate(h.id)}>
                          Release
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Sheet>
          <Sheet className="flex flex-col gap-3 p-4">
            <SectionHeader
              title="Retention"
              description={retention.data ? `Closed cases are deleted ${retention.data.retention_days} days after closing. Change this under Organization.` : undefined}
              actions={
                <Button onClick={() => confirm('Delete every eligible case now? This cannot be undone.') && sweep.mutate()} disabled={!retention.data?.eligible.length}>
                  Run deletion now
                </Button>
              }
            />
            {retention.data && (
              <p className="text-xs">
                <Badge tone={retention.data.eligible.length ? 'candidate' : 'neutral'}>{retention.data.eligible.length} due for deletion</Badge>{' '}
                <Badge>{retention.data.held.length} kept by legal hold</Badge>
              </p>
            )}
            {retention.data?.eligible.length ? (
              <p className="text-2xs text-ink-muted">Due: {retention.data.eligible.map((e) => e.reference).join(', ')}</p>
            ) : null}
          </Sheet>
        </>
      )}
      <Dialog open={placing} onClose={() => setPlacing(false)} title="Place a legal hold">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Case">
            {(id) => (
              <Select id={id} required value={form.case_id} onChange={(e) => setForm({ ...form, case_id: e.target.value })}>
                <option value="">Choose a case</option>
                {cases.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.reference} {c.subject_name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Reason" hint="For example the matter or subpoena reference.">
            {(id, d) => <Textarea id={id} aria-describedby={d} required minLength={10} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}
          </Field>
          {place.error && <Notice tone="conflict">{errorMessage(place.error)}</Notice>}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setPlacing(false)}>Cancel</Button>
            <Button type="submit" variant="primary" busy={place.isPending}>
              Place hold
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
