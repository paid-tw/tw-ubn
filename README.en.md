# tw-ubn

[![CI](https://github.com/paid-tw/tw-ubn/actions/workflows/ci.yml/badge.svg)](https://github.com/paid-tw/tw-ubn/actions/workflows/ci.yml)
&nbsp;[繁體中文](README.md)

Free tier (R2 shards, runs on Workers Free):
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/paid-tw/tw-ubn/tree/main/worker)

Paid tier (D1, adds name search, needs Workers Paid):
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/paid-tw/tw-ubn/tree/main/worker-d1)

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
        FIA withholding units: BGMOPEN99.csv (nonprofits) + BGMOPEN99X.csv (schools) + agency list
           │
           ▼  ubn-build (Rust): normalize (ROC→ISO), merge + status / kind
         dist/
           ├─ shards/<n>.json   8192 per-UBN shards (ban → name/address/useInvoice/status/kind)
           ├─ ubn.sqlite        full dataset, indexed on ban
           ├─ ubn.ndjson.gz     full dataset, one JSON object per line
           └─ manifest.json     data date, rows, shards, hash, license

 checkout ─► your CDN (R2 + Cloudflare) ─► shards/<bucket>.json   (1 request, edge-cached)
                            miss ─► Worker ─► FIA per-record API ─► GCIS company registry (cached at edge)
```

- **FIA tax registry** is the primary source: it covers every VAT-registered
  entity (companies *and* 商號), and carries the invoice title and the
  uniform-invoice flag — exactly what checkout needs. Updated daily.
- Active-vs-suspended **status** comes from FIA itself (`BGMOPEN1` +
  `BGMOPEN1X`), so GCIS is not needed for it. Shard records include
  `status` (`active`, `suspended`, or `closed` — deregistered, withholding
  units only). Shards built before that field omit it; a missing value means
  unknown, not active. The suspension date is on the full dataset only, not on
  the checkout shard.
- **Withholding units** (schools, kindergartens, nonprofits, Executive Yuan
  agencies) hold a valid UBN without being VAT-registered, so they are not in
  the tax registry. The build merges them in, tagged by `kind` (`business` /
  `nonprofit` / `school` / `agency`), always with `useInvoice: false`.
- **GCIS** (company registration) has no usable bulk master (see
  [`docs/data-dictionary.md`](docs/data-dictionary.md)), so it is used at query
  time only: when both the dataset and FIA miss, the Worker asks GCIS, which
  knows dissolved/revoked companies (`status: "closed"`, `closedDate`) and live
  companies that aren't in the tax registry.
- A brand-new UBN not yet in the daily snapshot falls back to the **documented
  FIA per-record API**, behind your own edge cache so the government server is
  hit at most once per UBN per cache window — never per checkout.

## Client usage

```bash
npm install @paid-tw/ubn   # or pnpm add / yarn add
```

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

If you deploy the Worker below, use `lookupTitle` against its `/v1/vat/:ban`
instead. It **never throws** (an invalid checksum resolves to `null`, unlike
`lookupVAT`), and each of its three results means one thing:

```ts
import { lookupTitle, isSameTitle } from '@paid-tw/ubn';

const r = await lookupTitle(ban, { baseUrl: 'https://ubn.example.com', timeoutMs: 1500 });
if (r === null) {
  // no answer: bad checksum, timeout, network error, non-2xx (incl. the 502
  // for an upstream outage), or an unusable name (empty, PUA glyphs).
  // Show nothing; let the buyer type the title.
} else if (!r.found) {
  // the Worker says no such registration — only now ask the buyer to recheck.
} else {
  fillTitle(r.name);                     // r.status may be 'suspended' / 'closed'; your call
}

// compare a buyer-typed title with the registered name: ignores full/half
// width (NFKC), 臺/台, whitespace and Latin case; never rewrites legal forms
// such as 股份有限公司.
isSameTitle('臺灣ＡＢＣ　股份有限公司', '台灣abc股份有限公司'); // true
```

The `validateUBN` checksum is verified against all ~1.7M active UBNs (100%); it
uses the post-2023 rule, not the stale `% 10` one found in many snippets.

## Reading a lookup: not found ≠ invalid UBN

The Worker's `/v1/vat/:ban` answers in one of four ways:

| Response | Meaning | What checkout should do |
|---|---|---|
| `200 { "found": true, … }` | Found. `source` is `dataset` / `fia-api` / `gcis`; `status` is optional (`active` / `suspended` / `closed`) and absent on FIA-API hits and live GCIS companies — **missing means unknown, not active** | Fill in `name`; `suspended` and `closed` deserve a hint. Don't autofill a name flagged `nameHasPrivateUse` |
| `200 { "found": false }` | **No source returned a record**: the dataset, FIA and GCIS had nothing (if one of them failed, only the others were consulted) | A hint at most; let the buyer type the title. **Don't** block checkout |
| `400 { "error": "invalid_ubn" }` | Bad checksum — the UBN is certainly mistyped | Ask the buyer to check it |
| `502 { "found": null, "error": "upstream_unavailable" }` | Upstream outage — **no answer** | Treat as not looked up; show nothing |

`found: false` **does not mean the UBN is invalid**. Many valid, in-use UBNs have
no public source that carries the UBN: professional practices (accountants,
bookkeepers, lawyers, architects, land agents), hospitals and clinics, licensed
cram schools, long-term-care and social-welfare institutions, employee welfare
committees, daycare centres, building management committees, and more. Their
UBNs are withholding-unit UBNs issued by the tax bureau, but the Ministry of
Finance only publishes three such categories (schools, nonprofits, Executive
Yuan agencies). In a sample of ~40k real checkout UBNs, about 7% had a valid
checksum yet `found: false`, mostly in those categories.

Conversely, the `% 5` checksum doesn't catch every single-digit typo, so
`found: false` can also be a typo — which is exactly why it works as a
"please double-check" hint rather than an error. Categories and measurements:
[`docs/data-dictionary.md`](docs/data-dictionary.md#coverage-gaps-found-false-is-not-an-invalid-ubn).

## One-click lookup service (two versions)

The two **Deploy to Cloudflare** buttons each deploy a self-contained Worker to
your account:

| | Free `worker/` | Paid `worker-d1/` |
|---|---|---|
| Backend | R2 shards + FIA fallback | D1 (SQLite) + FIA fallback |
| Endpoints | `/v1/vat/:ban` | `/v1/vat/:ban` **+ `/v1/search?name=`** |
| Plan | **Workers Free is enough** | **Workers Paid** (the 1.7M-row initial load exceeds Free's 100k writes/day) |
| For | plain UBN → title autofill | you also need **name/company search** (D1's SQL edge) |

Both: `/v1/vat/:ban` validates the checksum → serves from the dataset (edge
cached) → else proxies the official FIA per-record API and caches it (government
hit at most once per UBN per cache window). CORS defaults to `*` (set
`ALLOWED_ORIGINS` for production); bindings are provisioned by the deploy flow,
and until the data is loaded it falls back to FIA — run the
[dataset workflow](.github/workflows/dataset.yml) to upgrade to "dataset first".

```
GET https://<your-worker>/v1/vat/22099131
→ { "found": true, "ban": "22099131", "name": "台灣積體電路製造股份有限公司", "source": "dataset" }

GET https://<your-worker-d1>/v1/search?name=台灣積體      # name prefix search, paid only
→ { "query": "台灣積體", "count": 1, "results": [ … ] }
```

> Why R2 by default, not D1? Measured on a real Cloudflare account — for plain
> point lookups R2 is cheaper: [docs/bench-r2-vs-d1.md](docs/bench-r2-vs-d1.md).
> D1's value is the name search.

## Repository layout

```
crates/ubn-core    Rust: UBN checksum, FNV shard hash, ROC date (source of truth)
crates/ubn-build   Rust: the build pipeline (a single binary, no external tools)
client/            TypeScript: @paid-tw/ubn, the browser checkout client
worker/            Cloudflare Worker (free): R2 shards + FIA fallback, one-click deploy
worker-d1/         Cloudflare Worker (paid): D1 backend + name search, one-click deploy
```

## Building the dataset

The pipeline is a self-contained Rust binary — no shell/node/duckdb toolchain:

```bash
cargo run --release -p ubn-build -- --out dist --shards 8192
# offline, against a local copy (skips the government fetch):
cargo run --release -p ubn-build -- --active-zip BGMOPEN1.zip --no-suspended --out dist
# incremental: pass the previous state.tsv to emit only the day's D1 upserts
cargo run --release -p ubn-build -- --out dist --prev prev/state.tsv
```

Every build also writes `state.tsv` (for the next diff), `d1/delta.sql`
(upserts + deletes) and `changed-shards.txt`. A daily run writes only changed
rows, so the D1 write cost drops to ~cents — see
[docs/bench-r2-vs-d1.md](docs/bench-r2-vs-d1.md).

CI runs it daily and publishes the artifacts; see
[`.github/workflows/dataset.yml`](.github/workflows/dataset.yml).

## Develop

```bash
cargo test                              # Rust: core + pipeline + real-UBN fixture
cd client && pnpm install && pnpm test  # TS client (vitest) + pnpm build (tsc)
```

The Rust core and the TS client re-implement the same ~3 functions; shared test
vectors (see `client/src/__tests__`) keep them from drifting.

## Releasing the client (npm)

`@paid-tw/ubn` (`client/`) publishes on a git tag: push `ubn-vX.Y.Z` and the
[release workflow](.github/workflows/release.yml) tests, builds, and publishes
via **npm OIDC trusted publishing (no token, with provenance)**.

```bash
cd client && npm version 0.1.1   # or edit package.json
git tag ubn-v0.1.1 && git push origin ubn-v0.1.1
```

## License

Source code: MIT. See [`LICENSE`](LICENSE).

The data artifacts are derived from open data released by
**財政部財政資訊中心** under **政府資料開放授權條款－第1版** (Open Government
Data License v1, <https://data.gov.tw/license>). The licence's exhibit says
that omitting the attribution means no licence was granted:

- Provider (提供機關／單位): 財政部財政資訊中心
- Datasets: 全國營業(稅籍)登記資料集 and 全國營業(稅籍)登記(停業)資料集
- Version: the extract date of that build, in `manifest.json` as `dataDate`
  and `attribution.datasets[].version`

此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。

政府資料開放授權條款：<https://data.gov.tw/license>

## Disclaimer

Data is provided as-is from government sources and may lag reality by up to a
day. Suspended rows are included with `status: "suspended"` (the suspension
date is on the full dataset only). Verify anything legally or financially
significant against the official source.
