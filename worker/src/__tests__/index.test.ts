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
  /** Route fetch by host: FIA answers with `impl`, GCIS with `gcis` (default `[]`). */
  const fia = (impl: () => Promise<Response>, gcis: () => Promise<Response> = () => Promise.resolve(Response.json([]))) => {
    const f = vi.fn((input: RequestInfo | URL) => (String(input).includes('data.gcis.nat.gov.tw') ? gcis() : impl()));
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

  it('answers 502, uncached, when FIA returns 200 with a non-JSON body', async () => {
    fia(() => Promise.resolve(new Response('<html>maintenance</html>', { status: 200 })));
    const res = await lookup(published([]));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ found: null, ban: '22099131', error: 'upstream_unavailable' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://a.example');
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

  describe('GCIS fallback after a FIA 404', () => {
    const FIA_404 = () => Promise.resolve(new Response(null, { status: 404 }));
    // Field names as returned live by GCIS on 2026-10-29.
    const dissolved = {
      Business_Accounting_NO: '22099131',
      Company_Status_Desc: '解散',
      Company_Name: '鑫晶生物科技有限公司',
      Company_Location: '臺北市大同區市民大道1段209號10樓',
      Revoke_App_Date: '1141124',
    };

    it('answers a dissolved company as closed, with its termination date, and caches it', async () => {
      const f = fia(FIA_404, () => Promise.resolve(Response.json([dissolved])));
      const res = await lookup(published([]));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        found: true,
        ban: '22099131',
        name: '鑫晶生物科技有限公司',
        address: '臺北市大同區市民大道1段209號10樓',
        source: 'gcis',
        companyStatus: '解散',
        status: 'closed',
        closedDate: '2025-11-24',
      });
      expect(put).toHaveBeenCalledTimes(1);
      const gcisUrl = String(f.mock.calls[1][0]);
      expect(gcisUrl).toContain('5F64D864-61CB-4D0D-8AD9-492047CC1EA6');
      expect(decodeURIComponent(gcisUrl)).toContain('Business_Accounting_NO eq 22099131');
    });

    it('answers a live company with its name but no tax status', async () => {
      fia(FIA_404, () =>
        Promise.resolve(Response.json([{ ...dissolved, Company_Status_Desc: '核准設立', Revoke_App_Date: '' }])),
      );
      const res = await lookup(published([]));
      const body = await res.json();
      expect(body).toMatchObject({ found: true, source: 'gcis', companyStatus: '核准設立', closedDate: null });
      expect(body).not.toHaveProperty('status');
    });

    it('does not consult GCIS when FIA found the ban', async () => {
      const f = fia(() => Promise.resolve(Response.json(TSMC)));
      await lookup(published([]));
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('keeps a cacheable found:false when GCIS returns an empty array', async () => {
      fia(FIA_404, () => Promise.resolve(Response.json([])));
      const res = await lookup(published([]));
      expect(await res.json()).toEqual({ found: false, ban: '22099131' });
      expect(put).toHaveBeenCalledTimes(1);
    });

    const unavailable: [string, () => Promise<Response>][] = [
      ['an HTTP error', () => Promise.resolve(new Response('oops', { status: 500 }))],
      ['a network error', () => Promise.reject(new Error('network error'))],
      ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
      ['HTTP 200 with a non-JSON body', () => Promise.resolve(new Response('<html>busy</html>', { status: 200 }))],
      ['HTTP 200 with a non-array JSON body', () => Promise.resolve(Response.json({ error: 'x' }))],
    ];
    for (const [what, gcis] of unavailable) {
      it(`returns found:false uncached (not a 502) on ${what}`, async () => {
        fia(FIA_404, gcis);
        const res = await lookup(published([]));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ found: false, ban: '22099131' });
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(put).not.toHaveBeenCalled();
      });
    }

    // GCIS's live "no such company" (HTTP 200, Content-Length: 0), which is
    // also its reported outage mode: cached, but only for NEGATIVE_CACHE_TTL.
    const EMPTY_200 = () => Promise.resolve(new Response('', { status: 200 }));

    it('caches found:false briefly (default 3600 s) when GCIS returns an empty body', async () => {
      fia(FIA_404, EMPTY_200);
      const res = await lookup(published([]));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ found: false, ban: '22099131' });
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
      expect(put).toHaveBeenCalledTimes(1);
    });

    it('honours NEGATIVE_CACHE_TTL, capped at CACHE_TTL', async () => {
      fia(FIA_404, EMPTY_200);
      const bkt = published([]);
      const get = (vars: Partial<Env>) =>
        worker.fetch(new Request('https://w/v1/vat/22099131'), { ...env, SHARDS: '256', UBN_BUCKET: bkt, ...vars }, ctx);
      expect((await get({ NEGATIVE_CACHE_TTL: '600' })).headers.get('Cache-Control')).toBe('public, max-age=600');
      expect((await get({ CACHE_TTL: '300' })).headers.get('Cache-Control')).toBe('public, max-age=300');
    });

    it('does not cache an empty GCIS body while R2 errored', async () => {
      fia(FIA_404, EMPTY_200);
      const res = await lookup(failing);
      expect(await res.json()).toEqual({ found: false, ban: '22099131' });
      expect(put).not.toHaveBeenCalled();
    });

    it('does not cache a GCIS hit while R2 errored (the dataset might carry the ban)', async () => {
      fia(FIA_404, () => Promise.resolve(Response.json([dissolved])));
      const res = await lookup(failing);
      expect(await res.json()).toMatchObject({ found: true, source: 'gcis', status: 'closed' });
      expect(put).not.toHaveBeenCalled();
    });
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
