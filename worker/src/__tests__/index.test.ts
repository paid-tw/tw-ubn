import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../index';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const env: Env = { ALLOWED_ORIGINS: 'https://a.example,https://b.example' };

// A response cached by an allowed origin still carries its CORS headers.
const cacheHit = (origin: string) =>
  vi.stubGlobal('caches', {
    default: {
      match: () =>
        Promise.resolve(
          new Response('{"found":true}', { headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } }),
        ),
      put: () => Promise.resolve(),
    },
  });
const get = (origin: string) =>
  worker.fetch(new Request('https://w/v1/vat/22099131', { headers: { Origin: origin } }), env, ctx);

afterEach(() => vi.unstubAllGlobals());

describe('CORS on a cache hit', () => {
  it("does not hand a disallowed origin another origin's allow header", async () => {
    cacheHit('https://a.example');
    const res = await get('https://evil.example');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toBeNull();
  });

  it('rewrites the allow header for a different allowed origin', async () => {
    cacheHit('https://a.example');
    const res = await get('https://b.example');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://b.example');
    expect(res.headers.get('Vary')).toBe('Origin');
  });
});

describe('cache is populated CORS-free', () => {
  it('stores the response without any origin allow header', async () => {
    const put = vi.fn(() => Promise.resolve());
    vi.stubGlobal('caches', { default: { match: () => Promise.resolve(undefined), put } });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ businessNm: '台灣積體電路製造股份有限公司', isUseInvoice: 'Y' }))),
    );
    const res = await get('https://a.example');
    // The caller still gets its own CORS header…
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://a.example');
    // …but the shared cache entry carries none, so it can't leak to others.
    const stored = (put.mock.calls[0] as unknown[])[1] as Response;
    expect(stored.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(stored.headers.get('Vary')).toBeNull();
  });
});
