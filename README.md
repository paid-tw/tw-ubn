# tw-ubn

[![CI](https://github.com/paid-tw/tw-ubn/actions/workflows/ci.yml/badge.svg)](https://github.com/paid-tw/tw-ubn/actions/workflows/ci.yml)
&nbsp;[English](README.en.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/paid-tw/tw-ubn/tree/main/worker)

台灣營業人（統一編號）的開放資料集，**每日更新**；並附一個極小的客戶端，專做最常見的
情境：**結帳時輸入統編，自動帶出公司抬頭。**

設計目標是：查詢**在請求當下完全不依賴政府伺服器**，因此不會繼承官方查詢頁的慢、不穩與
限流。所有「每次查詢」的成本都在建檔時先付掉；每一次查詢只是一個對你自架靜態資料、可被
CDN 快取的請求。

## 運作原理

```
 每日  FIA 稅籍：BGMOPEN1.zip（營業中）+ BGMOPEN1X.csv（停業）
          │
          ▼  ubn-build（Rust）：正規化（ROC→西元）、合併並標 status
        dist/
          ├─ shards/<n>.json   8192 個逐統編分片（ban → name/address/useInvoice/status）
          ├─ ubn.sqlite        完整資料集，統編建索引
          ├─ ubn.ndjson.gz     完整資料集，逐行 JSON
          └─ manifest.json     資料日期、筆數、片數、雜湊、授權

 結帳 ─► 你的 CDN（R2 + Cloudflare）─► shards/<bucket>.json   （一個請求、邊緣快取）
                       查無 ─► Worker ─► FIA 單筆 API（在邊緣快取）
```

- **FIA 稅籍**是主來源：涵蓋所有營業人（公司**與**商號），且帶有**發票抬頭**與**使用
  統一發票**旗標——正是結帳需要的。每日更新。
- **營業中／停業狀態**由 FIA 自己提供（`BGMOPEN1` + `BGMOPEN1X`），不需要 GCIS。
  分片上的 `status` 為 `active` 或 `suspended`。較早的分片沒有這個欄位；缺值代表未知，
  不要當成營業中。停業日期只在完整資料集，不在結帳分片。
- **GCIS**（公司／商業登記）為選用的逐筆 enrichment（例如負責人）；為何沒有可用的
  GCIS 全量 master，詳見 [`docs/data-dictionary.md`](docs/data-dictionary.md)。
- 尚未進入當日快照的新設統編，會 fallback 到**有官方文件的 FIA 單筆 API**，並擺在你
  自己的邊緣快取後面——政府伺服器每個統編每個快取週期最多被打一次，**絕不在每次結帳時**。

## 客戶端用法

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

## 一鍵部署查詢服務（Cloudflare Worker）

點上面的 **Deploy to Cloudflare** 按鈕，即可把 `worker/` 部署到你自己的 Cloudflare
帳號：它會自動建立 R2 bucket，並給你一個查詢端點。

```
GET https://<你的worker>/v1/vat/22099131
→ { "found": true, "ban": "22099131", "name": "台灣積體電路製造股份有限公司", "source": "dataset" }
```

- **R2 分片優先**：bucket 有資料就直接回（邊緣快取、不碰政府）。
- **查無則 fallback**：bucket 尚空或新設統編，轉打官方 FIA 單筆 API 並在邊緣快取，
  政府每個統編每個快取週期最多被打一次。
- **CORS**：預設 `*`，正式上線請在 `wrangler.jsonc` 的 `ALLOWED_ORIGINS` 設白名單。
- 部署後跑 [dataset workflow](.github/workflows/dataset.yml) 把分片灌進 R2，即升級為「資料集優先」。

## 專案結構

```
crates/ubn-core    Rust：統編檢查碼、FNV 分片雜湊、ROC 日期（權威來源）
crates/ubn-build   Rust：建檔 pipeline（單一 binary，無外部工具鏈）
client/            TypeScript：@paid-tw/ubn，瀏覽器結帳客戶端
worker/            Cloudflare Worker：查詢服務（R2 分片 + FIA fallback），可一鍵部署
```

## 建置資料集

Pipeline 是自包含的 Rust binary——不需 shell/node/duckdb 工具鏈：

```bash
cargo run --release -p ubn-build -- --out dist --shards 8192
# 離線、對本機檔案跑（略過向政府下載）：
cargo run --release -p ubn-build -- --active-zip BGMOPEN1.zip --no-suspended --out dist
```

CI 每日執行並發布產物，見 [`.github/workflows/dataset.yml`](.github/workflows/dataset.yml)。

## 開發

```bash
cargo test                              # Rust：core + pipeline + 真實統編 fixture
cd client && pnpm install && pnpm test  # TS 客戶端（vitest）+ pnpm build（tsc）
```

Rust core 與 TS 客戶端各自實作同樣的 ~3 個函式；共用的測試向量（見
`client/src/__tests__`）確保兩邊不會走鐘。

## 授權

原始碼：MIT。資料產物：衍生自台灣政府開放資料，採**政府資料開放授權條款第 1 版**——
再散布時請註明來源與擷取日期。見 [`LICENSE`](LICENSE)。

## 免責聲明

資料以政府來源原樣提供，可能落後現況最多一天。停業列的 `status` 為 `suspended`
（停業日期只在完整資料集）。涉及法律或財務的重要用途，請以官方來源為準。
