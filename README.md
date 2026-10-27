# tw-ubn

An open, **daily-updated** dataset of Taiwan business registrations (統一編號 /
UBN), plus a tiny client for the most common use case: **at checkout, the buyer
types their UBN and the company title (抬頭) auto-fills.**

The design goal is that the lookup never depends on a government server at
request time — so it can't inherit the slowness, instability, and throttling of
the official query pages. All per-query cost is paid at build time; every lookup
is a single cache-friendly request to static data you host yourself.

## How it works

```
 daily   FIA 稅籍 bulk (BGMOPEN1.zip)  ─┐
                                         ├─►  build  ─►  dist/
 (opt)   GCIS company registration  ────┘      │          ├─ ubn.ndjson.gz   full dataset
                                                │          ├─ ubn.sqlite      indexed on ban
         normalize: ROC→ISO, status,           │          ├─ ubn.duckdb      analytics
         checksum-verify, name cross-check      │          ├─ shards/<n>.json 8192 static shards
                                                           └─ manifest.json

 checkout  ──►  your CDN (R2 + Cloudflare)  ──►  shards/<bucket>.json   (1 request, edge-cached)
                                  miss ──►  Worker ──►  FIA per-record API (cached at edge)
```

- **FIA tax registry** is the primary source: it covers every VAT-registered
  entity (companies *and* 商號), and carries the invoice title and the
  uniform-invoice flag — exactly what checkout needs. Updated daily.
- **GCIS** (company registration) is used server-side to cross-check the legal
  name and detect dissolved/revoked companies.
- A brand-new UBN not yet in the daily snapshot falls back to the **documented
  FIA per-record API**, behind your own edge cache so the government server is
  hit at most once per UBN per cache window — never per checkout.

See [`docs/data-dictionary.md`](docs/data-dictionary.md) for sources, fields,
and license.

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

## Building the dataset

```bash
# requires: curl, unzip, sqlite3, node, and the `duckdb` CLI on PATH
pnpm dataset        # -> dist/
```

CI runs this daily and publishes the artifacts; see
[`.github/workflows/dataset.yml`](.github/workflows/dataset.yml).

## Develop

```bash
pnpm install
pnpm test           # vitest
pnpm build          # tsc -> dist/
```

## License

Source code: MIT. Data artifacts: derived from Taiwan government open data under
the Open Government Data License v1.0 — redistribute with source + date
attribution. See [`LICENSE`](LICENSE).

## Disclaimer

Data is provided as-is from government sources and may lag reality by up to a
day (and excludes suspended/closed entities in the primary file). Verify
anything legally or financially significant against the official source.
