import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ config: { RATE_LIMIT_PER_MINUTE: '5' } });
});
afterAll(() => env.close());

describe('rate limiting', () => {
  it('returns 429 with retry-after once the limit is exceeded', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await env.app.inject({ method: 'GET', url: '/v1/auth/session' });
      codes.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        expect(res.json().code).toBe('rate_limited');
      }
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('never limits health probes', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await env.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
  });
});
