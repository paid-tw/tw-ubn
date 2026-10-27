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
    const url = `${opts.baseUrl.replace(/\/$/, '')}/shards/${bucket}.json`;
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const rows = (await res.json()) as UBNRecord[];
    return rows.find((r) => r.ban === ban) ?? null;
  } finally {
    clearTimeout(timer);
  }
}
