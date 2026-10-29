import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupTitle } from '../lookupTitle.js';

const BAN = '22099131';
const BASE = 'https://ubn.example.test';

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

/** A fetch that never settles and ignores its signal. */
function hanging(): typeof fetch {
  return vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

describe('lookupTitle request', () => {
  it.each([
    [BASE, `${BASE}/v1/vat/${BAN}`],
    [`${BASE}/`, `${BASE}/v1/vat/${BAN}`],
    [`${BASE}//`, `${BASE}/v1/vat/${BAN}`],
    [`${BASE}/ubn/`, `${BASE}/ubn/v1/vat/${BAN}`],
  ])('builds the URL from baseUrl %s', async (baseUrl, expected) => {
    const fetchImpl = respond({ found: false, ban: BAN });
    await lookupTitle(BAN, { baseUrl, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe(expected);
    expect(vi.mocked(fetchImpl).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['22099130', '1234567', '2209913X', '', ' 22099131'])(
    'returns null without a request for invalid UBN %j',
    async (ban) => {
      const fetchImpl = respond({ found: true, ban, name: 'x' });
      await expect(lookupTitle(ban, { baseUrl: BASE, fetchImpl })).resolves.toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

describe('lookupTitle answers', () => {
  it('returns a found record with its useful fields', async () => {
    const res = await lookupTitle(BAN, {
      baseUrl: BASE,
      fetchImpl: respond({
        found: true,
        ban: BAN,
        name: '台灣積體電路製造股份有限公司',
        address: '新竹科學園區',
        useInvoice: true,
        status: 'active',
        kind: 'business',
        nameHasPrivateUse: false,
        source: 'dataset',
        companyStatus: '核准設立',
        setupDate: '1987-02-21',
      }),
    });
    expect(res).toEqual({
      found: true,
      ban: BAN,
      name: '台灣積體電路製造股份有限公司',
      address: '新竹科學園區',
      useInvoice: true,
      status: 'active',
      kind: 'business',
      source: 'dataset',
      companyStatus: '核准設立',
      setupDate: '1987-02-21',
    });
  });

  it('keeps closed status and closedDate (caller decides)', async () => {
    const res = await lookupTitle(BAN, {
      baseUrl: BASE,
      fetchImpl: respond({
        found: true,
        ban: BAN,
        name: '某某商行',
        status: 'closed',
        source: 'gcis',
        closedDate: '2024-05-01',
      }),
    });
    expect(res).toMatchObject({ found: true, name: '某某商行', status: 'closed', closedDate: '2024-05-01' });
  });

  it('accepts a minimal found body and drops unknown enum values', async () => {
    const res = await lookupTitle(BAN, {
      baseUrl: BASE,
      fetchImpl: respond({ found: true, name: '某某商行', status: 'weird', kind: 'alien', source: 'x' }),
    });
    expect(res).toEqual({ found: true, ban: BAN, name: '某某商行' });
  });

  it('returns found: false for an authoritative not-found', async () => {
    const res = await lookupTitle(BAN, {
      baseUrl: BASE,
      fetchImpl: respond({ found: false, ban: BAN }),
    });
    expect(res).toEqual({ found: false });
  });
});

describe('lookupTitle returns null (no answer)', () => {
  it.each([
    ['502 upstream_unavailable (#9)', { found: null, error: 'upstream_unavailable' }, 502],
    ['503', { error: 'x' }, 503],
    ['500', 'oops', 500],
    ['404', 'not found', 404],
    ['400 invalid_ubn', { found: false, ban: BAN, error: 'invalid_ubn' }, 400],
    ['429', { found: false }, 429],
  ])('on non-2xx: %s', async (_label, body, status) => {
    await expect(
      lookupTitle(BAN, { baseUrl: BASE, fetchImpl: respond(body, status) }),
    ).resolves.toBeNull();
  });

  it.each([
    ['malformed JSON', '{"found": tr'],
    ['HTML error page', '<html>bad gateway</html>'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['JSON string', '"found"'],
    ['found missing', { ban: BAN, name: '某某商行' }],
    ['found null on 200', { found: null, ban: BAN }],
    ['found as string', { found: 'true', ban: BAN, name: '某某商行' }],
    ['found as number', { found: 1, ban: BAN, name: '某某商行' }],
    ['ban mismatch', { found: true, ban: '87006234', name: '某某商行' }],
    ['ban mismatch on not-found', { found: false, ban: '87006234' }],
    ['name missing', { found: true, ban: BAN }],
    ['name not a string', { found: true, ban: BAN, name: 42 }],
    ['name empty', { found: true, ban: BAN, name: '' }],
    ['name whitespace only', { found: true, ban: BAN, name: ' 　' }],
    ['name with BMP PUA (#10)', { found: true, ban: BAN, name: '某某商行' }],
    ['name with plane-15 PUA (#10)', { found: true, ban: BAN, name: '台北\u{FA3FE}行' }],
    ['server flagged nameHasPrivateUse', { found: true, ban: BAN, name: '某某商行', nameHasPrivateUse: true }],
  ])('on a 200 with %s', async (_label, body) => {
    await expect(lookupTitle(BAN, { baseUrl: BASE, fetchImpl: respond(body) })).resolves.toBeNull();
  });

  it('on a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(lookupTitle(BAN, { baseUrl: BASE, fetchImpl })).resolves.toBeNull();
  });

  it('when no fetchImpl is given and there is no global fetch', async () => {
    // Delete (not set to undefined) so a bare `fetch` reference would throw
    // ReferenceError, as on a runtime that never defined it.
    const g = globalThis as { fetch?: typeof fetch };
    const saved = g.fetch;
    delete g.fetch;
    try {
      await expect(lookupTitle(BAN, { baseUrl: BASE })).resolves.toBeNull();
    } finally {
      g.fetch = saved;
    }
  });

  it('on a fetch that rejects with AbortError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    await expect(lookupTitle(BAN, { baseUrl: BASE, fetchImpl })).resolves.toBeNull();
  });
});

describe('lookupTitle timeout and abort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out after the default 2000 ms, even if fetch ignores its signal', async () => {
    vi.useFakeTimers();
    const fetchImpl = hanging();
    const p = lookupTitle(BAN, { baseUrl: BASE, fetchImpl });
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBeNull();
    const signal = vi.mocked(fetchImpl).mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it('honours a custom timeoutMs', async () => {
    vi.useFakeTimers();
    const p = lookupTitle(BAN, { baseUrl: BASE, fetchImpl: hanging(), timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBeNull();
  });

  it('times out while the body is still streaming', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    })) as unknown as typeof fetch;
    const p = lookupTitle(BAN, { baseUrl: BASE, fetchImpl });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBeNull();
  });

  it('resolves null when the caller aborts mid-flight, and aborts the fetch', async () => {
    const caller = new AbortController();
    const fetchImpl = hanging();
    const p = lookupTitle(BAN, { baseUrl: BASE, fetchImpl, signal: caller.signal });
    caller.abort();
    await expect(p).resolves.toBeNull();
    expect(vi.mocked(fetchImpl).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('makes no request when the caller signal is already aborted', async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchImpl = respond({ found: true, ban: BAN, name: '某某商行' });
    await expect(
      lookupTitle(BAN, { baseUrl: BASE, fetchImpl, signal: caller.signal }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cleans up: a later caller abort does not affect a finished lookup', async () => {
    const caller = new AbortController();
    const res = await lookupTitle(BAN, {
      baseUrl: BASE,
      fetchImpl: respond({ found: false, ban: BAN }),
      signal: caller.signal,
    });
    caller.abort();
    expect(res).toEqual({ found: false });
  });
});
