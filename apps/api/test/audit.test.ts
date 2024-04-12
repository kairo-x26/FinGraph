import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { recordAudit, verifyAuditChain } from '../src/modules/audit/service';
import { createTestDb } from './helpers';

let db: Database;
let tenantId: string;

beforeAll(async () => {
  db = await createTestDb();
  tenantId = (await db.system((tx) =>
    tx.one<{ id: string }>(`insert into tenants (slug, name) values ('audit-co', 'Audit Co') returning id`),
  ))!.id;
});
afterAll(() => db.close());

const actor = { type: 'user' as const, id: 'u-1' };

describe('audit log', () => {
  it('builds a verifiable hash chain', async () => {
    for (let i = 0; i < 5; i++) {
      await db.tenant(tenantId, (tx) =>
        recordAudit(tx, { tenantId, actor, action: 'case.created', resourceType: 'case', resourceId: `c${i}`, details: { i } }),
      );
    }
    const result = await db.tenant(tenantId, (tx) => verifyAuditChain(tx, tenantId));
    expect(result).toMatchObject({ valid: true, checked: 5, broken_at_seq: null });
  });

  it('assigns gap-free sequence numbers under concurrent writers', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.tenant(tenantId, (tx) =>
          recordAudit(tx, { tenantId, actor, action: 'doc.viewed', resourceType: 'document', resourceId: `d${i}` }),
        ),
      ),
    );
    const seqs = await db.tenant(tenantId, (tx) =>
      tx.many<{ seq: number }>('select seq from audit_events order by seq'),
    );
    expect(seqs.map((r) => r.seq)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('rejects updates and deletes', async () => {
    await expect(
      db.tenant(tenantId, (tx) => tx.query(`update audit_events set action = 'x'`)),
    ).rejects.toThrow();
    await expect(
      db.system((tx) => tx.query(`delete from audit_events where seq = 1`)),
    ).rejects.toThrow(/append-only/);
  });

  it('detects tampering when the trigger is bypassed', async () => {
    await db.system(async (tx) => {
      await tx.query('alter table audit_events disable trigger audit_events_no_update');
      await tx.query(`update audit_events set details = '{"i": 99}' where tenant_id = $1 and seq = 3`, [tenantId]);
      await tx.query('alter table audit_events enable trigger audit_events_no_update');
    });
    const result = await db.tenant(tenantId, (tx) => verifyAuditChain(tx, tenantId));
    expect(result.valid).toBe(false);
    expect(result.broken_at_seq).toBe(3);
  });
});
