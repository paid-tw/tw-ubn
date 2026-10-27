import { describe, expect, it } from 'vitest';
import { lookupVAT } from '../lookup.js';

function jsonFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
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
