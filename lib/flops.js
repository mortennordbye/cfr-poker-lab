'use strict';
// Representative flop subset. All 22,100 flops are sorted by texture (suit pattern, pairing, high,
// middle and low rank), then picked with systematic sampling, so each texture group gets its share.
const { cardName } = require('./equity');

function texture(a, b, c) {
  const cards = [a, b, c].sort((x, y) => y - x);
  const r = cards.map((x) => x >> 2), s = new Set(cards.map((x) => x & 3)).size;
  const suit = s === 1 ? 0 : s === 2 ? 1 : 2;                    // monotone, two-tone, rainbow
  const pair = r[0] === r[2] ? 0 : r[0] === r[1] || r[1] === r[2] ? 1 : 2; // trips, paired, unpaired
  return { cards, key: [suit, pair, 12 - r[0], 12 - r[1], 12 - r[2]] };
}

function allFlops() {
  const out = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) for (let c = b + 1; c < 52; c++) out.push(texture(a, b, c));
  out.sort((x, y) => { for (let k = 0; k < 5; k++) if (x.key[k] !== y.key[k]) return x.key[k] - y.key[k]; return 0; });
  return out;
}

// n flops as strings like 'Jd8s7c', each standing for an equal share of all flops.
function flopSubset(n = 20) {
  const all = allFlops();
  const out = [];
  for (let k = 0; k < n; k++) out.push(all[Math.floor(((k + 0.5) * all.length) / n)].cards.map(cardName).join(''));
  return out;
}

module.exports = { flopSubset, allFlops };
