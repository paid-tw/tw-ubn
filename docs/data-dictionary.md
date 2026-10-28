# Data dictionary & sources

## Sources (verified 2026-10-27)

| Source | What | Access | Role |
| --- | --- | --- | --- |
| **FIA 全國營業(稅籍)登記資料集** (data.gov.tw/dataset/9400) | All VAT-registered entities (companies **and** 商號), with the invoice title and the uniform-invoice flag | Bulk `https://eip.fia.gov.tw/data/BGMOPEN1.zip`, updated **daily** | **Primary** |
| **FIA per-record API** | Single UBN lookup | `https://eip.fia.gov.tw/OAI/api/businessRegistration/{ban}` — documented at `/OAI/v2/api-docs`, CORS `*`, but `Cache-Control: private` | **Fallback** (behind your own edge cache) |
| **GCIS company registration** | Companies only (公司); legal name, status (核准/解散/撤銷), responsible person, capital | `https://data.gcis.nat.gov.tw/od/data/api/...` — JSON, **no CORS** (server-side only) | **Validation / enrichment** |

The FIA bulk file (`BGMOPEN1`) covers **active** entities only; a suspended/closed
set is published separately (`BGMOPEN1X`, a plain CSV — there is no `.zip` for it).
Line 2 of the CSV is a sentinel row holding the extract date (e.g. `27-OCT-26`)
and must be dropped.

### Is there a GCIS bulk master? (investigated 2026-10-27)

No usable one. GCIS (經濟部商業發展署) exposes company data three ways, none a
maintained full dump:

- **Per-record API** (`/od/data/api/{resource}`): requires a `$filter`; with no
  filter it returns `此API不存在` / `$filter參數有誤`, so you cannot page the whole
  set. It is query-by-UBN only. Used here for per-record enrichment.
- **`reportCity.jsp`**: monthly **PDF** bulletins per city (`…Asetup/change/rest…pdf`)
  — unstructured deltas, not usable as data.
- **商業設立登記清冊(月份)** (data.gov.tw/dataset/6668): downloadable **monthly
  CSVs** (`/od/file?oid=…`, UTF-8 with BOM) with columns 序號, 縣市名稱, 統一編號,
  商業名稱, 商業所在地, 資本額, 組織型態, **負責人**, 設立日期, 核准文號. These are the
  real downloadable files and carry the responsible person — but they are
  **setup-event increments** (new registrations that month; ~3–4k rows/file;
  no later name changes or closures), cover **商業 (sole-prop/partnership) only**
  (companies are a parallel dataset), and start 2013-10. A full 統編→負責人 map
  would mean concatenating ~156 files and de-duplicating by UBN.

**Decision:** FIA (`BGMOPEN1` + `BGMOPEN1X`) is the bulk source and already
covers name / invoice flag / industry / address / status. GCIS responsible-person
enrichment is a possible **phase 3** (concatenate the monthly 設立 registers), not
required for the checkout title lookup.

Both government sources are released by their providers under the
**政府資料開放授權條款－第1版** (Open Government Data License v1,
<https://data.gov.tw/license>). The FIA bulk files this repository republishes
must carry the 顯名聲明 described under [Licence](#licence). Omitting it means
the licence was not granted.

## FIA tax-registry columns (BGMOPEN1.csv)

UTF-8, no BOM. Original header → field name used in this repo:

| Original (zh) | Field | Notes |
| --- | --- | --- |
| 營業地址 | `address` | Quoted; may contain full-width digits |
| 統一編號 | `ban` | 8-digit UBN (primary key) |
| 總機構統一編號 | `hq_ban` | HQ UBN for branches; usually empty |
| 營業人名稱 | `name` | **Invoice title (抬頭)** |
| 資本額 | `capital` | Integer TWD, as text |
| 設立日期 | `setup_date` | ROC date (e.g. `0760321`); use `rocToISO()` |
| 組織別名稱 | `org_type` | 獨資 / 股份有限公司 / … |
| 使用統一發票 | `use_invoice` | `Y` / `N` |
| 行業代號, 名稱 | `industry_code`, `industry_name` | Primary industry |
| 行業代號1..3, 名稱1..3 | `industry_code1..3`, `industry_name1..3` | Additional industries |

`ubn-build` maps those columns **by header name, in any order**. The header
must be exactly this set. An extra, missing, duplicate, or empty column name
aborts the build — a positional read will not be guessed. Both files start
with a sentinel row (the extract date in `營業地址`, empty 統一編號), which
is recorded as `dataDate` and dropped.

### Suspended file (`BGMOPEN1X.csv`)

Same columns as `BGMOPEN1`, plus `停業日期` (ROC `YYYMMDD`, occasionally
blank). In the upstream file it sits between `組織別名稱` and `使用統一發票`;
the parser does not depend on that position. The expected header is the
active set plus `停業日期`, and any other shape is an error.

| Published field | Notes |
| --- | --- |
| `suspension_date` | Raw ROC date, or null when the cell is blank. Absent as a value on active rows (the column is not in `BGMOPEN1`). |
| `suspension_date_iso` | `roc_to_iso(suspension_date)`; null when the raw value is missing or not a real month/day. |
| `status` | `suspended` for this file, `active` for `BGMOPEN1`. Stored on the full dataset and on each shard record. |

On the 2026-10-27 extract (sentinel `28-OCT-26`) the suspended file has
114,612 data rows, of which **94,999** have `使用統一發票=Y` and 19,613 have
`N`. A positional parse of that file reported `Y` for **0** rows, because
index 7 is `停業日期`.

## GCIS company fields used for validation

`Company_Name`, `Company_Status_Desc` (e.g. 核准設立 / 解散 / 撤銷),
`Responsible_Name`, `Capital_Stock_Amount`, `Company_Setup_Date` (ROC),
`Revoke_App_Date`, suspension dates. Keyed by `Business_Accounting_NO` (= `ban`).

## Published artifacts

See `crates/ubn-build` (`src/main.rs`). `manifest.json` records `dataDate`,
`rows`, `shards` (default 8192), and `hash` (`fnv1a-32`) so clients shard
identically.

`shards/<n>.json` is a JSON array of `{ban, name, address, useInvoice, status}`.

For D1, the build also emits `d1/schema.sql` (create), `d1/migrate.sql`
(idempotent `ADD COLUMN` for older tables), `d1/delta.sql` (the day's upserts +
deletes vs `--prev`), and `d1/full.sql` (a `DELETE` + all-rows reload). The
workflow applies the delta only when D1's own checkpoint matches — a checkpoint
of `"<state-sha> <target-fingerprint>"` (the sha256 of the `state.tsv` D1 last
reflected plus a sha256 of account/database), stored separately from dataset
publication. A fresh or out-of-sync D1, or a changed target (e.g. repointed at a
new database), fails the match and gets a `full.sql` reload so unchanged rows
are never left missing.
`status` is `"active"` or `"suspended"`. Shards built before that field existed
omit it; clients must treat a missing `status` as unknown, not as active.
Adding the field is backward compatible for readers that ignore unknown JSON
keys. `suspension_date` is not copied onto shards; it is only on
`ubn.ndjson.gz` and `ubn.sqlite`.

## Licence

`manifest.json` (written by `ubn-build`) is the per-build copy of the
Open Government Data License exhibit. `attribution` contains:

1. `exhibit` — 提供機關／單位, year, and dataset name plus version. The
   version is the CSV sentinel date (for example `28-OCT-26`); these files
   are replaced daily and have no separate version number. `dataDate` is the
   active file's sentinel; `suspendedDataDate` is the suspended file's.
2. `statement` — 「此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。」
3. `licenseUrl` — <https://data.gov.tw/license>

| Dataset | Provider | Catalog | File |
| --- | --- | --- | --- |
| 全國營業(稅籍)登記資料集 | 財政部財政資訊中心 | <https://data.gov.tw/dataset/9400> | `BGMOPEN1.zip` |
| 全國營業(稅籍)登記(停業)資料集 | 財政部財政資訊中心 | <https://data.gov.tw/dataset/75140> | `BGMOPEN1X.csv` |

The dataset workflow turns `attribution.exhibit`, `attribution.statement`, and
`attribution.licenseUrl` into the GitHub Release notes. `--no-suspended`
drops the suspended dataset from the exhibit.

## UBN checksum

`validateUBN()` implements the post-2023 rule (`sum % 5 === 0`, with the
7th-digit-is-7 exception). Verified against **all 1,714,969** active UBNs in the
2026-10-27 snapshot: 100% pass. The pre-2023 `% 10` rule matches only ~88% and
must not be used.
