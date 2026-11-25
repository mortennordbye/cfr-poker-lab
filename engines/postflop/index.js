'use strict';
// Heads-up postflop engine (kind 'postflop'), backed by the Rust library b-inary/postflop-solver
// (AGPL-3.0-or-later). Node starts one solver process per solve (rs/, built with cargo on first use),
// reads its progress, and then asks it for nodes over stdin/stdout JSON lines. See README.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
// Range, board and size parsing are shared with the old JS engine (same param formats).
const G = require('../postflop-js/game');
const { cardName } = require('../../lib/equity');

const RS_DIR = path.join(__dirname, 'rs');
// POSTFLOP_BIN: a prebuilt binary (the container image sets it); then cargo is never run.
const PREBUILT = process.env.POSTFLOP_BIN || null;
const BIN = PREBUILT || path.join(RS_DIR, 'target', 'release', process.platform === 'win32' ? 'postflop-engine.exe' : 'postflop-engine');
const SCALE = 100; // chips per bb inside the solver (amounts are integers: 0.01 bb steps)
const STREET = { 3: 'flop', 4: 'turn', 5: 'river' };

// Heads-up single-raised pot (SB opens, BB calls). In HU the SB is the button: IP postflop. Same as postflop-js.
const DEFAULT_RANGES = {
  IP: '22+,A2s+,K2s+,Q2s+,J4s+,T6s+,96s+,85s+,74s+,64s+,53s+,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,98o,87o',
  OOP: '22-JJ,QQ:0.3,A2s-AQs,AKs:0.3,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,74s+,63s+,53s+,43s,A2o-AJo,AQo:0.5,K7o+,Q8o+,J8o+,T8o+,97o+,87o,76o',
};

const DEFAULTS = {
  board: 'Jd8s7c', pot: 6, stack: 97, oop: 'BB', ip: 'SB', allinSpr: 1.5, iterations: 1000, targetExploitability: 0.5,
  maxSeconds: 600, threads: 8, maxMemoryMB: 8000, compressAboveMB: 1000, forceAllinSpr: 0.15, mergeThreshold: 0.1,
  donkBets: 'none',
};

// Default trees (similar to common commercial solver trees). Raises: '2.5x' = raise to 2.5 times the bet. Empty param = these.
const AUTO_SIZES = {
  // Flop: the full commercial-style tree (turn 50/100, river 33/75/125, 2.5x raises everywhere) needs ~21 GB.
  // This one needs ~1.6 GB (compressed) and solves the default spot in ~35 s with 8 threads.
  flop: { flopBets: '33,75', flopRaises: '2.5x', turnBets: '66', turnRaises: 'allin', riverBets: '75', riverRaises: '2.5x', raiseCap: 1 },
  turn: { turnBets: '50,100', turnRaises: '2.5x,allin', riverBets: '33,75,125', riverRaises: '2.5x,allin', raiseCap: 2 },
  river: { riverBets: '33,75,125', riverRaises: '2.5x,allin', raiseCap: 3 },
};

const params = [
  { name: 'board', type: 'text', default: DEFAULTS.board, label: 'Board (3-5 cards)' },
  { name: 'pot', type: 'number', default: DEFAULTS.pot, min: 0.5, max: 2000, label: 'Pot (bb)' },
  { name: 'stack', type: 'number', default: DEFAULTS.stack, min: 0.01, max: 2000, label: 'Effective stack behind (bb)' },
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
  { name: 'donkBets', type: 'text', default: DEFAULTS.donkBets, label: 'OOP donk bets after calling (none, same, or % pot)' },
  { name: 'raiseCap', type: 'number', default: null, min: 0, max: 6, label: 'Raises per street (empty = auto)' },
  { name: 'allinSpr', type: 'number', default: DEFAULTS.allinSpr, min: 0, max: 100, label: 'Add allin when stack/pot below' },
  { name: 'iterations', type: 'number', default: DEFAULTS.iterations, min: 1, max: 10000, label: 'Max iterations' },
  { name: 'targetExploitability', type: 'number', default: DEFAULTS.targetExploitability, min: 0, max: 100, label: 'Target exploitability (% pot)' },
  { name: 'maxSeconds', type: 'number', default: DEFAULTS.maxSeconds, min: 1, max: 7200, label: 'Max seconds' },
  { name: 'threads', type: 'number', default: DEFAULTS.threads, min: 1, max: 64, label: 'Threads' },
];

const SIZE_KEYS = [];
for (const st of ['Flop', 'Turn', 'River']) for (const k of ['Bets', 'Raises']) SIZE_KEYS.push(st.toLowerCase() + k, 'oop' + st + k, 'ip' + st + k);

function num(v, lo, hi, def) {
  const n = v === null || v === '' || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}
const sizeStr = (v) => (Array.isArray(v) ? (v.length ? v.join(',') : 'none') : String(v));

// Fills defaults and clamps numbers. Same names and formats as postflop-js, plus donkBets, forceAllinSpr,
// mergeThreshold, compress ('auto' | true | false), compressAboveMB, maxMemoryMB, equity (per-hand equity in nodes).
function normalizeParams(q = {}) {
  const P = {};
  P.board = G.parseBoard(q.board || DEFAULTS.board).map(G.cardName).join('');
  P.pot = num(q.pot, 0.5, 2000, DEFAULTS.pot);
  P.stack = num(q.stack, 0.01, 2000, DEFAULTS.stack);
  P.oop = String(q.oop || DEFAULTS.oop);
  P.ip = String(q.ip || DEFAULTS.ip);
  if (P.ip === P.oop) P.ip += '_IP';
  const auto = AUTO_SIZES[STREET[P.board.length / 2]];
  for (const k of SIZE_KEYS) {
    const v = q[k] !== undefined && q[k] !== null && q[k] !== '' ? q[k] : auto[k];
    if (v !== undefined && v !== null && v !== '') P[k] = sizeStr(v);
  }
  P.donkBets = q.donkBets !== undefined && q.donkBets !== null && q.donkBets !== '' ? sizeStr(q.donkBets) : DEFAULTS.donkBets;
  P.raiseCap = Math.round(num(q.raiseCap, 0, 6, auto.raiseCap));
  P.allinSpr = num(q.allinSpr, 0, 100, DEFAULTS.allinSpr);
  P.forceAllinSpr = num(q.forceAllinSpr, 0, 10, DEFAULTS.forceAllinSpr);
  P.mergeThreshold = num(q.mergeThreshold, 0, 10, DEFAULTS.mergeThreshold);
  P.iterations = Math.round(num(q.iterations, 1, 10000, DEFAULTS.iterations));
  P.targetExploitability = num(q.targetExploitability, 0, 100, DEFAULTS.targetExploitability);
  P.maxSeconds = num(q.maxSeconds, 1, 7200, DEFAULTS.maxSeconds);
  P.threads = Math.round(num(q.threads, 1, Math.max(1, os.cpus().length), Math.min(DEFAULTS.threads, os.cpus().length || 1)));
  P.maxMemoryMB = num(q.maxMemoryMB, 50, 64000, DEFAULTS.maxMemoryMB);
  P.compressAboveMB = num(q.compressAboveMB, 0, 64000, DEFAULTS.compressAboveMB);
  P.compress = q.compress === true || q.compress === 'true' ? true : q.compress === false || q.compress === 'false' ? false : 'auto';
  P.equity = q.equity !== false && q.equity !== 'false';
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

// Solver config (chips = bb * SCALE). Bet sizes: 'p0.33' = 33% pot, 'x2.5' = raise to 2.5x the bet, 'a' = allin.
function solverConfig(P, mode) {
  const board = G.parseBoard(P.board);
  const ranges = [P.ranges[P.oop], P.ranges[P.ip]].map((r) => {
    const w = G.parseRange(r), out = [];
    for (let k = 0; k < 1326; k++) if (w[k] > 0) out.push([G.COMBO_A[k], G.COMBO_B[k], w[k]]);
    return out;
  });
  const conv = (list, raise) => list.map((x) => (x === 'allin' ? 'a' : raise ? 'x' + x : 'p' + x / 100));
  const sizes = {};
  for (const st of ['flop', 'turn', 'river']) {
    const cap = st[0].toUpperCase() + st.slice(1);
    sizes[st] = ['oop', 'ip'].map((pre) => ({
      bet: conv(G.parseSizes(P[pre + cap + 'Bets'], P[st + 'Bets']), false),
      raise: conv(G.parseSizes(P[pre + cap + 'Raises'], P[st + 'Raises']), true),
    }));
  }
  const d = String(P.donkBets).trim().toLowerCase();
  const donk = d === 'same' ? null : conv(G.parseSizes(d === 'none' ? 'none' : d), false);
  return {
    mode, scale: SCALE, board, ranges, sizes, donk: { turn: donk, river: donk },
    pot: Math.round(P.pot * SCALE), stack: Math.round(P.stack * SCALE),
    raiseCap: P.raiseCap, addAllin: P.allinSpr, forceAllin: P.forceAllinSpr, merge: P.mergeThreshold,
    iterations: P.iterations, targetExploitability: P.targetExploitability, maxSeconds: P.maxSeconds,
    threads: P.threads, maxMemoryMB: P.maxMemoryMB, compressAboveMB: P.compressAboveMB, compress: P.compress, equity: P.equity,
  };
}

// ---------------------------------------------------------------- binary build
let buildPromise = null;
function newestMtime(dir) {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestMtime(f) : fs.statSync(f).mtimeMs);
  }
  return t;
}
function needsBuild() {
  if (PREBUILT) return false;
  if (!fs.existsSync(BIN)) return true;
  const bin = fs.statSync(BIN).mtimeMs;
  return newestMtime(path.join(RS_DIR, 'src')) > bin || fs.statSync(path.join(RS_DIR, 'Cargo.toml')).mtimeMs > bin;
}
function ensureBinary(onProgress) {
  if (!needsBuild()) return Promise.resolve(BIN);
  if (buildPromise) return buildPromise;
  if (onProgress) onProgress(0, 'building the Rust solver (first use, about 1 minute)');
  const env = { ...process.env };
  env.PATH = ['/opt/homebrew/opt/rustup/bin', path.join(os.homedir(), '.cargo', 'bin'), env.PATH || ''].join(path.delimiter);
  buildPromise = new Promise((resolve, reject) => {
    const p = spawn('cargo', ['build', '--release'], { cwd: RS_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT'
      ? 'cargo not found: install Rust (https://rustup.rs) or put cargo in PATH, then retry. The postflop-js engine works without Rust.'
      : 'cargo failed to start: ' + e.message)));
    p.on('exit', (code) => (code === 0 && fs.existsSync(BIN) ? resolve(BIN) : reject(new Error('cargo build --release failed:\n' + err))));
  }).finally(() => { buildPromise = null; });
  return buildPromise;
}

// ---------------------------------------------------------------- solver process
const live = new Set();
process.on('exit', () => { for (const c of live) { try { c.kill('SIGKILL'); } catch { /* ignore */ } } });

function startProcess(P, mode, onProgress) {
  return ensureBinary(onProgress).then((bin) => new Promise((resolve, reject) => {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    live.add(child);
    const pending = new Map();
    let nextId = 1, buf = '', stderr = '', done = false, info = null, dead = null;
    const fail = (e) => {
      dead = e;
      if (!done) { done = true; reject(e); }
      for (const [, p] of pending) p.reject(e);
      pending.clear();
    };
    child.on('error', (e) => fail(new Error('solver process: ' + e.message)));
    child.on('exit', (code, sig) => {
      live.delete(child);
      if (!dead) fail(new Error(sig ? `solver process stopped (${sig})` : `solver process ended, code ${code}${stderr ? ': ' + stderr.trim().slice(-500) : ''}`));
    });
    child.stdin.on('error', () => { /* process gone: handled by exit */ });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined) {
          const p = pending.get(m.id);
          if (p) { pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.node); }
        } else if (m.type === 'info') {
          info = m;
          if (onProgress) onProgress(0.01, `solving: ${m.combos[0]} vs ${m.combos[1]} combos, ${m.memoryMB} MB${m.compressed ? ' (compressed)' : ''}, ${m.threads} threads`);
        } else if (m.type === 'progress') {
          if (onProgress) {
            const e = m.exploitability;
            const f = Math.max(m.iteration / P.iterations, m.elapsedMs / 1000 / P.maxSeconds,
              e ? Math.min(1, Math.pow(P.targetExploitability / e, 0.7)) : 0);
            onProgress(Math.min(0.97, f), `iteration ${m.iteration}/${P.iterations}, exploitability ${e === null || e === undefined ? '?' : e.toFixed(3)}% pot`);
          }
        } else if (m.type === 'done') {
          done = true;
          resolve({ stats: m.stats, info, query, kill });
        } else if (m.type === 'error') {
          fail(new Error(m.error));
          kill();
        }
      }
    });
    function query(pathArr) {
      if (dead) return Promise.reject(dead);
      return new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        child.stdin.write(JSON.stringify({ id, path: pathArr }) + '\n');
      });
    }
    function kill() {
      if (!dead) dead = new Error('solve was disposed');
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    child.stdin.write(JSON.stringify(solverConfig(P, mode)) + '\n');
    if (mode === 'stats') child.stdin.end();
  }));
}

// ---------------------------------------------------------------- nodes
const fix = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const bb = (chips) => fix(chips / SCALE, 2);

function actionOut(a) {
  const amount = bb(a.amount);
  const label = a.type === 'fold' ? 'Fold' : a.type === 'check' ? 'Check' : a.type === 'call' ? 'Call ' + amount
    : (a.type === 'allin' ? 'Allin ' : a.type === 'bet' ? 'Bet ' : 'Raise ') + amount;
  return { label, type: a.type, amount };
}

function formatNode(P, id, raw) {
  const pos = [P.oop, P.ip];
  const tb = raw.totalBet;
  const stackChips = Math.round(P.stack * SCALE);
  const prefix = (k) => (k === 0 ? 'r' : 'r.' + id.split('.').slice(1, k + 1).join('.'));
  const out = {
    id, street: STREET[raw.board.length], board: raw.board.map(cardName),
    pot: fix(P.pot + (tb[0] + tb[1]) / SCALE, 2),
    players: [0, 1].map((p) => ({
      pos: pos[p], stack: bb(stackChips - tb[p]), invested: fix(P.pot / 2 + tb[p] / SCALE, 2),
      folded: raw.kind === 'fold' && raw.folder === p,
    })),
    history: raw.history.map((h) => (h.deal !== undefined
      ? { pos: null, street: STREET[h.boardLen], label: cardName(h.deal), type: 'deal', nodeId: prefix(h.step) }
      : { pos: pos[h.player], street: STREET[h.boardLen], ...(({ label, type }) => ({ label, type }))(actionOut(h.action)), nodeId: prefix(h.step) })),
    toAct: null, toCall: 0, actions: [], handKind: 'combo', hands: {}, terminal: null,
  };
  if (raw.kind === 'act') {
    out.toAct = pos[raw.player];
    out.toCall = bb(raw.toCall);
    out.actions = raw.actions.map((a, i) => ({ ...actionOut(a), child: id + '.' + i }));
    out.hands = raw.hands;
  } else if (raw.kind === 'chance') {
    out.actions = raw.cards.map((c, i) => ({ label: cardName(c), type: 'deal', amount: 0, child: id + '.' + i }));
  } else if (raw.kind === 'fold') {
    out.terminal = { type: 'fold', winner: pos[1 - raw.folder] };
  } else {
    out.terminal = { type: 'showdown' };
    if (raw.board.length < 5) out.note = 'All-in before the river: value is the equity over all runouts.';
  }
  return out;
}

function parseId(id) {
  if (typeof id !== 'string' || !/^r(\.\d+)*$/.test(id)) return null;
  return id === 'r' ? [] : id.slice(2).split('.').map(Number);
}

function finishStats(s, t0) {
  return { ...s, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- engine interface
async function solve(params, onProgress) {
  const t0 = Date.now();
  const P = normalizeParams(params || {});
  const proc = await startProcess(P, 'full', onProgress);
  const cache = new Map(); // id -> Promise<Node>, small LRU
  let disposed = false;
  function getNode(id) {
    const p = parseId(id);
    if (!p) return Promise.resolve(null);
    if (disposed) return Promise.reject(new Error('solve was disposed'));
    let r = cache.get(id);
    if (r) { cache.delete(id); cache.set(id, r); return r; }
    r = proc.query(p).then((raw) => formatNode(P, id, raw), (e) => {
      cache.delete(id);
      if (/bad (deal|action) index|past a terminal/.test(e.message)) return null;
      throw e;
    });
    cache.set(id, r);
    while (cache.size > 500) cache.delete(cache.keys().next().value);
    return r;
  }
  return {
    root: 'r',
    getNode,
    dispose() { disposed = true; cache.clear(); proc.kill(); },
    stats: finishStats(proc.stats, t0),
    params: P,
  };
}

// Memory estimate of the tree without solving: { memoryMB, memoryRawMB, memoryCompressedMB, compressed, combos }.
async function estimate(params) {
  const P = normalizeParams(params || {});
  const bin = await ensureBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('exit', () => {
      const m = out.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } }).pop() || {};
      if (m.type === 'estimate') resolve(m); else reject(new Error(m.error || 'estimate failed'));
    });
    child.stdin.end(JSON.stringify(solverConfig(P, 'estimate')) + '\n');
  });
}

// Light solve for tools (calibration): the process exits after the solve; no node tree is kept.
async function solveStats(params, onProgress) {
  const t0 = Date.now();
  const proc = await startProcess(normalizeParams(params || {}), 'stats', onProgress);
  return finishStats(proc.stats, t0);
}

module.exports = {
  kind: 'postflop', title: 'Heads-up postflop', params, solve, solveStats, estimate, normalizeParams, solverConfig, ensureBinary,
  DEFAULT_RANGES, AUTO_SIZES,
};
