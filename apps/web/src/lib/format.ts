import { CASE_STATUS_LABELS, CASE_TYPE_LABELS, DOCUMENT_CATEGORY_LABELS, type CaseStatus, type CaseType, type DocumentCategory } from '@fingraph/shared';
import type { Tone } from '@/ui';

const dateFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const rel = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

export const fmtDate = (v: string | Date | null | undefined) => (v ? dateFmt.format(new Date(v)) : '');
export const fmtDateTime = (v: string | Date | null | undefined) => (v ? dateTimeFmt.format(new Date(v)) : '');

export function fmtRelative(v: string | Date | null | undefined) {
  if (!v) return '';
  const diff = (new Date(v).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rel.format(Math.round(diff), 'second');
  if (abs < 3600) return rel.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rel.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rel.format(Math.round(diff / 86400), 'day');
  return fmtDate(v);
}

export function fmtBytes(n: number | null | undefined) {
  if (n === null || n === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export const caseStatusLabel = (s: string) => CASE_STATUS_LABELS[s as CaseStatus] ?? s;
export const caseTypeLabel = (s: string) => CASE_TYPE_LABELS[s as CaseType] ?? s;
export const categoryLabel = (s: string | null | undefined) => (s ? (DOCUMENT_CATEGORY_LABELS[s as DocumentCategory] ?? s) : 'Not classified yet');

export function caseStatusTone(s: string): Tone {
  if (s === 'approved') return 'verified';
  if (s === 'rejected') return 'conflict';
  if (s === 'escalated' || s === 'pending_approval') return 'candidate';
  if (s === 'in_review') return 'register';
  return 'neutral';
}

export const riskTone = (r: string): Tone => (r === 'high' ? 'conflict' : r === 'medium' ? 'candidate' : 'neutral');

export function versionStatus(s: string): { label: string; tone: Tone } {
  switch (s) {
    case 'processed':
      return { label: 'Processed', tone: 'verified' };
    case 'quarantined':
      return { label: 'Quarantined', tone: 'conflict' };
    case 'rejected':
      return { label: 'Rejected', tone: 'conflict' };
    case 'failed':
      return { label: 'Failed', tone: 'conflict' };
    case 'processing':
      return { label: 'Processing', tone: 'register' };
    default:
      return { label: 'Queued', tone: 'neutral' };
  }
}

export function factStatus(s: string): { label: string; tone: Tone } {
  switch (s) {
    case 'approved':
      return { label: 'Approved', tone: 'verified' };
    case 'corrected':
      return { label: 'Corrected', tone: 'verified' };
    case 'rejected':
      return { label: 'Rejected', tone: 'conflict' };
    case 'superseded':
      return { label: 'Superseded', tone: 'neutral' };
    default:
      return { label: 'Needs review', tone: 'candidate' };
  }
}

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '' : `${Math.round(Number(n) * 100)}%`);
