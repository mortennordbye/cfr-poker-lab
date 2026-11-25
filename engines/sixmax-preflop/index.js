'use strict';
// Engine 'sixmax-preflop': 6-max preflop (UTG..BB), ChipEV, CFR+ over 169 hand classes.
// See README.md and CONTRACT.md.
const path = require('path');
const { Worker } = require('worker_threads');
const { sha1, toBase64, fromBase64, files } = require('../../lib/platform');
const { className } = require('../../lib/equity');
const { POS, normalizeParams, buildTree } = require('./tree');

const VERSION = 5;
const CACHE = path.join(__dirname, '..', '..', 'cache');
const H = 169;

const params = [
  { name: 'stack', type: 'number', default: 100, min: 10, max: 300, step: 1, label: 'Stack (bb)' },
  { name: 'ante', type: 'number', default: 0, min: 0, max: 3, step: 0.1, label: 'BB ante (bb, 0 = cash; MTT: 1)' },
  { name: 'open', type: 'number', default: 0, min: 0, max: 10, step: 0.1, label: 'Open size UTG-BTN (bb, 0 = auto: 2.5, or 2.1 with ante)' },
  { name: 'sbOpen', type: 'number', default: 0, min: 0, max: 10, step: 0.1, label: 'SB open size (bb, 0 = auto: 3, or 2.5 with ante)' },
  { name: 'threeBetIP', type: 'number', default: 0, min: 0, max: 10, step: 0.1, label: '3-bet IP (x of open, 0 = auto: 3, or 4 with ante)' },
  { name: 'threeBetOOP', type: 'number', default: 0, min: 0, max: 10, step: 0.1, label: '3-bet OOP (x of open, 0 = auto: 4, or 5 with ante)' },
  { name: 'squeezeAdd', type: 'number', default: 1, min: 0, max: 3, step: 0.1, label: 'Squeeze: add x of open per caller' },
  { name: 'fourBet', type: 'number', default: 0, min: 0, max: 5, step: 0.1, label: '4-bet (x of 3-bet, 0 = auto: 2.5)' },
  { name: 'coldCalls', type: 'boolean', default: true, label: 'Allow cold calls' },
  { name: 'sbLimp', type: 'boolean', default: false, label: 'Allow SB limp' },
  { name: 'maxPlayers', type: 'number', default: 3, min: 2, max: 3, step: 1, label: 'Max players in a single-raised pot' },
  { name: 'rIp', type: 'number', default: 1.0, min: 0.5, max: 1.5, step: 0.01, label: 'Equity realization IP' },
  { name: 'rOop', type: 'number', default: 0.88, min: 0.5, max: 1.5, step: 0.01, label: 'Equity realization OOP' },
  { name: 'iterations', type: 'number', default: 1000, min: 10, max: 20000, step: 50, label: 'Iterations' },
  { name: 'maxSeconds', type: 'number', default: 240, min: 5, max: 1800, step: 5, label: 'Max solve time (s)' },
];

// At most one 6-max solve at a time (it uses up to 4 threads).
let chain = Promise.resolve();

function runWorker(P, threads, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'worker.js'), { workerData: { role: 'master', P, threads } });
    let done = false;
    w.on('message', (m) => {
      if (m.error) { done = true; reject(new Error(m.error)); }
      else if (m.result) { done = true; resolve(m.result); w.terminate(); } // a browser worker does not stop by itself
      else if (m.progress !== undefined) onProgress(m.progress, m.message);
    });
    w.on('error', (e) => { done = true; reject(e); });
    w.on('exit', (code) => { if (!done) reject(new Error('worker exit ' + code)); });
  });
}

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

function wrap(P, tree, offs, data, stats) {
  const nodes = tree.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const note = 'Preflop only. Flop = pot * equity * R (R IP ' + P.rIp + ', OOP ' + P.rOop + '). '
    + 'Shares normalized to the pot (zero-sum). Card removal: exact between two hands, folded players and 3-way pots approximated. '
    + 'Max ' + P.maxPlayers + ' players in a single-raised pot, heads-up in 3-bet+ pots; 5-bet = allin.';
  function players(n) {
    return POS.map((pos, p) => ({ pos, stack: r2(P.stack - n.inv[p]), invested: n.inv[p], folded: n.folded[p] }));
  }
  // Skip forced nodes (only Fold possible): resolve to the first real node below.
  const real = (n) => { while (n.forced) n = nodes[n.children[0]]; return n; };
  function getNode(id) {
    const f = byId.get(id || 'root');
    if (!f) return null;
    const n = real(f);
    const node = {
      id: n.id, street: 'preflop', board: [], pot: n.pot, players: players(n),
      history: n.history.map(({ pos, street, label, nodeId }) => ({ pos, street, label, nodeId: real(byId.get(nodeId)).id })),
      toAct: n.toAct >= 0 ? POS[n.toAct] : null,
      toCall: n.toCall,
      actions: n.actions.map((a, k) => ({ label: a.label, type: a.type, amount: a.amount, child: real(nodes[n.children[k]]).id })),
      handKind: 'class', hands: {}, terminal: null, note,
    };
    const lo = offs[n.idx], hi = offs[n.idx + 1];
    if (n.terminal) {
      const t = { type: n.terminal.type };
      const ranges = {};
      if (hi > lo) {
        n.active.forEach((q, k) => {
          const r = {};
          for (let h = 0; h < H; h++) { const w = data[lo + k * H + h]; if (w >= 5e-4) r[className(h)] = r4(w); }
          ranges[POS[q]] = r;
        });
      }
      if (n.terminal.type === 'fold') t.winner = POS[n.active[0]];
      else t.ranges = ranges;
      if (n.terminal.type === 'flop' && n.active.length === 2) {
        const [oop, ip] = n.order;
        t.flop = { oop: POS[oop], ip: POS[ip], pot: n.pot, stack: r2(Math.min(P.stack - n.inv[oop], P.stack - n.inv[ip])),
          ranges: { [POS[oop]]: ranges[POS[oop]] || {}, [POS[ip]]: ranges[POS[ip]] || {} } };
      } else if (n.terminal.type === 'flop') {
        t.note = '3-way flop: valued with the pairwise-product equity approximation; no postflop solve.';
      }
      node.terminal = t;
      node.ranges = ranges;
      return node;
    }
    const A = n.children.length, rec = 2 + 2 * A;
    for (let o = lo; o < hi; o += rec) {
      const h = data[o];
      const st = [], ev = [];
      let s = 0;
      for (let a = 0; a < A; a++) s += data[o + 2 + a];
      for (let a = 0; a < A; a++) st.push(r4(s > 0 ? data[o + 2 + a] / s : 1 / A));
      for (let a = 0; a < A; a++) { const x = data[o + 2 + A + a]; ev.push(Number.isFinite(x) ? r4(x) : null); }
      node.hands[className(h)] = { weight: r4(data[o + 1]), strategy: st, ev };
    }
    return node;
  }
  return { root: 'root', getNode, stats };
}

async function solve(raw = {}, onProgress = () => {}, opts = {}) {
  const P = normalizeParams(raw);
  const solveKey = { ...P }; delete solveKey.maxSeconds;
  const hash = sha1(JSON.stringify({ v: VERSION, P: solveKey })).slice(0, 16);
  const file = path.join(CACHE, `sixmax-preflop-${hash}.json`);
  const tree = buildTree(P);
  if (!opts.noCache && files.exists(file)) {
    try {
      const d = JSON.parse(await files.readTextAsync(file));
      onProgress(1, 'loaded from cache');
      return wrap(P, tree, fromBase64(d.offs, Int32Array), fromBase64(d.data, Float32Array), { ...d.stats, cached: true });
    } catch (e) { /* solve again */ }
  }
  const prev = chain;
  let release;
  chain = new Promise((r) => { release = r; });
  onProgress(0, 'waiting for the previous 6-max solve');
  await prev;
  try {
    const res = await runWorker(P, opts.threads || 4, onProgress);
    if (!opts.noCache) {
      await files.writeTextAsync(file, JSON.stringify({ v: VERSION, params: P, stats: res.stats, offs: toBase64(res.offs), data: toBase64(res.data) }));
    }
    onProgress(1, 'done');
    return wrap(P, tree, res.offs, res.data, res.stats);
  } finally { release(); }
}

module.exports = { kind: 'sixmax-preflop', title: '6-max preflop', params, solve, normalizeParams };
