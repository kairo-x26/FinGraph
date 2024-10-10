import type { DocumentCategory } from '@fingraph/shared';
import { parseDate, parseEin, parseMoney, parsePercent } from './normalize';
import type { ParsedDocument, ParsedPage, ParsedTable } from './parse';

export type ValueType = 'string' | 'date' | 'percent' | 'money' | 'ein' | 'identifier';

export interface FactCandidate {
  field_key: string;
  field_label: string;
  value_type: ValueType;
  value: unknown;
  value_text: string;
  group_key: string | null;
  confidence: number;
  critical: boolean;
  evidence: { page_no: number; start: number; end: number; quote: string };
}

interface FieldSpec {
  key: string;
  label: string;
  type: ValueType;
  critical?: boolean;
  /** Labels that precede the value, e.g. "Entity name:". */
  labels: RegExp[];
  /** Only search after a line matching this (section scoping). */
  after?: RegExp;
  /** Marks the field used as the document's evidence date. */
  evidenceDate?: boolean;
}

interface TableSpec {
  group: string;
  label: string;
  critical?: boolean;
  /** All header patterns must match some header cell. */
  header: RegExp[];
  columns: { key: string; label: string; type: ValueType; header: RegExp; critical?: boolean }[];
}

interface RangeSpec {
  label: RegExp;
  start: { key: string; label: string };
  end: { key: string; label: string; evidenceDate?: boolean };
  critical?: boolean;
}

export interface CategorySchema {
  version: string;
  fields: FieldSpec[];
  tables?: TableSpec[];
  ranges?: RangeSpec[];
}

const L = (s: string) => new RegExp(`^${s}\\s*:\\s*`, 'i');

export const SCHEMAS: Partial<Record<DocumentCategory, CategorySchema>> = {
  certificate_of_incorporation: {
    version: '1.1',
    fields: [
      { key: 'entity_name', label: 'Entity name', type: 'string', critical: true, labels: [L('entity name'), L('name of (?:company|corporation|entity)')] },
      { key: 'entity_type', label: 'Entity type', type: 'string', labels: [L('entity type'), L('type of entity')] },
      { key: 'jurisdiction', label: 'Jurisdiction', type: 'string', critical: true, labels: [L('jurisdiction(?: of formation)?'), L('state of (?:formation|incorporation)')] },
      { key: 'file_number', label: 'Registration number', type: 'identifier', critical: true, labels: [L('file number'), L('registration number'), L('entity number')] },
      { key: 'formation_date', label: 'Date of formation', type: 'date', critical: true, labels: [L('date of (?:formation|incorporation)'), L('formation date')] },
      { key: 'registered_address', label: 'Registered office', type: 'string', labels: [L('registered office'), L('principal office')] },
      { key: 'registered_agent', label: 'Registered agent', type: 'string', labels: [L('registered agent')] },
    ],
  },
  beneficial_ownership: {
    version: '1.2',
    fields: [
      { key: 'entity_name', label: 'Legal entity name', type: 'string', critical: true, labels: [L('legal name of entity'), L('entity name')] },
      { key: 'ein', label: 'EIN', type: 'ein', critical: true, labels: [L('employer identification number'), L('ein'), L('tax id(?:entification number)?')] },
      { key: 'address', label: 'Address', type: 'string', labels: [L('address')], },
      { key: 'control_person_name', label: 'Control person', type: 'string', critical: true, labels: [L('name')], after: /control prong/i },
      { key: 'control_person_title', label: 'Control person title', type: 'string', labels: [L('title')], after: /control prong/i },
      { key: 'certification_date', label: 'Certification date', type: 'date', labels: [L('date')], after: /certif/i, evidenceDate: true },
    ],
    tables: [
      {
        group: 'beneficial_owner',
        label: 'Beneficial owner',
        critical: true,
        header: [/name/i, /owner|interest|%/i],
        columns: [
          { key: 'name', label: 'Name', type: 'string', header: /^name/i, critical: true },
          { key: 'ownership_pct', label: 'Ownership', type: 'percent', header: /owner|interest|%/i, critical: true },
          { key: 'dob', label: 'Date of birth', type: 'date', header: /birth|dob/i },
          { key: 'address', label: 'Address', type: 'string', header: /address/i },
        ],
      },
    ],
  },
  director_register: {
    version: '1.0',
    fields: [
      { key: 'entity_name', label: 'Company', type: 'string', critical: true, labels: [L('company'), L('entity name')] },
      { key: 'file_number', label: 'Registration number', type: 'identifier', labels: [L('file number'), L('registration number')] },
      { key: 'register_date', label: 'Register date', type: 'date', labels: [L('register date'), L('date')], evidenceDate: true },
    ],
    tables: [
      {
        group: 'director',
        label: 'Director or officer',
        critical: true,
        header: [/name/i, /position|role|title/i],
        columns: [
          { key: 'name', label: 'Name', type: 'string', header: /^name/i, critical: true },
          { key: 'position', label: 'Position', type: 'string', header: /position|role|title/i },
          { key: 'appointed', label: 'Date appointed', type: 'date', header: /appointed|since/i },
        ],
      },
    ],
  },
  bank_statement: {
    version: '1.0',
    fields: [
      { key: 'bank_name', label: 'Bank', type: 'string', labels: [] },
      { key: 'account_holder', label: 'Account holder', type: 'string', critical: true, labels: [L('account holder'), L('account name')] },
      { key: 'account_number', label: 'Account number', type: 'identifier', labels: [L('account number'), L('account no\\.?')] },
      { key: 'opening_balance', label: 'Opening balance', type: 'money', labels: [L('opening balance'), L('beginning balance')] },
      { key: 'closing_balance', label: 'Closing balance', type: 'money', labels: [L('closing balance'), L('ending balance')] },
    ],
    ranges: [
      {
        label: L('statement period'),
        start: { key: 'period_start', label: 'Period start' },
        end: { key: 'period_end', label: 'Period end', evidenceDate: true },
        critical: true,
      },
    ],
  },
  tax_form: {
    version: '1.0',
    fields: [
      { key: 'entity_name', label: 'Name', type: 'string', critical: true, labels: [L('1 name(?: of entity)?'), L('name of entity'), L('name')] },
      { key: 'tax_classification', label: 'Tax classification', type: 'string', labels: [L('3 federal tax classification'), L('federal tax classification')] },
      { key: 'ein', label: 'EIN', type: 'ein', critical: true, labels: [L('employer identification number'), L('ein')] },
      { key: 'signature_date', label: 'Signature date', type: 'date', labels: [L('date')], evidenceDate: true },
    ],
  },
  ownership_chart: {
    version: '1.0',
    fields: [
      { key: 'subject_entity', label: 'Prepared for', type: 'string', labels: [L('prepared for'), L('company')] },
      { key: 'as_of', label: 'As of', type: 'date', labels: [L('as of')], evidenceDate: true },
    ],
    tables: [
      {
        group: 'ownership_edge',
        label: 'Ownership',
        critical: true,
        header: [/owner/i, /owned|entity|subsidiary/i, /interest|%|share/i],
        columns: [
          { key: 'owner', label: 'Owner', type: 'string', header: /^owner$/i, critical: true },
          { key: 'owned', label: 'Owned entity', type: 'string', header: /owned|entity|subsidiary/i, critical: true },
          { key: 'pct', label: 'Percentage held', type: 'percent', header: /interest|%|share/i, critical: true },
        ],
      },
    ],
  },
  compliance_policy: {
    version: '1.0',
    fields: [
      { key: 'policy_owner', label: 'Policy owner', type: 'string', labels: [L('policy owner')] },
      { key: 'policy_version', label: 'Version', type: 'identifier', labels: [L('version')] },
      { key: 'effective_date', label: 'Effective date', type: 'date', labels: [L('effective date')], evidenceDate: true },
    ],
  },
};

export function schemaVersion(category: DocumentCategory): string {
  return SCHEMAS[category]?.version ?? '0';
}

/** Returns the normalized value and a display string, or null when the text does not parse. */
export function normalizeValue(type: ValueType, raw: string): { value: unknown; text: string } | null {
  const t = raw.trim();
  if (!t) return null;
  switch (type) {
    case 'date': {
      const d = parseDate(t);
      return d ? { value: d, text: d } : null;
    }
    case 'percent': {
      const p = parsePercent(t);
      return p === null ? null : { value: p, text: `${p}%` };
    }
    case 'money': {
      const m = parseMoney(t);
      return m ? { value: m, text: `${m.currency} ${m.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}` } : null;
    }
    case 'ein': {
      const e = parseEin(t);
      return e ? { value: e, text: e } : null;
    }
    default:
      return { value: t, text: t };
  }
}

function ocrFactor(page: ParsedPage) {
  return page.ocr ? Math.max(0.5, page.ocr_confidence ?? 0.7) : 1;
}

function findLabeled(pages: ParsedPage[], spec: FieldSpec): FactCandidate | null {
  for (const page of pages) {
    let active = !spec.after;
    for (const line of page.lines) {
      if (!active) {
        if (spec.after!.test(line.text)) active = true;
        continue;
      }
      for (const re of spec.labels) {
        const m = line.text.match(re);
        if (!m) continue;
        const rawValue = line.text.slice(m[0].length);
        const n = normalizeValue(spec.type, rawValue);
        const start = line.start + m[0].length;
        const end = line.end;
        const evidence = { page_no: page.page_no, start, end, quote: page.text.slice(start, end) };
        if (!n) {
          return {
            field_key: spec.key,
            field_label: spec.label,
            value_type: spec.type,
            value: rawValue.trim(),
            value_text: rawValue.trim(),
            group_key: null,
            confidence: 0.4,
            critical: !!spec.critical,
            evidence,
          };
        }
        return {
          field_key: spec.key,
          field_label: spec.label,
          value_type: spec.type,
          value: n.value,
          value_text: n.text,
          group_key: null,
          confidence: Math.round(0.95 * ocrFactor(page) * 10000) / 10000,
          critical: !!spec.critical,
          evidence,
        };
      }
    }
  }
  return null;
}

function tableFacts(doc: ParsedDocument, spec: TableSpec): FactCandidate[] {
  const out: FactCandidate[] = [];
  const tables = doc.tables.filter((t: ParsedTable) => spec.header.every((h) => t.header.some((c) => h.test(c))));
  let n = 0;
  for (const table of tables) {
    const page = doc.pages.find((p) => p.page_no === table.page_no)!;
    const colIndex = spec.columns.map((col) => table.header.findIndex((h) => col.header.test(h)));
    for (const row of table.rows) {
      n++;
      const group = `${spec.group}:${n}`;
      spec.columns.forEach((col, i) => {
        const idx = colIndex[i]!;
        if (idx < 0) return;
        const raw = row.cells[idx] ?? '';
        const norm = normalizeValue(col.type, raw);
        if (!raw.trim()) return;
        // evidence points at the cell within the row line
        const line = page.lines.find((l) => l.start === row.start);
        const cell = line?.cells.find((c) => c.text === raw);
        const start = cell?.start ?? row.start;
        const end = cell?.end ?? row.end;
        out.push({
          field_key: `${spec.group}.${col.key}`,
          field_label: `${spec.label} ${col.label.toLowerCase()}`,
          value_type: col.type,
          value: norm?.value ?? raw,
          value_text: norm?.text ?? raw,
          group_key: group,
          confidence: Math.round((norm ? 0.9 : 0.4) * ocrFactor(page) * 10000) / 10000,
          critical: !!(spec.critical && col.critical),
          evidence: { page_no: page.page_no, start, end, quote: page.text.slice(start, end) },
        });
      });
    }
  }
  return out;
}

function rangeFacts(pages: ParsedPage[], spec: RangeSpec): FactCandidate[] {
  for (const page of pages) {
    for (const line of page.lines) {
      const m = line.text.match(spec.label);
      if (!m) continue;
      const rest = line.text.slice(m[0].length);
      const parts = rest.split(/\s+(?:to|through|-|–)\s+/i);
      if (parts.length !== 2) continue;
      const a = parseDate(parts[0]!);
      const b = parseDate(parts[1]!);
      if (!a || !b) continue;
      const base = line.start + m[0].length;
      const bStart = base + rest.lastIndexOf(parts[1]!);
      const mk = (k: { key: string; label: string }, value: string, start: number, end: number): FactCandidate => ({
        field_key: k.key,
        field_label: k.label,
        value_type: 'date',
        value,
        value_text: value,
        group_key: null,
        confidence: Math.round(0.95 * ocrFactor(page) * 10000) / 10000,
        critical: !!spec.critical,
        evidence: { page_no: page.page_no, start, end, quote: page.text.slice(start, end) },
      });
      return [mk(spec.start, a, base, base + parts[0]!.length), mk(spec.end, b, bStart, bStart + parts[1]!.length)];
    }
  }
  return [];
}

export const EXTRACTOR_VERSION = 'schema-1.2';

export interface ExtractionResult {
  facts: FactCandidate[];
  evidence_date: string | null;
  coverage: { expected: number; found: number };
}

/** Schema-driven extraction with page/character evidence for every value. */
export function extractFacts(doc: ParsedDocument, category: DocumentCategory): ExtractionResult {
  const schema = SCHEMAS[category];
  if (!schema) return { facts: [], evidence_date: null, coverage: { expected: 0, found: 0 } };
  const facts: FactCandidate[] = [];
  let evidenceDate: string | null = null;

  for (const spec of schema.fields) {
    if (category === 'bank_statement' && spec.key === 'bank_name') {
      // the bank name is the statement's first line
      const page = doc.pages[0];
      const first = page?.lines.find((l) => l.text.trim());
      if (page && first && /bank|credit union|n\.a\./i.test(first.text)) {
        facts.push({
          field_key: 'bank_name',
          field_label: 'Bank',
          value_type: 'string',
          value: first.text.trim(),
          value_text: first.text.trim(),
          group_key: null,
          confidence: 0.8,
          critical: false,
          evidence: { page_no: page.page_no, start: first.start, end: first.end, quote: first.text },
        });
      }
      continue;
    }
    const f = findLabeled(doc.pages, spec);
    if (f) {
      facts.push(f);
      if (spec.evidenceDate && f.value_type === 'date' && f.confidence > 0.5) evidenceDate = String(f.value);
    }
  }
  for (const spec of schema.ranges ?? []) {
    const r = rangeFacts(doc.pages, spec);
    facts.push(...r);
    if (spec.end.evidenceDate && r[1]) evidenceDate = String(r[1].value);
  }
  for (const spec of schema.tables ?? []) facts.push(...tableFacts(doc, spec));

  const expected = schema.fields.length + (schema.ranges?.length ?? 0) * 2 + (schema.tables?.length ?? 0);
  const found = new Set(facts.map((f) => f.group_key?.split(':')[0] ?? f.field_key)).size;
  return { facts, evidence_date: evidenceDate, coverage: { expected, found } };
}
