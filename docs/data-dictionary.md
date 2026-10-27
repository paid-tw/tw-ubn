# Data dictionary & sources

## Sources (verified 2026-10-27)

| Source | What | Access | Role |
| --- | --- | --- | --- |
| **FIA 全國營業(稅籍)登記資料集** (data.gov.tw/dataset/9400) | All VAT-registered entities (companies **and** 商號), with the invoice title and the uniform-invoice flag | Bulk `https://eip.fia.gov.tw/data/BGMOPEN1.zip`, updated **daily** | **Primary** |
| **FIA per-record API** | Single UBN lookup | `https://eip.fia.gov.tw/OAI/api/businessRegistration/{ban}` — documented at `/OAI/v2/api-docs`, CORS `*`, but `Cache-Control: private` | **Fallback** (behind your own edge cache) |
| **GCIS company registration** | Companies only (公司); legal name, status (核准/解散/撤銷), responsible person, capital | `https://data.gcis.nat.gov.tw/od/data/api/...` — JSON, **no CORS** (server-side only) | **Validation / enrichment** |

The FIA bulk file (`BGMOPEN1`) covers **active** entities only; a suspended/closed
set is published separately (`BGMOPEN1X`). Line 2 of the CSV is a sentinel row
holding the extract date (e.g. `27-OCT-26`) and must be dropped.

Both government sources are released under the **Open Government Data License
v1.0 (政府資料開放授權條款-第1版)**: redistribution is permitted with attribution
of the source and extraction date.

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

## GCIS company fields used for validation

`Company_Name`, `Company_Status_Desc` (e.g. 核准設立 / 解散 / 撤銷),
`Responsible_Name`, `Capital_Stock_Amount`, `Company_Setup_Date` (ROC),
`Revoke_App_Date`, suspension dates. Keyed by `Business_Accounting_NO` (= `ban`).

## Published artifacts

See `pipeline/build.sh`. `manifest.json` records `dataDate`, `rows`, `shards`
(default 8192), and `hash` (`fnv1a-32`) so clients shard identically.

## UBN checksum

`validateUBN()` implements the post-2023 rule (`sum % 5 === 0`, with the
7th-digit-is-7 exception). Verified against **all 1,714,969** active UBNs in the
2026-10-27 snapshot: 100% pass. The pre-2023 `% 10` rule matches only ~88% and
must not be used.
