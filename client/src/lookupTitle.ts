import { validateUBN } from './checksum.js';
import type { EntityKind, RegistryStatus } from './lookup.js';
import { hasPrivateUse } from './title.js';

export interface LookupTitleOptions {
  /** Base URL of a deployed tw-ubn Worker (e.g. `https://ubn.example.com`). */
  baseUrl: string;
  /** Caller's abort signal; aborting it resolves the lookup to `null`. */
  signal?: AbortSignal;
  /** Give up after this many ms and resolve to `null`. Default 2000. */
  timeoutMs?: number;
  /** Inject a fetch implementation (tests / non-browser runtimes). */
  fetchImpl?: typeof fetch;
}

/** Where the Worker found the record. */
export type TitleSource = 'dataset' | 'fia-api' | 'gcis';

/** A registered entity whose name is usable as an invoice title. */
export interface TitleFound {
  found: true;
  ban: string;
  /** Registered name — the invoice title (抬頭). Non-empty, no PUA glyphs. */
  name: string;
  /** Absent means unknown — do not treat it as active. */
  status?: RegistryStatus;
  address?: string;
  useInvoice?: boolean;
  kind?: EntityKind;
  source?: TitleSource;
  /** Company status text from GCIS (公司狀態), when the Worker has it. */
  companyStatus?: string;
  closedDate?: string;
  setupDate?: string;
}

/** The number is well-formed but no registration exists for it. */
export interface TitleNotFound {
  found: false;
}

export type TitleLookupResult = TitleFound | TitleNotFound;

const STATUSES: readonly string[] = ['active', 'suspended', 'closed'];
const KINDS: readonly string[] = ['business', 'nonprofit', 'school', 'agency'];
const SOURCES: readonly string[] = ['dataset', 'fia-api', 'gcis'];

/**
 * Look up the invoice title for a UBN through a deployed tw-ubn Worker
 * (`GET <baseUrl>/v1/vat/<ban>`). Designed for checkout "type UBN -> fill
 * company title".
 *
 * Three outcomes:
 * - `{ found: true, name, status?, ... }` — a registration with a usable name.
 *   `status` may be `suspended` or `closed`; deciding what to do with those is
 *   up to the caller.
 * - `{ found: false }` — the Worker answered authoritatively that no
 *   registration exists. Only then is it right to tell the buyer "not found".
 * - `null` — no answer. Show nothing and let the buyer type the title. This
 *   covers: a malformed UBN or bad checksum (no request is made), a timeout,
 *   the caller's signal aborting, a network error, any non-2xx response
 *   (including the Worker's `502 upstream_unavailable`, #9), a body that is not
 *   JSON or whose `found` is not a boolean, a `ban` in the body that differs
 *   from the one asked for, and a name that is empty or contains Private Use
 *   Area glyphs (or that the server flagged with `nameHasPrivateUse`, #10).
 *
 * Unlike `lookupVAT`, this never throws — not even for an invalid UBN: every
 * failure is "no answer", so a checkout can `await` it without a try/catch.
 */
export async function lookupTitle(
  ban: string,
  opts: LookupTitleOptions,
): Promise<TitleLookupResult | null> {
  if (!validateUBN(ban)) return null;
  if (opts.signal?.aborted) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/vat/${ban}`;

  // Combine the caller's signal with the timeout by hand: AbortSignal.any is
  // missing on Node 18 / older browsers.
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, opts.timeoutMs ?? 2000);
  opts.signal?.addEventListener('abort', abort, { once: true });
  // Also race the abort itself, so a fetch implementation that ignores its
  // signal still cannot hold the lookup past the deadline.
  const aborted = new Promise<null>((resolve) =>
    controller.signal.addEventListener('abort', () => resolve(null), { once: true }),
  );

  try {
    return await Promise.race([request(url, ban, doFetch, controller.signal), aborted]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
  }
}

async function request(
  url: string,
  ban: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<TitleLookupResult | null> {
  const res = await doFetch(url, { signal });
  if (!res.ok) return null;
  return parse(await res.json(), ban);
}

function parse(body: unknown, ban: string): TitleLookupResult | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.found !== 'boolean') return null;
  if (b.ban !== undefined && b.ban !== ban) return null;
  if (!b.found) return { found: false };

  const name = b.name;
  if (typeof name !== 'string' || name.trim() === '') return null;
  if (b.nameHasPrivateUse === true || hasPrivateUse(name)) return null;

  const out: TitleFound = { found: true, ban, name };
  if (typeof b.status === 'string' && STATUSES.includes(b.status)) {
    out.status = b.status as RegistryStatus;
  }
  if (typeof b.address === 'string') out.address = b.address;
  if (typeof b.useInvoice === 'boolean') out.useInvoice = b.useInvoice;
  if (typeof b.kind === 'string' && KINDS.includes(b.kind)) out.kind = b.kind as EntityKind;
  if (typeof b.source === 'string' && SOURCES.includes(b.source)) {
    out.source = b.source as TitleSource;
  }
  if (typeof b.companyStatus === 'string') out.companyStatus = b.companyStatus;
  if (typeof b.closedDate === 'string') out.closedDate = b.closedDate;
  if (typeof b.setupDate === 'string') out.setupDate = b.setupDate;
  return out;
}
