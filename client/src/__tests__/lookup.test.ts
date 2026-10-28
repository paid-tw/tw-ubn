import { describe, expect, it } from 'vitest';
import { lookupVAT } from '../lookup.js';
import { shardOf } from '../shard.js';

function jsonFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

/** Fetch mock that answers by URL suffix; anything unmatched is a 404. */
function routed(routes: Record<string, unknown>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    return key
      ? new Response(JSON.stringify(routes[key]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      : new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('lookupVAT shard records', () => {
  it('returns status from current shards', async () => {
    const rec = await lookupVAT('22099131', {
      baseUrl: 'https://example.test',
      shards: 256,
      fetchImpl: jsonFetch([
        {
          ban: '22099131',
          name: '台積電',
          address: '新竹市',
          useInvoice: true,
          status: 'active',
        },
      ]),
    });
    expect(rec).toMatchObject({
      ban: '22099131',
      name: '台積電',
      useInvoice: true,
      status: 'active',
    });
  });

  it('returns suspended without dropping the invoice flag', async () => {
    const rec = await lookupVAT('87003412', {
      baseUrl: 'https://example.test',
      shards: 256,
      fetchImpl: jsonFetch([
        {
          ban: '87003412',
          name: '惜緣農業資材行',
          useInvoice: true,
          status: 'suspended',
        },
      ]),
    });
    expect(rec?.status).toBe('suspended');
    expect(rec?.useInvoice).toBe(true);
    expect(rec?.name).toBe('惜緣農業資材行');
  });

  it('accepts older shards that omit status', async () => {
    const rec = await lookupVAT('22099131', {
      baseUrl: 'https://example.test',
      shards: 256,
      fetchImpl: jsonFetch([{ ban: '22099131', name: '台積電', useInvoice: true }]),
    });
    expect(rec?.name).toBe('台積電');
    expect(rec?.useInvoice).toBe(true);
    expect(rec?.status).toBeUndefined();
  });
});

describe('lookupVAT versioned shard path', () => {
  const rows = [{ ban: '22099131', name: '台積電', useInvoice: true, status: 'active' }];
  const bucket = shardOf('22099131', 256);

  it('resolves latest.json and reads the versioned shard', async () => {
    const rec = await lookupVAT('22099131', {
      baseUrl: 'https://cdn.test',
      shards: 256,
      fetchImpl: routed({
        '/latest.json': { latest: 'v/20261028' },
        [`/v/20261028/shards/${bucket}.json`]: rows,
      }),
    });
    expect(rec?.name).toBe('台積電');
  });

  it('honors an explicit version and skips latest.json', async () => {
    const rec = await lookupVAT('22099131', {
      baseUrl: 'https://cdn.test',
      shards: 256,
      version: 'v/20261028',
      fetchImpl: routed({ [`/v/20261028/shards/${bucket}.json`]: rows }),
    });
    expect(rec?.name).toBe('台積電');
  });

  it('falls back to flat shards when latest.json is absent', async () => {
    const rec = await lookupVAT('22099131', {
      baseUrl: 'https://cdn.test',
      shards: 256,
      fetchImpl: routed({ [`/shards/${bucket}.json`]: rows }),
    });
    expect(rec?.name).toBe('台積電');
  });
});
