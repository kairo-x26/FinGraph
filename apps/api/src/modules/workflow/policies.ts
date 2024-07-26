import { z } from 'zod';
import { CASE_TYPES, RISK_LEVELS, type CaseType } from '@fingraph/shared';
import type { Tx } from '../../db';

const DISCREPANCY_TYPES = [
  'undeclared_beneficial_owner',
  'ownership_conflict',
  'ownership_exceeds_total',
  'identifier_mismatch',
  'name_mismatch',
  'missing_control_person',
  'missing_evidence',
  'expired_evidence',
  'unreadable_pages',
] as const;

export const policyRulesSchema = z.object({
  /** Effective ownership at or above this percentage identifies a beneficial owner. */
  ubo_threshold_pct: z.number().min(1).max(100).default(25),
  /** Risk levels whose outcome needs a second person with approval rights. */
  second_approval_for: z.array(z.enum(RISK_LEVELS)).default(['high']),
  /** Open findings of these types force escalation to a risk manager. */
  escalate_on: z.array(z.enum(DISCREPANCY_TYPES)).default(['undeclared_beneficial_owner', 'ownership_conflict', 'identifier_mismatch']),
  /** Approval is blocked while findings of these types are open. */
  block_approval_on: z.array(z.enum(DISCREPANCY_TYPES)).default(['missing_evidence', 'expired_evidence']),
  /** Every critical extracted fact must be approved, corrected or rejected first. */
  require_critical_fact_review: z.boolean().default(true),
  /** Every ownership relationship to an individual must be verified first. */
  require_verified_ownership: z.boolean().default(false),
  /** Review time target in days, used for overdue reporting. */
  review_sla_days: z.number().int().min(1).max(365).default(10),
});
export type PolicyRules = z.infer<typeof policyRulesSchema>;

export interface PolicyRow {
  id: string;
  key: string;
  name: string;
  jurisdiction: string;
  version: number;
  case_types: CaseType[];
  rules: PolicyRules;
  notes: string | null;
  status: string;
  effective_from: Date;
  effective_to: Date | null;
  created_at: Date;
}

export const DEFAULT_POLICY = {
  key: 'us-kyb-cdd',
  name: 'US KYB customer due diligence',
  jurisdiction: 'US',
  case_types: [...CASE_TYPES] as CaseType[],
  rules: policyRulesSchema.parse({}),
  notes:
    'Platform starting point. Requirements depend on the institution, its regulators and its own risk assessment; review before use.',
};

/** The active policy applying to a case type, creating the default policy on first use. */
export async function activePolicy(tx: Tx, tenantId: string, caseType: string): Promise<PolicyRow> {
  const p = await tx.one<PolicyRow>(
    `select * from compliance_policies where status = 'active' and $1 = any(case_types)
      order by effective_from desc limit 1`,
    [caseType],
  );
  if (p) return { ...p, rules: policyRulesSchema.parse(p.rules) };
  const any = await tx.one('select 1 from compliance_policies where key = $1', [DEFAULT_POLICY.key]);
  if (any) {
    // policies exist but none covers this case type: fall back to defaults without storing
    return { id: '', version: 0, status: 'active', effective_from: new Date(), effective_to: null, created_at: new Date(), ...DEFAULT_POLICY };
  }
  const created = await tx.one<PolicyRow>(
    `insert into compliance_policies (tenant_id, key, name, jurisdiction, version, case_types, rules, notes)
     values ($1,$2,$3,$4,1,$5,$6,$7) returning *`,
    [tenantId, DEFAULT_POLICY.key, DEFAULT_POLICY.name, DEFAULT_POLICY.jurisdiction, DEFAULT_POLICY.case_types, JSON.stringify(DEFAULT_POLICY.rules), DEFAULT_POLICY.notes],
  );
  return { ...created!, rules: policyRulesSchema.parse(created!.rules) };
}

export async function policyById(tx: Tx, id: string | null): Promise<PolicyRow | null> {
  if (!id) return null;
  const p = await tx.one<PolicyRow>('select * from compliance_policies where id = $1', [id]);
  return p ? { ...p, rules: policyRulesSchema.parse(p.rules) } : null;
}
