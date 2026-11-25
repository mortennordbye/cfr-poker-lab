'use strict';
// Flop reports: solve one heads-up flop spot on many flops (lib/flops.js flopSubset(n)) and aggregate the root
// results, so the user sees how the strategy changes with the board. Used by server.js (/api/report) and by
// tools/flop-report.js. See CONTRACT.md, section "Flop reports".
//
// Input: { kind: 'hu-preflop' | 'sixmax-preflop', params, terminalKey } (a flop terminal of a preflop solve)
//     or { spot: { ranges, pot, stack, oop, ip } } (a postflop spot), plus flops (25 | 49 | 95) and tree
//     (postflop engine params: bet sizes, targetExploitability, maxSeconds, iterations, threads).
// Each flop: one postflop solve (one at a time). Stored per flop: board, texture, OOP root strategy, IP strategy
// after an OOP check, EV and equity of both players, exploitability, time. A flop from a hu-preflop terminal also
// saves a realization sample (lib/realization.js), so reports and calibration share the work.
// Storage: <dir>/<id>.json, id = hash of the input. The file is written after each flop: a stopped run continues
// where it was when the same input is started again.
const path = require('path');
const { files, sha1 } = require('./platform');
const { parseCard } = require('./equity');
const { flopSubset } = require('./flops');
const RZ = require('./realization');

const VERSION = 1;
const REPORTS_DIR = process.env.REPORTS_DIR || path.join(__dirname, '..', 'cache', 'reports');
const FLOP_COUNTS = [25, 49, 95];
const PREFLOP_KINDS = ['hu-preflop', 'sixmax-preflop'];
// Postflop params a report may set, and the report defaults (threads do not change the report id).
const TREE_KEYS = ['flopBets', 'flopRaises', 'turnBets', 'turnRaises', 'riverBets', 'riverRaises', 'donkBets', 'raiseCap',
  'allinSpr', 'iterations', 'targetExploitability', 'maxSeconds', 'threads'];
const TREE_DEFAULTS = { targetExploitability: 1, maxSeconds: 300, threads: 8 };

const RANKS = '23456789TJQKA';
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
const badInput = (msg) => Object.assign(new Error(msg), { status: 400 });

// ---- texture ----
// { suits: 'monotone' | 'two-tone' | 'rainbow', pairing: 'unpaired' | 'paired' | 'trips', high: 'A', highRank: 12,
//   ranks: [12, 7, 3] (high first), group: lib/realization.js texture group }
function texture(board) {
  const s = String(board).replace(/\s+/g, '');
  const c = [0, 2, 4].map((i) => parseCard(s.slice(i, i + 2)));
  if (c.some((x) => !(x >= 0 && x < 52)) || new Set(c).size !== 3) throw new Error(`bad flop: ${board}`);
  const r = c.map((x) => x >> 2).sort((a, b) => b - a);
  const ns = new Set(c.map((x) => x & 3)).size;
  return {
    suits: ns === 1 ? 'monotone' : ns === 2 ? 'two-tone' : 'rainbow',
    pairing: r[0] === r[2] ? 'trips' : r[0] === r[1] || r[1] === r[2] ? 'paired' : 'unpaired',
    high: RANKS[r[0]], highRank: r[0], ranks: r,
    group: RZ.texGroup(s),
  };
}

// ---- one node: overall action frequencies (weighted by reach) ----
// [{ label, type, amount, freq }]. bet = share of bet, raise and allin actions.
function actionFreqs(node) {
  if (!node || !node.actions || !node.actions.length) return null;
  const hands = Object.values(node.hands || {});
  const tot = hands.reduce((s, h) => s + h.weight, 0);
  const actions = node.actions.map((a, i) => ({
    label: a.label, type: a.type, amount: a.amount,
    freq: tot > 0 ? r4(hands.reduce((s, h) => s + h.weight * (h.strategy[i] || 0), 0) / tot) : 0,
  }));
  const bet = r4(actions.filter((a) => /^(bet|raise|allin)$/.test(a.type)).reduce((s, a) => s + a.freq, 0));
  return { player: node.toAct, actions, bet };
}

// Weighted mean of a field over results (each flop of flopSubset stands for an equal share of all flops).
function mean(list, get) {
  let s = 0, n = 0;
  for (const x of list) { const v = get(x); if (Number.isFinite(v)) { s += v; n++; } }
  return n ? r4(s / n) : null;
}
// Mean action frequencies by label. A flop where an action is missing counts as 0 for it.
function meanActions(list, side) {
  const withSide = list.filter((x) => x[side]);
  if (!withSide.length) return null;
  const order = [], sum = {}, meta = {};
  for (const x of withSide) for (const a of x[side].actions) {
    if (!(a.label in sum)) { order.push(a.label); sum[a.label] = 0; meta[a.label] = { type: a.type, amount: a.amount }; }
    sum[a.label] += a.freq;
  }
  return {
    n: withSide.length,
    actions: order.map((label) => ({ label, ...meta[label], freq: r4(sum[label] / withSide.length) })),
    bet: mean(withSide, (x) => x[side].bet),
  };
}

const HIGH_GROUPS = [['A', 'A-high', (r) => r === 12], ['K', 'K-high', (r) => r === 11], ['Q', 'Q-high', (r) => r === 10],
  ['J', 'J-high', (r) => r === 9], ['T', 'T-high', (r) => r === 8], ['9', '9-high or lower', (r) => r <= 7]];
const GROUPS = [
  { key: 'all', label: 'All flops', test: () => true },
  ...['monotone', 'two-tone', 'rainbow'].map((v) => ({ key: v, label: v[0].toUpperCase() + v.slice(1), by: 'suits', test: (t) => t.suits === v })),
  ...['unpaired', 'paired', 'trips'].map((v) => ({ key: v, label: v[0].toUpperCase() + v.slice(1), by: 'pairing', test: (t) => t.pairing === v })),
  ...HIGH_GROUPS.map(([k, label, f]) => ({ key: 'high-' + k, label, by: 'high', test: (t) => f(t.highRank) })),
];

// Summary rows by texture group: [{ key, label, by, n, oop, ip, ev: { oop, ip }, eq: { oop, ip }, exploitabilityPctPot }].
// Groups without flops are left out.
function summarize(results) {
  const out = [];
  for (const g of GROUPS) {
    const list = results.filter((x) => x && x.texture && g.test(x.texture));
    if (!list.length) continue;
    out.push({
      key: g.key, label: g.label, by: g.by || null, n: list.length,
      oop: meanActions(list, 'oop'), ip: meanActions(list, 'ip'),
      ev: { oop: mean(list, (x) => x.ev.oop), ip: mean(list, (x) => x.ev.ip) },
      eq: { oop: mean(list, (x) => x.eq.oop), ip: mean(list, (x) => x.eq.ip) },
      exploitabilityPctPot: mean(list, (x) => x.exploitabilityPctPot),
    });
  }
  return out;
}

// One flop's entry from the solve's root node, the IP node after an OOP check (or null) and the stats.
function flopEntry(board, root, ipNode, stats, ms) {
  const avg = (m) => { const v = Object.values(m || {}); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  return {
    board, texture: texture(board),
    oop: actionFreqs(root), ip: actionFreqs(ipNode),
    // bb won from the flop root (share of the pot), and equity vs the other range. Rust gives them in stats.
    ev: { oop: r4(stats.evOop), ip: r4(stats.evIp) },
    eq: { oop: r4(Number.isFinite(stats.eqOop) ? stats.eqOop : avg(stats.rootEq && stats.rootEq.oop)),
      ip: r4(Number.isFinite(stats.eqIp) ? stats.eqIp : avg(stats.rootEq && stats.rootEq.ip)) },
    exploitabilityPctPot: stats.exploitabilityPctPot === undefined ? null : stats.exploitabilityPctPot,
    iterations: stats.iterations, ms,
  };
}

// ---- input ----
function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])]));
  return x;
}
function treeOf(t = {}) {
  const out = { ...TREE_DEFAULTS };
  for (const k of TREE_KEYS) if (t[k] !== undefined && t[k] !== null && t[k] !== '') out[k] = t[k];
  return out;
}
// Checks the input and fills defaults: { kind, params, terminalKey } | { spot }, flops, tree. Throws (status 400).
function normalizeInput(input = {}) {
  const flops = Number(input.flops || 25);
  if (!FLOP_COUNTS.includes(flops)) throw badInput(`flops must be one of ${FLOP_COUNTS.join(', ')}`);
  const tree = treeOf(input.tree);
  if (input.spot) {
    const s = input.spot;
    if (!s.ranges || typeof s.ranges !== 'object') throw badInput('spot.ranges is required: { pos: { hand: weight } | "range text" }');
    const oop = String(s.oop || 'BB'), ip = String(s.ip || 'SB');
    if (!s.ranges[oop] || !s.ranges[ip]) throw badInput(`spot.ranges needs ${oop} and ${ip}`);
    const pot = Number(s.pot), stack = Number(s.stack);
    if (!(pot > 0) || !(stack > 0)) throw badInput('spot.pot and spot.stack must be positive numbers');
    return { spot: { ranges: s.ranges, pot, stack, oop, ip }, flops, tree };
  }
  if (!PREFLOP_KINDS.includes(input.kind)) throw badInput(`kind must be one of ${PREFLOP_KINDS.join(', ')}, or give spot`);
  if (!input.terminalKey) throw badInput('terminalKey is required (node.terminal.key, or the node id of the flop terminal)');
  return { kind: input.kind, params: input.params || {}, terminalKey: String(input.terminalKey), flops, tree };
}
// Report id: hash of the input without threads (threads change speed, not the report).
function reportId(inp) {
  const { threads, ...tree } = inp.tree;
  return sha1(JSON.stringify(sortKeys({ v: VERSION, ...inp, tree }))).slice(0, 16);
}

// The flop terminal of a preflop solve: by node id, or by its key ('SB:Raise 2.5/BB:Call', the actions from the root).
async function findTerminal(res, key) {
  const isFlop = (n) => n && n.terminal && n.terminal.type === 'flop';
  let n = null;
  try { n = await res.getNode(key); } catch (e) { n = null; }
  if (isFlop(n)) return n;
  n = await res.getNode(res.root);
  for (const step of String(key).split('/').filter(Boolean)) {
    const i = step.indexOf(':');
    const pos = step.slice(0, i), label = step.slice(i + 1);
    const a = n && n.toAct === pos && (n.actions || []).find((x) => x.label === label);
    if (!a) throw badInput(`no flop terminal ${key} (step ${step} not found)`);
    n = await res.getNode(a.child);
  }
  if (!isFlop(n) || (n.terminal.key && n.terminal.key !== key)) throw badInput(`${key} is not a flop terminal`);
  return n;
}

// The heads-up flop spot of the input: { oop, ip, pot, stack, ranges, source }.
async function resolveSpot(inp, engines) {
  if (inp.spot) return { ...inp.spot, source: null };
  const eng = engines[inp.kind];
  if (!eng) throw badInput(`engine ${inp.kind} is not loaded`);
  const res = await eng.solve(inp.params, () => {});
  try {
    const n = await findTerminal(res, inp.terminalKey);
    const t = n.terminal, f = t.flop;
    if (!f || !f.ranges) throw badInput(`${inp.terminalKey} is not a heads-up flop terminal`);
    return {
      oop: f.oop, ip: f.ip, pot: f.pot, stack: f.stack, ranges: f.ranges,
      source: { kind: inp.kind, spotKey: t.spotKey || null, terminalKey: t.key || n.id, name: t.name || null, mass: t.mass === undefined ? null : t.mass },
    };
  } finally { if (typeof res.dispose === 'function') { try { res.dispose(); } catch (e) { /* ignore */ } } }
}

// ---- runner ----
// engines: { kind: engine } (the server's registry). dir: where report files go. postflopKind: engine to use
// (default 'postflop', else 'postflop-js'). samples: save realization samples (default true).
function createReports({ engines, dir = REPORTS_DIR, postflopKind = null, samples = true, log = console.log, logError = console.error } = {}) {
  const live = new Map(); // id -> { status, message, current, flopProgress, startedAt }
  const queue = [];
  let busy = false;
  const fileOf = (id) => path.join(dir, `${id}.json`);
  const read = (id) => { try { return JSON.parse(files.readText(fileOf(id))); } catch (e) { return null; } };
  const write = (r) => { r.updatedAt = new Date().toISOString(); files.writeText(fileOf(r.id), JSON.stringify(r)); };
  const pkind = () => (postflopKind && engines[postflopKind] ? postflopKind : engines.postflop ? 'postflop' : engines['postflop-js'] ? 'postflop-js' : null);

  // Start (or continue) a report. Returns { reportId, status }. Throws on bad input (status 400).
  function start(input) {
    const inp = normalizeInput(input);
    if (!pkind()) throw badInput('no postflop engine loaded');
    const id = reportId(inp);
    const st = live.get(id);
    if (st && (st.status === 'queued' || st.status === 'running')) return { reportId: id, status: st.status };
    const old = read(id);
    if (old && old.status === 'done') return { reportId: id, status: 'done' };
    live.set(id, { status: 'queued', message: 'waiting for the report before it', current: null, flopProgress: 0 });
    queue.push({ id, inp });
    pump();
    return { reportId: id, status: 'queued' };
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const { id, inp } = queue.shift();
        try { await run(id, inp); } catch (e) {
          const st = live.get(id);
          Object.assign(st, { status: 'error', message: e.message });
          const r = read(id);
          if (r) { r.status = 'error'; r.error = e.message; write(r); } else st.error = e.message;
          logError(`report ${id} failed:`, e);
        }
      }
    } finally { busy = false; }
  }

  async function run(id, inp) {
    const st = live.get(id);
    st.status = 'running'; st.startedAt = Date.now();
    let r = read(id);
    if (!r || r.version !== VERSION) {
      st.message = 'solving the preflop spot';
      const spot = await resolveSpot(inp, engines);
      r = { id, version: VERSION, createdAt: new Date().toISOString(), status: 'running', input: inp, spot,
        name: spot.source && spot.source.name ? spot.source.name : `${spot.oop} vs ${spot.ip}, pot ${spot.pot}`,
        engine: pkind(), tree: inp.tree, flops: flopSubset(inp.flops), results: [], runMs: 0, error: null };
      write(r);
    }
    r.status = 'running'; r.error = null;
    const kind = pkind();
    const eng = engines[kind];
    const doneBoards = new Set(r.results.map((x) => x.board));
    const todo = r.flops.filter((b) => !doneBoards.has(b));
    log(`report ${id} (${r.name}): ${todo.length} of ${r.flops.length} flops to solve with ${kind}`);
    for (const board of todo) {
      const t0 = Date.now();
      st.current = board; st.flopProgress = 0; st.message = `solving ${board}`;
      const P = { board, pot: r.spot.pot, stack: r.spot.stack, oop: r.spot.oop, ip: r.spot.ip, ranges: r.spot.ranges, ...r.tree };
      const res = await eng.solve(P, (f, m) => { st.flopProgress = f; if (m) st.message = `${board}: ${m}`; });
      let root, ipNode = null;
      try {
        root = await res.getNode(res.root);
        const check = root && root.actions.find((a) => a.type === 'check');
        if (check) ipNode = await res.getNode(check.child);
      } finally { if (typeof res.dispose === 'function') { try { res.dispose(); } catch (e) { /* ignore */ } } }
      const ms = Date.now() - t0;
      const entry = flopEntry(board, root, ipNode, res.stats || {}, ms);
      const src = r.spot.source;
      if (samples && src && src.kind === 'hu-preflop' && src.spotKey && res.stats && res.stats.rootEv) {
        try {
          const eq = res.stats.rootEq ? null : await RZ.flopEquitiesAsync(board, r.spot.ranges, r.spot.oop, r.spot.ip);
          const sample = RZ.makeSample({ terminalKey: src.terminalKey, board, pot: r.spot.pot, ranges: r.spot.ranges, stats: res.stats, oop: r.spot.oop, ip: r.spot.ip, eq });
          entry.sample = RZ.saveSample(src.spotKey, sample) ? 'saved' : 'skipped (a newer sample exists)';
        } catch (e) { entry.sample = 'error: ' + e.message; }
      }
      r.results.push(entry);
      r.runMs += Date.now() - t0;
      write(r);
      log(`report ${id}: ${r.results.length}/${r.flops.length} ${board} expl ${entry.exploitabilityPctPot}% pot, ${(ms / 1000).toFixed(1)} s`);
    }
    r.results.sort((a, b) => r.flops.indexOf(a.board) - r.flops.indexOf(b.board));
    r.status = 'done';
    r.summary = summarize(r.results);
    write(r);
    Object.assign(st, { status: 'done', message: 'done', current: null, flopProgress: 0 });
    log(`report ${id} done: ${r.results.length} flops, ${(r.runMs / 1000).toFixed(0)} s solve time`);
  }

  // GET /api/report/:id answer, or null. Partial results while it runs. status 'stopped' = incomplete file, not
  // running (the process was stopped): start the same input again to continue.
  function status(id) {
    if (!/^[0-9a-f]{16}$/.test(String(id))) return null;
    const st = live.get(id);
    const r = read(id);
    if (!r && !st) return null;
    if (!r) return { id, status: st.status, message: st.message, error: st.error || null, progress: 0, done: 0, total: null, results: [], summary: [] };
    const done = r.results.length, total = r.flops.length;
    const status = st ? st.status : r.status === 'done' || r.status === 'error' ? r.status : 'stopped';
    const running = status === 'running';
    const perFlop = done ? r.runMs / done : null;
    return {
      id, status, message: st ? st.message : status === 'stopped' ? 'stopped: start it again to continue' : r.status,
      error: r.error || (st && st.error) || null,
      progress: r4(running ? (done + (st.flopProgress || 0)) / total : done / total),
      done, total, current: running ? st.current : null,
      etaMs: running && perFlop ? Math.round(perFlop * (total - done) - (st.flopProgress || 0) * perFlop) : null,
      name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt, runMs: r.runMs, engine: r.engine,
      input: r.input, spot: r.spot, tree: r.tree, flops: r.flops,
      results: r.results, summary: r.summary || summarize(r.results),
    };
  }

  // GET /api/reports answer: newest first, without the per-flop data.
  function list() {
    let names = [];
    try { names = files.list(dir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f)); } catch (e) { return []; }
    const out = [];
    for (const f of names) {
      const s = status(f.slice(0, -5));
      if (!s || !s.flops) continue;
      out.push({ id: s.id, status: s.status, name: s.name, done: s.done, total: s.total, progress: s.progress,
        createdAt: s.createdAt, updatedAt: s.updatedAt, runMs: s.runMs, input: s.input });
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  const isBusy = () => busy;
  return { start, status, list, isBusy, dir };
}

module.exports = {
  VERSION, REPORTS_DIR, FLOP_COUNTS, GROUPS, texture, actionFreqs, summarize, flopEntry, normalizeInput, reportId,
  findTerminal, resolveSpot, createReports,
};
