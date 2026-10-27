/**
 * Official government sources, for enrichment / validation / fallback.
 * These talk to government servers directly and are NOT the checkout hot path.
 * All endpoints below were verified on 2026-10-27.
 */

/**
 * FIA (財政部財政資訊中心) per-record tax-registration API.
 * Documented at https://eip.fia.gov.tw/OAI/v2/api-docs
 *
 * CORS: `Access-Control-Allow-Origin: *` (browser-callable), but responses are
 * `Cache-Control: private`. Do NOT call it per checkout — put your own edge
 * cache in front and use it only as a fallback for UBNs missing from the daily
 * bulk snapshot. Returns null on 404 (not found).
 */
export async function fiaRegistration(
  ban: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const res = await fetchImpl(`https://eip.fia.gov.tw/OAI/api/businessRegistration/${ban}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`FIA API ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * GCIS (經濟部商業司) company-registration OpenData API.
 *
 * Covers COMPANIES ONLY (公司 — 股份/有限公司); sole proprietors and
 * partnerships (商號) are under a different business-registration resource.
 * No CORS headers -> server-side only. Use it to cross-check the legal name
 * and to detect dissolved/revoked status (Company_Status_Desc), which the FIA
 * tax registry does not carry.
 */
const GCIS_COMPANY_RESOURCE = '5F64D864-61CB-4D0D-8AD9-492047CC1EA6';

export async function gcisCompany(
  ban: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const url =
    `https://data.gcis.nat.gov.tw/od/data/api/${GCIS_COMPANY_RESOURCE}` +
    `?$format=json&$filter=Business_Accounting_NO eq ${ban}&$skip=0&$top=1`;
  const res = await fetchImpl(url);
  if (!res.ok) return null;
  const arr = (await res.json()) as Record<string, unknown>[];
  return arr?.[0] ?? null;
}
