import { normalizeFia, normalizeGcis, validateUBN, type RegistryKind, type RegistryStatus, type UBNResult } from './lib';

export interface Env {
  /** D1 database holding the `ubn` table (see the pipeline's d1/schema.sql). */
  UBN_DB: D1Database;
  /** "*" (default) or a comma-separated origin allowlist. */
  ALLOWED_ORIGINS?: string;
  /** Edge cache TTL in seconds. */
  CACHE_TTL?: string;
  /**
   * Edge cache TTL in seconds for a found:false whose GCIS check came back as
   * an empty body (see `fromGcis`). Default 3600; capped at CACHE_TTL.
   */
  NEGATIVE_CACHE_TTL?: string;
}

const FIA_API = 'https://eip.fia.gov.tw/OAI/api/businessRegistration';
const GCIS_COMPANY_API = 'https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6';
/** GCIS only enriches a miss; don't let a slow GCIS hold the response. */
const GCIS_TIMEOUT_MS = 3000;

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

      const d1 = await fromD1(ban, env);
      let result: UBNResult;
      let cacheable: boolean;
      let cacheTtl = ttl;
      if (d1.ok && d1.value) {
        result = d1.value;
        cacheable = true;
      } else {
        const fia = await fromFia(ban);
        if (!fia.ok) {
          // No authoritative answer: a found:false here would read as "no
          // such business" to the caller. Say so explicitly, never cache it.
          return json({ found: null, ban, error: 'upstream_unavailable' }, 502, cors);
        }
        result = fia.value;
        // A "not found" is authoritative only if D1 was too; when D1 errored
        // the ban may just be in the not-yet-loaded dataset, so don't pin
        // found:false in the cache for a day.
        cacheable = fia.value.found || d1.ok;
        if (!fia.value.found) {
          // Not in the tax registry: GCIS may still know the company, closed
          // (解散/廢止 …, so the caller can say why) or live but unregistered
          // for tax. GCIS is an enhancement, so its failure never 502s; it
          // only keeps the FIA-derived found:false out of the cache.
          const gcis = await fromGcis(ban);
          if (!gcis.ok) cacheable = false;
          else if (gcis.value) result = gcis.value;
          // An empty body is GCIS's "no such company" but also its outage
          // mode: cache that found:false only briefly.
          else if (gcis.empty) cacheTtl = Math.min(ttl, Number(env.NEGATIVE_CACHE_TTL ?? '3600'));
        }
      }
      // Cache CORS-free (the key is shared by all origins); apply the caller's
      // CORS per request so no single origin's allow header enters the cache.
      const res = json(result, 200, {}, cacheable ? cacheTtl : 0);
      if (cacheable) ctx.waitUntil(cache.put(key, res.clone()));
      return withCors(res, cors);
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
      if (!rows) return withCors(json({ query: name, count: 0, results: [] }, 200, {}), cors);
      const res = json({ query: name, count: rows.length, results: rows }, 200, {}, ttl);
      ctx.waitUntil(cache.put(key, res.clone()));
      return withCors(res, cors);
    }

    return json({ routes: ['/v1/vat/:ban', '/v1/search?name=&limit='] }, 404, cors);
  },
};

/**
 * A lookup that either produced an authoritative answer (`ok: true`) or failed
 * transiently (`ok: false` — e.g. D1 has no `ubn` table yet, or FIA was
 * unreachable). A failed lookup must never be cached: the real answer may
 * appear once the dataset finishes loading or the upstream recovers.
 */
type Lookup<T> = { ok: true; value: T } | { ok: false };

/**
 * `{ ok: false }` on a D1 error (e.g. no `ubn` table before the first load) so
 * the caller falls back to FIA instead of throwing a 1101; `{ ok: true }` with
 * the row, or with `null` for an authoritative "not in the dataset".
 */
async function fromD1(ban: string, env: Env): Promise<Lookup<UBNResult | null>> {
  let row: Record<string, unknown> | null;
  try {
    // SELECT * rather than naming columns: a column added by a newer build
    // (`kind`, `name_has_private_use` …) may not exist yet if this Worker is
    // deployed before the dataset workflow has run migrate.sql, and naming it
    // would fail every lookup over to FIA. Optional columns are mapped only
    // when present.
    row = await env.UBN_DB.prepare('SELECT * FROM ubn WHERE ban = ?')
      .bind(ban)
      .first<Record<string, unknown>>();
  } catch (e) {
    console.error('d1 lookup failed; falling back to FIA', e);
    return { ok: false };
  }
  if (!row) return { ok: true, value: null };
  return {
    ok: true,
    value: {
      found: true,
      ban,
      name: row.name as string,
      address: row.address as string,
      useInvoice: !!(row.use_invoice as number),
      status: row.status as RegistryStatus,
      // Absent (pre-migrate table) or NULL (row loaded before `kind`): unknown.
      kind: (row.kind as RegistryKind | null | undefined) ?? undefined,
      // Absent or NULL (row loaded before the column existed): same as false.
      ...(row.name_has_private_use ? { nameHasPrivateUse: true as const } : {}),
      setupDate: (row.setup_date_iso as string) ?? null,
      source: 'dataset',
    },
  };
}

async function fromFia(ban: string): Promise<Lookup<UBNResult>> {
  let res: Response;
  try {
    res = await fetch(`${FIA_API}/${ban}`);
  } catch (e) {
    // FIA unreachable: {ok:false} (not a throw) so the handler answers 502
    // instead of letting it bubble up as a Cloudflare 1101. This matters most
    // on a fresh deploy, where D1 is empty and FIA is the only source — a
    // transient FIA blip must not take the whole worker down.
    console.error('fia lookup failed', e);
    return { ok: false };
  }
  // 404 is an authoritative "not a VAT entity"; a 5xx is transient, so treat
  // it like an outage (not a cacheable miss).
  if (res.status === 404) return { ok: true, value: { found: false, ban } };
  if (!res.ok) return { ok: false };
  try {
    return { ok: true, value: normalizeFia(ban, (await res.json()) as Record<string, unknown>) };
  } catch (e) {
    console.error('fia returned a non-JSON body', e);
    return { ok: false };
  }
}

/**
 * GCIS (經濟部商業司) company registration, keyed by `Business_Accounting_NO`.
 * Companies only (not 商號); no CORS, so it can only be queried server-side.
 *
 * Verified live 2026-10-29: a hit is HTTP 200 with a one-element JSON array
 * carrying `Company_Name`, `Company_Status_Desc`, `Company_Location`,
 * `Revoke_App_Date` (ROC, e.g. "1141124"; "" for a live company) and more.
 * A ban GCIS has no record of is ALSO HTTP 200 with `Content-Length: 0` (an
 * empty body, never `[]`), i.e. the same bytes as the outage mode reported in
 * #7. We can't tell those apart, so an empty body is a miss flagged `empty`
 * (the handler caches it for NEGATIVE_CACHE_TTL only). A parsed array (`[]`
 * or a row) is authoritative; an HTTP error, network error, timeout, or a
 * non-empty body that isn't a JSON array is unavailable (`ok: false`).
 */
async function fromGcis(ban: string): Promise<Lookup<UBNResult | null> & { empty?: boolean }> {
  const url = `${GCIS_COMPANY_API}?$format=json&$filter=Business_Accounting_NO eq ${ban}&$skip=0&$top=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(GCIS_TIMEOUT_MS) });
    if (!res.ok) return { ok: false };
    const body = await res.text();
    if (body.trim() === '') return { ok: true, value: null, empty: true };
    const rows: unknown = JSON.parse(body);
    if (!Array.isArray(rows)) return { ok: false };
    const row = rows[0] as Record<string, unknown> | undefined;
    return { ok: true, value: row ? normalizeGcis(ban, row) : null };
  } catch (e) {
    // Network error, timeout, or a non-JSON body.
    console.error('gcis lookup failed', e);
    return { ok: false };
  }
}

/**
 * Prefix search over `name`, expressed as an index range (`name >= p AND
 * name < p+￿`) so SQLite uses idx_name and reads only matching rows —
 * far cheaper than a `LIKE '%term%'` full scan.
 */
async function searchByName(name: string, limit: number, env: Env) {
  const upper = name + '￿';
  try {
    const { results } = await env.UBN_DB.prepare(
      'SELECT ban, name, address, status FROM ubn WHERE name >= ? AND name < ? ORDER BY name LIMIT ?',
    )
      .bind(name, upper, limit)
      .all<Record<string, unknown>>();
    return results ?? [];
  } catch (e) {
    // null (not []) so the handler skips caching a transient failure.
    console.error('d1 search failed', e);
    return null;
  }
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
  // A cached response carries the CORS headers of whoever populated it; drop
  // them so a disallowed origin doesn't get another origin's allow header.
  r.headers.delete('Access-Control-Allow-Origin');
  r.headers.delete('Vary');
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
