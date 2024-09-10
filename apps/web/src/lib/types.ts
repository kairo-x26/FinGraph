export interface CaseSummary {
  id: string;
  reference: string;
  case_type: string;
  subject_name: string;
  customer_ref: string | null;
  status: string;
  risk_level: 'low' | 'medium' | 'high';
  restricted: boolean;
  assignee_id: string | null;
  assignee_name: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  document_count: number;
  due_at: string | null;
  closed_at: string | null;
  review_started_at: string | null;
  created_at: string;
  updated_at: string;
  policy_id: string | null;
  subject_entity_id: string | null;
  members?: { user_id: string; role: string; display_name: string }[];
}

export interface DocumentSummary {
  id: string;
  case_id: string;
  title: string;
  category: string | null;
  category_confidence: number | null;
  category_source: string | null;
  restricted: boolean;
  evidence_date: string | null;
  current_version_id: string;
  version_no: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status: string;
  latest_status: string;
  latest_version_no: number;
  page_count: number | null;
  source: string;
  scan_result: { clean: boolean; threats: string[]; warnings: string[] } | null;
  error: { type: string; message?: string } | null;
  created_at: string;
}

export interface Fact {
  id: string;
  document_id: string;
  document_title: string;
  document_category: string | null;
  version_id: string;
  version_no: number;
  field_key: string;
  field_label: string;
  value_type: string;
  value: unknown;
  value_text: string | null;
  group_key: string | null;
  confidence: number;
  critical: boolean;
  status: string;
  evidence_page: number | null;
  evidence_start: number | null;
  evidence_end: number | null;
  evidence_quote: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
}

export interface Page {
  page_no: number;
  text: string;
  ocr: boolean;
  needs_ocr: boolean;
}

export interface ChecklistItem {
  key: string;
  label: string;
  category: string;
  required: boolean;
  max_age_days?: number;
  status: 'satisfied' | 'pending' | 'expired' | 'waived' | 'requested' | 'missing';
  document_ids: string[];
  waiver: { reason: string; created_at: string } | null;
  request: { id: string; message: string; created_at: string } | null;
}

export interface Finding {
  id: string;
  type: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  refs: { entities?: string[]; relationships?: string[]; facts?: string[]; documents?: string[]; checklist_items?: string[] };
}

export interface Readiness {
  policy: { id: string; key: string; name: string; version: number };
  checks: { key: string; ok: boolean; detail: string }[];
  findings: Finding[];
  escalation_findings: Finding[];
  can_approve: boolean;
  escalation_required: boolean;
  second_approval_required: boolean;
  checklist: { complete: boolean; missing: string[] };
}

export interface GraphNode {
  id: string;
  kind: 'organization' | 'individual';
  display_name: string;
  status: string;
  jurisdiction: string | null;
  identifiers: Record<string, string>;
  attributes: Record<string, unknown>;
  depth?: number;
}

export interface GraphEdge {
  id: string;
  case_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  ownership_pct: number | null;
  role_title: string | null;
  evidence_document_id: string;
  evidence_document_version_id: string;
  evidence_page: number | null;
  evidence_quote: string | null;
  evidence_document_title?: string;
  review_status: string;
  valid_from: string | null;
  valid_to: string | null;
  origin: string;
  confidence: number | null;
}

export interface Citation {
  passage_id: string;
  kind: 'document' | 'graph';
  document_id: string;
  document_title: string;
  version_id: string;
  page_no: number | null;
  char_start: number | null;
  char_end: number | null;
  excerpt: string;
  relationship_id?: string;
}

export interface Answer {
  id: string;
  status: 'answered' | 'insufficient_evidence' | 'failed' | 'blocked';
  question: string;
  answer: string;
  claims: { text: string; citations: string[] }[];
  citations: Citation[];
  missing: string[];
  flags: string[];
  model?: { provider: string; model: string; prompt_version: string };
  asked_by?: string;
  feedback?: string | null;
  created_at: string;
}

export interface Paged<T> {
  items: T[];
  next_cursor: string | null;
}
