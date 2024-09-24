'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Link2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { caseStatusLabel, fmtBytes, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { CaseSummary } from '@/lib/types';
import { Badge, Button, Checkbox, Dialog, EmptyState, Field, Input, LoadingRows, Notice, SectionHeader, Sheet, Table, Td, Th, useToast } from '@/ui';
import { keys } from './hooks';

interface Decision {
  id: string;
  kind: string;
  outcome: string | null;
  from_status: string;
  to_status: string;
  rationale: string | null;
  decided_by_name: string | null;
  policy_name: string | null;
  policy_version: number | null;
  snapshot: { findings?: { title: string; severity: string }[]; checks?: { detail: string; ok: boolean }[] };
  created_at: string;
}

const KIND: Record<string, string> = {
  start: 'Review started',
  recommendation: 'Reviewer decision',
  approval: 'Approver decision',
  escalation: 'Escalated',
  return: 'Returned to reviewer',
  info_request: 'Information requested',
  reopen: 'Reopened',
  archive: 'Archived',
};

export function DecisionsTab({ c }: { c: CaseSummary }) {
  const q = useQuery({ queryKey: keys.decisions(c.id), queryFn: () => api<{ items: Decision[] }>(`/v1/cases/${c.id}/decisions`) });
  if (q.isLoading) return <LoadingRows />;
  const items = q.data?.items ?? [];
  if (!items.length) return <EmptyState title="No decisions yet">Decisions, their rationale and the policy version in force are recorded here.</EmptyState>;
  return (
    <ol className="relative mx-auto flex max-w-3xl flex-col gap-4 border-l border-rule pl-6">
      {items.map((d) => (
        <li key={d.id} className="relative">
          <span className="absolute top-1.5 -left-[29px] size-2.5 rounded-full border-2 border-sheet bg-register" aria-hidden />
          <Sheet className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold">
                {KIND[d.kind] ?? d.kind}
                {d.outcome && d.kind !== 'start' && <span className="font-normal text-ink-muted">: {d.outcome.replace('_', ' ')}</span>}
              </p>
              <span className="text-2xs text-ink-muted">{fmtDateTime(d.created_at)}</span>
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">
              {d.decided_by_name ?? 'System'} moved the case from {caseStatusLabel(d.from_status).toLowerCase()} to {caseStatusLabel(d.to_status).toLowerCase()}
              {d.policy_version ? ` under ${d.policy_name ?? 'policy'} version ${d.policy_version}` : ''}.
            </p>
            {d.rationale && <p className="mt-2 text-sm whitespace-pre-wrap">{d.rationale}</p>}
            {d.snapshot.findings && d.snapshot.findings.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-2xs text-register">Findings open at the time ({d.snapshot.findings.length})</summary>
                <ul className="mt-1 list-disc pl-5 text-xs text-ink-muted">
                  {d.snapshot.findings.map((f, i) => (
                    <li key={i}>{f.title}</li>
                  ))}
                </ul>
              </details>
            )}
          </Sheet>
        </li>
      ))}
    </ol>
  );
}

interface Event {
  id: string;
  seq: number;
  occurred_at: string;
  actor_type: string;
  actor_name: string | null;
  actor_id: string | null;
  action: string;
  details: Record<string, unknown>;
}

export function describeAction(e: Pick<Event, 'action' | 'details'>): string {
  const d = e.details ?? {};
  const map: Record<string, string> = {
    'case.created': 'Created the case',
    'case.updated': 'Updated case details',
    'case.assigned': 'Changed the reviewer',
    'case.member_added': 'Added a case member',
    'case.checklist_waived': `Waived a checklist item: ${String(d.reason ?? '')}`,
    'case.documents_requested': 'Requested documents from the customer',
    'case.note_added': 'Added a note',
    'document.uploaded': `Uploaded ${String(d.filename ?? 'a document')}`,
    'document.version_added': `Uploaded a new version of ${String(d.filename ?? 'a document')}`,
    'document.duplicate_linked': 'Uploaded a file that was already in the case',
    'document.downloaded': 'Downloaded a document',
    'document.viewed': 'Opened a document',
    'document.quarantined': 'A file was quarantined by the malware scanner',
    'document.processing_failed': 'Document processing failed',
    'document.deleted': 'Deleted a document',
    'fact.approved': `Approved ${String(d.field ?? 'a field')}`,
    'fact.corrected': `Corrected ${String(d.field ?? 'a field')}`,
    'fact.rejected': `Rejected ${String(d.field ?? 'a field')}`,
    'ai.question_answered': 'Asked a question about the evidence',
    'case.start': 'Started the review',
    'case.recommendation': 'Submitted a decision',
    'case.approval': 'Made the approval decision',
    'case.escalation': 'Escalated the case',
    'case.return': 'Returned the case to the reviewer',
    'case.info_request': 'Requested information',
    'case.reopen': 'Reopened the case',
    'audit.export_requested': 'Requested an evidence export',
  };
  return map[e.action] ?? e.action.replace(/[._]/g, ' ');
}

export function ActivityTab({ c }: { c: CaseSummary }) {
  const q = useQuery({ queryKey: keys.timeline(c.id), queryFn: () => api<{ items: Event[] }>(`/v1/cases/${c.id}/timeline`) });
  const [hideViews, setHideViews] = useState(true);
  if (q.isLoading) return <LoadingRows />;
  const items = (q.data?.items ?? []).filter((e) => !hideViews || !['document.viewed', 'document.downloaded'].includes(e.action));
  return (
    <Sheet>
      <div className="flex items-center justify-between border-b border-rule px-4 py-3">
        <SectionHeader title="Activity" description="From the tamper-evident audit log." />
        <Checkbox label="Hide views and downloads" checked={hideViews} onChange={(e) => setHideViews(e.target.checked)} />
      </div>
      <Table caption="Case activity">
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Who</Th>
            <Th>What</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <Td className="text-xs whitespace-nowrap text-ink-muted">{fmtDateTime(e.occurred_at)}</Td>
              <Td className="text-xs whitespace-nowrap">{e.actor_name ?? (e.actor_type === 'system' ? 'FinGraph' : e.actor_type === 'api_client' ? `API client ${e.actor_id}` : 'Unknown')}</Td>
              <Td className="text-xs">{describeAction(e)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Sheet>
  );
}

interface ExportRow {
  id: string;
  version_no: number;
  status: string;
  sha256: string | null;
  size_bytes: number | null;
  requested_by_name: string | null;
  approved_by_name: string | null;
  created_at: string;
  ready_at: string | null;
  download_url: string | null;
  scope: { include_files: boolean; include_ai: boolean; include_audit_trail: boolean; documents: number };
}

export function ExportsTab({ c }: { c: CaseSummary }) {
  const s = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [...keys.case(c.id), 'exports'],
    queryFn: () => api<{ items: ExportRow[] }>(`/v1/cases/${c.id}/exports`),
    refetchInterval: (query) => (query.state.data?.items.some((e) => ['queued', 'building'].includes(e.status)) ? 1500 : false),
  });
  const [opts, setOpts] = useState({ include_files: true, include_ai: true, include_audit_trail: true });
  const [share, setShare] = useState<ExportRow | null>(null);
  const [recipient, setRecipient] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: () => api('/v1/audit/exports', { body: { case_id: c.id, ...opts } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...keys.case(c.id), 'exports'] });
      toast({ tone: 'success', message: 'Export requested' });
    },
    onError: (err) => toast({ tone: 'error', message: errorMessage(err) }),
  });
  const approve = useMutation({
    mutationFn: (id: string) => api(`/v1/audit/exports/${id}/approve`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...keys.case(c.id), 'exports'] }),
    onError: (err) => toast({ tone: 'error', message: errorMessage(err) }),
  });
  const createShare = useMutation({
    mutationFn: () => api<{ url: string }>(`/v1/audit/exports/${share!.id}/shares`, { body: { recipient } }),
    onSuccess: (r) => setLink(r.url),
  });
  const submitShare = (e: FormEvent) => {
    e.preventDefault();
    createShare.mutate();
  };
  return (
    <div className="flex flex-col gap-4">
      {s.can('audit:export') && (
        <Sheet className="flex flex-col gap-3 p-4">
          <SectionHeader
            title="Evidence package"
            description="A versioned ZIP with the case record, approved facts, relationships, decisions with policy versions and checksums for every file."
          />
          <div className="flex flex-wrap gap-4">
            <Checkbox label="Original files" checked={opts.include_files} onChange={(e) => setOpts({ ...opts, include_files: e.target.checked })} />
            <Checkbox label="AI questions and answers" checked={opts.include_ai} onChange={(e) => setOpts({ ...opts, include_ai: e.target.checked })} />
            <Checkbox label="Audit trail" checked={opts.include_audit_trail} onChange={(e) => setOpts({ ...opts, include_audit_trail: e.target.checked })} />
          </div>
          <div>
            <Button variant="primary" onClick={() => request.mutate()} busy={request.isPending}>
              Create evidence package
            </Button>
          </div>
        </Sheet>
      )}
      <Sheet>
        {q.isLoading ? (
          <LoadingRows />
        ) : !q.data?.items.length ? (
          <div className="p-4">
            <EmptyState title="No exports yet" />
          </div>
        ) : (
          <Table caption="Exports">
            <thead>
              <tr>
                <Th>Version</Th>
                <Th>Status</Th>
                <Th>Requested</Th>
                <Th numeric>Size</Th>
                <Th>Checksum (SHA-256)</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((e) => (
                <tr key={e.id}>
                  <Td className="tabular-nums">v{e.version_no}</Td>
                  <Td>
                    <Badge tone={e.status === 'ready' ? 'verified' : e.status === 'failed' ? 'conflict' : e.status === 'pending_approval' ? 'candidate' : 'neutral'}>
                      {e.status.replace('_', ' ')}
                    </Badge>
                  </Td>
                  <Td className="text-xs">
                    {e.requested_by_name}, {fmtDateTime(e.created_at)}
                    {e.approved_by_name && <span className="block text-2xs text-ink-muted">Approved by {e.approved_by_name}</span>}
                  </Td>
                  <Td numeric className="text-xs">
                    {fmtBytes(e.size_bytes)}
                  </Td>
                  <Td className="max-w-[16ch] truncate font-mono text-2xs text-ink-muted" title={e.sha256 ?? ''}>
                    {e.sha256 ?? ''}
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    {e.status === 'pending_approval' && s.can('case:approve') && (
                      <Button size="sm" onClick={() => approve.mutate(e.id)}>
                        Approve export
                      </Button>
                    )}
                    {e.download_url && (
                      <div className="flex justify-end gap-1">
                        <a href={`/api${e.download_url}`} className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-register hover:bg-sheet-sunk">
                          <Download className="size-3.5" /> Download
                        </a>
                        {s.can('audit:export') && (
                          <Button size="sm" variant="ghost" icon={<Link2 className="size-3.5" />} onClick={() => (setShare(e), setLink(null), setRecipient(''))}>
                            Share
                          </Button>
                        )}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Sheet>
      <Dialog open={!!share} onClose={() => setShare(null)} title={`Share export v${share?.version_no}`} description="Creates a link that expires in 72 hours and allows three downloads. Every download is logged.">
        {link ? (
          <div className="flex flex-col gap-3">
            <Notice tone="verified" title="Link created">
              Send this link to {recipient} through a secure channel. It is shown only once.
            </Notice>
            <Input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Share link" />
            <div className="flex justify-end">
              <Button onClick={() => navigator.clipboard?.writeText(link)}>Copy link</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submitShare} className="flex flex-col gap-3">
            <Field label="Recipient email">
              {(id) => <Input id={id} type="email" required value={recipient} onChange={(e) => setRecipient(e.target.value)} />}
            </Field>
            {createShare.error && <Notice tone="conflict">{errorMessage(createShare.error)}</Notice>}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setShare(null)}>Cancel</Button>
              <Button type="submit" variant="primary" busy={createShare.isPending}>
                Create link
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
