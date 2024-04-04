export const DOCUMENT_CATEGORIES = [
  'certificate_of_incorporation',
  'beneficial_ownership',
  'director_register',
  'bank_statement',
  'tax_form',
  'ownership_chart',
  'compliance_policy',
  'other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  certificate_of_incorporation: 'Certificate of incorporation',
  beneficial_ownership: 'Beneficial ownership declaration',
  director_register: 'Register of directors',
  bank_statement: 'Bank statement',
  tax_form: 'Tax form',
  ownership_chart: 'Ownership chart',
  compliance_policy: 'Compliance policy',
  other: 'Other document',
};

/** Lifecycle of a single stored document version. */
export const VERSION_STATUSES = [
  'pending_upload',
  'uploaded',
  'quarantined',
  'rejected',
  'queued',
  'processing',
  'processed',
  'failed',
] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const INGESTION_STAGES = [
  'validate',
  'scan',
  'parse',
  'classify',
  'extract',
  'index',
  'graph',
] as const;
export type IngestionStage = (typeof INGESTION_STAGES)[number];

export const CASE_TYPES = ['kyb_onboarding', 'kyb_refresh', 'kyc_individual'] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const CASE_TYPE_LABELS: Record<CaseType, string> = {
  kyb_onboarding: 'KYB onboarding',
  kyb_refresh: 'KYB periodic review',
  kyc_individual: 'KYC individual',
};

export const CASE_STATUSES = [
  'open',
  'in_review',
  'info_requested',
  'pending_approval',
  'escalated',
  'approved',
  'rejected',
  'archived',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Open',
  in_review: 'In review',
  info_requested: 'Waiting on customer',
  pending_approval: 'Awaiting approval',
  escalated: 'Escalated',
  approved: 'Approved',
  rejected: 'Rejected',
  archived: 'Archived',
};

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const FACT_STATUSES = ['candidate', 'approved', 'corrected', 'rejected', 'superseded'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const REVIEW_ACTIONS = ['approve', 'correct', 'reject'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const ENTITY_KINDS = ['organization', 'individual'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const RELATIONSHIP_TYPES = [
  'OWNED_BY',
  'DIRECTOR_OF',
  'SUBSIDIARY_OF',
  'OFFICER_OF',
  'SIGNATORY_OF',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  OWNED_BY: 'owned by',
  DIRECTOR_OF: 'director of',
  SUBSIDIARY_OF: 'subsidiary of',
  OFFICER_OF: 'officer of',
  SIGNATORY_OF: 'signatory of',
};

export const ASSERTION_STATUSES = ['candidate', 'verified', 'rejected', 'conflicting'] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

export const DECISION_OUTCOMES = ['approve', 'reject', 'escalate', 'request_info'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const CONNECTION_STATUSES = ['pending', 'active', 'expired', 'revoked', 'error'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
