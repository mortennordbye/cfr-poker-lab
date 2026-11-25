'use strict';
// Engine 'hu-preflop': heads-up preflop SB vs BB, ChipEV, CFR+. See README.md and CONTRACT.md.
const path = require('path');
const { Worker } = require('worker_threads');
const { sha1, files } = require('../../lib/platform');
const { VERSION, normalizeParams, spotKey, terminalName } = require('./solver');
const realization = require('../../lib/realization');

const CACHE = path.join(__dirname, '..', '..', 'cache');

const params = [
  { name: 'stack', type: 'number', default: 100, min: 2, max: 300, step: 1, label: 'Stack (bb)' },
  { name: 'ante', type: 'number', default: 0, min: 0, max: 2, step: 0.05, label: 'Ante (bb)' },
  { name: 'sbOpen', type: 'text', default: '2.5', label: 'SB open sizes (bb, comma list, empty = none)' },
  { name: 'limp', type: 'boolean', default: true, label: 'Allow SB limp' },
  { name: 'isoSize', type: 'number', default: 4, min: 0, max: 50, step: 0.5, label: 'BB raise vs limp (bb, 0 = none)' },
  { name: 'threeBetX', type: 'number', default: 4, min: 0, max: 10, step: 0.1, label: '3-bet size (x of raise, 0 = none)' },
  { name: 'fourBetX', type: 'number', default: 2.2, min: 0, max: 10, step: 0.1, label: '4-bet size (x of 3-bet, 0 = none)' },
  { name: 'rIp', type: 'number', default: 1.0, min: 0.5, max: 1.5, step: 0.01, label: 'Equity realization IP (SB)' },
  { name: 'rOop', type: 'number', default: 0.88, min: 0.5, max: 1.5, step: 0.01, label: 'Equity realization OOP (BB)' },
  { name: 'realization', type: 'select', options: ['calibrated', 'flat'], default: 'calibrated', label: 'Realization (calibrated = measured by postflop solves; falls back to flat R if no table)' },
  { name: 'iterations', type: 'number', default: 1500, min: 10, max: 20000, step: 100, label: 'Iterations' },
];

const MAX_WORKERS = 4;
let running = 0;
const queue = [];
function slot() { return new Promise((res) => { if (running < MAX_WORKERS) { running++; res(); } else queue.push(res); }); }
function release() { const next = queue.shift(); if (next) next(); else running--; }

// Calibration table for a spot. First choice: built from the flop samples in cache/realization-samples/<spot>/
// (lib/realization.js). Fallback: the old batch table cache/realization-hu-<spot>.json. null if neither exists.
function tableFile(P) { return path.join(CACHE, `realization-hu-${spotKey(P)}.json`); }
function loadTable(P) {
  if (P.realization !== 'calibrated') return null;
  try {
    const t = realization.buildTable(spotKey(P), { rIp: P.rIp, rOop: P.rOop });
    if (t && Object.keys(t.terminals).length) return t;
  } catch (e) { console.error('hu-preflop: realization table failed:', e.message); }
  try { return JSON.parse(files.readText(tableFile(P))); } catch (e) { return null; }
}

// Per-terminal sample counts for the Solve tab: [{ key, name, flops, full, mass, m }], largest reach first.
function calibrationInfo(P, data, rTable) {
  const sk = spotKey(P);
  const terms = Object.values(data.nodes).filter((n) => n.terminal && n.terminal.type === 'flop').map((n) => {
    const flops = realization.sampleCount(sk, n.terminal.key);
    return { key: n.terminal.key, name: n.terminal.name || terminalName(n.terminal.key), flops, full: realization.FULL,
      mass: n.terminal.mass, m: +(flops / (flops + realization.MIX_K)).toFixed(3) };
  }).sort((a, b) => (b.mass || 0) - (a.mass || 0));
  return {
    mode: P.realization, spotKey: sk,
    source: rTable ? (rTable.version ? 'samples' : 'batch table') : 'flat',
    table: rTable ? rTable.version || rTable.builtAt || null : null,
    terminals: terms,
  };
}

function runWorker(P, onProgress, rTable) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'worker.js'), { workerData: { params: P, rTable } });
    w.on('message', (m) => {
      if (m.progress !== undefined) onProgress(m.progress, m.message);
      else if (m.error) reject(new Error(m.error));
      else if (m.result) { resolve(m.result); w.terminate(); } // a browser worker does not stop by itself
    });
    w.on('error', reject);
    w.on('exit', (code) => { if (code !== 0) reject(new Error('worker exit ' + code)); });
  });
}

function wrap(data) {
  return { root: 'n0', getNode: (id) => data.nodes[id] || null, stats: data.stats };
}

function cacheFile(raw, rTable) {
  const P = normalizeParams(raw);
  const tv = rTable ? rTable.version || rTable.builtAt || 'table' : null; // new samples give a new cache entry
  const hash = sha1(JSON.stringify({ v: VERSION, P, tv })).slice(0, 16);
  return path.join(CACHE, `hu-preflop-${hash}.json`);
}

async function solve(raw, onProgress = () => {}) {
  const P = normalizeParams(raw);
  const rTable = loadTable(P);
  const file = cacheFile(P, rTable);
  if (files.exists(file)) {
    try {
      const data = JSON.parse(await files.readTextAsync(file));
      onProgress(1, 'loaded from cache');
      data.stats.cached = true;
      data.stats.calibration = calibrationInfo(P, data, rTable);
      return wrap(data);
    } catch (e) { /* fall through and solve again */ }
  }
  onProgress(0, 'waiting for a worker');
  await slot();
  let data;
  try { data = await runWorker(P, onProgress, rTable); } finally { release(); }
  onProgress(0.98, 'saving cache');
  try { await files.writeTextAsync(file, JSON.stringify(data)); } catch (e) { /* cache is optional */ }
  data.stats.cached = false;
  data.stats.calibration = calibrationInfo(P, data, rTable);
  return wrap(data);
}

module.exports = { kind: 'hu-preflop', title: 'Heads-up preflop (SB vs BB)', params, solve, cacheFile, tableFile, loadTable, spotKey };
