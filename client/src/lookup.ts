import { validateUBN } from './checksum.js';
import { shardOf, DEFAULT_SHARDS } from './shard.js';

/** Registry status written onto shards. Older shards omit the field. */
export type RegistryStatus = 'active' | 'suspended';

export interface UBNRecord {
  ban: string;
  /** Business name as registered for tax — this is the invoice title (抬頭). */
  name: string;
  /** Registered business address. */
  address?: string;
  /** Whether the entity issues uniform invoices (使用統一發票). */
  useInvoice?: boolean;
  /**
   * `active` or `suspended`, from `BGMOPEN1` / `BGMOPEN1X`.
   *
   * Present on shards built by the header-driven pipeline. Shards published
   * before that omit `status`; a missing value means unknown — do not treat
   * it as active. The suspension date itself is not on the shard; it is only
   * in the full dataset (`ubn.ndjson.gz` / `ubn.sqlite`).
   */
  status?: RegistryStatus;
}

export interface LookupOptions {
  /** Base URL serving the dataset (e.g. your CDN in front of R2). */
  baseUrl: string;
  /** Shard count; must match the published manifest.json. Default 8192. */
  shards?: number;
  /** Abort the request after this many ms. Default 2000. */
  timeoutMs?: number;
  /** Inject a fetch implementation (tests / non-browser runtimes). */
  fetchImpl?: typeof fetch;
  /**
   * Version prefix of the published shards (e.g. `"v/20261028"`). When omitted,
   * the client reads `<baseUrl>/latest.json` to discover it. Set this to pin a
   * version, or to `""` to read shards flat at `<baseUrl>/shards/` (e.g. when
   * `baseUrl` already points inside a version).
   */
  version?: string;
}

/**
 * Resolve the directory that holds the shards. The dataset workflow publishes
 * them under a versioned, immutable prefix (`v/<date>/shards/`) with a short-TTL
 * `latest.json` = `{"latest":"v/<date>"}` pointer, so the client must resolve
 * that pointer rather than assume a flat `/shards/`. Falls back to flat when
 * `latest.json` is absent or `version` is given explicitly.
 */
async function resolveShardsDir(
  opts: LookupOptions,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const base = opts.baseUrl.replace(/\/$/, '');
  if (opts.version !== undefined) {
    return opts.version ? `${base}/${opts.version}/shards` : `${base}/shards`;
  }
  const res = await doFetch(`${base}/latest.json`, { signal });
  if (res.ok) {
    const { latest } = (await res.json()) as { latest?: string };
    return latest ? `${base}/${latest.replace(/^\/|\/$/g, '')}/shards` : `${base}/shards`;
  }
  // Only an absent pointer (404) means the legacy flat layout. Any other status
  // is an outage: propagate it so the caller sees an error, not a false "not
  // found" (returning null here would mask the outage as a missing record).
  if (res.status === 404) return `${base}/shards`;
  throw new Error(`tw-ubn: latest.json resolution failed (HTTP ${res.status})`);
}

export class InvalidUBNError extends Error {
  constructor(public readonly ban: string) {
    super(`Invalid UBN: ${ban}`);
    this.name = 'InvalidUBNError';
  }
}

/**
 * Look up a UBN against the static dataset: one request for its shard, then a
 * local match. Designed for checkout "type UBN -> fill company title".
 *
 * - Validates the checksum first and throws InvalidUBNError before any network.
 * - Returns null when the UBN is well-formed but not in the dataset
 *   (e.g. a brand-new registration not yet in the daily snapshot). Callers
 *   can then fall back to the live FIA API; see src/sources.ts.
 * - Never let a lookup block checkout: treat a thrown/timeout as "no autofill".
 */
export async function lookupVAT(ban: string, opts: LookupOptions): Promise<UBNRecord | null> {
  if (!validateUBN(ban)) throw new InvalidUBNError(ban);

  const shards = opts.shards ?? DEFAULT_SHARDS;
  const bucket = shardOf(ban, shards);
  const doFetch = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2000);
  try {
    const dir = await resolveShardsDir(opts, doFetch, controller.signal);
    const res = await doFetch(`${dir}/${bucket}.json`, { signal: controller.signal });
    if (!res.ok) return null;
    const rows = (await res.json()) as UBNRecord[];
    return rows.find((r) => r.ban === ban) ?? null;
  } finally {
    clearTimeout(timer);
  }
}
