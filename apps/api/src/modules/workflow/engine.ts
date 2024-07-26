import type { CaseStatus } from '@fingraph/shared';
import type { Tx } from '../../db';
import type { CaseRow } from '../cases/access';
import { evaluateChecklist } from '../cases/checklists';
import { documentVisibleSql } from '../documents/access';
import { caseDiscrepancies, type Discrepancy } from '../graph/discrepancies';
import { activePolicy, policyById, type PolicyRow } from './policies';

export type DecisionKind = 'start' | 'recommendation' | 'approval' | 'escalation' | 'return' | 'info_request' | 'reopen' | 'archive';

/** Allowed status transitions. Anything not listed is rejected. */
export const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  open: ['in_review'],
  in_review: ['info_requested', 'pending_approval', 'escalated', 'approved', 'rejected'],
  info_requested: ['in_review'],
  pending_approval: ['approved', 'rejected', 'in_review'],
  escalated: ['approved', 'rejected', 'in_review'],
  approved: ['in_review', 'archived'],
  rejected: ['in_review', 'archived'],
  archived: [],
};

export function canTransition(from: string, to: string) {
  return (TRANSITIONS[from as CaseStatus] ?? []).includes(to as CaseStatus);
}

export interface ReadinessCheck {
  key: 'critical_facts_reviewed' | 'blocking_findings' | 'ownership_verified';
  ok: boolean;
  detail: string;
}

export interface Readiness {
  policy: { id: string; key: string; name: string; version: number };
  checks: ReadinessCheck[];
  findings: Discrepancy[];
  escalation_findings: Discrepancy[];
  /** Approval is possible once every check passes. */
  can_approve: boolean;
  escalation_required: boolean;
  second_approval_required: boolean;
  checklist: { complete: boolean; missing: string[] };
}

export async function casePolicy(tx: Tx, c: CaseRow & { policy_id?: string | null }): Promise<PolicyRow> {
  return (await policyById(tx, c.policy_id ?? null)) ?? (await activePolicy(tx, c.tenant_id, c.case_type));
}

/**
 * Evaluates the case against its policy. Uses only evidence the caller can see,
 * but reviewers with restricted access are blocked from approving anyway when
 * critical facts on hidden documents are unreviewed (counted without visibility).
 */
export async function evaluateReadiness(tx: Tx, c: CaseRow & { policy_id?: string | null }, userId: string | null): Promise<Readiness> {
  const policy = await casePolicy(tx, c);
  const rules = policy.rules;
  const findings = await caseDiscrepancies(tx, c.id, userId, rules.ubo_threshold_pct);
  const pending = await tx.one<{ n: number; hidden: number }>(
    `select count(*)::int as n,
            count(*) filter (where not ${documentVisibleSql('d', '$2')})::int as hidden
       from extracted_facts f join documents d on d.id = f.document_id
      where f.case_id = $1 and f.critical and f.status = 'candidate' and f.version_id = d.current_version_id
        and d.deleted_at is null`,
    [c.id, userId],
  );
  const unverified = await tx.one<{ n: number }>(
    `select count(*)::int as n from entity_relationships r join entities t on t.id = r.target_entity_id
       join documents d on d.id = r.evidence_document_id
      where r.case_id = $1 and r.relationship_type = 'OWNED_BY' and t.kind = 'individual'
        and r.review_status in ('candidate', 'conflicting') and (r.valid_to is null) and d.deleted_at is null`,
    [c.id],
  );
  const blocking = findings.filter((f) => rules.block_approval_on.includes(f.type as never));
  const escalation = findings.filter((f) => rules.escalate_on.includes(f.type as never));
  const checks: ReadinessCheck[] = [];
  if (rules.require_critical_fact_review) {
    checks.push({
      key: 'critical_facts_reviewed',
      ok: pending!.n === 0,
      detail: pending!.n === 0 ? 'All critical fields are reviewed.' : `${pending!.n} critical field(s) still need review${pending!.hidden ? ` (${pending!.hidden} on documents you cannot open)` : ''}.`,
    });
  }
  checks.push({
    key: 'blocking_findings',
    ok: blocking.length === 0,
    detail: blocking.length ? blocking.map((b) => b.title).join('; ') : 'No blocking findings.',
  });
  if (rules.require_verified_ownership) {
    checks.push({
      key: 'ownership_verified',
      ok: unverified!.n === 0,
      detail: unverified!.n ? `${unverified!.n} ownership relationship(s) are not verified.` : 'All ownership relationships are verified.',
    });
  }
  const checklist = await evaluateChecklist(tx, c.id, c.checklist_template_id);
  return {
    policy: { id: policy.id, key: policy.key, name: policy.name, version: policy.version },
    checks,
    findings,
    escalation_findings: escalation,
    can_approve: checks.every((x) => x.ok),
    escalation_required: escalation.length > 0,
    second_approval_required: rules.second_approval_for.includes(c.risk_level) || escalation.length > 0,
    checklist: {
      complete: checklist.complete,
      missing: checklist.items.filter((i) => i.required && !['satisfied', 'waived'].includes(i.status)).map((i) => i.key),
    },
  };
}

export async function recordDecision(
  tx: Tx,
  c: CaseRow,
  d: {
    kind: DecisionKind;
    to: CaseStatus;
    outcome?: string | null;
    rationale?: string | null;
    userId: string | null;
    policy: PolicyRow | null;
    snapshot?: Record<string, unknown>;
  },
) {
  const row = await tx.one(
    `insert into review_decisions (tenant_id, case_id, kind, outcome, from_status, to_status, rationale, decided_by,
                                   policy_id, policy_version, snapshot)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [
      c.tenant_id,
      c.id,
      d.kind,
      d.outcome ?? null,
      c.status,
      d.to,
      d.rationale ?? null,
      d.userId,
      d.policy?.id || null,
      d.policy?.version ?? null,
      JSON.stringify(d.snapshot ?? {}),
    ],
  );
  const closing = d.to === 'approved' || d.to === 'rejected';
  await tx.query(
    `update cases set status = $2,
            closed_at = case when $3 then now() when $2 in ('in_review', 'info_requested', 'pending_approval', 'escalated') then null else closed_at end,
            review_started_at = case when $2 = 'in_review' then coalesce(review_started_at, now()) else review_started_at end,
            policy_id = coalesce(policy_id, $4)
      where id = $1`,
    [c.id, d.to, closing, d.policy?.id || null],
  );
  return row!;
}

/** Compact, reconstructible snapshot stored with each decision. */
export function snapshotOf(r: Readiness) {
  return {
    policy: r.policy,
    checks: r.checks,
    findings: r.findings.map((f) => ({ id: f.id, type: f.type, severity: f.severity, title: f.title })),
    checklist: r.checklist,
  };
}
