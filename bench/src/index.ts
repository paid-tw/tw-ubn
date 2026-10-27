// Local/remote benchmark worker: compare an R2-shard lookup vs a D1 point query
// for the same synthetic dataset. Not part of the product; used only to measure.

export interface Env {
  BENCH_R2: any;
  BENCH_D1: any;
  SHARDS: string;
}

function shardOf(ban: string, shards: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < ban.length; i++) {
    h ^= ban.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % shards;
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function seed(env: Env, n: number, shards: number) {
  await env.BENCH_D1.exec('DROP TABLE IF EXISTS ubn');
  await env.BENCH_D1.exec(
    'CREATE TABLE ubn (ban TEXT PRIMARY KEY, name TEXT, address TEXT, useInvoice INTEGER)',
  );

  const buckets = new Map<number, unknown[]>();
  const insert = env.BENCH_D1.prepare(
    'INSERT INTO ubn (ban, name, address, useInvoice) VALUES (?, ?, ?, ?)',
  );
  let batch: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const ban = String(10_000_000 + i); // 8-digit synthetic UBN
    const name = `測試商行股份有限公司第${i}號`;
    const address = `臺北市信義區某某路${i}巷${(i % 50) + 1}號${(i % 12) + 1}樓`;
    const useInvoice = i % 2;
    batch.push(insert.bind(ban, name, address, useInvoice));
    const b = shardOf(ban, shards);
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push({
      ban,
      name,
      address,
      useInvoice: !!useInvoice,
    });
    if (batch.length >= 100) {
      await env.BENCH_D1.batch(batch);
      batch = [];
    }
  }
  if (batch.length) await env.BENCH_D1.batch(batch);

  for (const [b, rows] of buckets) {
    await env.BENCH_R2.put(`shards/${b}.json`, JSON.stringify(rows));
  }

  return { seeded: n, shards, r2Objects: buckets.size, sampleBan: String(10_000_000 + (n >> 1)) };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const shards = Number(env.SHARDS || '25');

    if (path === '/seed') {
      const n = Number(url.searchParams.get('n') || '5000');
      return j(await seed(env, n, Number(url.searchParams.get('shards') || shards)));
    }

    if (path.startsWith('/d1/')) {
      const ban = path.slice(4);
      const row = await env.BENCH_D1.prepare(
        'SELECT ban, name, address, useInvoice FROM ubn WHERE ban = ?',
      )
        .bind(ban)
        .first();
      return j(row ?? { found: false });
    }

    if (path.startsWith('/r2/')) {
      const ban = path.slice(4);
      const obj = await env.BENCH_R2.get(`shards/${shardOf(ban, shards)}.json`);
      if (!obj) return j({ found: false });
      const rows = (await obj.json()) as { ban: string }[];
      return j(rows.find((r) => r.ban === ban) ?? { found: false });
    }

    return j({ routes: ['/seed?n=&shards=', '/d1/:ban', '/r2/:ban'] });
  },
};
