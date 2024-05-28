import type { DocumentCategory } from '@fingraph/shared';
import type { ParsedDocument } from './parse';

interface Rule {
  category: Exclude<DocumentCategory, 'other'>;
  /** Phrase → weight. Phrases are matched case-insensitively as whole words. */
  signals: [string, number][];
}

const RULES: Rule[] = [
  {
    category: 'certificate_of_incorporation',
    signals: [
      ['certificate of formation', 5],
      ['certificate of incorporation', 5],
      ['articles of incorporation', 5],
      ['articles of organization', 4],
      ['secretary of state', 2],
      ['date of formation', 2],
      ['registered agent', 1.5],
      ['good standing', 1],
      ['file number', 1],
    ],
  },
  {
    category: 'beneficial_ownership',
    signals: [
      ['beneficial owners', 5],
      ['beneficial ownership', 5],
      ['ownership prong', 3],
      ['control prong', 3],
      ['legal entity customer', 2],
      ['25 percent', 1.5],
    ],
  },
  {
    category: 'director_register',
    signals: [
      ['register of directors', 5],
      ['register of managers', 5],
      ['officers', 1],
      ['date appointed', 2.5],
      ['board of directors', 2],
      ['position', 0.5],
    ],
  },
  {
    category: 'bank_statement',
    signals: [
      ['statement period', 4],
      ['opening balance', 2.5],
      ['closing balance', 2.5],
      ['account number', 1.5],
      ['checking', 1],
      ['debits', 1],
      ['credits', 1],
      ['member fdic', 1.5],
    ],
  },
  {
    category: 'tax_form',
    signals: [
      ['form w-9', 5],
      ['w-9', 3],
      ['w-8ben', 4],
      ['taxpayer identification number', 4],
      ['internal revenue service', 2],
      ['employer identification number', 1],
      ['federal tax classification', 2],
    ],
  },
  {
    category: 'ownership_chart',
    signals: [
      ['ownership structure', 5],
      ['group structure', 4],
      ['organizational chart', 4],
      ['owned entity', 3],
      ['indirect', 1],
      ['general partner', 1],
    ],
  },
  {
    category: 'compliance_policy',
    signals: [
      ['policy owner', 4],
      ['due diligence', 2],
      ['policy', 1.5],
      ['effective date', 1],
      ['escalation', 1.5],
      ['purpose', 0.5],
    ],
  },
];

export interface Classification {
  category: DocumentCategory;
  confidence: number;
  method: 'rules' | 'model';
  scores: Partial<Record<DocumentCategory, number>>;
  /** Uncertain classifications are flagged for human review. */
  needs_review: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const CLASSIFIER_VERSION = 'rules-1.2';

/**
 * Keyword-weighted classifier. Signals in the first lines (titles) count double.
 * Confidence combines the winning margin with the absolute evidence.
 */
export function classifyDocument(doc: ParsedDocument, filename = ''): Classification {
  const full = doc.pages.map((p) => p.text).join('\n').toLowerCase();
  const head = doc.pages[0]?.lines.slice(0, 4).map((l) => l.text).join('\n').toLowerCase() ?? '';
  const name = filename.toLowerCase().replace(/[-_.]/g, ' ');
  const scores: Partial<Record<DocumentCategory, number>> = {};
  for (const rule of RULES) {
    let score = 0;
    for (const [phrase, weight] of rule.signals) {
      const re = new RegExp(`\\b${escape(phrase)}\\b`, 'g');
      const hits = Math.min(3, (full.match(re) ?? []).length);
      if (!hits) continue;
      score += weight * (1 + Math.log2(hits));
      if (re.test(head)) score += weight;
      if (name.includes(phrase)) score += weight / 2;
    }
    scores[rule.category] = Math.round(score * 100) / 100;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]) as [DocumentCategory, number][];
  const [best, second] = ranked;
  if (!best || best[1] < 4) {
    return { category: 'other', confidence: best ? 0.3 : 0.1, method: 'rules', scores, needs_review: true };
  }
  const margin = (best[1] - (second?.[1] ?? 0)) / best[1];
  const strength = Math.min(1, best[1] / 15);
  const confidence = Math.round((0.5 + 0.3 * margin + 0.2 * strength) * 10000) / 10000;
  return { category: best[0], confidence, method: 'rules', scores, needs_review: confidence < 0.7 };
}
