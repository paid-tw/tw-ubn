// Self-contained copies of the tiny core functions. The Worker directory must
// be fully self-contained for the Deploy to Cloudflare button, so these mirror
// crates/ubn-core and client/src (kept in sync via the shared test vectors).

const WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1];

/** Post-2023 UBN checksum (`% 5`, with the 7th-digit-is-7 exception). */
export function validateUBN(ban: string): boolean {
  if (!/^\d{8}$/.test(ban)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const p = Number(ban[i]) * WEIGHTS[i];
    sum += Math.floor(p / 10) + (p % 10);
  }
  if (sum % 5 === 0) return true;
  return ban[6] === '7' && (sum + 1) % 5 === 0;
}

/** FNV-1a 32-bit shard bucket — identical to the pipeline and client. */
export function shardOf(ban: string, shards: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < ban.length; i++) {
    h ^= ban.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % shards;
}

/** ROC date "0760321" -> "1987-03-21"; null if empty/malformed. */
export function rocToISO(roc: string | null | undefined): string | null {
  if (!roc || !/^\d{7}$/.test(roc)) return null;
  const year = Number(roc.slice(0, 3)) + 1911;
  const mm = roc.slice(3, 5);
  const dd = roc.slice(5, 7);
  if (mm === '00' || dd === '00') return null;
  return `${year}-${mm}-${dd}`;
}

export type RegistryStatus = 'active' | 'suspended' | 'closed';

/** Which register the UBN came from: VAT business or a withholding unit. */
export type RegistryKind = 'business' | 'nonprofit' | 'school' | 'agency';

/** One object inside a published `shards/<n>.json` file. */
export interface ShardRow {
  ban: string;
  name?: string;
  address?: string;
  useInvoice?: boolean;
  /**
   * Omitted on shards built before the header-driven pipeline. Missing means
   * unknown, not active. The suspension date is not part of the shard.
   */
  status?: RegistryStatus;
  /** Omitted on shards built before the withholding-unit sources; missing means unknown. */
  kind?: RegistryKind;
}

export interface UBNResult {
  found: boolean;
  ban: string;
  name?: string;
  address?: string;
  useInvoice?: boolean;
  setupDate?: string | null;
  /** Carried from the shard when present. See `ShardRow.status`. */
  status?: RegistryStatus;
  /** Carried from the shard when present. See `ShardRow.kind`. */
  kind?: RegistryKind;
  source?: 'dataset' | 'fia-api';
}

/** Map a dataset shard row onto the lookup result, including `status` / `kind` when the shard has them. */
export function datasetResult(row: ShardRow): UBNResult {
  return {
    found: true,
    ban: row.ban,
    name: row.name,
    address: row.address,
    useInvoice: row.useInvoice,
    status: row.status,
    kind: row.kind,
    source: 'dataset',
  };
}

/** Map the FIA per-record API JSON onto the unified result shape. */
export function normalizeFia(ban: string, j: Record<string, unknown>): UBNResult {
  return {
    found: true,
    ban,
    name: (j.businessNm as string) ?? undefined,
    address: (j.businessAddress as string) ?? undefined,
    useInvoice: j.isUseInvoice === 'Y',
    setupDate: rocToISO(j.businessSetupDate as string),
    source: 'fia-api',
  };
}
