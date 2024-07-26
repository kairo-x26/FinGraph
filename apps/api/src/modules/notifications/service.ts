import type { Tx } from '../../db';

export interface NotifyInput {
  tenantId: string;
  userIds: (string | null | undefined)[];
  type: string;
  title: string;
  body?: string;
  link?: string;
  resource?: { type: string; id: string };
  /** The acting user is not notified about their own action. */
  exclude?: string | null;
}

export async function notify(tx: Tx, n: NotifyInput) {
  const users = [...new Set(n.userIds.filter((u): u is string => !!u && u !== n.exclude))];
  for (const userId of users) {
    await tx.query(
      `insert into notifications (tenant_id, user_id, type, title, body, link, resource_type, resource_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [n.tenantId, userId, n.type, n.title, n.body ?? null, n.link ?? null, n.resource?.type ?? null, n.resource?.id ?? null],
    );
  }
  return users.length;
}

/** Active users holding any of the roles (e.g. every risk manager for approvals). */
export async function usersWithRole(tx: Tx, roles: string[]): Promise<string[]> {
  const rows = await tx.many<{ id: string }>(`select id from users where status = 'active' and roles && $1::text[]`, [roles]);
  return rows.map((r) => r.id);
}
