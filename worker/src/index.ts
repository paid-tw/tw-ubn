import {
  datasetResult,
  normalizeFia,
  normalizeGcis,
  shardOf,
  validateUBN,
  type ShardRow,
  type UBNResult,
} from './lib';

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
const GCIS_COMPANY_API = 'https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6';
/** GCIS only enriches a miss; don't let a slow GCIS hold the response. */
const GCIS_TIMEOUT_MS = 3000;

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
    const r2 = await fromR2(ban, env);
    let result: UBNResult;
    let cacheable: boolean;
    if (r2.ok && r2.value) {
      result = r2.value;
      cacheable = true;
    } else {
      const fia = await fromFia(ban);
      if (!fia.ok) {
        // No authoritative answer: a found:false here would read as "no such
        // business" to the caller. Say so explicitly and never cache it.
        return json({ found: null, ban, error: 'upstream_unavailable' }, 502, cors);
      }
      result = fia.value;
      // A "not found" is authoritative only if the dataset read was too; when
      // R2 errored the ban may just be in the unread shard, so don't pin
      // found:false in the cache for a day.
      cacheable = fia.value.found || r2.ok;
      if (!fia.value.found) {
        // Not in the tax registry: GCIS may still know the company, closed
        // (解散/廢止 …, so the caller can say why) or live but unregistered
        // for tax. GCIS is an enhancement, so its failure never 502s; it only
        // keeps the FIA-derived found:false out of the cache.
        const gcis = await fromGcis(ban);
        if (!gcis.ok) cacheable = false;
        else if (gcis.value) result = gcis.value;
      }
    }
    // Cache the response CORS-free (the key is origin-independent and shared by
    // all origins), then apply the caller's CORS per request. This keeps any
    // one origin's allow header out of the shared cache at the source.
    const res = json(result, 200, {}, cacheable ? ttl : 0);
    if (cacheable) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return withCors(res, cors);
  },
};

/**
 * A lookup that either produced an authoritative answer (`ok: true`) or failed
 * transiently (`ok: false` — e.g. an R2 read threw, or FIA was unreachable).
 * A failed lookup must never be cached: the real answer may appear once the
 * upstream recovers.
 */
type Lookup<T> = { ok: true; value: T } | { ok: false };

/**
 * Look the UBN up in the R2-hosted shards: `{ ok: true }` with the row, or
 * with `null` for an authoritative "not in the dataset"; `{ ok: false }` when
 * the dataset should be there but couldn't be read.
 *
 * An unbound bucket is FIA-only mode by design (the binding is optional), so
 * there is no dataset to consult and FIA alone is authoritative: `ok: true`.
 * A bound bucket without `latest.json` (or without the ban's shard) is a
 * dataset that is meant to exist but isn't published yet, the same state as
 * worker-d1 before its first load: `ok: false`, so a FIA 404 isn't pinned in
 * the cache while the real dataset might still carry the ban.
 */
async function fromR2(ban: string, env: Env): Promise<Lookup<UBNResult | null>> {
  if (!env.UBN_BUCKET) return { ok: true, value: null };
  try {
    const pointer = await env.UBN_BUCKET.get('latest.json');
    if (!pointer) return { ok: false };
    const { latest } = (await pointer.json()) as { latest?: string };
    if (!latest) return { ok: false };

    const shards = Number(env.SHARDS ?? '8192');
    const obj = await env.UBN_BUCKET.get(`${latest}/shards/${shardOf(ban, shards)}.json`);
    if (!obj) return { ok: false };

    const rows = (await obj.json()) as ShardRow[];
    const rec = rows.find((r) => r.ban === ban);
    return { ok: true, value: rec ? datasetResult(rec) : null };
  } catch (e) {
    console.error('r2 lookup failed; falling back to FIA', e);
    return { ok: false };
  }
}

/** The official FIA per-record API: 404 is an authoritative "not found". */
async function fromFia(ban: string): Promise<Lookup<UBNResult>> {
  let res: Response;
  try {
    res = await fetch(`${FIA_API}/${ban}`);
  } catch (e) {
    // FIA unreachable: {ok:false} (not a throw) so the handler answers 502
    // instead of letting it bubble up as a Cloudflare 1101.
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
 * #7. We can't tell those apart, so an empty or non-JSON body counts as
 * unavailable (`ok: false`): the answer is still the FIA-derived found:false,
 * just not cached. Only a parsed array (`[]` or a row) is authoritative.
 */
async function fromGcis(ban: string): Promise<Lookup<UBNResult | null>> {
  const url = `${GCIS_COMPANY_API}?$format=json&$filter=Business_Accounting_NO eq ${ban}&$skip=0&$top=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(GCIS_TIMEOUT_MS) });
    if (!res.ok) return { ok: false };
    const rows: unknown = JSON.parse(await res.text());
    if (!Array.isArray(rows)) return { ok: false };
    const row = rows[0] as Record<string, unknown> | undefined;
    return { ok: true, value: row ? normalizeGcis(ban, row) : null };
  } catch (e) {
    // Network error, timeout, or an empty / non-JSON body.
    console.error('gcis lookup failed', e);
    return { ok: false };
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
