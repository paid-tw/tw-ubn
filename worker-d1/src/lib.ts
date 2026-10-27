// Self-contained helpers (the worker-d1 directory must stand alone for the
// Deploy to Cloudflare button). Mirrors crates/ubn-core & the other workers;
// kept in sync by the shared test vectors.

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

/** ROC date "0760321" -> "1987-03-21"; null if empty/malformed. */
export function rocToISO(roc: string | null | undefined): string | null {
  if (!roc || !/^\d{7}$/.test(roc)) return null;
  const year = Number(roc.slice(0, 3)) + 1911;
  const mm = roc.slice(3, 5);
  const dd = roc.slice(5, 7);
  if (mm === '00' || dd === '00') return null;
  return `${year}-${mm}-${dd}`;
}

export interface UBNResult {
  found: boolean;
  ban: string;
  name?: string;
  address?: string;
  useInvoice?: boolean;
  status?: string;
  setupDate?: string | null;
  source?: 'dataset' | 'fia-api';
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
