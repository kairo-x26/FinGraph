import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import type { Tx } from '../../db';
import { decrypt, deriveKey, encrypt, randomToken, sha256Hex } from '../../lib/crypto';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit, recordAudit } from '../audit/service';
import { getVisibleCase, isClosed } from '../cases/access';
import { detectMime, isSupportedMime, safeFilename } from '../documents/filetypes';
import { registerDocument } from '../documents/routes';
import { emitEvent } from '../events/outbox';
import { pkcePair } from '../identity/oidc';
import { PermanentJobError } from '../jobs/errors';
import { enqueue } from '../jobs/queue';
import type { JobContext } from '../jobs/worker';
import { ReauthorizationRequired, TokenRejectedError, type ConnectorProvider, type TokenSet } from './providers';

export const SYNC_JOB = 'connector_sync';
const FLOW_TTL_MS = 10 * 60_000;

interface ConnectionRow {
  id: string;
  tenant_id: string;
  provider: string;
  status: string;
  account_label: string | null;
  scopes: string[];
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: Date | null;
  sync_state: { case_id?: string; page_token?: string | null; imported?: number; skipped?: number; job_id?: string };
  last_sync_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

const PUBLIC_COLUMNS = `id, provider, status, account_label, scopes, expires_at, sync_state, last_sync_at, last_error, created_at, revoked_at`;

const keyFor = (ctx: Pick<AppContext, 'config'>) => deriveKey(ctx.config.APP_SECRET, 'connector-tokens');

async function storeTokens(tx: Tx, ctx: Pick<AppContext, 'config'>, connectionId: string, t: TokenSet, keepRefresh: string | null) {
  const k = keyFor(ctx);
  const refresh = t.refresh_token ?? keepRefresh;
  await tx.query(
    `update connections set access_token_enc = $2, refresh_token_enc = $3,
            expires_at = case when $4::int is null then null else now() + make_interval(secs => $4) end,
            scopes = case when $5::text is null then scopes else string_to_array($5, ' ') end,
            status = 'active', last_error = null
      where id = $1`,
    [
      connectionId,
      encrypt(k, t.access_token, `${connectionId}:access`),
      refresh ? encrypt(k, refresh, `${connectionId}:refresh`) : null,
      t.expires_in ?? null,
      t.scope ?? null,
    ],
  );
}

/**
 * Runs `fn` with a valid access token: refreshes ahead of expiry, retries once
 * after a rejected token, and marks the connection expired when the refresh token
 * no longer works.
 */
export async function withAccessToken<T>(ctx: AppContext, provider: ConnectorProvider, tenantId: string, connectionId: string, fn: (token: string) => Promise<T>): Promise<T> {
  const k = keyFor(ctx);
  const load = () => ctx.db.tenant(tenantId, (tx) => tx.one<ConnectionRow>('select * from connections where id = $1', [connectionId]));
  let c = await load();
  if (!c) throw new PermanentJobError('not_found', 'connection not found');
  if (c.status === 'revoked') throw new PermanentJobError('connection_revoked', 'The connection was revoked.');
  if (c.status === 'expired') throw new PermanentJobError('reauthorization_required', 'The connection needs to be authorized again.');

  const refresh = async () => {
    const rt = c!.refresh_token_enc ? decrypt(k, c!.refresh_token_enc, `${connectionId}:refresh`) : null;
    if (!rt) throw new ReauthorizationRequired('no refresh token');
    const tokens = await provider.refresh(rt);
    await ctx.db.tenant(tenantId, (tx) => storeTokens(tx, ctx, connectionId, tokens, rt));
    c = await load();
  };

  try {
    if (c.expires_at && new Date(c.expires_at).getTime() < Date.now() + 60_000) await refresh();
    try {
      return await fn(decrypt(k, c!.access_token_enc!, `${connectionId}:access`));
    } catch (err) {
      if (!(err instanceof TokenRejectedError)) throw err;
      await refresh();
      return await fn(decrypt(k, c!.access_token_enc!, `${connectionId}:access`));
    }
  } catch (err) {
    if (err instanceof ReauthorizationRequired || err instanceof TokenRejectedError) {
      await ctx.db.tenant(tenantId, async (tx) => {
        await tx.query(`update connections set status = 'expired', last_error = $2 where id = $1`, [connectionId, 'Authorization expired; reconnect the integration.']);
        await recordAudit(tx, { tenantId, actor: { type: 'system', id: 'connector' }, action: 'connection.expired', resourceType: 'connection', resourceId: connectionId });
      });
      throw new PermanentJobError('reauthorization_required', 'The connection needs to be authorized again.');
    }
    throw err;
  }
}

/** Resumable, incremental import of repository files into a case (WF-02 step 6). */
export function syncHandler(ctx: AppContext, providers: Map<string, ConnectorProvider> = ctx.connectors) {
  return async ({ job, heartbeat }: JobContext) => {
    const { connection_id: connectionId, case_id: caseId } = job.payload as { connection_id: string; case_id: string };
    const fileIds = (job.payload.file_ids as string[] | undefined) ?? null;
    const tenantId = job.tenant_id;
    const conn = await ctx.db.tenant(tenantId, (tx) => tx.one<ConnectionRow>('select * from connections where id = $1', [connectionId]));
    if (!conn) throw new PermanentJobError('not_found', 'connection not found');
    const provider = providers.get(conn.provider);
    if (!provider) throw new PermanentJobError('provider_unavailable', `provider ${conn.provider} is not configured`);

    // resume from the saved page when this job is being retried
    const resume = conn.sync_state.job_id === job.id ? conn.sync_state : { job_id: job.id, case_id: caseId, page_token: null, imported: 0, skipped: 0 };
    let pageToken = resume.page_token ?? null;
    let imported = resume.imported ?? 0;
    let skipped = resume.skipped ?? 0;
    const saveState = () =>
      ctx.db.tenant(tenantId, (tx) =>
        tx.query('update connections set sync_state = $2 where id = $1', [connectionId, JSON.stringify({ job_id: job.id, case_id: caseId, page_token: pageToken, imported, skipped })]),
      );
    await saveState();

    do {
      const page = await withAccessToken(ctx, provider, tenantId, connectionId, (t) => provider.listFiles(t, pageToken));
      for (const f of page.files) {
        if (fileIds && !fileIds.includes(f.id)) continue;
        if (!isSupportedMime(f.mimeType)) {
          skipped++;
          continue;
        }
        const seen = await ctx.db.tenant(tenantId, (tx) =>
          tx.one<{ remote_modified: string | null; remote_checksum: string | null; document_id: string | null }>(
            'select * from connector_items where connection_id = $1 and remote_id = $2 and case_id = $3',
            [connectionId, f.id, caseId],
          ),
        );
        if (seen && seen.document_id && seen.remote_modified === f.modifiedTime && seen.remote_checksum === f.checksum) {
          skipped++;
          continue;
        }
        const bytes = await withAccessToken(ctx, provider, tenantId, connectionId, (t) => provider.download(t, f.id));
        const detected = detectMime(bytes);
        if (detected !== f.mimeType && !(f.mimeType.startsWith('text/') && detected.startsWith('text/'))) {
          skipped++;
          continue;
        }
        const sha = sha256Hex(bytes);
        const key = `tenants/${tenantId}/cases/${caseId}/imports/${connectionId}/${sha}`;
        await ctx.storage.put(key, bytes, { contentType: detected });
        await ctx.db.tenant(tenantId, async (tx) => {
          const kase = await tx.one<{ status: string }>('select status from cases where id = $1', [caseId]);
          if (!kase || isClosed(kase)) throw new PermanentJobError('case_closed', 'The target case is closed.');
          const existing = seen?.document_id
            ? await tx.one<{ id: string }>('select id from documents where id = $1 and deleted_at is null', [seen.document_id])
            : undefined;
          const r = await registerDocument(tx, {
            tenantId,
            caseId,
            filename: safeFilename(f.name),
            mimeType: detected,
            sizeBytes: bytes.length,
            sha256: sha,
            storageKey: key,
            replacesDocumentId: existing?.id,
            replacedReason: existing ? `Updated in ${provider.label}` : undefined,
            source: 'connector',
            sourceRef: `${conn.provider}:${f.id}`,
            userId: null,
          });
          const docId = r.duplicate ? r.document_id : r.document.id;
          await tx.query(
            `insert into connector_items (tenant_id, connection_id, remote_id, case_id, remote_modified, remote_checksum, document_id)
             values ($1,$2,$3,$4,$5,$6,$7)
             on conflict (connection_id, remote_id, case_id) do update
               set remote_modified = excluded.remote_modified, remote_checksum = excluded.remote_checksum,
                   document_id = excluded.document_id, imported_at = now()`,
            [tenantId, connectionId, f.id, caseId, f.modifiedTime, f.checksum, docId],
          );
        });
        imported++;
      }
      pageToken = page.nextPageToken;
      await saveState();
      await heartbeat();
    } while (pageToken);

    await ctx.db.tenant(tenantId, async (tx) => {
      await tx.query(`update connections set last_sync_at = now(), sync_state = $2, last_error = null where id = $1`, [
        connectionId,
        JSON.stringify({ case_id: caseId, imported, skipped, completed_at: new Date().toISOString() }),
      ]);
      await recordAudit(tx, {
        tenantId,
        actor: { type: 'system', id: 'connector' },
        action: 'connection.synced',
        resourceType: 'connection',
        resourceId: connectionId,
        details: { case_id: caseId, imported, skipped },
      });
    });
    return { imported, skipped };
  };
}

export async function connectionRoutes(app: FastifyInstance) {
  const { config, db, connectors: providers } = app.ctx;
  const redirectUri = (provider: string) => `${config.PUBLIC_API_URL}/v1/connections/${provider}/callback`;
  const webResult = (params: Record<string, string>) => `${config.WEB_URL}/admin/integrations?${new URLSearchParams(params)}`;

  route(app, {
    method: 'GET',
    url: '/v1/connections/providers',
    summary: 'Document repositories that can be connected',
    tags: ['integrations'],
    permission: 'admin:integrations',
    handler: async () => ({ items: [...providers.values()].map((p) => ({ id: p.id, label: p.label, scopes: p.scopes })) }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/connections/:provider/authorize',
    summary: 'Start connecting a document repository (OAuth Authorization Code with PKCE)',
    tags: ['integrations'],
    permission: 'admin:integrations',
    params: z.object({ provider: z.string().max(50) }),
    handler: async ({ params, auth, req, tx }) => {
      const provider = providers.get(params.provider);
      if (!provider) throw notFound('Provider');
      const state = randomToken(24);
      const { verifier, challenge } = pkcePair();
      await db.system((t) =>
        t.query('insert into connector_auth_flows (state, tenant_id, provider, code_verifier, created_by) values ($1,$2,$3,$4,$5)', [
          state,
          auth.tenantId,
          provider.id,
          verifier,
          auth.userId,
        ]),
      );
      await tx((t) => audit(t, req, { action: 'connection.authorize_started', resourceType: 'connection', resourceId: null, details: { provider: provider.id } }));
      return { authorization_url: provider.authorizationUrl({ state, codeChallenge: challenge, redirectUri: redirectUri(provider.id) }) };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/connections/:provider/callback',
    summary: 'OAuth redirect endpoint for repository connections',
    tags: ['integrations'],
    auth: 'none',
    params: z.object({ provider: z.string().max(50) }),
    query: z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }),
    handler: async ({ params, query, req, reply }) => {
      const provider = providers.get(params.provider);
      if (!provider || !query.state) return reply.redirect(webResult({ error: 'invalid_request' }), 302);
      const flow = await db.system((t) =>
        t.one<{ tenant_id: string; code_verifier: string; created_by: string | null; created_at: Date; provider: string }>(
          `update connector_auth_flows set consumed_at = now() where state = $1 and consumed_at is null returning *`,
          [query.state],
        ),
      );
      if (!flow || flow.provider !== provider.id || Date.now() - new Date(flow.created_at).getTime() > FLOW_TTL_MS) {
        return reply.redirect(webResult({ error: 'invalid_state' }), 302);
      }
      const actor = { type: 'user' as const, id: flow.created_by };
      if (query.error || !query.code) {
        await db.tenant(flow.tenant_id, (t) =>
          recordAudit(t, { tenantId: flow.tenant_id, actor, action: 'connection.consent_denied', resourceType: 'connection', resourceId: null, correlationId: req.id, details: { provider: provider.id, error: query.error ?? 'no_code' } }),
        );
        return reply.redirect(webResult({ error: query.error === 'access_denied' ? 'access_denied' : 'provider_error' }), 302);
      }
      let tokens: TokenSet;
      try {
        tokens = await provider.exchangeCode({ code: query.code, codeVerifier: flow.code_verifier, redirectUri: redirectUri(provider.id) });
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'connector code exchange failed');
        return reply.redirect(webResult({ error: 'token_exchange_failed' }), 302);
      }
      const label = await provider.accountLabel(tokens.access_token).catch(() => null);
      const id = await db.tenant(flow.tenant_id, async (t) => {
        const row = await t.one<{ id: string }>(
          `insert into connections (tenant_id, provider, status, account_label, created_by) values ($1,$2,'pending',$3,$4) returning id`,
          [flow.tenant_id, provider.id, label, flow.created_by],
        );
        await storeTokens(t, app.ctx, row!.id, tokens, null);
        await recordAudit(t, {
          tenantId: flow.tenant_id,
          actor,
          action: 'connection.created',
          resourceType: 'connection',
          resourceId: row!.id,
          correlationId: req.id,
          details: { provider: provider.id, scopes: tokens.scope ?? null },
        });
        return row!.id;
      });
      return reply.redirect(webResult({ connected: provider.id, connection: id }), 302);
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/connections',
    summary: 'Connected repositories',
    tags: ['integrations'],
    handler: async ({ auth, tx }) => ({
      items: await tx(async (t) => {
        if (!auth.permissions.has('admin:integrations') && !auth.permissions.has('document:upload')) throw forbidden();
        return t.many(`select ${PUBLIC_COLUMNS}, (select count(*)::int from connector_items i where i.connection_id = c.id) as imported_files
                  from connections c order by created_at desc`);
      }),
    }),
  });

  async function activeConnection(t: Tx, id: string) {
    const c = await t.one<ConnectionRow>('select * from connections where id = $1', [id]);
    if (!c) throw notFound('Connection');
    if (c.status === 'revoked') throw conflict('This connection was revoked.');
    if (c.status === 'expired') throw conflict('This connection needs to be authorized again.', { code: 'reauthorization_required' });
    const provider = providers.get(c.provider);
    if (!provider) throw conflict('This provider is not configured.');
    return { c, provider };
  }

  route(app, {
    method: 'GET',
    url: '/v1/connections/:id/files',
    summary: 'Browse files in a connected repository',
    tags: ['integrations'],
    permission: 'document:upload',
    params: uuidParam,
    query: z.object({ page_token: z.string().max(500).optional() }),
    handler: async ({ params, query, auth, tx }) => {
      const { c, provider } = await tx((t) => activeConnection(t, params.id));
      try {
        const page = await withAccessToken(app.ctx, provider, auth.tenantId, c.id, (token) => provider.listFiles(token, query.page_token));
        return { items: page.files.map((f) => ({ ...f, supported: isSupportedMime(f.mimeType) })), next_page_token: page.nextPageToken };
      } catch (err) {
        if (err instanceof PermanentJobError) throw conflict(err.message, { code: err.type });
        throw err;
      }
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/connections/:id/sync',
    summary: 'Import repository files into a case (incremental, runs in the background)',
    tags: ['integrations'],
    permission: 'document:upload',
    status: 202,
    params: uuidParam,
    body: z.object({ case_id: z.uuid(), file_ids: z.array(z.string().max(200)).max(500).optional() }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const { c } = await activeConnection(t, params.id);
        const kase = await getVisibleCase(t, auth, body.case_id);
        if (isClosed(kase)) throw unprocessable('case_closed', 'Files cannot be imported into a closed case.');
        const job = await enqueue(t, {
          tenantId: auth.tenantId,
          kind: SYNC_JOB,
          payload: { connection_id: c.id, case_id: kase.id, file_ids: body.file_ids },
          dedupeKey: `sync:${c.id}:${kase.id}`,
          resource: { type: 'connection', id: c.id },
          createdBy: auth.userId,
        });
        await audit(t, req, { action: 'connection.sync_requested', resourceType: 'connection', resourceId: c.id, details: { case_id: kase.id, job_id: job.id, files: body.file_ids?.length ?? 'all' } });
        return { job_id: job.id };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/connections/:id/revoke',
    summary: 'Disconnect a repository: revokes provider tokens and stops future imports',
    tags: ['integrations'],
    permission: 'admin:integrations',
    params: uuidParam,
    handler: async ({ params, auth, req, tx }) => {
      const c = await tx((t) => t.one<ConnectionRow>('select * from connections where id = $1', [params.id]));
      if (!c) throw notFound('Connection');
      if (c.status === 'revoked') throw conflict('The connection is already revoked.');
      const provider = providers.get(c.provider);
      const k = keyFor(app.ctx);
      let providerRevoked = false;
      if (provider) {
        for (const [enc, kind] of [[c.refresh_token_enc, 'refresh'], [c.access_token_enc, 'access']] as const) {
          if (!enc) continue;
          try {
            await provider.revoke(decrypt(k, enc, `${c.id}:${kind}`));
            providerRevoked = true;
          } catch (err) {
            req.log.warn({ err: (err as Error).message }, 'provider token revocation failed');
          }
        }
      }
      return tx(async (t) => {
        const row = await t.one(
          `update connections set status = 'revoked', access_token_enc = null, refresh_token_enc = null, expires_at = null,
                  revoked_at = now(), revoked_by = $2 where id = $1 returning ${PUBLIC_COLUMNS}`,
          [c.id, auth.userId],
        );
        // cancel queued imports for this connection
        await t.query(`update jobs set status = 'failed', last_error = '{"type":"connection_revoked","message":"Connection revoked"}', finished_at = now()
                        where kind = $1 and status = 'queued' and payload->>'connection_id' = $2`, [SYNC_JOB, c.id]);
        await emitEvent(t, { tenantId: auth.tenantId, type: 'connection.revoked', resource: { type: 'connection', id: c.id }, data: { provider: c.provider }, correlationId: req.id });
        await audit(t, req, { action: 'connection.revoked', resourceType: 'connection', resourceId: c.id, details: { provider: c.provider, provider_revoked: providerRevoked } });
        return row;
      });
    },
  });
}
