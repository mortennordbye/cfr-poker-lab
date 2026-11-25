'use strict';
// Hand classes, 7-card evaluator and the 169 x 169 preflop all-in equity table.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const RANKS = '23456789TJQKA';
const N = 169;

// Class id = row * 13 + col in the grid. Row/col 0 = Ace.
// Pairs on the diagonal, suited above it, offsuit below it.
function classOf(a, b) {
  const ra = a >> 2, rb = b >> 2;
  const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
  if (hi === lo) return (12 - hi) * 13 + (12 - hi);
  if ((a & 3) === (b & 3)) return (12 - hi) * 13 + (12 - lo);
  return (12 - lo) * 13 + (12 - hi);
}

function className(id) {
  const r = Math.floor(id / 13), c = id % 13;
  if (r === c) return RANKS[12 - r] + RANKS[12 - r];
  if (r < c) return RANKS[12 - r] + RANKS[12 - c] + 's';
  return RANKS[12 - c] + RANKS[12 - r] + 'o';
}

// All 1326 combos, grouped per class.
const COMBOS = Array.from({ length: N }, () => []);
for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) COMBOS[classOf(a, b)].push([a, b]);

// W[i*N+j] = number of combo pairs (class i vs class j) that share no card.
function comboWeights() {
  const all = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) all.push([a, b, classOf(a, b)]);
  const W = new Float64Array(N * N);
  for (const x of all) for (const y of all) {
    if (x[0] === y[0] || x[0] === y[1] || x[1] === y[0] || x[1] === y[1]) continue;
    W[x[2] * N + y[2]]++;
  }
  return W;
}

// ---- 7-card evaluator. Higher score = better hand. ----
const counts = new Int32Array(13);
const sm = new Int32Array(4);
const sc = new Int32Array(4);

function straightHigh(mask) {
  for (let r = 12; r >= 4; r--) {
    const m = 0x1f << (r - 4);
    if ((mask & m) === m) return r;
  }
  if ((mask & 0x100f) === 0x100f) return 3; // A-2-3-4-5
  return -1;
}

function topBits(mask, n) {
  let out = 0, k = 0;
  for (let r = 12; r >= 0 && k < n; r--) if (mask & (1 << r)) { out = (out << 4) | r; k++; }
  while (k < n) { out <<= 4; k++; }
  return out;
}

function eval7(cards) {
  counts.fill(0); sm.fill(0); sc.fill(0);
  let mask = 0;
  for (let i = 0; i < 7; i++) {
    const c = cards[i], r = c >> 2, s = c & 3;
    counts[r]++; sm[s] |= 1 << r; sc[s]++; mask |= 1 << r;
  }
  for (let s = 0; s < 4; s++) {
    if (sc[s] >= 5) {
      const sf = straightHigh(sm[s]);
      if (sf >= 0) return (8 << 20) | (sf << 16);
      return (5 << 20) | topBits(sm[s], 5);
    }
  }
  let quad = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    const n = counts[r];
    if (n === 4) quad = r;
    else if (n === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
    else if (n === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
  }
  if (quad >= 0) return (7 << 20) | (quad << 16) | (topBits(mask & ~(1 << quad), 1) << 12);
  if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return (6 << 20) | (t1 << 16) | (Math.max(t2, p1) << 12);
  const st = straightHigh(mask);
  if (st >= 0) return (4 << 20) | (st << 16);
  if (t1 >= 0) return (3 << 20) | (t1 << 16) | (topBits(mask & ~(1 << t1), 2) << 8);
  if (p1 >= 0 && p2 >= 0) return (2 << 20) | (p1 << 16) | (p2 << 12) | (topBits(mask & ~(1 << p1) & ~(1 << p2), 1) << 8);
  if (p1 >= 0) return (1 << 20) | (p1 << 16) | (topBits(mask & ~(1 << p1), 3) << 4);
  return topBits(mask, 5);
}

// ---- Monte Carlo equity for class i vs class j ----
let seed = 0x9e3779b9;
function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }

function samplePair(i, j, samples) {
  const A = COMBOS[i], B = COMBOS[j];
  const deck = new Int32Array(48), h1 = new Int32Array(7), h2 = new Int32Array(7);
  const BOARDS = 16; // boards per combo pair
  let score = 0, done = 0;
  while (done < samples) {
    const a = A[rnd() % A.length], b = B[rnd() % B.length];
    if (a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1]) continue;
    let k = 0;
    for (let c = 0; c < 52; c++) if (c !== a[0] && c !== a[1] && c !== b[0] && c !== b[1]) deck[k++] = c;
    h1[0] = a[0]; h1[1] = a[1]; h2[0] = b[0]; h2[1] = b[1];
    for (let n = 0; n < BOARDS; n++) {
      for (let t = 0; t < 5; t++) {
        const x = t + (rnd() % (48 - t));
        const tmp = deck[t]; deck[t] = deck[x]; deck[x] = tmp;
        h1[2 + t] = deck[t]; h2[2 + t] = deck[t];
      }
      const s1 = eval7(h1), s2 = eval7(h2);
      score += s1 > s2 ? 1 : s1 === s2 ? 0.5 : 0;
    }
    done += BOARDS;
  }
  return score / done;
}

if (!isMainThread && workerData && workerData.equityWorker) {
  seed = workerData.seed >>> 0 || 1;
  const { pairs, samples } = workerData;
  const out = new Float64Array(pairs.length / 2);
  for (let p = 0; p < out.length; p++) {
    out[p] = samplePair(pairs[2 * p], pairs[2 * p + 1], samples);
    if (p % 200 === 0) parentPort.postMessage({ progress: p });
  }
  parentPort.postMessage({ done: out });
}

// Builds the table with one worker per CPU core.
async function buildEquity(samples, log = console.log) {
  const pairs = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) pairs.push([i, j]);
  const nw = Math.max(1, os.cpus().length);
  const chunks = Array.from({ length: nw }, () => []);
  pairs.forEach((p, k) => chunks[k % nw].push(p));
  const E = new Float64Array(N * N).fill(0.5);
  const progress = new Array(nw).fill(0);
  const t0 = Date.now();
  await Promise.all(chunks.map((chunk, w) => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { equityWorker: true, pairs: chunk.flat(), samples, seed: 12345 + w * 7919 } });
    worker.on('message', (m) => {
      if (m.progress !== undefined) {
        progress[w] = m.progress;
        if (w === 0) log(`equity: ${Math.round((100 * progress.reduce((a, b) => a + b, 0)) / pairs.length)}%`);
      } else {
        chunk.forEach(([i, j], k) => { E[i * N + j] = m.done[k]; E[j * N + i] = 1 - m.done[k]; });
        resolve();
      }
    });
    worker.on('error', reject);
  })));
  log(`equity: done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return E;
}

const FILE = path.join(__dirname, 'equity.json');

async function loadEquity(samples = 100000) {
  if (fs.existsSync(FILE)) {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { E: Float64Array.from(d.E), W: Float64Array.from(d.W), samples: d.samples };
  }
  console.log(`equity.json not found. Calculating it now (${samples} boards per hand pair).`);
  const E = await buildEquity(samples);
  const W = comboWeights();
  fs.writeFileSync(FILE, JSON.stringify({ samples, E: Array.from(E, (x) => +x.toFixed(5)), W: Array.from(W) }));
  return { E, W, samples };
}

module.exports = { N, RANKS, COMBOS, classOf, className, eval7, samplePair, loadEquity };

// ---- Card helpers. Card id = rank * 4 + suit. rank 0 = '2' ... 12 = 'A'. suit order 'cdhs'. ----
const SUITS = 'cdhs';
function cardName(c) { return RANKS[c >> 2] + SUITS[c & 3]; }
function parseCard(s) {
  const r = RANKS.indexOf(s[0].toUpperCase()), u = SUITS.indexOf(s[1].toLowerCase());
  if (r < 0 || u < 0) throw new Error('bad card: ' + s);
  return r * 4 + u;
}
// Combo name, high card first, e.g. "KsKh", "As2s".
function comboName(a, b) { return (a >> 2) > (b >> 2) || ((a >> 2) === (b >> 2) && a > b) ? cardName(a) + cardName(b) : cardName(b) + cardName(a); }
module.exports.SUITS = SUITS;
module.exports.cardName = cardName;
module.exports.parseCard = parseCard;
module.exports.comboName = comboName;
