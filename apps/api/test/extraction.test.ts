import { extraFixtures, northwindFixtures, type Fixture } from '@fingraph/fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyDocument } from '../src/modules/extraction/classify';
import { parseDate, parseMoney, parsePercent, normalizeName } from '../src/modules/extraction/normalize';
import { detectTables, parseDocument, textPages } from '../src/modules/extraction/parse';
import { extractFacts } from '../src/modules/extraction/schemas';

let fixtures: Fixture[];
beforeAll(async () => {
  fixtures = [...(await northwindFixtures()), ...(await extraFixtures())];
});

const byKey = (k: string) => fixtures.find((f) => f.key === k)!;

async function run(key: string) {
  const f = byKey(key);
  const doc = await parseDocument(f.bytes, f.mime, null);
  const cls = classifyDocument(doc, f.filename);
  const ex = extractFacts(doc, cls.category);
  const value = (k: string) => ex.facts.find((x) => x.field_key === k)?.value;
  return { doc, cls, ex, value };
}

describe('normalizers', () => {
  it('parses common date formats', () => {
    expect(parseDate('March 4, 2019')).toBe('2019-03-04');
    expect(parseDate('2024-01-08')).toBe('2024-01-08');
    expect(parseDate('03/04/2019')).toBe('2019-03-04');
    expect(parseDate('4 March 2019')).toBe('2019-03-04');
    expect(parseDate('February 30, 2020')).toBeNull();
  });
  it('parses money and percentages', () => {
    expect(parseMoney('$1,204,331.07')).toEqual({ amount: 1204331.07, currency: 'USD' });
    expect(parsePercent('45%')).toBe(45);
    expect(parsePercent('25 percent')).toBe(25);
    expect(parsePercent('140%')).toBeNull();
  });
  it('normalizes organization names for matching', () => {
    expect(normalizeName('Northwind Payments, L.L.C.')).toBe(normalizeName('NORTHWIND PAYMENTS LLC'));
    expect(normalizeName('Harbor Ventures Holdings LP')).toBe('harbor ventures holdings');
  });
});

describe('parsing', () => {
  it('keeps character offsets consistent with page text', async () => {
    const { doc } = await run('ubo');
    for (const page of doc.pages) {
      for (const line of page.lines) expect(page.text.slice(line.start, line.end)).toBe(line.text);
    }
  });

  it('detects tables from aligned columns', async () => {
    const { doc } = await run('structure');
    expect(doc.tables[0]!.header).toEqual(['Owner', 'Owned entity', 'Interest']);
    expect(doc.tables[0]!.rows).toHaveLength(6);
  });

  it('parses csv into a table', () => {
    const pages = textPages('name,pct\nA,10\nB,20', true);
    expect(pages[0]!.lines[1]!.cells.map((c) => c.text)).toEqual(['A', '10']);
    expect(detectTables(pages)).toEqual([]);
  });
});

describe('classification', () => {
  it('classifies every fixture correctly', async () => {
    for (const f of fixtures) {
      const doc = await parseDocument(f.bytes, f.mime, null);
      const cls = classifyDocument(doc, f.filename);
      expect(`${f.key}:${cls.category}`).toBe(`${f.key}:${f.expectedCategory}`);
      if (f.expectedCategory !== 'other') expect(cls.confidence).toBeGreaterThanOrEqual(0.7);
    }
  });
});

describe('extraction', () => {
  it('extracts formation details with evidence', async () => {
    const { value, ex, doc } = await run('formation');
    expect(value('entity_name')).toBe('Northwind Payments LLC');
    expect(value('jurisdiction')).toBe('Delaware');
    expect(value('file_number')).toBe('7731450');
    expect(value('formation_date')).toBe('2019-03-04');
    const f = ex.facts.find((x) => x.field_key === 'entity_name')!;
    expect(doc.pages[0]!.text.slice(f.evidence.start, f.evidence.end)).toBe('Northwind Payments LLC');
  });

  it('extracts beneficial owners and control person', async () => {
    const { ex, value } = await run('ubo');
    expect(value('ein')).toBe('84-3920175');
    expect(value('control_person_name')).toBe('Daniel Kim');
    expect(value('control_person_title')).toBe('Chief Executive Officer');
    const owners = ex.facts.filter((f) => f.field_key === 'beneficial_owner.name').map((f) => f.value);
    expect(owners).toEqual(['Maria Gonzalez', 'James Okoro']);
    const pct = ex.facts.filter((f) => f.field_key === 'beneficial_owner.ownership_pct').map((f) => f.value);
    expect(pct).toEqual([30, 25]);
    expect(ex.evidence_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('extracts bank statement period and balances', async () => {
    const { value, ex } = await run('bank');
    expect(value('bank_name')).toBe('First Harbor Bank, N.A.');
    expect(value('account_holder')).toBe('Northwind Payments LLC');
    expect(value('closing_balance')).toEqual({ amount: 1438155.16, currency: 'USD' });
    expect(value('period_end')).toBe(ex.evidence_date);
  });

  it('extracts directors and ownership edges', async () => {
    const d = await run('directors');
    expect(d.ex.facts.filter((f) => f.field_key === 'director.name').map((f) => f.value)).toEqual([
      'Maria Gonzalez',
      'Daniel Kim',
      'Priya Natarajan',
    ]);
    const s = await run('structure');
    const edges = s.ex.facts.filter((f) => f.group_key?.startsWith('ownership_edge'));
    expect(edges).toHaveLength(18);
    expect(s.ex.facts.find((f) => f.field_key === 'ownership_edge.owner' && f.value === 'Thomas Reid')).toBeTruthy();
  });

  it('extracts the W-9', async () => {
    const { value } = await run('tax');
    expect(value('entity_name')).toBe('Northwind Payments LLC');
    expect(value('ein')).toBe('84-3920175');
  });

  it('meets the critical-field precision target on the fixture set', async () => {
    const truth: Record<string, Record<string, unknown>> = {
      formation: { entity_name: 'Northwind Payments LLC', file_number: '7731450', formation_date: '2019-03-04', jurisdiction: 'Delaware' },
      ubo: { entity_name: 'Northwind Payments LLC', ein: '84-3920175', control_person_name: 'Daniel Kim' },
      bank: { account_holder: 'Northwind Payments LLC' },
      tax: { entity_name: 'Northwind Payments LLC', ein: '84-3920175' },
    };
    let correct = 0;
    let total = 0;
    for (const [key, fields] of Object.entries(truth)) {
      const { ex } = await run(key);
      for (const f of ex.facts.filter((x) => x.critical && x.confidence >= 0.9 && !x.group_key)) {
        if (f.field_key in fields) {
          total++;
          if (f.value === fields[f.field_key]) correct++;
        }
      }
    }
    expect(total).toBeGreaterThan(8);
    expect(correct / total).toBeGreaterThanOrEqual(0.95);
  });
});
