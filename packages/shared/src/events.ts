/** Event contracts from requirements section 9.4. */
export const EVENT_TYPES = [
  'document.uploaded',
  'document.validation_failed',
  'document.processing_started',
  'document.processed',
  'document.processing_failed',
  'extraction.review_required',
  'extraction.approved',
  'extraction.rejected',
  'entity.relationship_changed',
  'case.review_assigned',
  'case.review_completed',
  'connection.revoked',
  'audit.export_created',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SCHEMA_VERSION = '2024-04-01';

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  type: EventType;
  tenant_id: string;
  occurred_at: string;
  schema_version: string;
  correlation_id: string | null;
  resource: { type: string; id: string };
  data: T;
}
