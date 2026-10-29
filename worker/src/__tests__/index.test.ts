import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('vat lookup: dataset, FIA fallback, and what gets cached', () => {
  const TSMC = { businessNm: '台灣積體電路製造股份有限公司', isUseInvoice: 'Y' };
  // SHARDS=256 puts 22099131 in shard 216 (the shared shard vector).
  const SHARD = 'data-1/shards/216.json';
  const r2obj = (v: unknown) => ({ json: () => Promise.resolve(v) });
  /** An R2 binding serving `objects` by key; a missing key reads as absent. */
  const bucket = (objects: Record<string, unknown>) =>
    ({ get: (k: string) => Promise.resolve(k in objects ? r2obj(objects[k]) : null) }) as unknown as R2Bucket;
  const published = (rows: unknown[]) =>
    bucket({ 'latest.json': { latest: 'data-1' }, [SHARD]: rows });
  const failing = { get: () => Promise.reject(new Error('R2 internal error')) } as unknown as R2Bucket;

  const put = vi.fn(() => Promise.resolve());
  const fia = (impl: () => Promise<Response>) => {
    const f = vi.fn(impl);
    vi.stubGlobal('fetch', f);
    return f;
  };
  const lookup = (bkt?: R2Bucket) =>
    worker.fetch(
      new Request('https://w/v1/vat/22099131', { headers: { Origin: 'https://a.example' } }),
      { ...env, SHARDS: '256', UBN_BUCKET: bkt },
      ctx,
    );

  beforeEach(() => {
    vi.stubGlobal('caches', { default: { match: () => Promise.resolve(undefined), put } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    put.mockClear();
  });

  it('answers a dataset hit from R2 without calling FIA, and caches it', async () => {
    const f = fia(() => Promise.resolve(Response.json(TSMC)));
    const res = await lookup(published([{ ban: '22099131', name: '台積電', useInvoice: true }]));
    expect(await res.json()).toMatchObject({ found: true, name: '台積電', source: 'dataset' });
    expect(f).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('falls back to FIA on a dataset miss and caches the hit', async () => {
    fia(() => Promise.resolve(Response.json(TSMC)));
    const res = await lookup(published([{ ban: '87003412', name: '其他' }]));
    expect(await res.json()).toMatchObject({ found: true, source: 'fia-api' });
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=/);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('caches found:false when the dataset misses cleanly and FIA says 404', async () => {
    fia(() => Promise.resolve(new Response(null, { status: 404 })));
    const res = await lookup(published([]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false, ban: '22099131' });
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=/);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('caches found:false in FIA-only mode (no bucket bound) on a FIA 404', async () => {
    fia(() => Promise.resolve(new Response(null, { status: 404 })));
    const res = await lookup(undefined);
    expect(await res.json()).toEqual({ found: false, ban: '22099131' });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('answers 502, uncached, when FIA returns a 5xx', async () => {
    fia(() => Promise.resolve(new Response('busy', { status: 503 })));
    const res = await lookup(published([]));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ found: null, ban: '22099131', error: 'upstream_unavailable' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://a.example');
    expect(put).not.toHaveBeenCalled();
  });

  it('answers 502, uncached, when FIA is unreachable', async () => {
    fia(() => Promise.reject(new Error('network error')));
    const res = await lookup(published([]));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ found: null, error: 'upstream_unavailable' });
    expect(put).not.toHaveBeenCalled();
  });

  it('answers 502 when both R2 and FIA fail', async () => {
    fia(() => Promise.reject(new Error('network error')));
    const res = await lookup(failing);
    expect(res.status).toBe(502);
    expect(put).not.toHaveBeenCalled();
  });

  it('returns but does not cache found:false when R2 errored and FIA says 404', async () => {
    fia(() => Promise.resolve(new Response(null, { status: 404 })));
    const res = await lookup(failing);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false, ban: '22099131' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(put).not.toHaveBeenCalled();
  });

  it('does not cache a FIA 404 while the bound bucket has no latest.json yet', async () => {
    fia(() => Promise.resolve(new Response(null, { status: 404 })));
    const res = await lookup(bucket({}));
    expect(await res.json()).toEqual({ found: false, ban: '22099131' });
    expect(put).not.toHaveBeenCalled();
  });

  it('still caches a FIA hit taken while R2 errored (the answer is authoritative)', async () => {
    fia(() => Promise.resolve(Response.json(TSMC)));
    const res = await lookup(failing);
    expect(await res.json()).toMatchObject({ found: true, source: 'fia-api' });
    expect(put).toHaveBeenCalledTimes(1);
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
