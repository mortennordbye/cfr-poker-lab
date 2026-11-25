'use strict';
// Heads-up postflop solver (kind 'postflop'). Discounted CFR over individual combos. See README.md.
const path = require('path');
const { Worker } = require('worker_threads');
const { sha1 } = require('../../lib/platform');
const G = require('./game');

// Heads-up single-raised pot (SB opens 3bb, BB calls). In HU the SB is the button: IP postflop.
const DEFAULT_RANGES = {
  IP: '22+,A2s+,K2s+,Q2s+,J4s+,T6s+,96s+,85s+,74s+,64s+,53s+,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,98o,87o',
  OOP: '22-JJ,QQ:0.3,A2s-AQs,AKs:0.3,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,74s+,63s+,53s+,43s,A2o-AJo,AQo:0.5,K7o+,Q8o+,J8o+,T8o+,97o+,87o,76o',
};

const DEFAULTS = {
  board: 'Jd8s7c', pot: 6, stack: 97, oop: 'BB', ip: 'SB', allinSpr: 1.5, iterations: 1000, targetExploitability: 0.5, maxSeconds: 600, threads: 4, maxMemoryMB: 3000,
};

// Bet tree defaults depend on the street the solve starts on. Flop trees must stay small: every flop line that
// reaches the turn multiplies the tree by 49 x (turn lines) x 48. Empty param = use these.
const AUTO_SIZES = {
  flop: { flopBets: '33', flopRaises: 'none', turnBets: '66', turnRaises: 'allin', riverBets: '75', riverRaises: 'none', raiseCap: 1 },
  turn: { turnBets: '66,allin', turnRaises: 'allin', riverBets: '75,allin', riverRaises: 'allin', raiseCap: 1 },
  river: { riverBets: '75,allin', riverRaises: '3x,allin', raiseCap: 2 },
};

const params = [
  { name: 'board', type: 'text', default: DEFAULTS.board, label: 'Board (3-5 cards)' },
  { name: 'pot', type: 'number', default: DEFAULTS.pot, min: 0.5, max: 2000, label: 'Pot (bb)' },
  { name: 'stack', type: 'number', default: DEFAULTS.stack, min: 0, max: 2000, label: 'Effective stack behind (bb)' },
  { name: 'oop', type: 'text', default: DEFAULTS.oop, label: 'OOP position' },
  { name: 'ip', type: 'text', default: DEFAULTS.ip, label: 'IP position' },
  { name: 'oopRange', type: 'text', default: DEFAULT_RANGES.OOP, label: 'OOP range (used when ranges is empty)' },
  { name: 'ipRange', type: 'text', default: DEFAULT_RANGES.IP, label: 'IP range (used when ranges is empty)' },
  { name: 'ranges', type: 'json', default: null, label: 'Ranges { pos: { hand: weight } }' },
  { name: 'flopBets', type: 'text', default: '', label: 'Flop bets (% pot, allin), empty = auto' },
  { name: 'flopRaises', type: 'text', default: '', label: 'Flop raises (x bet, allin), empty = auto' },
  { name: 'turnBets', type: 'text', default: '', label: 'Turn bets (% pot, allin), empty = auto' },
  { name: 'turnRaises', type: 'text', default: '', label: 'Turn raises (x bet, allin), empty = auto' },
  { name: 'riverBets', type: 'text', default: '', label: 'River bets (% pot, allin), empty = auto' },
  { name: 'riverRaises', type: 'text', default: '', label: 'River raises (x bet, allin), empty = auto' },
  { name: 'raiseCap', type: 'number', default: null, min: 0, max: 4, label: 'Raises per street (empty = auto)' },
  { name: 'allinSpr', type: 'number', default: DEFAULTS.allinSpr, min: 0, max: 100, label: 'Add allin when stack/pot below' },
  { name: 'iterations', type: 'number', default: DEFAULTS.iterations, min: 1, max: 5000, label: 'Max iterations' },
  { name: 'targetExploitability', type: 'number', default: DEFAULTS.targetExploitability, min: 0, max: 100, label: 'Target exploitability (% pot)' },
  { name: 'maxSeconds', type: 'number', default: DEFAULTS.maxSeconds, min: 1, max: 7200, label: 'Max seconds' },
];

const SIZE_KEYS = [];
for (const st of ['Flop', 'Turn', 'River']) for (const k of ['Bets', 'Raises']) {
  SIZE_KEYS.push(st.toLowerCase() + k, 'oop' + st + k, 'ip' + st + k);
}

function num(v, lo, hi, def) {
  const n = v === null || v === '' || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

// Fills defaults, clamps numbers. Result is plain data (sent to workers, hashed for the cache).
function normalizeParams(q = {}) {
  const P = {};
  P.board = G.parseBoard(q.board || DEFAULTS.board).map(G.cardName).join('');
  P.pot = num(q.pot, 0.5, 2000, DEFAULTS.pot);
  P.stack = num(q.stack, 0, 2000, DEFAULTS.stack);
  P.oop = String(q.oop || DEFAULTS.oop);
  P.ip = String(q.ip || DEFAULTS.ip);
  if (P.ip === P.oop) P.ip += '_IP';
  const auto = AUTO_SIZES[G.STREET[P.board.length / 2]];
  for (const k of SIZE_KEYS) {
    const v = q[k] !== undefined && q[k] !== null && q[k] !== '' ? q[k] : auto[k];
    if (v !== undefined && v !== null && v !== '') P[k] = Array.isArray(v) ? (v.length ? v.join(',') : 'none') : String(v);
  }
  P.raiseCap = Math.round(num(q.raiseCap, 0, 4, auto.raiseCap));
  P.allinSpr = num(q.allinSpr, 0, 100, DEFAULTS.allinSpr);
  P.iterations = Math.round(num(q.iterations, 1, 5000, DEFAULTS.iterations));
  P.targetExploitability = num(q.targetExploitability, 0, 100, DEFAULTS.targetExploitability);
  P.maxSeconds = num(q.maxSeconds, 1, 7200, DEFAULTS.maxSeconds);
  P.threads = Math.round(num(q.threads, 1, 4, DEFAULTS.threads));
  P.maxMemoryMB = num(q.maxMemoryMB, 50, 16000, DEFAULTS.maxMemoryMB);
  let ranges = q.ranges;
  if (typeof ranges === 'string') { try { ranges = JSON.parse(ranges); } catch { ranges = null; } }
  const pick = (pos, str, def) => {
    const r = ranges && typeof ranges === 'object' ? ranges[pos] : null;
    if (r && (typeof r === 'string' ? r.trim() : Object.keys(r).length)) return r;
    return str && String(str).trim() ? String(str) : def;
  };
  P.ranges = { [P.oop]: pick(P.oop, q.oopRange, DEFAULT_RANGES.OOP), [P.ip]: pick(P.ip, q.ipRange, DEFAULT_RANGES.IP) };
  return P;
}

function hashParams(P) {
  const { maxSeconds, threads, ...rest } = P;
  return sha1(JSON.stringify(rest)).slice(0, 16);
}

// In-memory cache of finished solves (same params -> same result object). Not written to disk:
// a flop result is hundreds of MB of typed arrays.
const cache = new Map();
const CACHE_MAX = 4;

function runWorker(P, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'worker.js'), { workerData: { role: 'coord', params: P } });
    let done = false;
    w.on('message', (m) => {
      if (m.type === 'progress') { if (onProgress) onProgress(m.fraction, m.message); }
      else if (m.type === 'done') { done = true; resolve(m); w.terminate(); }
      else if (m.type === 'error') { done = true; reject(new Error(m.error)); w.terminate(); }
    });
    w.on('error', (e) => { if (!done) { done = true; reject(e); } });
    w.on('exit', (code) => { if (!done) { done = true; reject(new Error('solver worker stopped, code ' + code)); } });
  });
}

function makeResult(P, m) {
  const { Hs, cfg, board } = G.setup(P);
  const nH = [Hs[0].n, Hs[1].n];
  const pos = [P.oop, P.ip];
  const ctx = { cfg, nH, off: 0, split: board.length < 5, splits: [], ranks: null };
  const root = G.build(ctx, G.rootState(board));
  const splits = ctx.splits;
  const subBuf = new Map();
  for (const s of m.subs) subBuf.set(s.k * 52 + s.c, s);
  const subRoot = new Map();
  const getSub = (k, c) => {
    const key = k * 52 + c;
    let r = subRoot.get(key);
    if (!r) {
      const c2 = { cfg, nH, off: 0, split: false, splits: [], ranks: null };
      r = G.build(c2, G.subState(splits[k], c));
      subRoot.set(key, r);
    }
    return r;
  };
  const fix = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

  function getNode(id) {
    if (typeof id !== 'string' || !id.startsWith('r')) return null;
    const steps = id === 'r' ? [] : id.slice(2).split('.').map(Number);
    let node = root, buf = { R: m.R, S: m.S }, cur = 'r';
    const reach = [Float64Array.from(Hs[0].w), Float64Array.from(Hs[1].w)];
    const history = [];
    for (const i of steps) {
      if (!Number.isInteger(i) || i < 0) return null;
      if (node.kind === 'act') {
        if (i >= node.actions.length) return null;
        const q = node.player, nq = nH[q], r = reach[q];
        for (let h = 0; h < nq; h++) r[h] *= buf.S[node.off + i * nq + h];
        history.push({ pos: pos[q], street: G.STREET[node.board.length], label: node.actions[i].label, type: node.actions[i].type, nodeId: cur });
        node = node.children[i];
      } else if (node.kind === 'chance' || node.kind === 'split') {
        if (i >= node.cards.length) return null;
        const c = node.cards[i];
        for (let p = 0; p < 2; p++) for (const h of Hs[p].withCard[c]) reach[p][h] = 0;
        history.push({ pos: null, street: G.STREET[node.board.length + 1], label: G.cardName(c), type: 'deal', nodeId: cur });
        if (node.kind === 'split') {
          const b = subBuf.get(node.k * 52 + c);
          if (!b) return null;
          buf = b; node = getSub(node.k, c);
        } else node = node.children[i];
      } else return null;
      cur += '.' + i;
    }
    const out = {
      id: cur, street: G.STREET[node.board.length], board: node.board.map(G.cardName), pot: fix(node.pot, 2),
      players: [0, 1].map((p) => ({
        pos: pos[p], stack: fix(cfg.stack - node.inv[p], 2), invested: fix(cfg.pot0 / 2 + node.inv[p], 2),
        folded: node.kind === 'fold' && node.folder === p,
      })),
      history, toAct: null, toCall: 0, actions: [], handKind: 'combo', hands: {}, terminal: null,
    };
    if (node.kind === 'act') {
      const q = node.player, nq = nH[q], nA = node.actions.length, r = reach[q], H = Hs[q];
      out.toAct = pos[q]; out.toCall = node.toCall;
      out.actions = node.actions.map((a, i) => ({ label: a.label, type: a.type, amount: a.amount, child: cur + '.' + i }));
      for (let h = 0; h < nq; h++) {
        if (!(r[h] > 1e-9)) continue;
        const strategy = new Array(nA), ev = new Array(nA);
        for (let a = 0; a < nA; a++) {
          strategy[a] = fix(buf.S[node.off + a * nq + h], 4);
          const e = buf.R[node.off + a * nq + h];
          ev[a] = Number.isFinite(e) ? fix(e, 3) : null;
        }
        out.hands[H.names[h]] = { weight: fix(r[h], 5), strategy, ev };
      }
    } else if (node.kind === 'chance' || node.kind === 'split') {
      out.actions = node.cards.map((c, i) => ({ label: G.cardName(c), type: 'deal', amount: 0, child: cur + '.' + i }));
    } else if (node.kind === 'fold') {
      out.terminal = { type: 'fold', winner: pos[1 - node.folder] };
    } else {
      out.terminal = { type: 'showdown' };
      if (node.board.length < 5) out.note = 'All-in before the river: value is the equity over all runouts.';
    }
    return out;
  }

  return {
    root: 'r',
    getNode,
    stats: m.stats,
    params: P,
  };
}

async function solve(params, onProgress) {
  const P = normalizeParams(params || {});
  const key = hashParams(P);
  if (cache.has(key)) { if (onProgress) onProgress(1, 'from cache'); return cache.get(key); }
  const p = runWorker(P, onProgress).then((m) => makeResult(P, m));
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}

// Light solve for tools (calibration): no node tree, no cache. Returns only stats (with rootEv per combo).
async function solveStats(params, onProgress) {
  const m = await runWorker(normalizeParams(params), onProgress);
  return m.stats;
}

module.exports = { kind: 'postflop-js', title: 'Heads-up postflop (JS, old)', params, solve, solveStats, normalizeParams, DEFAULT_RANGES, AUTO_SIZES };
