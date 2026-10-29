# tw-ubn

[![CI](https://github.com/paid-tw/tw-ubn/actions/workflows/ci.yml/badge.svg)](https://github.com/paid-tw/tw-ubn/actions/workflows/ci.yml)
&nbsp;[English](README.en.md)

免費版（R2 分片，跑在 Workers Free）：
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/paid-tw/tw-ubn/tree/main/worker)

付費版（D1，含名稱搜尋，需 Workers Paid）：
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/paid-tw/tw-ubn/tree/main/worker-d1)

台灣營業人（統一編號）的開放資料集，**每日更新**；並附一個極小的客戶端，專做最常見的
情境：**結帳時輸入統編，自動帶出公司抬頭。**

設計目標是：查詢**在請求當下完全不依賴政府伺服器**，因此不會繼承官方查詢頁的慢、不穩與
限流。所有「每次查詢」的成本都在建檔時先付掉；每一次查詢只是一個對你自架靜態資料、可被
CDN 快取的請求。

## 運作原理

```
 每日  FIA 稅籍：BGMOPEN1.zip（營業中）+ BGMOPEN1X.csv（停業）
       FIA 扣繳單位：BGMOPEN99.csv（非營利）+ BGMOPEN99X.csv（學校）+ 行政院機關清單
          │
          ▼  ubn-build（Rust）：正規化（ROC→西元）、合併並標 status / kind
        dist/
          ├─ shards/<n>.json   8192 個逐統編分片（ban → name/address/useInvoice/status/kind）
          ├─ ubn.sqlite        完整資料集，統編建索引
          ├─ ubn.ndjson.gz     完整資料集，逐行 JSON
          └─ manifest.json     資料日期、筆數、片數、雜湊、授權

 結帳 ─► 你的 CDN（R2 + Cloudflare）─► shards/<bucket>.json   （一個請求、邊緣快取）
                       查無 ─► Worker ─► FIA 單筆 API ─► GCIS 公司登記（在邊緣快取）
```

- **FIA 稅籍**是主來源：涵蓋所有營業人（公司**與**商號），且帶有**發票抬頭**與**使用
  統一發票**旗標——正是結帳需要的。每日更新。
- **營業中／停業狀態**由 FIA 自己提供（`BGMOPEN1` + `BGMOPEN1X`），不需要 GCIS。
  分片上的 `status` 為 `active`、`suspended` 或 `closed`（只有扣繳單位會有，代表已註銷）。
  較早的分片沒有這個欄位；缺值代表未知，不要當成營業中。停業日期只在完整資料集，不在結帳分片。
- **扣繳單位**（學校、幼兒園、非營利機關團體、行政院所屬機關）有合法統編但不是營業人，
  不在稅籍裡；建檔時另外併入，以 `kind`（`business` / `nonprofit` / `school` / `agency`）
  區分，`useInvoice` 一律為 `false`。
- **GCIS**（公司登記）沒有可用的全量 master（詳見 [`docs/data-dictionary.md`](docs/data-dictionary.md)），
  所以只在查詢時用：資料集與 FIA 都查無時，Worker 再查 GCIS，找得到已解散／廢止的公司
  （`status: "closed"`、`closedDate`），或存續中但不在稅籍的公司。
- 尚未進入當日快照的新設統編，會 fallback 到**有官方文件的 FIA 單筆 API**，並擺在你
  自己的邊緣快取後面——政府伺服器每個統編每個快取週期最多被打一次，**絕不在每次結帳時**。

## 客戶端用法

```bash
npm install @paid-tw/ubn   # 或 pnpm add / yarn add
```

```ts
import { lookupVAT, validateUBN, InvalidUBNError } from '@paid-tw/ubn';

// 1. 先在本地驗證——格式/檢查碼不對就不發請求
if (validateUBN(ban)) {
  try {
    const rec = await lookupVAT(ban, { baseUrl: 'https://ubn.example.com', timeoutMs: 1500 });
    if (rec) fillTitle(rec.name);          // 取得抬頭
    // rec === null -> 統編有效但不在快照內；可選擇 fallback 到 FIA API
  } catch (e) {
    if (e instanceof InvalidUBNError) { /* 已先 validateUBN，理論上不會到這 */ }
    // 任何網路/逾時錯誤：讓買家自己輸入抬頭即可。
    // 自動帶入是加分功能——絕不因它而卡住結帳。
  }
}
```

`validateUBN` 的檢查碼已對全部約 170 萬筆營業中統編驗證（100% 通過），採用 **2023 年
後的規則**，而非許多網路片段裡過時的 `% 10` 版本。

## 一鍵部署查詢服務（兩個版本）

上面兩個 **Deploy to Cloudflare** 按鈕各部署一個自包含的 Worker 到你的帳號：

| | 免費版 `worker/` | 付費版 `worker-d1/` |
|---|---|---|
| 後端 | R2 分片 + FIA fallback | D1（SQLite）+ FIA fallback |
| 端點 | `/v1/vat/:ban` | `/v1/vat/:ban` **＋ `/v1/search?name=`** |
| 方案 | **Workers Free 即可** | **需 Workers Paid**（首載 340 萬列會撞 Free 的 10 萬寫入/日硬限制） |
| 適合 | 純統編→抬頭自動帶入 | 還要**名稱/公司搜尋**（D1 的 SQL 優勢） |

兩版共通：`/v1/vat/:ban` 先驗檢查碼 → 命中資料集就回（邊緣快取）→ 查無則轉打官方
FIA 單筆 API 並快取（政府每統編每快取週期最多被打一次）；CORS 預設 `*`，正式上線請在
`wrangler.jsonc` 的 `ALLOWED_ORIGINS` 設白名單；bindings 由部署流程自動建立，資料灌入前
會先走 FIA fallback，跑 [dataset workflow](.github/workflows/dataset.yml) 後升級為「資料集優先」。

```
GET https://<你的worker>/v1/vat/22099131
→ { "found": true, "ban": "22099131", "name": "台灣積體電路製造股份有限公司", "source": "dataset" }

GET https://<你的worker-d1>/v1/search?name=台灣積體      # 名稱前綴搜尋，付費版限定
→ { "query": "台灣積體", "count": 1, "results": [ … ] }
```

> 為何預設用 R2 而非 D1？在真實 Cloudflare 帳號上實測過延遲／成本／灌資料，純點查 R2 更省：
> [docs/bench-r2-vs-d1.md](docs/bench-r2-vs-d1.md)。D1 版的價值在於名稱搜尋。

## 專案結構

```
crates/ubn-core    Rust：統編檢查碼、FNV 分片雜湊、ROC 日期（權威來源）
crates/ubn-build   Rust：建檔 pipeline（單一 binary，無外部工具鏈）
client/            TypeScript：@paid-tw/ubn，瀏覽器結帳客戶端
worker/            Cloudflare Worker（免費版）：R2 分片 + FIA fallback，可一鍵部署
worker-d1/         Cloudflare Worker（付費版）：D1 後端 + 名稱搜尋，可一鍵部署
```

## 建置資料集

Pipeline 是自包含的 Rust binary——不需 shell/node/duckdb 工具鏈：

```bash
cargo run --release -p ubn-build -- --out dist --shards 8192
# 離線、對本機檔案跑（略過向政府下載）：
cargo run --release -p ubn-build -- --active-zip BGMOPEN1.zip --no-suspended --out dist
# 增量：帶上次的 state.tsv，只產出當日變動的 D1 upsert（dist/d1/delta.sql）
cargo run --release -p ubn-build -- --out dist --prev prev/state.tsv
```

每次建置都會輸出 `state.tsv`（供下次 diff）、`d1/delta.sql`（upsert+delete）、
`changed-shards.txt`。日更只寫變動列，D1 寫入成本因此趨近於零——比較見
[docs/bench-r2-vs-d1.md](docs/bench-r2-vs-d1.md)。

CI 每日執行並發布產物，見 [`.github/workflows/dataset.yml`](.github/workflows/dataset.yml)。

## 開發

```bash
cargo test                              # Rust：core + pipeline + 真實統編 fixture
cd client && pnpm install && pnpm test  # TS 客戶端（vitest）+ pnpm build（tsc）
```

Rust core 與 TS 客戶端各自實作同樣的 ~3 個函式；共用的測試向量（見
`client/src/__tests__`）確保兩邊不會走鐘。

## 發行客戶端（npm）

`@paid-tw/ubn`（`client/`）以 git tag 觸發發行：推一個 `ubn-vX.Y.Z` tag，
[release workflow](.github/workflows/release.yml) 會測試、建置並以 **npm OIDC
trusted publishing（免 token、附 provenance）** 發佈。

```bash
cd client && npm version 0.1.1   # 更新 package.json 版本
git tag ubn-v0.1.1 && git push origin ubn-v0.1.1
```

## 授權

原始碼：MIT。見 [`LICENSE`](LICENSE)。

資料產物衍生自**財政部財政資訊中心**的開放資料，授權為**政府資料開放授權條款－第1版**
（Open Government Data License v1，<https://data.gov.tw/license>）。未附上顯名聲明，
視同自始未取得授權：

- 提供機關／單位：財政部財政資訊中心
- 資料集：全國營業(稅籍)登記資料集、全國營業(稅籍)登記(停業)資料集
- 版本：各次建置的擷取日期，見該次 `manifest.json` 的 `dataDate` 與
  `attribution.datasets[].version`

此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。

政府資料開放授權條款：<https://data.gov.tw/license>

## 免責聲明

資料以政府來源原樣提供，可能落後現況最多一天。停業列的 `status` 為 `suspended`
（停業日期只在完整資料集）。涉及法律或財務的重要用途，請以官方來源為準。
