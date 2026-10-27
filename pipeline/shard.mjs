#!/usr/bin/env node
/**
 * Split the minimal NDJSON (one {ban,name,address,useInvoice} per line) into
 * N static JSON array files: <out>/<bucket>.json.
 *
 * The bucket hash MUST stay identical to src/shard.ts (FNV-1a 32-bit) so the
 * published client reads the same shard the pipeline wrote.
 *
 * Memory note: records are grouped in memory before writing. The minimal
 * projection for ~1.7M rows fits comfortably in a CI runner's RAM (~1 GB).
 *
 * Usage: node shard.mjs <shard_src.ndjson> <out_dir> [shards=8192]
 */
import fs from 'node:fs';
import readline from 'node:readline';

const [, , SRC, OUT, SHARDS_ARG] = process.argv;
const SHARDS = Number(SHARDS_ARG ?? 8192);
if (!SRC || !OUT) {
  console.error('usage: node shard.mjs <src.ndjson> <out_dir> [shards]');
  process.exit(1);
}

function shardOf(ban) {
  let h = 0x811c9dc5;
  for (let i = 0; i < ban.length; i++) {
    h ^= ban.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % SHARDS;
}

fs.mkdirSync(OUT, { recursive: true });

const buckets = Array.from({ length: SHARDS }, () => []);
const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });

let n = 0;
for await (const line of rl) {
  if (!line) continue;
  const r = JSON.parse(line);
  // normalize the uniform-invoice flag to a boolean here so shards are clean
  if (typeof r.useInvoice === 'string') r.useInvoice = r.useInvoice === 'Y';
  buckets[shardOf(r.ban)].push(r);
  n++;
}

let min = Infinity;
let max = 0;
for (let i = 0; i < SHARDS; i++) {
  fs.writeFileSync(`${OUT}/${i}.json`, JSON.stringify(buckets[i]));
  min = Math.min(min, buckets[i].length);
  max = Math.max(max, buckets[i].length);
}

console.log(`wrote ${SHARDS} shards for ${n} records (min ${min}, max ${max} rows/shard)`);
