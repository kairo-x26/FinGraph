import { extraFixtures, northwindFixtures, type Fixture } from '@fingraph/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jaroWinkler, nameSimilarity } from '../src/modules/graph/resolve';
import { ACME_USERS, acmeClients, client, createTestEnv, login, seedTenant, uploadDocument, type TestEnv } from './helpers';

let env: TestEnv;
let c: Awaited<ReturnType<typeof acmeClients>>;
let fx: Record<string, Fixture>;
let caseId: string;
const docs: Record<string, string> = {};

type GNode = { id: string; display_name: string; kind: string };
type GEdge = { id: string; source_entity_id: string; target_entity_id: string; relationship_type: string; ownership_pct: number | null; review_status: string; valid_to: string | null };

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  await seedTenant(env.db, 'acme', ACME_USERS);
  await seedTenant(env.db, 'globex', [{ email: 'olga@globex.test', name: 'Olga', roles: ['analyst'] }]);
  c = await acmeClients(env);
  fx = Object.fromEntries([...(await northwindFixtures()), ...(await extraFixtures())].map((f) => [f.key, f]));
  caseId = (await c.onboarding.post('/v1/cases', { subject_name: 'Northwind Payments LLC' })).json().id;
  for (const key of ['formation', 'ubo', 'ubo_old', 'directors', 'structure', 'tax', 'bank']) {
    docs[key] = (await uploadDocument(env.app, c.onboarding, caseId, fx[key]!)).json().document_id;
  }
  await env.app.worker.drain();
});
afterAll(() => env.close());

const graph = async (q = '') => (await c.analyst.get(`/v1/cases/${caseId}/graph${q}`)).json() as { subject_entity_id: string; nodes: GNode[]; edges: GEdge[] };
const idOf = (g: { nodes: GNode[] }, name: string) => g.nodes.find((n) => n.display_name === name)?.id;

describe('similarity', () => {
  it('scores names', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 2);
    expect(nameSimilarity('Maria Gonzalez', 'Gonzalez, Maria')).toBe(1);
    expect(nameSimilarity('Maria Gonzalez', 'Maria Gonzales')).toBeGreaterThan(0.9);
    expect(nameSimilarity('Maria Gonzalez', 'James Okoro')).toBeLessThan(0.6);
  });
});

describe('knowledge graph', () => {
  it('builds entities and typed relationships from the case documents', async () => {
    const g = await graph();
    const names = g.nodes.map((n) => n.display_name).sort();
    expect(names).toEqual(
      ['Daniel Kim', 'Elena Varga', 'Harbor Capital Partners LLC', 'Harbor Ventures Holdings LP', 'James Okoro', 'Maria Gonzalez', 'Northwind Payments LLC', 'Priya Natarajan', 'Thomas Reid'].sort(),
    );
    expect(g.nodes.find((n) => n.display_name === 'Harbor Ventures Holdings LP')!.kind).toBe('organization');
    expect(g.nodes.find((n) => n.display_name === 'Thomas Reid')!.kind).toBe('individual');
    const types = g.edges.reduce<Record<string, number>>((a, e) => ({ ...a, [e.relationship_type]: (a[e.relationship_type] ?? 0) + 1 }), {});
    expect(types.DIRECTOR_OF).toBe(3);
    expect(types.OFFICER_OF).toBe(1);
    expect(g.edges.every((e) => e.review_status === 'candidate')).toBe(true);
  });

  it('records identifiers on the subject from the certificate and W-9', async () => {
    const g = await graph();
    const subject = (await c.analyst.get(`/v1/entities/${g.subject_entity_id}`)).json();
    expect(subject.identifiers).toMatchObject({ file_number: '7731450', ein: '84-3920175' });
    expect(subject.jurisdiction).toBe('Delaware');
    expect(subject.mentions.length).toBeGreaterThanOrEqual(3);
  });

  it('closes outdated claims instead of treating them as conflicts', async () => {
    const all = await graph('?include_historical=true');
    const maria = idOf(all, 'Maria Gonzalez')!;
    const claims = all.edges.filter((e) => e.target_entity_id === maria && e.relationship_type === 'OWNED_BY');
    expect(claims.map((e) => e.ownership_pct).sort()).toEqual([30, 30, 50]);
    const old = claims.find((e) => e.ownership_pct === 50)!;
    expect(old.valid_to).toBeTruthy();
    expect(old.review_status).toBe('candidate');
    const current = await graph();
    expect(current.edges.find((e) => e.id === old.id)).toBeUndefined();
  });

  it('rolls up indirect ownership and finds the undeclared beneficial owner', async () => {
    const res = await c.analyst.get(`/v1/cases/${caseId}/ownership`);
    const owners = Object.fromEntries(res.json().owners.map((o: { display_name: string; effective_pct: number; declared: boolean }) => [o.display_name, [o.effective_pct, o.declared]]));
    expect(owners['Maria Gonzalez']).toEqual([30, true]);
    expect(owners['James Okoro']).toEqual([25, true]);
    expect(owners['Thomas Reid']).toEqual([27, false]);
    expect(owners['Elena Varga']).toEqual([18, false]);
    const d = await c.analyst.get(`/v1/cases/${caseId}/discrepancies`);
    const undeclared = d.json().items.filter((x: { type: string }) => x.type === 'undeclared_beneficial_owner');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].title).toContain('Thomas Reid holds 27%');
    expect(undeclared[0].severity).toBe('high');
  });

  it('marks same-date claims with different percentages as conflicting and keeps both', async () => {
    const g = await graph();
    const maria = idOf(g, 'Maria Gonzalez')!;
    const bo = g.edges.find((e) => e.target_entity_id === maria && e.ownership_pct === 30 && e.relationship_type === 'OWNED_BY')!;
    const boDoc = await env.db.system((tx) => tx.one('select valid_from from entity_relationships where id = $1', [bo.id]));
    const manual = await c.analyst.post(`/v1/cases/${caseId}/relationships`, {
      source: { entity_id: g.subject_entity_id },
      target: { entity_id: maria },
      relationship_type: 'OWNED_BY',
      ownership_pct: 35,
      evidence_document_id: docs.ubo,
      evidence_quote: 'Maria Gonzalez 35% (handwritten amendment)',
      valid_from: new Date(boDoc!.valid_from).toISOString().slice(0, 10),
    });
    expect(manual.statusCode).toBe(201);
    const after = await graph();
    const statuses = after.edges.filter((e) => e.target_entity_id === maria && e.relationship_type === 'OWNED_BY').map((e) => `${e.ownership_pct}:${e.review_status}`);
    expect(statuses).toEqual(expect.arrayContaining(['35:conflicting']));
    const d = await c.analyst.get(`/v1/cases/${caseId}/discrepancies`);
    expect(d.json().items.some((x: { type: string }) => x.type === 'ownership_conflict')).toBe(true);

    // rejecting the manual claim resolves the conflict
    const rej = await c.analyst.post(`/v1/relationships/${manual.json().id}/reviews`, { action: 'reject', comment: 'Amendment not signed' });
    expect(rej.json().review_status).toBe('rejected');
    const d2 = await c.analyst.get(`/v1/cases/${caseId}/discrepancies`);
    expect(d2.json().items.some((x: { type: string }) => x.type === 'ownership_conflict')).toBe(false);
  });

  it('requires evidence from the same case for manual relationships', async () => {
    const other = (await c.analyst.post('/v1/cases', { subject_name: 'Other Co' })).json().id;
    const res = await c.analyst.post(`/v1/cases/${other}/relationships`, {
      source: { name: 'Other Co', kind: 'organization' },
      target: { name: 'Someone', kind: 'individual' },
      relationship_type: 'OWNED_BY',
      evidence_document_id: docs.ubo,
      evidence_quote: 'borrowed evidence',
    });
    expect(res.json().code).toBe('evidence_not_in_case');
  });

  it('verifies relationships and filters to verified-only', async () => {
    const g = await graph();
    const james = idOf(g, 'James Okoro')!;
    const edge = g.edges.find((e) => e.target_entity_id === james && e.ownership_pct === 25)!;
    const res = await c.analyst.post(`/v1/relationships/${edge.id}/reviews`, { action: 'verify' });
    expect(res.json()).toMatchObject({ review_status: 'verified', reviewed_by: expect.any(String) });
    const verified = await graph('?include_unverified=false');
    expect(verified.edges.map((e) => e.id)).toContain(edge.id);
    expect(verified.edges.every((e) => e.review_status === 'verified')).toBe(true);
    expect((await c.auditor.post(`/v1/relationships/${edge.id}/reviews`, { action: 'reject', comment: 'no' })).statusCode).toBe(403);
  });

  it('traverses multiple hops with limits', async () => {
    const g = await graph();
    const thomas = idOf(g, 'Thomas Reid')!;
    const one = (await c.analyst.get(`/v1/entities/${thomas}/relationships?depth=1`)).json();
    expect(one.nodes.map((n: GNode) => n.display_name).sort()).toEqual(['Harbor Capital Partners LLC', 'Thomas Reid']);
    const three = (await c.analyst.get(`/v1/entities/${thomas}/relationships?depth=3`)).json();
    expect(three.nodes.map((n: GNode) => n.display_name)).toContain('Northwind Payments LLC');
    expect(three.truncated).toBe(false);
    const tooDeep = await c.analyst.get(`/v1/entities/${thomas}/relationships?depth=9`);
    expect(tooDeep.statusCode).toBe(422);
  });

  it('hides relationships evidenced by documents the user cannot see', async () => {
    await c.analyst.patch(`/v1/documents/${docs.structure}`, { restricted: true });
    const mine = await c.analyst.get(`/v1/cases/${caseId}/graph`);
    expect(mine.json().nodes.some((n: GNode) => n.display_name === 'Thomas Reid')).toBe(true);
    const other = await c.analyst2.get(`/v1/cases/${caseId}/graph`);
    expect(other.json().nodes.some((n: GNode) => n.display_name === 'Thomas Reid')).toBe(false);
    const thomas = idOf(mine.json(), 'Thomas Reid')!;
    expect((await c.analyst2.get(`/v1/entities/${thomas}`)).statusCode).toBe(404);
    const own = await c.analyst2.get(`/v1/cases/${caseId}/ownership`);
    expect(own.json().owners.some((o: { display_name: string }) => o.display_name === 'Thomas Reid')).toBe(false);
    await c.analyst.patch(`/v1/documents/${docs.structure}`, { restricted: false });
  });

  it('suggests and merges likely duplicates', async () => {
    const other = (await c.analyst.post('/v1/cases', { subject_name: 'Bayside Remit Inc' })).json().id;
    const up = await uploadDocument(env.app, c.analyst, other, { filename: 'note.txt', mime: 'text/plain', bytes: Buffer.from('Ownership note: Maria Gonzales owns 60 percent.') });
    await env.app.worker.drain();
    const made = await c.analyst.post(`/v1/cases/${other}/relationships`, {
      source: { name: 'Bayside Remit Inc', kind: 'organization' },
      target: { name: 'Maria Gonzales', kind: 'individual' },
      relationship_type: 'OWNED_BY',
      ownership_pct: 60,
      evidence_document_id: up.json().document_id,
      evidence_quote: 'Maria Gonzales owns 60 percent.',
    });
    expect(made.statusCode).toBe(201);
    const dups = (await c.analyst.get('/v1/entities/duplicates')).json().items;
    const pair = dups.find((d: { a_name: string; b_name: string }) => [d.a_name, d.b_name].sort().join('|') === 'Maria Gonzales|Maria Gonzalez');
    expect(pair).toBeTruthy();
    const g = await graph();
    const keep = idOf(g, 'Maria Gonzalez')!;
    const merged = await c.analyst.post(`/v1/entities/duplicates/${pair.id}/resolve`, { action: 'merge', keep });
    expect(merged.json()).toMatchObject({ status: 'merged', kept: keep });
    const profile = (await c.analyst.get(`/v1/entities/${keep}/relationships?depth=1`)).json();
    expect(profile.nodes.map((n: GNode) => n.display_name)).toContain('Bayside Remit Inc');
  });

  it('isolates the graph between tenants', async () => {
    const g = await graph();
    const olga = client(env.app, await login(env, 'olga@globex.test', 'globex'));
    expect((await olga.get(`/v1/entities/${g.subject_entity_id}`)).statusCode).toBe(404);
    expect((await olga.get(`/v1/cases/${caseId}/graph`)).statusCode).toBe(404);
    expect((await olga.get('/v1/entities?q=maria')).json().items).toHaveLength(0);
  });
});
