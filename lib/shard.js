'use strict';
// Shards for batch runs on many machines (tools/flop-report.js, tools/calibrate-sixmax.js, .github/workflows/
// precompute.yml). Shard i of n (1-based) takes items i-1, i-1+n, i-1+2n, ... of a fixed list (round robin). The
// lists are sorted (flops by texture, jobs by group), so each shard gets a mix of heavy and light work.

// '3/10' -> { index: 3, count: 10 }. Nothing -> null (no sharding). Throws on a bad value.
function parseShard(s) {
  if (s === undefined || s === null || s === '' || s === true) return null;
  const m = String(s).match(/^(\d+)\/(\d+)$/);
  const index = m ? Number(m[1]) : NaN, count = m ? Number(m[2]) : NaN;
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`bad shard "${s}": use i/n with 1 <= i <= n`);
  return { index, count };
}

// The items of one shard, in list order. shard null -> all items.
function shardSlice(list, shard) {
  if (!shard) return list.slice();
  return list.filter((_, k) => k % shard.count === shard.index - 1);
}

module.exports = { parseShard, shardSlice };
