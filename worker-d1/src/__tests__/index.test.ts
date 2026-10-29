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

/** Route fetch by host: FIA answers with `fia`, GCIS with `gcis` (default `[]`). */
const upstream = (fia: () => Promise<Response>, gcis: () => Promise<Response> = () => Promise.resolve(Response.json([]))) => {
  const f = vi.fn((input: RequestInfo | URL) => (String(input).includes('data.gcis.nat.gov.tw') ? gcis() : fia()));
  vi.stubGlobal('fetch', f);
  return f;
};

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
    upstream(() => Promise.resolve(new Response(null, { status: 404 })));
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
  const fia = upstream;
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
      const res = await lookup(loaded(null));
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
      const res = await lookup(loaded(null));
      const body = await res.json();
      expect(body).toMatchObject({ found: true, source: 'gcis', companyStatus: '核准設立', closedDate: null });
      expect(body).not.toHaveProperty('status');
    });

    it('does not consult GCIS when FIA found the ban', async () => {
      const f = fia(() => Promise.resolve(Response.json(TSMC)));
      await lookup(loaded(null));
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('keeps a cacheable found:false when GCIS returns an empty array', async () => {
      fia(FIA_404, () => Promise.resolve(Response.json([])));
      const res = await lookup(loaded(null));
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
        const res = await lookup(loaded(null));
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
      const res = await lookup(loaded(null));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ found: false, ban: '22099131' });
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
      expect(put).toHaveBeenCalledTimes(1);
    });

    it('honours NEGATIVE_CACHE_TTL, capped at CACHE_TTL', async () => {
      fia(FIA_404, EMPTY_200);
      const ttlOf = async (vars: Partial<Env>) =>
        (await lookup({ ...loaded(null), ...vars })).headers.get('Cache-Control');
      expect(await ttlOf({ NEGATIVE_CACHE_TTL: '600' })).toBe('public, max-age=600');
      expect(await ttlOf({ CACHE_TTL: '300' })).toBe('public, max-age=300');
    });

    it('does not cache an empty GCIS body while D1 errored', async () => {
      fia(FIA_404, EMPTY_200);
      const res = await lookup({ UBN_DB: noTableDb });
      expect(await res.json()).toEqual({ found: false, ban: '22099131' });
      expect(put).not.toHaveBeenCalled();
    });

    it('does not cache a GCIS hit while D1 errored (the dataset might carry the ban)', async () => {
      fia(FIA_404, () => Promise.resolve(Response.json([dissolved])));
      const res = await lookup({ UBN_DB: noTableDb });
      expect(await res.json()).toMatchObject({ found: true, source: 'gcis', status: 'closed' });
      expect(put).not.toHaveBeenCalled();
    });
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

describe('D1 row mapping', () => {
  /**
   * A D1 table holding `row`, with only `row`'s keys as columns: a query that
   * names any other column fails like D1 does ("no such column").
   */
  const rowDb = (row: Record<string, unknown>) =>
    ({
      prepare: (sql: string) => {
        const named = /^SELECT (.+) FROM/i.exec(sql)?.[1] ?? '*';
        const missing = named === '*' ? [] : named.split(',').map((c) => c.trim()).filter((c) => !(c in row));
        return {
          bind: () => ({
            first: () =>
              missing.length
                ? Promise.reject(new Error(`D1_ERROR: no such column: ${missing[0]}`))
                : Promise.resolve(row),
          }),
        };
      },
    }) as unknown as D1Database;

  const lookup = async (row: Record<string, unknown>) => {
    const fia = upstream(() => Promise.resolve(new Response(null, { status: 404 })));
    const res = await worker.fetch(new Request(`https://w/v1/vat/${row.ban}`), { UBN_DB: rowDb(row) }, ctx);
    return { body: (await res.json()) as Record<string, unknown>, fia };
  };

  it('passes kind through', async () => {
    const { body } = await lookup({
      ban: '00532072',
      name: '臺北市私立陽光森林麗湖幼兒園',
      address: '臺北市',
      use_invoice: 0,
      status: 'closed',
      kind: 'school',
      setup_date_iso: null,
    });
    expect(body).toMatchObject({ found: true, status: 'closed', kind: 'school', useInvoice: false, source: 'dataset' });
  });

  it('still answers from D1 when the table predates the kind column', async () => {
    // Worker deployed before the dataset workflow ran migrate.sql.
    const { body, fia } = await lookup({
      ban: '22099131',
      name: '台灣積體電路製造股份有限公司',
      address: '新竹市力行六路8號',
      use_invoice: 1,
      status: 'active',
      setup_date_iso: '1987-02-21',
    });
    expect(body).toMatchObject({ found: true, ban: '22099131', status: 'active', source: 'dataset' });
    expect('kind' in body).toBe(false);
    expect(fia).not.toHaveBeenCalled();
    expect('nameHasPrivateUse' in body).toBe(false);
  });

  it('passes the private-use flag through', async () => {
    const { body } = await lookup({
      ban: '02409186',
      name: '財團法人大三\u{F961C}慈惠寺',
      address: '臺中市',
      use_invoice: 0,
      status: 'active',
      kind: 'nonprofit',
      name_has_private_use: 1,
      setup_date_iso: null,
    });
    expect(body).toMatchObject({ found: true, kind: 'nonprofit', nameHasPrivateUse: true, source: 'dataset' });
  });

  it('omits the flag for unflagged and NULL rows', async () => {
    for (const flag of [0, null]) {
      const { body } = await lookup({ ban: '22099131', name: '台積電', use_invoice: 1, status: 'active', kind: null, name_has_private_use: flag });
      expect('nameHasPrivateUse' in body).toBe(false);
      expect('kind' in body).toBe(false);
    }
  });

  it('still answers from D1 when the table has kind but predates name_has_private_use', async () => {
    const { body, fia } = await lookup({
      ban: '00532072',
      name: '臺北市私立陽光森林麗湖幼兒園',
      use_invoice: 0,
      status: 'closed',
      kind: 'school',
    });
    expect(body).toMatchObject({ found: true, kind: 'school', source: 'dataset' });
    expect('nameHasPrivateUse' in body).toBe(false);
    expect(fia).not.toHaveBeenCalled();
  });
});
