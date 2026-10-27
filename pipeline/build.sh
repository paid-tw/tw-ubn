#!/usr/bin/env bash
#
# Build the tw-ubn open dataset from the FIA daily tax-registry snapshot.
#
# Produces, under dist/:
#   ubn.ndjson.gz   full dataset, one JSON object per line (for pipelines)
#   ubn.sqlite      full dataset, indexed on ban (for general queries)
#   ubn.duckdb      full dataset (fast analytics / rebuilds)
#   shards/<n>.json 8192 static shards: ban -> {name,address,useInvoice}
#   manifest.json   version, data date, row count, shard count, hash, license
#
# Requirements: bash, curl, unzip, sqlite3, node, and the `duckdb` CLI on PATH.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/dist}"
TMP="${TMP:-$ROOT/tmp}"
SHARDS="${SHARDS:-8192}"
SRC_URL="https://eip.fia.gov.tw/data/BGMOPEN1.zip"

mkdir -p "$OUT" "$TMP"

echo "==> download FIA tax registry"
curl -sSL --retry 3 --fail -o "$TMP/BGMOPEN1.zip" "$SRC_URL"
unzip -o "$TMP/BGMOPEN1.zip" -d "$TMP" >/dev/null

echo "==> extract data date + strip sentinel row (line 2 is the extract date)"
DATA_DATE="$(sed -n '2p' "$TMP/BGMOPEN1.csv" | cut -d, -f1)"   # e.g. 27-OCT-26
sed '2d' "$TMP/BGMOPEN1.csv" > "$TMP/clean.csv"
ROWS=$(( $(wc -l < "$TMP/clean.csv") - 1 ))
echo "    data date: $DATA_DATE  rows: $ROWS"

echo "==> build DuckDB + full NDJSON + shard source"
rm -f "$OUT/ubn.duckdb"
duckdb "$OUT/ubn.duckdb" <<SQL
CREATE OR REPLACE TABLE ubn AS
SELECT * FROM read_csv('$TMP/clean.csv', header=true, all_varchar=true, columns={
  'address':'VARCHAR','ban':'VARCHAR','hq_ban':'VARCHAR','name':'VARCHAR','capital':'VARCHAR',
  'setup_date':'VARCHAR','org_type':'VARCHAR','use_invoice':'VARCHAR',
  'industry_code':'VARCHAR','industry_name':'VARCHAR',
  'industry_code1':'VARCHAR','industry_name1':'VARCHAR',
  'industry_code2':'VARCHAR','industry_name2':'VARCHAR',
  'industry_code3':'VARCHAR','industry_name3':'VARCHAR'});
COPY ubn TO '$OUT/ubn.ndjson' (FORMAT json);
COPY (SELECT ban, name, address, use_invoice AS useInvoice FROM ubn)
  TO '$TMP/shard_src.ndjson' (FORMAT json);
SQL

echo "==> build SQLite (indexed on ban)"
rm -f "$OUT/ubn.sqlite"
sqlite3 "$OUT/ubn.sqlite" <<SQL
CREATE TABLE ubn(address TEXT,ban TEXT,hq_ban TEXT,name TEXT,capital TEXT,setup_date TEXT,
  org_type TEXT,use_invoice TEXT,industry_code TEXT,industry_name TEXT,
  industry_code1 TEXT,industry_name1 TEXT,industry_code2 TEXT,industry_name2 TEXT,
  industry_code3 TEXT,industry_name3 TEXT);
.mode csv
.import --skip 1 $TMP/clean.csv ubn
CREATE INDEX idx_ban ON ubn(ban);
VACUUM;
SQL

echo "==> generate $SHARDS static shards"
node "$ROOT/pipeline/shard.mjs" "$TMP/shard_src.ndjson" "$OUT/shards" "$SHARDS"

echo "==> compress bulk artifact + write manifest"
gzip -9 -f "$OUT/ubn.ndjson"
cat > "$OUT/manifest.json" <<JSON
{
  "source": "$SRC_URL",
  "sourceAgency": "財政部財政資訊中心 (Fiscal Information Agency, Ministry of Finance)",
  "dataDate": "$DATA_DATE",
  "builtAt": "$(date -u +%FT%TZ)",
  "rows": $ROWS,
  "shards": $SHARDS,
  "hash": "fnv1a-32",
  "license": "政府資料開放授權條款-第1版 (Open Government Data License v1.0)"
}
JSON

echo "==> done; artifacts in $OUT"
