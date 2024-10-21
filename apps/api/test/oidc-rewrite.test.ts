import { describe, expect, it } from 'vitest';
import { OidcClient } from '../src/modules/identity/oidc';

describe('OIDC internal URL rewriting', () => {
  it('fetches discovery from the internal address but validates the public issuer', async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ issuer: 'http://localhost:4100', authorization_endpoint: 'http://localhost:4100/authorize', token_endpoint: 'http://localhost:4100/token', jwks_uri: 'http://localhost:4100/jwks' }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const c = new OidcClient(fakeFetch, { from: 'http://localhost:4100', to: 'http://sandbox:4100' });
    const d = await c.discover('http://localhost:4100');
    expect(seen).toEqual(['http://sandbox:4100/.well-known/openid-configuration']);
    // the browser still goes to the public authorize endpoint
    expect(d.authorization_endpoint).toBe('http://localhost:4100/authorize');
  });
});
