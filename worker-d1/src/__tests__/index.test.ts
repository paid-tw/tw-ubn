import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../index';

// A D1 binding whose every query fails like an unloaded database does.
const noTableDb = {
  prepare: () => ({
    bind: () => ({
      first: () => Promise.reject(new Error('D1_ERROR: no such table: ubn')),
      all: () => Promise.reject(new Error('D1_ERROR: no such table: ubn')),
    }),
  }),
} as unknown as D1Database;

const env: Env = { UBN_DB: noTableDb };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const put = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.stubGlobal('caches', { default: { match: () => Promise.resolve(undefined), put } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  put.mockClear();
});

describe('worker-d1 before the dataset is loaded', () => {
  it('falls back to FIA when the ubn table is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ businessNm: '台灣積體電路製造股份有限公司', isUseInvoice: 'Y' }))),
    );
    const res = await worker.fetch(new Request('https://w/v1/vat/22099131'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ found: true, name: '台灣積體電路製造股份有限公司', source: 'fia-api' });
  });

  it('returns an empty, uncached search when D1 fails', async () => {
    const res = await worker.fetch(new Request('https://w/v1/search?name=台灣積體'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: '台灣積體', count: 0, results: [] });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(put).not.toHaveBeenCalled();
  });

  it('answers 502 (not a 1101) when D1 is empty and the FIA fallback is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network error'))),
    );
    const res = await worker.fetch(new Request('https://w/v1/vat/22099131'), env, ctx);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ found: null, ban: '22099131', error: 'upstream_unavailable' });
  });

  it('caches a FIA hit taken while D1 is empty (the answer is authoritative)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ businessNm: '台灣積體電路製造股份有限公司', isUseInvoice: 'Y' }))),
    );
    const res = await worker.fetch(new Request('https://w/v1/vat/22099131'), env, ctx);
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=/);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('does not cache the 502 taken while D1 is empty and FIA is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network error'))),
    );
    const res = await worker.fetch(new Request('https://w/v1/vat/22099131'), env, ctx);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(put).not.toHaveBeenCalled();
  });

  it('does not cache a FIA 404 while D1 is empty (ban may be in the unloaded set)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );
    const res = await worker.fetch(new Request('https://w/v1/vat/22099131'), env, ctx);
    expect(await res.json()).toMatchObject({ found: false, ban: '22099131' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(put).not.toHaveBeenCalled();
  });

  it('still caches a genuine miss once D1 is loaded (clean miss + FIA 404)', async () => {
    // A loaded D1 that answers "no such ban" is authoritative; with FIA also
    // 404, found:false is real and should be cached as before.
    const loadedEmptyDb = {
      prepare: () => ({ bind: () => ({ first: () => Promise.resolve(null), all: () => Promise.resolve({ results: [] }) }) }),
    } as unknown as D1Database;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );
    const res = await worker.fetch(new Request('https://w/v1/vat/22099131'), { UBN_DB: loadedEmptyDb }, ctx);
    expect(await res.json()).toMatchObject({ found: false, ban: '22099131' });
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=/);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe('vat lookup with D1 loaded', () => {
  const TSMC = { businessNm: '台灣積體電路製造股份有限公司', isUseInvoice: 'Y' };
  /** A loaded D1 whose `ubn` lookup returns `row` (null for a clean miss). */
  const loaded = (row: Record<string, unknown> | null): Env => ({
    UBN_DB: { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(row) }) }) } as unknown as D1Database,
    ALLOWED_ORIGINS: 'https://a.example',
  });
  const fia = (impl: () => Promise<Response>) => {
    const f = vi.fn(impl);
    vi.stubGlobal('fetch', f);
    return f;
  };
  const lookup = (e: Env) =>
    worker.fetch(new Request('https://w/v1/vat/22099131', { headers: { Origin: 'https://a.example' } }), e, ctx);

  it('answers a dataset hit from D1 without calling FIA, and caches it', async () => {
    const f = fia(() => Promise.resolve(Response.json(TSMC)));
    const res = await lookup(loaded({ ban: '22099131', name: '台積電', use_invoice: 1, status: 'active' }));
    expect(await res.json()).toMatchObject({ found: true, name: '台積電', status: 'active', source: 'dataset' });
    expect(f).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('falls back to FIA on a D1 miss and caches the hit', async () => {
    fia(() => Promise.resolve(Response.json(TSMC)));
    const res = await lookup(loaded(null));
    expect(await res.json()).toMatchObject({ found: true, source: 'fia-api' });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('answers 502, uncached, when FIA returns a 5xx', async () => {
    fia(() => Promise.resolve(new Response('busy', { status: 503 })));
    const res = await lookup(loaded(null));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ found: null, ban: '22099131', error: 'upstream_unavailable' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://a.example');
    expect(put).not.toHaveBeenCalled();
  });

  it('answers 502, uncached, when FIA is unreachable', async () => {
    fia(() => Promise.reject(new Error('network error')));
    const res = await lookup(loaded(null));
    expect(res.status).toBe(502);
    expect(put).not.toHaveBeenCalled();
  });

  it('answers 502, uncached, when FIA returns 200 with a non-JSON body', async () => {
    fia(() => Promise.resolve(new Response('<html>maintenance</html>', { status: 200 })));
    const res = await lookup(loaded(null));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ found: null, ban: '22099131', error: 'upstream_unavailable' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://a.example');
    expect(put).not.toHaveBeenCalled();
  });
});

describe('CORS on a cache hit', () => {
  // A response cached by an allowed origin still carries its CORS headers.
  const cachedFor = (origin: string) =>
    new Response('{"found":true}', {
      headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' },
    });
  const allowlist: Env = { UBN_DB: noTableDb, ALLOWED_ORIGINS: 'https://a.example,https://b.example' };
  const get = (origin: string) =>
    worker.fetch(new Request('https://w/v1/vat/22099131', { headers: { Origin: origin } }), allowlist, ctx);

  it("does not hand a disallowed origin another origin's allow header", async () => {
    vi.stubGlobal('caches', { default: { match: () => Promise.resolve(cachedFor('https://a.example')), put } });
    const res = await get('https://evil.example');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toBeNull();
  });

  it('rewrites the allow header for a different allowed origin', async () => {
    vi.stubGlobal('caches', { default: { match: () => Promise.resolve(cachedFor('https://a.example')), put } });
    const res = await get('https://b.example');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://b.example');
    expect(res.headers.get('Vary')).toBe('Origin');
  });
});

describe('cache is populated CORS-free', () => {
  const allowlist: Env = { UBN_DB: noTableDb, ALLOWED_ORIGINS: 'https://a.example,https://b.example' };

  it('stores the vat response without any origin allow header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ businessNm: '台灣積體電路製造股份有限公司', isUseInvoice: 'Y' }))),
    );
    const res = await worker.fetch(
      new Request('https://w/v1/vat/22099131', { headers: { Origin: 'https://a.example' } }),
      allowlist,
      ctx,
    );
    // The caller still gets its own CORS header…
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://a.example');
    // …but the shared cache entry carries none, so it can't leak to others.
    const stored = (put.mock.calls[0] as unknown[])[1] as Response;
    expect(stored.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(stored.headers.get('Vary')).toBeNull();
  });
});
