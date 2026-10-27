import { normalizeFia, shardOf, validateUBN, type UBNResult } from './lib';

export interface Env {
  /** R2 bucket holding the published dataset. Optional; falls back to FIA. */
  UBN_BUCKET?: R2Bucket;
  /** "*" (default) or a comma-separated origin allowlist. */
  ALLOWED_ORIGINS?: string;
  /** Shard count of the published dataset (must match manifest.json). */
  SHARDS?: string;
  /** Edge cache TTL in seconds. */
  CACHE_TTL?: string;
}

const FIA_API = 'https://eip.fia.gov.tw/OAI/api/businessRegistration';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(req.headers.get('Origin') ?? '', env.ALLOWED_ORIGINS ?? '*');

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, cors);

    const url = new URL(req.url);
    const matched = url.pathname.match(/^\/v1\/vat\/(\d{8})$/);
    const ban = matched?.[1] ?? url.searchParams.get('ban') ?? '';

    if (!validateUBN(ban)) {
      return json({ found: false, ban, error: 'invalid_ubn' }, 400, cors);
    }

    const cache = caches.default;
    const cacheKey = new Request(`https://cache.tw-ubn/v1/vat/${ban}`);
    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached, cors);

    const ttl = Number(env.CACHE_TTL ?? '86400');
    const result = (await fromR2(ban, env)) ?? (await fromFia(ban)) ?? { found: false, ban };
    const res = json(result, 200, cors, ttl);
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};

/** Look the UBN up in the R2-hosted shards, if the bucket is bound & populated. */
async function fromR2(ban: string, env: Env): Promise<UBNResult | null> {
  if (!env.UBN_BUCKET) return null;
  const pointer = await env.UBN_BUCKET.get('latest.json');
  if (!pointer) return null;
  const { latest } = (await pointer.json()) as { latest?: string };
  if (!latest) return null;

  const shards = Number(env.SHARDS ?? '8192');
  const obj = await env.UBN_BUCKET.get(`${latest}/shards/${shardOf(ban, shards)}.json`);
  if (!obj) return null;

  const rows = (await obj.json()) as UBNResult[];
  const rec = rows.find((r) => r.ban === ban);
  return rec ? { ...rec, found: true, source: 'dataset' } : null;
}

/** Fall back to the official FIA per-record API (404 => not found). */
async function fromFia(ban: string): Promise<UBNResult | null> {
  const res = await fetch(`${FIA_API}/${ban}`);
  if (res.status === 404) return { found: false, ban };
  if (!res.ok) return null;
  return normalizeFia(ban, (await res.json()) as Record<string, unknown>);
}

function corsHeaders(origin: string, allowed: string): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
  if (allowed.trim() === '*') {
    base['Access-Control-Allow-Origin'] = '*';
  } else if (origin && allowed.split(',').map((o) => o.trim()).includes(origin)) {
    base['Access-Control-Allow-Origin'] = origin;
    base['Vary'] = 'Origin';
  }
  return base;
}

function withCors(res: Response, cors: Record<string, string>): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
  return r;
}

function json(body: unknown, status: number, cors: Record<string, string>, ttl = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': ttl > 0 ? `public, max-age=${ttl}` : 'no-store',
      ...cors,
    },
  });
}
