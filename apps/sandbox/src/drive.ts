import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { extraFixtures, northwindFixtures } from '@fingraph/fixtures';
import type { SandboxState } from './state';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number;
  md5Checksum: string;
  bytes: Buffer;
}

/**
 * A tiny OAuth-protected document repository modeled on cloud drive APIs. Every
 * sandbox user sees the same synthetic KYB files.
 */
export async function registerDrive(app: FastifyInstance, state: SandboxState) {
  const files = new Map<string, DriveFile>();
  const all = [...(await northwindFixtures()), ...(await extraFixtures())].filter((f) => f.key !== 'letter');
  const base = Date.now() - 3 * 86_400_000;
  all.forEach((f, i) => {
    files.set(`f-${f.key}`, {
      id: `f-${f.key}`,
      name: f.filename,
      mimeType: f.mime,
      modifiedTime: new Date(base + i * 60_000).toISOString(),
      size: f.bytes.length,
      md5Checksum: createHash('md5').update(f.bytes).digest('hex'),
      bytes: f.bytes,
    });
  });
  state.driveFiles = files;

  const authorize = (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const t = state.resolveAccessToken(token);
    if (!t) {
      reply.code(401).send({ error: { code: 401, message: 'Invalid or expired access token' } });
      return null;
    }
    if (!t.scope.split(' ').includes('drive.readonly')) {
      reply.code(403).send({ error: { code: 403, message: 'Insufficient scope' } });
      return null;
    }
    return t;
  };

  app.get('/drive/v1/files', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const q = req.query as { page_token?: string; page_size?: string };
    const size = Math.min(100, Math.max(1, Number(q.page_size ?? 4)));
    const offset = q.page_token ? Number(Buffer.from(q.page_token, 'base64url').toString()) : 0;
    const list = [...files.values()].sort((a, b) => a.id.localeCompare(b.id));
    const page = list.slice(offset, offset + size).map(({ bytes: _b, ...meta }) => meta);
    const next = offset + size < list.length ? Buffer.from(String(offset + size)).toString('base64url') : null;
    return { files: page, next_page_token: next };
  });

  app.get('/drive/v1/files/:id/content', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const f = files.get((req.params as { id: string }).id);
    if (!f) return reply.code(404).send({ error: { code: 404, message: 'File not found' } });
    return reply.header('content-type', f.mimeType).send(f.bytes);
  });

  // Test helper: simulate a file being edited in the repository.
  app.post('/drive/v1/_sandbox/touch/:id', async (req, reply) => {
    const f = files.get((req.params as { id: string }).id);
    if (!f) return reply.code(404).send({});
    f.bytes = Buffer.concat([f.bytes, Buffer.from(`\n% edited ${Date.now()}\n`)]);
    f.size = f.bytes.length;
    f.md5Checksum = createHash('md5').update(f.bytes).digest('hex');
    f.modifiedTime = new Date().toISOString();
    return { id: f.id, modifiedTime: f.modifiedTime };
  });
}
