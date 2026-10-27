# Serving the lookup: R2 shards vs D1 — measured

Which backend should the lookup Worker read from — R2 static shards or a D1
(SQLite) point query? Measured on a real Cloudflare account (`cf` CLI) with the
`bench/` Worker, 2026-10-27.

## Method

- `bench/` Worker with two routes over the **same** synthetic data: `/d1/:ban`
  (indexed `SELECT ... WHERE ban = ?`) and `/r2/:ban` (GET the shard object,
  `JSON.parse`, find). Seeded via the Worker itself against real bindings.
- 5,000 rows, 25 shards (~200 rows/shard ≈ the production 8192-shard size).
- Resources created with `cf d1 create` / `cf r2 buckets create`; Worker
  deployed with Wrangler using the `cf` OAuth token; torn down afterwards.
- Latency from `curl %{time_total}`, 100 requests/route, varied UBNs, edge
  cache disabled (`no-store`) so every request hits the backend.
- **Caveat:** one account, one client. The client egress landed on the **DFW**
  PoP, so "colocated" below means data in **ENAM**; "cross-region" means data in
  **APAC**. Absolute numbers include client↔PoP RTT; the Worker→backend *delta*
  is the signal. Cost figures are Cloudflare list prices, not measured.

## Latency

**Colocated (Worker PoP and data in the same region), warm reused connection:**

| | p50 | p90 | p99 | backend-only (p50 − baseline) |
|---|---|---|---|---|
| baseline `/` (no backend) | 22 ms | 36 ms | 69 ms | — |
| **D1** point query | 61 ms | 76 ms | 119 ms | **≈ 39 ms** |
| **R2** shard get+parse | 79 ms | 130 ms | 175 ms | **≈ 57 ms** |

Colocated, the indexed **D1 point query is faster and tighter-tailed** than
fetching+parsing an ~8 KB shard. R2's tail is worse (cold-object variance;
new-connection run showed a 1.4 s max).

**Cross-region (Worker DFW ↔ data APAC), new connection/request:**

| | p50 | p90 | p99 |
|---|---|---|---|
| D1 | 323 ms | 371 ms | 433 ms |
| R2 | 289 ms | 358 ms | 496 ms |

Both are swamped by the ~270 ms trans-Pacific RTT and are indistinguishable.
D1 has a **single primary region**: a far client pays this on every read unless
read-replication is enabled. R2 fronted by the CDN caches at the edge globally.

## Ingestion (measured)

Seeding 5,000 rows through the Worker: **31 s (APAC) / 11 s (ENAM)**. That is the
decisive operational difference:

- **R2**: a rebuild rewrites 8,192 small objects — fast, flat, cheap.
- **D1**: the FIA snapshot is a **full** daily dump (no diffs). Reloading all
  ~1.7 M rows daily extrapolates to a very slow job and a large write volume
  (see cost). Incremental upserts need diffing you'd have to build yourself.

## Cost (Cloudflare list prices)

| | R2 (shards + CDN) | D1 |
|---|---|---|
| Storage | $0.015/GB·mo → ~330 MB ≈ **$0.005/mo** | $0.75/GB·mo (5 GB free) |
| Writes (rebuild) | Class A $4.50/M → 8,192/day ≈ **~$1/mo** | rows written **$1.00/M** → 1.7 M/day full reload ≈ **~$50/mo** |
| Reads (lookups) | Class B $0.36/M, **and CDN-cached hits don't bill**; egress **free** | rows read $0.001/M (point lookup ≈ 1 row, cheap) |
| Free-tier ceiling | generous | **100 k writes/day** → a 1.7 M full reload is impossible on free |

## Verdict

For the checkout point lookup (統編 → 抬頭), **R2 static shards + CDN wins** — not
on raw query latency (colocated D1 is actually a touch faster), but on everything
around it:

- **Ingestion**: rewrite 8 k files vs reload 1.7 M rows daily.
- **Cost**: cents/month, egress-free, cache-served reads don't bill — vs ~$50/mo
  of D1 writes for a daily full reload.
- **Topology**: shards serve from the edge globally (even with **zero** compute —
  pure static R2+CDN, no Worker); D1 has one primary region.
- In steady state both sit behind a cache and resolve in ~RTT, so latency is a
  wash; the differentiators are ingestion, cost, and reach.

**Choose D1 instead when you need SQL**: name/fuzzy search (FTS5), filtering, or
joins (e.g. GCIS 負責人), and you can run incremental ingestion. Exact-UBN
autofill needs none of that, so the shard approach stays the default; a future
name-search feature is the reason to add D1 alongside it.

## Reproduce

`bench/` holds the Worker. Create a D1 + R2 (APAC or ENAM), put their ids in
`bench/wrangler.jsonc`, deploy, `curl /seed?n=5000&shards=25`, then measure
`/d1/:ban` and `/r2/:ban`. Delete the resources afterwards.
