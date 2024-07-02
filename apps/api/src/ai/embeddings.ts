import { createHash } from 'node:crypto';
import type { Config } from '../config';
import { RetryableJobError } from '../modules/jobs/errors';
import { terms } from './text';

export interface EmbeddingProvider {
  /** Stored with every vector; queries only compare vectors from the same model. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

function bucket(feature: string, dims: number): [number, number] {
  const h = createHash('md5').update(feature).digest();
  return [h.readUInt32LE(0) % dims, h[4]! & 1 ? 1 : -1];
}

/**
 * Deterministic feature-hashing embedding over stemmed unigrams and bigrams. Not a
 * neural model, but stable, offline and good enough to exercise semantic retrieval
 * in development and tests.
 */
export class HashingEmbedding implements EmbeddingProvider {
  readonly model = 'fingraph-hash-384-v1';
  readonly dimensions = 384;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dimensions).fill(0);
      const ts = terms(t);
      const features = [...ts, ...ts.slice(1).map((w, i) => `${ts[i]}_${w}`)];
      for (const f of features) {
        const [i, sign] = bucket(f, this.dimensions);
        v[i]! += sign * (f.includes('_') ? 0.5 : 1);
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
    });
  }
}

/** Voyage AI embeddings (HTTP API). */
export class VoyageEmbedding implements EmbeddingProvider {
  readonly dimensions = 1024;
  constructor(
    private readonly apiKey: string,
    readonly model = 'voyage-3.5',
  ) {}

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: texts.slice(i, i + 64), model: this.model, input_type: kind }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) throw new RetryableJobError('embedding_unavailable', `voyage ${res.status}`);
      if (!res.ok) throw new Error(`voyage embeddings failed: ${res.status}`);
      const body = (await res.json()) as { data: { embedding: number[] }[] };
      out.push(...body.data.map((d) => d.embedding));
    }
    return out;
  }
}

export function createEmbeddings(config: Config): EmbeddingProvider {
  if (config.EMBEDDING_PROVIDER === 'voyage') {
    if (!config.EMBEDDING_API_KEY) throw new Error('EMBEDDING_API_KEY is required for voyage embeddings');
    return new VoyageEmbedding(config.EMBEDDING_API_KEY);
  }
  return new HashingEmbedding();
}

export const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;
