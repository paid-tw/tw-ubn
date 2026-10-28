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

  it('does not 1101 when D1 is empty and the FIA fallback is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network error'))),
    );
    const res = await worker.fetch(new Request('https://w/v1/vat/22099131'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ found: false, ban: '22099131' });
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

  it('does not cache a vat miss taken while D1 is empty (ban may load later)', async () => {
    // FIA unreachable -> {found:false}, but D1 never authoritatively answered,
    // so the ban might appear once the dataset loads: must not be pinned.
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
