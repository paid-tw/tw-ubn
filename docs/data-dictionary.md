# Data dictionary & sources

## Sources (verified 2026-10-27)

| Source | What | Access | Role |
| --- | --- | --- | --- |
| **FIA 全國營業(稅籍)登記資料集** (data.gov.tw/dataset/9400) | All VAT-registered entities (companies **and** 商號), with the invoice title and the uniform-invoice flag | Bulk `https://eip.fia.gov.tw/data/BGMOPEN1.zip`, updated **daily** | **Primary** |
| **FIA per-record API** | Single UBN lookup | `https://eip.fia.gov.tw/OAI/api/businessRegistration/{ban}` — documented at `/OAI/v2/api-docs`, CORS `*`, but `Cache-Control: private` | **Fallback** (behind your own edge cache) |
| **GCIS company registration** | Companies only (公司); legal name, status (核准/解散/撤銷), responsible person, capital | `https://data.gcis.nat.gov.tw/od/data/api/...` — JSON, **no CORS** (server-side only) | **Validation / enrichment** |
| **FIA withholding units** (扣繳單位; data.gov.tw 34147, 75136, 44806 — verified 2026-10-29) | Nonprofits, schools and Executive Yuan agencies: UBNs that are not VAT-registered | `BGMOPEN99.csv`, `BGMOPEN99X.csv`, and the agency list — see [Withholding units](#withholding-units) | **Secondary** (`kind` ≠ `business`) |

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
| 營業人名稱 | `name` | **Invoice title (抬頭)**. May contain Private Use Area characters; see `name_has_private_use` |
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

## Withholding units

Schools, nonprofits and government agencies hold a UBN as a withholding unit
(扣繳單位) without being VAT-registered, so they are absent from `BGMOPEN1` /
`BGMOPEN1X`. The FIA publishes three lists of them, all under the same
licence. Downloaded and checked on 2026-10-29:

| File | Dataset | Updated | Rows | Format |
| --- | --- | --- | ---: | --- |
| `https://eip.fia.gov.tw/data/BGMOPEN99.csv` | 非營利事業機關團體資料集 ([34147](https://data.gov.tw/dataset/34147)), 所得稅法 §11(4) bodies | daily | 99,815 | UTF-8, LF, no BOM; sentinel `,1151030,,,,` (ROC date) |
| `https://eip.fia.gov.tw/data/BGMOPEN99X.csv` | 全國各級學校統一編號資料集 ([75136](https://data.gov.tw/dataset/75136)), schools and kindergartens | monthly | 12,178 | UTF-8, LF, no BOM; sentinel `,01-OCT-26,,,,` |
| `https://www.fia.gov.tw/download/9bc4de1485014443b518beb37d8f35fe` (`機關名單.csv`) | 行政院所屬各機關同意開放統一編號資料集 ([44806](https://data.gov.tw/dataset/44806)) | irregular | 610 (606 distinct UBNs) | UTF-8, CRLF, no BOM, every field quoted, names right-padded with spaces; no sentinel |

`BGMOPEN99` and `BGMOPEN99X` share the header
`統一編號,單位名稱,機關所在縣市,最近異動日期,最近異動原因,原因說明文字`.
The agency list has only `統一編號,機關單位名稱`. As with `BGMOPEN1`,
columns are matched by name and any other header aborts the build; the
sentinel (empty 統一編號, date in the name column) is recorded and dropped.
The agency list repeats four UBNs, one of them under two names
(`91002127`); the first row wins.

| Original (zh) | Field | Notes |
| --- | --- | --- |
| 統一編號 | `ban` | |
| 單位名稱 / 機關單位名稱 | `name` | The registered withholding-unit name; usable as the invoice title. |
| 機關所在縣市 | `address` | **County/city only** (e.g. `臺北市`) — the only location these files give. Empty for agencies, and on 86 rows of the two other files (82 + 4). |
| 最近異動原因 | `status` | See below. |
| 最近異動日期, 原因說明文字 | — | Not published. The date column holds some malformed values (e.g. `115702`). |

`最近異動原因` is the latest registration event, so a deregistered unit stays
in the file. Codes seen on 2026-10-29:

| Code | Meaning | `BGMOPEN99` | `BGMOPEN99X` | `status` |
| --- | --- | ---: | ---: | --- |
| 01 | 新設立 / 申請設立登記 | 4,311 | 346 | `active` |
| 02 | 變更負責人 | 83,896 | 8,195 | `active` |
| 03 | 變更名稱 | 1,339 | 121 | `active` |
| 04 | 地址變更 | 1,410 | 44 | `active` |
| 11 | 註銷稅籍 / 一般註銷 | 6,073 | 3,082 | **`closed`** |
| 12 | 申請停業 | 1 | 25 | `suspended` |
| 13 | 申請復業 | 2 | 1 | `active` |
| 16 | 補建檔 | — | 1 | `active` |
| 17 | 撤銷登記 / 廢止(撤銷)登記 | 1,217 | 115 | **`closed`** |
| 18 | 擅自歇業(他遷不明) | 1,494 | 226 | **`closed`** |
| 20 | 變更統一編號 | 3 | 2 | `active` |
| 49 | 資料釐正 | 69 | 20 | `active` |

Any other code maps to `active`. The agency list has no status column; its
rows are `active`.

None of the three files has capital, setup date, organisation type, the
invoice flag or industries, so on these rows `capital`, `setup_date` and
`org_type` are `""`, `setup_date_iso` and the suspension dates are null,
`use_invoice` is `false`, and `industries` is `[]`.

**Overlaps and precedence.** A UBN that appears in more than one file is
published once. Precedence, highest first: `BGMOPEN1` (active) >
`BGMOPEN1X` (suspended) > `BGMOPEN99X` (school) > `BGMOPEN99` (nonprofit) >
agency list. On 2026-10-29 the three lists held 112,133 distinct UBNs; 66
(all on the agency list) are also VAT-registered and keep their business
row; 458 are both nonprofit and school (school foundations, with identical
status) and 8 both school and agency (agency-run academies), which become
`school`. The build added 112,067 rows, for 1,941,938 in total:

| `kind` | `active` | `suspended` | `closed` |
| --- | ---: | ---: | ---: |
| `business` | 1,715,355 | 114,516 | — |
| `nonprofit` | 90,620 | 1 | 8,736 |
| `school` | 8,730 | 25 | 3,423 |
| `agency` | 532 | — | — |

Skip the files with `--no-nonprofit`, `--no-school`, `--no-agency`, or all
three with `--no-withholding`; `--nonprofit-csv`, `--school-csv` and
`--agency-csv` read local copies instead of fetching.

## GCIS company fields used for validation

`Company_Name`, `Company_Status_Desc` (e.g. 核准設立 / 解散 / 撤銷),
`Responsible_Name`, `Capital_Stock_Amount`, `Company_Setup_Date` (ROC),
`Revoke_App_Date`, suspension dates. Keyed by `Business_Accounting_NO` (= `ban`).

## Published artifacts

See `crates/ubn-build` (`src/main.rs`). `manifest.json` records `dataDate`,
`rows`, `shards` (default 8192), and `hash` (`fnv1a-32`) so clients shard
identically.

`shards/<n>.json` is a JSON array of `{ban, name, address, useInvoice, status, kind}`,
plus `nameHasPrivateUse: true` on rows whose name has a
[Private Use Area character](#private-use-area-characters-in-name).

For D1, the build also emits `d1/schema.sql` (create), `d1/migrate.sql`
(idempotent `ADD COLUMN` for older tables), `d1/delta.sql` (the day's upserts +
deletes vs `--prev`), and `d1/full.sql` (a `DELETE` + all-rows reload). The
workflow applies the delta only when D1's own checkpoint matches — a checkpoint
of `"<state-sha> <target-fingerprint>"` (the sha256 of the `state.tsv` D1 last
reflected plus a sha256 of account/database), stored separately from dataset
publication. A fresh or out-of-sync D1, or a changed target (e.g. repointed at a
new database), fails the match and gets a `full.sql` reload so unchanged rows
are never left missing.
`status` is `"active"`, `"suspended"` or `"closed"` (deregistered; only
withholding units carry it — see [Withholding units](#withholding-units)).
Shards built before that field existed omit it; clients must treat a missing
`status` as unknown, not as active. Adding the field is backward compatible
for readers that ignore unknown JSON keys. `suspension_date` is not copied
onto shards; it is only on `ubn.ndjson.gz` and `ubn.sqlite`.

`kind` is `"business"` (the VAT registry, `BGMOPEN1` / `BGMOPEN1X`),
`"nonprofit"`, `"school"` or `"agency"`. It is on every row of the full
dataset, the shards, `ubn.sqlite` and D1. Shards built before it existed omit
it, and D1 rows loaded before it have `kind` NULL until that row is next
upserted; a missing `kind` means unknown. Adding `kind` changed every row's
hash, so the first build after it upserts every row into D1 once.

### Private Use Area characters in `name`

`name` is published exactly as the registry has it, and some names contain
Unicode Private Use Area (PUA) code points — characters the tax-registry
system defined locally (造字). They render as boxes in ordinary fonts, and an
e-invoice platform is unlikely to accept them in a buyer title. On the
2026-10-29/30 files, 472 business names (463 active, 9 suspended), 34
nonprofit names and 3 school names contain one; e.g. `00426115` ends in
U+F585, and the most common code point is U+FA3FE.

A row whose `name` has any code point in U+E000–U+F8FF, U+F0000–U+FFFFD or
U+100000–U+10FFFD carries a flag:

| Where | Field | Value |
| --- | --- | --- |
| `ubn.ndjson.gz` | `name_has_private_use` | `true`; **omitted** when false |
| shards, lookup API | `nameHasPrivateUse` | `true`; **omitted** when false |
| `ubn.sqlite`, D1 | `name_has_private_use` | `1` / `0`; NULL on D1 rows loaded before the column existed (= false) |

`manifest.json` reports the number of flagged rows as `namesWithPrivateUse`.
A client should not autofill a flagged name as an invoice title as is; let the
buyer type it.

The PUA characters are **not converted** to standard Unicode. Which
private character set the registry uses (for example, whether it matches the
CNS 11643 全字庫 mapping) has not been verified, so there is no conversion
table. Because the flag is serialized only when true, adding it changed the
row hash of flagged rows only.

## Coverage gaps: `found: false` is not an invalid UBN

A lookup answers `found: false` when the UBN is in none of: the VAT registry
(`BGMOPEN1` / `BGMOPEN1X`), the [withholding units](#withholding-units) we
include, the FIA per-record API (404), or GCIS company registration. If GCIS
was unavailable, only the first three were checked (that `found: false` is not
cached). Either way it means "not in any source we have", **not** "this UBN does
not exist". Integrators should treat it as a hint and let the buyer type the
title.

### Valid UBNs with no public source (measured 2026-10-29, [#8](https://github.com/paid-tw/tw-ubn/issues/8))

From one real checkout system's 39,509 distinct UBNs, 2,739 (6.9%) had a valid
checksum but were absent from the VAT registry, the three withholding-unit
lists, and GCIS company registration. Classified by the title the buyer typed:

| Category (by title keyword) | UBNs | Source checked | Carries the UBN? |
|---|---:|---|---|
| Professional practices (會計師, 記帳士, 律師, 建築師, 地政士 …) | 1,028 | Searched; no public roster with UBNs found | Not found |
| Hospitals, clinics, other medical institutions | 460 | [醫療機構基本資料](https://data.gov.tw/dataset/15393) | No — `機構代碼` only |
| Companies / 商號 | 350 | GCIS business (商號) registration — unmeasured, see below | — |
| Licensed cram schools (短期補習班) | 259 | [全國立案短期補習班基本資料](https://data.gov.tw/dataset/16461); [商業登記－短期補習班業](https://data.gov.tw/dataset/81117) | First: no. Second: yes, but 107 rows, 0 hits |
| Long-term care, nursing homes, social welfare | 196 | [長照ABC據點](https://data.gov.tw/dataset/88270) | No — `機構代碼` only |
| Other / can't tell from the title | 157 | — | — |
| Employee welfare committees (職工福利委員會) | 129 | Searched; only one city-level dataset, empty | Not found |
| Daycare (托嬰中心; kindergartens are in `BGMOPEN99X`) | 57 | Searched; county statistics and rosters only | Not found |
| Scattered: agencies, juridical persons, building committees, religious bodies, schools | 103 | — | — |

"No" was confirmed from the dataset's field list on data.gov.tw; "Not found"
only means a search turned nothing up. These units hold withholding-unit UBNs
(扣繳單位統編) issued by the tax bureau, but the Ministry of Finance publishes
only schools, nonprofits and Executive Yuan agencies.

The 商號 row is unmeasured because the GCIS business-registration API
(`7E6AFA72-AD6A-46D3-8681-ED77951D912D`, filtered by `President_No`) returned
HTTP 200 with an empty body for every call in the batch, while single manual
queries before it worked. The Workers don't query it.

### Typos that pass the checksum

In the same sample, 53 UBNs with a valid checksum and `found: false` had a
buyer-typed title that matched, in the dataset, a UBN differing in one or two
digits — almost certainly typos. The `% 5` checksum doesn't catch every
single-digit error. (For comparison, 129 of the 189 UBNs that *failed* the
checksum could be corrected the same way.) This is another reason to show
`found: false` as "please double-check" rather than as an error.

### Not done: a `reason` field

The lookup does not say *why* a UBN was not found (e.g. `not_in_registry`).
Until there is a source that can tell these categories apart, a single
`found: false` is more honest than a guess. Terminated companies are the
exception: GCIS identifies them, so they come back as `found: true` with
`status: "closed"`.

## Licence

`manifest.json` (written by `ubn-build`) is the per-build copy of the
Open Government Data License exhibit. `attribution` contains:

1. `exhibit` — 提供機關／單位, year, and dataset name plus version. The
   version is the CSV sentinel date (for example `28-OCT-26`, or the ROC
   `1151030` of `BGMOPEN99`); these files are replaced in place and have no
   separate version number. The agency list has no sentinel and is labelled
   `版本未標示`. `dataDate` is the active file's sentinel;
   `suspendedDataDate` is the suspended file's; the withholding files' dates
   are only in `attribution.datasets[].version`.
2. `statement` — 「此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。」
3. `licenseUrl` — <https://data.gov.tw/license>

| Dataset | Provider | Catalog | File |
| --- | --- | --- | --- |
| 全國營業(稅籍)登記資料集 | 財政部財政資訊中心 | <https://data.gov.tw/dataset/9400> | `BGMOPEN1.zip` |
| 全國營業(稅籍)登記(停業)資料集 | 財政部財政資訊中心 | <https://data.gov.tw/dataset/75140> | `BGMOPEN1X.csv` |
| 非營利事業機關團體資料集 | 財政部財政資訊中心 | <https://data.gov.tw/dataset/34147> | `BGMOPEN99.csv` |
| 全國各級學校統一編號資料集 | 財政部財政資訊中心 | <https://data.gov.tw/dataset/75136> | `BGMOPEN99X.csv` |
| 行政院所屬各機關同意開放統一編號資料集 | 財政部財政資訊中心 | <https://data.gov.tw/dataset/44806> | `機關名單.csv` |

The dataset workflow turns `attribution.exhibit`, `attribution.statement`, and
`attribution.licenseUrl` into the GitHub Release notes. `--no-suspended`,
`--no-nonprofit`, `--no-school` and `--no-agency` drop that dataset from the
exhibit; every file a build loads is listed.

## UBN checksum

`validateUBN()` implements the post-2023 rule (`sum % 5 === 0`, with the
7th-digit-is-7 exception). Verified against **all 1,714,969** active UBNs in the
2026-10-27 snapshot: 100% pass. The pre-2023 `% 10` rule matches only ~88% and
must not be used.
