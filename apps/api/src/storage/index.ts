import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config';
import { deriveKey } from '../lib/crypto';

export interface ObjectStorage {
  readonly driver: 'local' | 's3' | 'memory';
  put(key: string, data: Buffer, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const MAGIC = Buffer.from('FGE1');

/**
 * Envelope encryption: each object gets a random data key (AES-256-GCM); the data key
 * is wrapped with the storage key-encryption key. The object key is bound as AAD so
 * ciphertext cannot be swapped between objects.
 */
export class Envelope {
  constructor(private readonly kek: Buffer) {}

  seal(key: string, plaintext: Buffer): Buffer {
    const dek = randomBytes(32);
    const wrapIv = randomBytes(12);
    const wrap = createCipheriv('aes-256-gcm', this.kek, wrapIv);
    wrap.setAAD(Buffer.from(`dek:${key}`));
    const wrapped = Buffer.concat([wrap.update(dek), wrap.final()]);
    const wrapTag = wrap.getAuthTag();

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(Buffer.from(key));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, wrapIv, wrapTag, wrapped, iv, tag, ct]);
  }

  open(key: string, blob: Buffer): Buffer {
    if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error('object is not encrypted with a supported envelope');
    let o = 4;
    const take = (n: number) => blob.subarray(o, (o += n));
    const wrapIv = take(12);
    const wrapTag = take(16);
    const wrapped = take(32);
    const iv = take(12);
    const tag = take(16);
    const ct = blob.subarray(o);
    const unwrap = createDecipheriv('aes-256-gcm', this.kek, wrapIv);
    unwrap.setAAD(Buffer.from(`dek:${key}`));
    unwrap.setAuthTag(wrapTag);
    const dek = Buffer.concat([unwrap.update(wrapped), unwrap.final()]);
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

function assertKey(key: string) {
  if (!/^[A-Za-z0-9/_.-]{1,512}$/.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new Error(`invalid storage key: ${key}`);
  }
}

/** Encrypted files on local disk. Writes are atomic (temp file + rename). */
export class LocalStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  constructor(
    private readonly root: string,
    private readonly envelope: Envelope,
  ) {}

  private file(key: string) {
    assertKey(key);
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, this.envelope.seal(key, data), { mode: 0o600 });
    await rename(tmp, f);
  }

  async get(key: string) {
    return this.envelope.open(key, await readFile(this.file(key)));
  }

  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }

  async exists(key: string) {
    try {
      await stat(this.file(key));
      return true;
    } catch {
      return false;
    }
  }
}

/** In-memory storage (still encrypted) for tests. */
export class MemoryStorage implements ObjectStorage {
  readonly driver = 'memory' as const;
  readonly objects = new Map<string, Buffer>();
  constructor(private readonly envelope: Envelope) {}

  async put(key: string, data: Buffer) {
    assertKey(key);
    this.objects.set(key, this.envelope.seal(key, data));
  }
  async get(key: string) {
    const blob = this.objects.get(key);
    if (!blob) throw Object.assign(new Error(`object not found: ${key}`), { code: 'ENOENT' });
    return this.envelope.open(key, blob);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
}

/**
 * S3-compatible storage. Objects are envelope-encrypted client side and stored with
 * SSE-KMS (or SSE-S3 when no key is configured) as a second layer.
 */
export class S3Storage implements ObjectStorage {
  readonly driver = 's3' as const;
  private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client>;

  constructor(
    private readonly bucket: string,
    private readonly envelope: Envelope,
    opts: { region?: string; endpoint?: string; kmsKeyId?: string },
  ) {
    this.kmsKeyId = opts.kmsKeyId;
    this.clientPromise = import('@aws-sdk/client-s3').then(
      ({ S3Client }) =>
        new S3Client({ region: opts.region ?? 'us-east-1', endpoint: opts.endpoint, forcePathStyle: !!opts.endpoint }),
    );
  }
  private kmsKeyId?: string;

  async put(key: string, data: Buffer, opts?: { contentType?: string }) {
    assertKey(key);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientPromise;
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: this.envelope.seal(key, data),
        ContentType: 'application/octet-stream',
        Metadata: opts?.contentType ? { 'original-content-type': opts.contentType } : undefined,
        ServerSideEncryption: this.kmsKeyId ? 'aws:kms' : 'AES256',
        SSEKMSKeyId: this.kmsKeyId,
      }),
    );
  }

  async get(key: string) {
    assertKey(key);
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientPromise;
    const res = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return this.envelope.open(key, Buffer.from(bytes));
  }

  async delete(key: string) {
    assertKey(key);
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientPromise;
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string) {
    assertKey(key);
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientPromise;
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

export function createStorage(config: Config): ObjectStorage {
  const envelope = new Envelope(deriveKey(config.APP_SECRET, 'storage-kek'));
  if (config.NODE_ENV === 'test') return new MemoryStorage(envelope);
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET) throw new Error('S3_BUCKET is required for the s3 storage driver');
    return new S3Storage(config.S3_BUCKET, envelope, {
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      kmsKeyId: config.S3_KMS_KEY_ID,
    });
  }
  return new LocalStorage(path.resolve(config.STORAGE_LOCAL_DIR), envelope);
}
