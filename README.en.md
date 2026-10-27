# tw-ubn

[![CI](https://github.com/paid-tw/tw-ubn/actions/workflows/ci.yml/badge.svg)](https://github.com/paid-tw/tw-ubn/actions/workflows/ci.yml)
&nbsp;[繁體中文](README.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/paid-tw/tw-ubn/tree/main/worker)

An open, **daily-updated** dataset of Taiwan business registrations (統一編號 /
UBN), plus a tiny client for the most common use case: **at checkout, the buyer
types their UBN and the company title (抬頭) auto-fills.**

The design goal is that the lookup never depends on a government server at
request time — so it can't inherit the slowness, instability, and throttling of
the official query pages. All per-query cost is paid at build time; every lookup
is a single cache-friendly request to static data you host yourself.

## How it works

```
 daily  FIA tax registry: BGMOPEN1.zip (active) + BGMOPEN1X.csv (suspended)
           │
           ▼  ubn-build (Rust): normalize (ROC→ISO), merge + status flag
         dist/
           ├─ shards/<n>.json   8192 per-UBN shards (ban → name/address/useInvoice)
           ├─ ubn.sqlite        full dataset, indexed on ban
           ├─ ubn.ndjson.gz     full dataset, one JSON object per line
           └─ manifest.json     data date, rows, shards, hash, license

 checkout ─► your CDN (R2 + Cloudflare) ─► shards/<bucket>.json   (1 request, edge-cached)
                            miss ─► Worker ─► FIA per-record API (cached at edge)
```

- **FIA tax registry** is the primary source: it covers every VAT-registered
  entity (companies *and* 商號), and carries the invoice title and the
  uniform-invoice flag — exactly what checkout needs. Updated daily.
- Active-vs-suspended **status** comes from FIA itself (`BGMOPEN1` +
  `BGMOPEN1X`), so GCIS is not needed for it.
- **GCIS** (company/business registration) is optional, per-record enrichment
  (e.g. responsible person); see [`docs/data-dictionary.md`](docs/data-dictionary.md)
  for why there is no usable GCIS bulk master.
- A brand-new UBN not yet in the daily snapshot falls back to the **documented
  FIA per-record API**, behind your own edge cache so the government server is
  hit at most once per UBN per cache window — never per checkout.

## Client usage

```ts
import { lookupVAT, validateUBN, InvalidUBNError } from '@paid-tw/ubn';

// 1. validate locally first — no network for malformed input
if (validateUBN(ban)) {
  try {
    const rec = await lookupVAT(ban, { baseUrl: 'https://ubn.example.com', timeoutMs: 1500 });
    if (rec) fillTitle(rec.name);          // got the 抬頭
    // rec === null -> valid UBN, not in snapshot; optionally fall back to the FIA API
  } catch (e) {
    if (e instanceof InvalidUBNError) { /* shouldn't happen after validateUBN */ }
    // any network/timeout error: just let the buyer type the title themselves.
    // Autofill is an enhancement — never block checkout on it.
  }
}
```

The `validateUBN` checksum is verified against all ~1.7M active UBNs (100%); it
uses the post-2023 rule, not the stale `% 10` one found in many snippets.

## One-click lookup service (Cloudflare Worker)

Click the **Deploy to Cloudflare** button above to deploy `worker/` to your own
Cloudflare account. It provisions an R2 bucket and gives you an endpoint:

```
GET https://<your-worker>/v1/vat/22099131
→ { "found": true, "ban": "22099131", "name": "台灣積體電路製造股份有限公司", "source": "dataset" }
```

- **R2 shards first**: served from the edge, never touching the government.
- **Fallback on miss**: an empty bucket or a brand-new UBN proxies the official
  FIA per-record API and caches it at the edge (government hit at most once per
  UBN per cache window).
- **CORS**: defaults to `*`; set an allowlist via `ALLOWED_ORIGINS` in
  `wrangler.jsonc` for production.
- After deploy, run the [dataset workflow](.github/workflows/dataset.yml) to fill
  R2 and upgrade from "FIA fallback" to "dataset first".

> Why R2 shards and not D1? Measured on a real Cloudflare account (latency /
> cost / ingestion): [docs/bench-r2-vs-d1.md](docs/bench-r2-vs-d1.md).

## Repository layout

```
crates/ubn-core    Rust: UBN checksum, FNV shard hash, ROC date (source of truth)
crates/ubn-build   Rust: the build pipeline (a single binary, no external tools)
client/            TypeScript: @paid-tw/ubn, the browser checkout client
worker/            Cloudflare Worker: lookup service (R2 shards + FIA fallback), one-click deploy
```

## Building the dataset

The pipeline is a self-contained Rust binary — no shell/node/duckdb toolchain:

```bash
cargo run --release -p ubn-build -- --out dist --shards 8192
# offline, against a local copy (skips the government fetch):
cargo run --release -p ubn-build -- --active-zip BGMOPEN1.zip --no-suspended --out dist
```

CI runs it daily and publishes the artifacts; see
[`.github/workflows/dataset.yml`](.github/workflows/dataset.yml).

## Develop

```bash
cargo test                              # Rust: core + pipeline + real-UBN fixture
cd client && pnpm install && pnpm test  # TS client (vitest) + pnpm build (tsc)
```

The Rust core and the TS client re-implement the same ~3 functions; shared test
vectors (see `client/src/__tests__`) keep them from drifting.

## License

Source code: MIT. Data artifacts: derived from Taiwan government open data under
the Open Government Data License v1.0 — redistribute with source + date
attribution. See [`LICENSE`](LICENSE).

## Disclaimer

Data is provided as-is from government sources and may lag reality by up to a
day (and excludes suspended/closed entities in the primary file). Verify
anything legally or financially significant against the official source.
