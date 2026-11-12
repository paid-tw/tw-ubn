import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupTitle } from '../lookupTitle.js';

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../fixtures/lookup-title-vectors.json', import.meta.url)),
    'utf8',
  ),
) as {
  ban: string;
  cases: { label: string; status: number; body: string; expect: unknown }[];
};

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

// Shared with the Ruby gem (ruby/test/lookup_title_test.rb): both
// implementations MUST read every response the same way.
describe('lookupTitle shared vectors', () => {
  it.each(vectors.cases)('$label', async ({ status, body, expect: expected }) => {
    const res = await lookupTitle(vectors.ban, { baseUrl: BASE, fetchImpl: respond(body, status) });
    expect(res).toEqual(expected);
  });
});

describe('lookupTitle returns null (no answer)', () => {
  it('on a non-2xx with a stalled body, cancels the body and aborts the request', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 502 })) as unknown as typeof fetch;
    await expect(lookupTitle(BAN, { baseUrl: BASE, fetchImpl })).resolves.toBeNull();
    expect(cancelled).toBe(true);
    expect(vi.mocked(fetchImpl).mock.calls[0][1]?.signal?.aborted).toBe(true);
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
