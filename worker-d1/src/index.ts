import { normalizeFia, validateUBN, type UBNResult } from './lib';

export interface Env {
  /** D1 database holding the `ubn` table (see the pipeline's d1/schema.sql). */
  UBN_DB: D1Database;
  /** "*" (default) or a comma-separated origin allowlist. */
  ALLOWED_ORIGINS?: string;
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
    const ttl = Number(env.CACHE_TTL ?? '86400');
    const cache = caches.default;

    // --- exact UBN lookup -------------------------------------------------
    const m = url.pathname.match(/^\/v1\/vat\/(\d{8})$/);
    if (m) {
      const ban = m[1];
      if (!validateUBN(ban)) return json({ found: false, ban, error: 'invalid_ubn' }, 400, cors);

      const key = new Request(`https://cache.tw-ubn/v1/vat/${ban}`);
      const hit = await cache.match(key);
      if (hit) return withCors(hit, cors);

      const result = (await fromD1(ban, env)) ?? (await fromFia(ban)) ?? { found: false, ban };
      const res = json(result, 200, cors, ttl);
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }

    // --- name prefix search (D1 only) ------------------------------------
    if (url.pathname === '/v1/search') {
      const name = (url.searchParams.get('name') ?? '').trim();
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '20') || 20, 50);
      if (name.length < 2) return json({ error: 'name_too_short', minLength: 2 }, 400, cors);

      const key = new Request(`https://cache.tw-ubn/v1/search/${encodeURIComponent(name)}/${limit}`);
      const hit = await cache.match(key);
      if (hit) return withCors(hit, cors);

      const rows = await searchByName(name, limit, env);
      const res = json({ query: name, count: rows.length, results: rows }, 200, cors, ttl);
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }

    return json({ routes: ['/v1/vat/:ban', '/v1/search?name=&limit='] }, 404, cors);
  },
};

async function fromD1(ban: string, env: Env): Promise<UBNResult | null> {
  const row = await env.UBN_DB.prepare(
    'SELECT ban, name, address, use_invoice, status, setup_date_iso FROM ubn WHERE ban = ?',
  )
    .bind(ban)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    found: true,
    ban,
    name: row.name as string,
    address: row.address as string,
    useInvoice: !!(row.use_invoice as number),
    status: row.status as string,
    setupDate: (row.setup_date_iso as string) ?? null,
    source: 'dataset',
  };
}

async function fromFia(ban: string): Promise<UBNResult | null> {
  const res = await fetch(`${FIA_API}/${ban}`);
  if (res.status === 404) return { found: false, ban };
  if (!res.ok) return null;
  return normalizeFia(ban, (await res.json()) as Record<string, unknown>);
}

/**
 * Prefix search over `name`, expressed as an index range (`name >= p AND
 * name < p+￿`) so SQLite uses idx_name and reads only matching rows —
 * far cheaper than a `LIKE '%term%'` full scan.
 */
async function searchByName(name: string, limit: number, env: Env) {
  const upper = name + '￿';
  const { results } = await env.UBN_DB.prepare(
    'SELECT ban, name, address, status FROM ubn WHERE name >= ? AND name < ? ORDER BY name LIMIT ?',
  )
    .bind(name, upper, limit)
    .all<Record<string, unknown>>();
  return results ?? [];
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
