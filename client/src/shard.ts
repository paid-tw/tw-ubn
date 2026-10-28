/**
 * Static sharding of the dataset by UBN.
 *
 * The published dataset is split into N static JSON shards so a single lookup
 * is one cache-friendly request. The bucket is derived from the UBN with a
 * 32-bit FNV-1a hash (portable, no deps) so the client and the build pipeline
 * agree exactly. `crates/ubn-core` (`shard_of`) and the worker copies MUST keep
 * an identical implementation; shared test vectors guard against drift.
 *
 * The shard count lives in the published manifest.json ("shards"); a client
 * should read it rather than hard-coding, but 8192 is the default.
 */
export const DEFAULT_SHARDS = 8192;

export function shardOf(ban: string, shards: number = DEFAULT_SHARDS): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < ban.length; i++) {
    h ^= ban.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return (h >>> 0) % shards;
}
