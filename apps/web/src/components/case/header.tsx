'use client';

import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { caseStatusLabel, caseStatusTone, caseTypeLabel, fmtDate, riskTone } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { CaseSummary } from '@/lib/types';
import { Badge, Button, Dialog, Field, Notice, Select, Textarea } from '@/ui';
import { useCaseMutation, useReadiness } from './hooks';

type Action = 'recommend' | 'approval' | 'request_info' | 'escalate' | 'reopen';

const MIN = 20;

function DecisionDialog({ c, action, onClose }: { c: CaseSummary; action: Action | null; onClose: () => void }) {
  const readiness = useReadiness(c.id);
  const [outcome, setOutcome] = useState('approve');
  const [text, setText] = useState('');
  const m = useCaseMutation(
    c.id,
    async () => {
      switch (action) {
        case 'recommend':
          return api(`/v1/cases/${c.id}/recommendation`, { body: { outcome, rationale: text } });
        case 'approval':
          return api(`/v1/cases/${c.id}/approval`, { body: { decision: outcome, rationale: text } });
        case 'request_info':
          return api(`/v1/cases/${c.id}/request-info`, { body: { message: text } });
        case 'escalate':
          return api(`/v1/cases/${c.id}/escalate`, { body: { rationale: text } });
        case 'reopen':
          return api(`/v1/cases/${c.id}/reopen`, { body: { rationale: text } });
      }
    },
    'Decision recorded',
  );
  if (!action) return null;
  const titles: Record<Action, string> = {
    recommend: 'Submit recommendation',
    approval: 'Decide as approver',
    request_info: 'Ask the customer for more information',
    escalate: 'Escalate to a risk manager',
    reopen: 'Reopen case',
  };
  const r = readiness.data;
  const min = action === 'request_info' ? 10 : MIN;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate(undefined, { onSuccess: onClose });
  };
  const routing =
    action === 'recommend' && r && outcome === 'approve'
      ? r.escalation_required
        ? 'Open findings require escalation: this will go to a risk manager.'
        : r.second_approval_required
          ? 'Policy requires a second approver for this risk level.'
          : 'You can close this case on your own decision.'
      : null;
  return (
    <Dialog open onClose={onClose} title={titles[action]} description={`${c.reference}, ${c.subject_name}`}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {(action === 'recommend' || action === 'approval') && (
          <Field label="Outcome">
            {(id) => (
              <Select id={id} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                <option value="approve">Approve the customer</option>
                <option value="reject">Reject the customer</option>
                {action === 'approval' && <option value="return">Return to the reviewer</option>}
              </Select>
            )}
          </Field>
        )}
        {(action === 'recommend' || action === 'approval') && outcome === 'approve' && r && !r.can_approve && (
          <Notice tone="conflict" title="Policy checks are not met">
            <ul className="list-disc pl-4">
              {r.checks
                .filter((x) => !x.ok)
                .map((x) => (
                  <li key={x.key}>{x.detail}</li>
                ))}
            </ul>
          </Notice>
        )}
        {routing && <Notice tone="register">{routing}</Notice>}
        <Field
          label={action === 'request_info' ? 'Message to the onboarding team' : 'Rationale'}
          hint={`Recorded with the decision and included in audit exports. At least ${min} characters.`}
        >
          {(id, d) => <Textarea id={id} aria-describedby={d} value={text} onChange={(e) => setText(e.target.value)} required minLength={min} rows={5} />}
        </Field>
        {m.error && <Notice tone="conflict">{errorMessage(m.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={outcome === 'reject' ? 'danger' : 'primary'} busy={m.isPending} disabled={text.trim().length < min}>
            {action === 'request_info' ? 'Send request' : action === 'escalate' ? 'Escalate' : action === 'reopen' ? 'Reopen case' : 'Record decision'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CaseHeader({ c }: { c: CaseSummary }) {
  const s = useSession();
  const [action, setAction] = useState<Action | null>(null);
  const start = useCaseMutation(c.id, () => api(`/v1/cases/${c.id}/start-review`, { method: 'POST' }), 'Review started');
  const claim = useCaseMutation(c.id, () => api(`/v1/cases/${c.id}/claim`, { method: 'POST' }), 'Case assigned to you');
  const isReviewer = c.assignee_id === s.user.id || c.members?.some((m) => m.user_id === s.user.id && m.role === 'reviewer');

  const actions: React.ReactNode[] = [];
  if (s.can('case:review')) {
    if (!c.assignee_id && !c.closed_at) actions.push(<Button key="claim" onClick={() => claim.mutate(undefined)} busy={claim.isPending}>Assign to me</Button>);
    if ((c.status === 'open' || c.status === 'info_requested') && (isReviewer || !c.assignee_id)) {
      actions.push(<Button key="start" variant="primary" onClick={() => start.mutate(undefined)} busy={start.isPending}>{c.status === 'open' ? 'Start review' : 'Resume review'}</Button>);
    }
    if (c.status === 'in_review' && isReviewer) {
      actions.push(<Button key="info" onClick={() => setAction('request_info')}>Request information</Button>);
      actions.push(<Button key="esc" onClick={() => setAction('escalate')}>Escalate</Button>);
      actions.push(<Button key="rec" variant="primary" onClick={() => setAction('recommend')}>Submit decision</Button>);
    }
  }
  if (s.can('case:approve')) {
    if ((c.status === 'pending_approval' || c.status === 'escalated') && !isReviewer) {
      actions.push(<Button key="appr" variant="primary" onClick={() => setAction('approval')}>Decide</Button>);
    }
    if (c.status === 'approved' || c.status === 'rejected') actions.push(<Button key="reopen" onClick={() => setAction('reopen')}>Reopen</Button>);
  }

  return (
    <div className="flex flex-col gap-3">
      <nav aria-label="Breadcrumb" className="text-xs text-ink-muted">
        <Link href="/cases" className="hover:text-ink">
          Cases
        </Link>{' '}
        / <span className="tabular-nums">{c.reference}</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {c.restricted && <Lock className="size-4 text-ink-muted" aria-label="Restricted case" />}
            {c.subject_name}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-muted">
            <Badge tone={caseStatusTone(c.status)}>{caseStatusLabel(c.status)}</Badge>
            <Badge tone={riskTone(c.risk_level)}>{c.risk_level[0]!.toUpperCase() + c.risk_level.slice(1)} risk</Badge>
            <span className="tabular-nums">{c.reference}</span>
            <span>{caseTypeLabel(c.case_type)}</span>
            <span>Reviewer: {c.assignee_name ?? 'unassigned'}</span>
            {c.due_at && !c.closed_at && <span className={new Date(c.due_at) < new Date() ? 'text-conflict' : ''}>Due {fmtDate(c.due_at)}</span>}
          </div>
        </div>
        {actions.length > 0 && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <DecisionDialog key={action ?? 'none'} c={c} action={action} onClose={() => setAction(null)} />
    </div>
  );
}
