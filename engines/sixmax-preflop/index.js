'use strict';
// Engine 'sixmax-preflop': 6-max preflop (UTG..BB), ChipEV, CFR+ over 169 hand classes.
// See README.md and CONTRACT.md.
const path = require('path');
const { Worker } = require('worker_threads');
const { sha1, toBase64, fromBase64, files } = require('../../lib/platform');
const { className } = require('../../lib/equity');
const { POS, normalizeParams, buildTree, spotKey } = require('./tree');
const realization = require('../../lib/realization');

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
  { name: 'realization', type: 'select', options: ['calibrated', 'flat'], default: 'calibrated', label: 'Realization (calibrated = per hand, measured by postflop solves, per group; flat R where a group has no samples)' },
  { name: 'iterations', type: 'number', default: 1000, min: 10, max: 20000, step: 50, label: 'Iterations' },
  { name: 'maxSeconds', type: 'number', default: 240, min: 5, max: 1800, step: 5, label: 'Max solve time (s)' },
];

// At most one 6-max solve at a time (it uses up to 4 threads).
let chain = Promise.resolve();

// Calibration table of a spot (lib/realization.js, from cache/realization-samples/<spotKey>/), or null.
function loadTable(P) {
  if (P.realization !== 'calibrated') return null;
  try { return realization.buildGroupTable(spotKey(P), { rIp: P.rIp, rOop: P.rOop }); }
  catch (e) { console.error('sixmax-preflop: realization table failed:', e.message); return null; }
}

// Groups of the table that exist in this tree, as the worker wants them: [{ group, ip: [169 R], oop: [169 R] }].
function calibList(tree, table) {
  if (!table || !table.groups) return [];
  const inTree = new Set(tree.nodes.filter((n) => n.group).map((n) => n.group));
  return Object.keys(table.groups).filter((g) => inTree.has(g)).sort().map((g) => {
    const t = table.groups[g];
    return { group: g, ip: t[t.ip], oop: t[t.oop] };
  });
}

// Calibration state for the Solve tab (same shape as hu-preflop): one row per realization group, largest reach
// first. Rows: the 12 groups with the most reach plus every group with samples. groups: all groups.
const SHOW_GROUPS = 12;
function calibrationInfo(P, tree, mass, table) {
  const by = new Map();
  for (const n of tree.nodes) {
    if (!n.group) continue;
    const g = by.get(n.group) || { key: n.group, name: n.group, terminals: 0, mass: 0 };
    g.terminals++;
    if (mass) g.mass += mass[n.idx];
    by.set(n.group, g);
  }
  const groups = [...by.values()].map((g) => {
    const flops = table && table.counts[g.key] ? table.counts[g.key] : 0;
    return { ...g, mass: mass ? r4(g.mass) : undefined, flops, full: realization.FULL, m: +(flops / (flops + realization.MIX_K)).toFixed(3) };
  }).sort((a, b) => (b.mass || 0) - (a.mass || 0));
  return {
    mode: P.realization, spotKey: spotKey(P),
    source: table ? 'samples' : 'flat',
    table: table ? table.version : null,
    info: table ? table.info : null,
    terminals: groups.filter((g, i) => i < SHOW_GROUPS || g.flops > 0),
    groups,
  };
}

function runWorker(P, threads, onProgress, calib) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'worker.js'), { workerData: { role: 'master', P, threads, calib } });
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

function wrap(P, tree, offs, data, stats, mass, table) {
  const nodes = tree.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const calib = new Map(calibList(tree, table).map((g) => [g.group, table.groups[g.group]]));
  const sk = spotKey(P);
  const note = 'Preflop only. Flop = pot * equity * R (R IP ' + P.rIp + ', OOP ' + P.rOop + ')'
    + (calib.size ? `; per-hand R measured by postflop solves in ${calib.size} group${calib.size === 1 ? '' : 's'} (${table.info})` : '') + '. '
    + 'Shares normalized to the pot (zero-sum). Card removal: exact between two hands, folded players and 3-way pots approximated. '
    + 'Max ' + P.maxPlayers + ' players in a single-raised pot, heads-up in 3-bet+ pots; 5-bet = allin.';
  stats = { ...stats, spotKey: sk, calibration: calibrationInfo(P, tree, mass, table) };
  stats.realization = calib.size ? `calibrated (${calib.size} group${calib.size === 1 ? '' : 's'}, ${table.info})`
    : P.realization === 'calibrated' ? 'flat (no calibration samples for this spot)' : 'flat';
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
        // For calibration: a postflop solve from here with params.source = { kind, spotKey, terminalKey, group } saves a sample.
        t.spotKey = sk; t.key = n.id; t.group = n.group; t.name = n.name;
        if (mass) t.mass = r4(mass[n.idx]);
        const g = calib.get(n.group);
        t.calibrated = !!g;
        t.note = g ? `Valued with realization per hand from ${g.n} postflop sample${g.n === 1 ? '' : 's'} of group ${n.group} (IP avg ${g[g.ip + 'avg']}, OOP avg ${g[g.oop + 'avg']}).`
          : `Valued with flat R (IP ${P.rIp}, OOP ${P.rOop}): no samples for group ${n.group} yet.`;
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
  const tree = buildTree(P);
  // opts.table: a group table to use instead of the samples (tests); null = flat.
  const table = opts.table !== undefined ? opts.table : loadTable(P);
  const calib = calibList(tree, table);
  const file = cacheFile(P, calib.length ? table : null);
  const unpackMass = (d) => (d.mass ? fromBase64(d.mass, Float32Array) : null); // older cache files have no mass
  if (!opts.noCache && files.exists(file)) {
    try {
      const d = JSON.parse(await files.readTextAsync(file));
      onProgress(1, 'loaded from cache');
      return wrap(P, tree, fromBase64(d.offs, Int32Array), fromBase64(d.data, Float32Array), { ...d.stats, cached: true }, unpackMass(d), table);
    } catch (e) { /* solve again */ }
  }
  const prev = chain;
  let release;
  chain = new Promise((r) => { release = r; });
  onProgress(0, 'waiting for the previous 6-max solve');
  await prev;
  try {
    const res = await runWorker(P, opts.threads || 4, onProgress, calib);
    if (!opts.noCache) {
      await files.writeTextAsync(file, JSON.stringify({ v: VERSION, params: P, stats: res.stats, offs: toBase64(res.offs), data: toBase64(res.data), mass: toBase64(res.mass) }));
    }
    onProgress(1, 'done');
    const out = wrap(P, tree, res.offs, res.data, res.stats, res.mass, table);
    if (opts.raw) out.raw = res; // tests: the packed result
    return out;
  } finally { release(); }
}

// Cache file. Without calibrated groups the key is the one of the flat engine before calibration existed (same
// result, same file); with groups it adds the table version, so new samples give a new entry.
function cacheFile(raw, table) {
  const P = normalizeParams(raw);
  const solveKey = { ...P }; delete solveKey.maxSeconds; delete solveKey.realization;
  const key = { v: VERSION, P: solveKey };
  if (table) key.tv = table.version;
  return path.join(CACHE, `sixmax-preflop-${sha1(JSON.stringify(key)).slice(0, 16)}.json`);
}

module.exports = { kind: 'sixmax-preflop', title: '6-max preflop', params, solve, normalizeParams, spotKey, loadTable, cacheFile };
