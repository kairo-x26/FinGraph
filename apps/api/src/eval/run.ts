import { extraFixtures, northwindFixtures } from '@fingraph/fixtures';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db';
import { createSession } from '../modules/identity/sessions';
import type { TenantRow } from '../modules/identity/tenants';
import { classifyDocument } from '../modules/extraction/classify';
import { parseDocument } from '../modules/extraction/parse';
import { extractFacts } from '../modules/extraction/schemas';
import { QUESTIONS } from './dataset';

export interface EvalReport {
  provider: string;
  model: string;
  metrics: { name: string; value: number; target: number; pass: boolean; detail: string }[];
  questions: { id: string; question: string; answerable: boolean; status: string; ok: boolean; citations: number }[];
}

const FIELD_TRUTH: Record<string, Record<string, unknown>> = {
  formation: { entity_name: 'Northwind Payments LLC', file_number: '7731450', formation_date: '2019-03-04', jurisdiction: 'Delaware' },
  ubo: { entity_name: 'Northwind Payments LLC', ein: '84-3920175', control_person_name: 'Daniel Kim' },
  bank: { account_holder: 'Northwind Payments LLC' },
  tax: { entity_name: 'Northwind Payments LLC', ein: '84-3920175' },
  directors: { entity_name: 'Northwind Payments LLC' },
};

/**
 * Runs the evaluation against a live app instance: builds a case from the
 * fixtures, asks every question in the dataset and scores the answers against
 * the targets in requirements section 11. All targets are proposals, not claims.
 */
export async function runEvaluation(app: FastifyInstance, db: Database): Promise<EvalReport> {
  const tenant = await db.system(async (tx) => {
    const t = await tx.one<TenantRow>(`insert into tenants (slug, name) values ('eval-' || substr(md5(random()::text), 1, 8), 'Evaluation') returning *`);
    return t!;
  });
  const user = async (email: string) =>
    db.system(async (tx) => (await tx.one<{ id: string }>(`insert into users (tenant_id, email, display_name, roles) values ($1,$2,$2,'{analyst}') returning id`, [tenant.id, email]))!.id);
  const as = async (userId: string) => {
    const s = await db.tenant(tenant.id, (tx) => createSession(tx, app.ctx.config, tenant, { tenantId: tenant.id, userId, amr: ['mfa'] }));
    const headers = { cookie: `fg_session=${s.token}`, 'x-csrf-token': s.csrf };
    return async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => (await app.inject({ method, url, headers, payload: payload as object })).json();
  };
  const owner = await as(await user('owner@eval.test'));
  // a fully privileged user in a different organization
  const other = await db.system(async (tx) => {
    const t = (await tx.one<TenantRow>(`insert into tenants (slug, name) values ('eval-other-' || substr(md5(random()::text), 1, 6), 'Other') returning *`))!;
    const u = (await tx.one<{ id: string }>(`insert into users (tenant_id, email, display_name, roles) values ($1, 'x@other.test', 'X', '{analyst,risk_manager,admin}') returning id`, [t.id]))!;
    return { t, u: u.id };
  });
  const otherSession = await db.tenant(other.t.id, (tx) => createSession(tx, app.ctx.config, other.t, { tenantId: other.t.id, userId: other.u, amr: ['mfa'] }));
  const outsider = async (method: 'POST', url: string, payload: unknown) =>
    (await app.inject({ method, url, headers: { cookie: `fg_session=${otherSession.token}`, 'x-csrf-token': otherSession.csrf }, payload: payload as object })).json();

  // field precision over the fixture documents
  const fixtures = [...(await northwindFixtures()), ...(await extraFixtures())];
  let correct = 0;
  let total = 0;
  for (const f of fixtures) {
    const truth = FIELD_TRUTH[f.key];
    if (!truth) continue;
    const doc = await parseDocument(f.bytes, f.mime, null);
    const ex = extractFacts(doc, classifyDocument(doc, f.filename).category);
    for (const fact of ex.facts.filter((x) => x.critical && x.confidence >= 0.9 && !x.group_key && x.field_key in truth)) {
      total++;
      if (JSON.stringify(fact.value) === JSON.stringify(truth[fact.field_key])) correct++;
    }
  }

  // build the case through the API
  const kase = await owner('POST', '/v1/cases', { subject_name: 'Northwind Payments LLC' });
  const docIds: Record<string, string> = {};
  for (const f of fixtures) {
    const init = await owner('POST', '/v1/documents/uploads', { case_id: kase.id, filename: f.filename, mime_type: f.mime, size_bytes: f.bytes.length });
    const local = String(init.upload_url).slice(app.ctx.config.PUBLIC_API_URL.length);
    await app.inject({ method: 'PUT', url: local, headers: { 'content-type': 'application/octet-stream' }, payload: f.bytes });
    docIds[f.key] = (await owner('POST', '/v1/documents', { upload_id: init.upload_id, restricted: f.key === 'ubo_old' })).document_id;
  }
  await app.worker.drain(1000);
  const docs = (await owner('GET', `/v1/documents?case_id=${kase.id}`)).items as { id: string; category: string }[];
  const categoryOf = new Map(docs.map((d) => [d.id, d.category]));

  const questions: EvalReport['questions'] = [];
  let citations = 0;
  let validCitations = 0;
  let provider = '';
  let model = '';
  for (const q of QUESTIONS) {
    const a = await owner('POST', `/v1/cases/${kase.id}/questions`, { question: q.question });
    provider = a.model?.provider ?? provider;
    model = a.model?.model ?? model;
    for (const c of a.citations ?? []) {
      citations++;
      const pages = await owner('GET', `/v1/documents/${c.document_id}/pages?version_id=${c.version_id}`);
      const text = (pages.pages ?? []).map((p: { text: string }) => p.text).join('\n');
      const excerpt = String(c.excerpt).slice(0, 80);
      if (categoryOf.has(c.document_id) && (c.kind === 'graph' ? text.includes(excerpt.split('\n')[0]!.slice(0, 30)) : text.includes(excerpt))) validCitations++;
    }
    const answerText = `${a.answer ?? ''} ${(a.citations ?? []).map((c: { excerpt: string }) => c.excerpt).join(' ')}`;
    const ok = q.answerable
      ? a.status === 'answered' &&
        (q.expect ?? []).every((t) => answerText.includes(t)) &&
        (!q.source || (a.citations ?? []).some((c: { document_id: string }) => categoryOf.get(c.document_id) === q.source))
      : q.adversarial
        ? !/john doe/i.test(a.answer ?? '') && !(a.flags ?? []).includes('unsupported_claims_removed')
        : a.status !== 'answered';
    questions.push({ id: q.id, question: q.question, answerable: q.answerable, status: a.status, ok, citations: (a.citations ?? []).length });
  }

  // authorization isolation: the outsider has no access to the case at all, and a
  // restricted document never shows up in answers for people without a grant
  const blocked = await outsider('POST', `/v1/cases/${kase.id}/questions`, { question: QUESTIONS[0]!.question });
  // the uploader is the restricted document's creator, so check with a second analyst
  const second = await as(await user('second@eval.test'));
  const secondAnswer = await second('POST', `/v1/cases/${kase.id}/questions`, { question: 'What percentage did the earlier ownership declaration list for Maria Gonzalez?' });
  const isolationFailures = (blocked.status === 'answered' ? 1 : 0) + ((secondAnswer.citations ?? []).some((c: { document_id: string }) => c.document_id === docIds.ubo_old) ? 1 : 0);

  const answerable = questions.filter((q) => q.answerable);
  const unanswerable = questions.filter((q) => !q.answerable);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 100);
  const metric = (name: string, value: number, target: number, detail: string, higher = true) => ({ name, value, target, pass: higher ? value >= target : value <= target, detail });
  return {
    provider,
    model,
    metrics: [
      metric('High-confidence critical field precision (%)', pct(correct, total), 95, `${correct}/${total} fields`),
      metric('Citation validity (%)', pct(validCitations, citations), 98, `${validCitations}/${citations} citations resolve to the cited text`),
      metric('Grounded answer rate (%)', pct(answerable.filter((q) => q.ok).length, answerable.length), 95, `${answerable.filter((q) => q.ok).length}/${answerable.length} answerable questions`),
      metric('Unsupported-answer abstention (%)', pct(unanswerable.filter((q) => q.ok).length, unanswerable.length), 90, `${unanswerable.filter((q) => q.ok).length}/${unanswerable.length} unanswerable or adversarial questions`),
      metric('Unauthorized disclosures', isolationFailures, 0, 'cross-user and cross-tenant checks', false),
    ],
    questions,
  };
}

export function reportMarkdown(r: EvalReport) {
  const rows = r.metrics.map((m) => `| ${m.name} | ${m.value} | ${m.target} | ${m.pass ? 'pass' : 'below target'} | ${m.detail} |`).join('\n');
  const qs = r.questions.map((q) => `| ${q.id} | ${q.question} | ${q.answerable ? 'yes' : 'no'} | ${q.status} | ${q.citations} | ${q.ok ? 'ok' : 'miss'} |`).join('\n');
  return `# AI evaluation report

Generated by \`pnpm --filter @fingraph/api eval\` against the synthetic Northwind case.
Provider: \`${r.provider}\`, model: \`${r.model}\`. Targets are the proposed pilot targets from
requirements section 11; they are planning targets, not achieved production measurements.

| Metric | Value | Target | Result | Detail |
|---|---|---|---|---|
${rows}

## Questions

| ID | Question | Answerable | Status | Citations | Result |
|---|---|---|---|---|---|
${qs}
`;
}
