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

/**
 * `suspended` is 停業 (may resume); `closed` is terminated (解散, 廢止, 撤銷 …)
 * and only ever comes from GCIS, since a closed business leaves the tax registry.
 */
export type RegistryStatus = 'active' | 'suspended' | 'closed';

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
  source?: 'dataset' | 'fia-api' | 'gcis';
  /** GCIS only: the raw `Company_Status_Desc`, e.g. 核准設立 / 解散. */
  companyStatus?: string;
  /** GCIS only: termination date (ISO) when `status` is `closed`, else null. */
  closedDate?: string | null;
}

/** Map a dataset shard row onto the lookup result, including `status` when the shard has it. */
export function datasetResult(row: ShardRow): UBNResult {
  return {
    found: true,
    ban: row.ban,
    name: row.name,
    address: row.address,
    useInvoice: row.useInvoice,
    status: row.status,
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

/**
 * Keywords in GCIS `Company_Status_Desc` that mean the company has terminated.
 * Covers 解散, 合併解散, 核准設立，但已命令解散, 廢止(登記/許可), 撤銷(登記/許可),
 * 撤回登記, and each "…已清算完結" form. 重整 and the 破產 family are left
 * unclassified (raw desc only): neither is a termination by itself.
 */
const CLOSED_KEYWORDS = ['解散', '廢止', '撤銷', '撤回', '清算完結'];

export function isClosedCompanyStatus(desc: string): boolean {
  return CLOSED_KEYWORDS.some((k) => desc.includes(k));
}

/**
 * Map a GCIS company-registration row onto the unified result shape. A live
 * company (核准設立) isn't in the tax registry either, so its tax status is
 * unknown and `status` stays unset; its name is still usable as an invoice
 * title.
 */
export function normalizeGcis(ban: string, j: Record<string, unknown>): UBNResult {
  const desc = (j.Company_Status_Desc as string) ?? '';
  const closed = isClosedCompanyStatus(desc);
  return {
    found: true,
    ban,
    name: (j.Company_Name as string) || undefined,
    address: (j.Company_Location as string)?.trim() || undefined,
    source: 'gcis',
    companyStatus: desc,
    status: closed ? 'closed' : undefined,
    closedDate: closed ? rocToISO(j.Revoke_App_Date as string) : null,
  };
}
