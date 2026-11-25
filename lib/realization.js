'use strict';
// Learn-as-you-browse realization calibration for the heads-up preflop engine.
//
// Samples: one file per (spot, flop terminal, board), written after each postflop solve that started from a
// hu-preflop flop terminal (UI "Solve flop", idle filler, tools/calibrate-hu.js):
//   cache/realization-samples/<spotKey>/<sha1(terminalKey)[0..12]>/<board>.json
//   { terminalKey, board, pot, rangesHash, ranges, createdAt, ev: { SB: {combo: ev}, BB: {...} }, eq: { SB, BB } }
// ev = combo's EV at the flop root (bb won from this point, = its share of the pot), eq = its equity on that
// board vs the opponent's range.
//
// buildTable() turns the samples of a spot into the rTable that engines/hu-preflop reads:
//   R(class) = sum(w * EV) / sum(w * pot * eq), w = texture-group weight x recency weight,
//   then R = m * Rmeasured + (1 - m) * Rflat, m = n / (n + 5), clamped to [0.2, 3].
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { N, COMBOS, classOf, className, parseCard, comboName, eval7 } = require('./equity');

const SAMPLES_DIR = process.env.REALIZATION_SAMPLES_DIR || path.join(__dirname, '..', 'cache', 'realization-samples');
const FULL = 20; // flops per terminal that count as "full" in the UI
const MIX_K = 5; // m = n / (n + MIX_K)
const R_MIN = 0.2, R_MAX = 3;

const sha = (x, n = 12) => crypto.createHash('sha1').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, n);
const classIdx = {};
for (let i = 0; i < N; i++) classIdx[className(i)] = i;
const comboClass = (combo) => classOf(parseCard(combo.slice(0, 2)), parseCard(combo.slice(2, 4)));
const clamp = (x) => Math.min(R_MAX, Math.max(R_MIN, x));

// ---- paths ----
const termHash = (terminalKey) => sha(String(terminalKey));
const spotDir = (spotKey, o = {}) => path.join(o.dir || SAMPLES_DIR, String(spotKey));
const termDir = (spotKey, terminalKey, o = {}) => path.join(spotDir(spotKey, o), termHash(terminalKey));
const boardName = (b) => (Array.isArray(b) ? b.join('') : String(b)).replace(/\s+/g, '');

// Ranges hash: rounded to 2 decimals so tiny solver noise does not count as a new range.
function rangesHash(ranges) {
  const out = {};
  for (const pos of Object.keys(ranges || {}).sort()) {
    const r = ranges[pos] || {};
    out[pos] = Object.keys(r).sort().filter((k) => r[k] >= 0.005).map((k) => k + ':' + Math.round(r[k] * 100));
  }
  return sha(out);
}

// ---- texture groups: suit pattern x pairing x high-card bucket ----
function texGroup(board) {
  const s = boardName(board);
  const c = [0, 2, 4].map((i) => parseCard(s.slice(i, i + 2)));
  const r = c.map((x) => x >> 2).sort((a, b) => b - a);
  const ns = new Set(c.map((x) => x & 3)).size;
  const suit = ns === 1 ? 0 : ns === 2 ? 1 : 2; // monotone, two-tone, rainbow
  const pair = r[0] === r[2] ? 0 : r[0] === r[1] || r[1] === r[2] ? 1 : 2; // trips, paired, unpaired
  const hi = r[0] === 12 ? 0 : r[0] >= 10 ? 1 : r[0] >= 8 ? 2 : 3; // A, K-Q, J-T, 9 or lower
  return `${['mono', 'two', 'rain'][suit]}-${['trips', 'paired', 'unpaired'][pair]}-${['A', 'KQ', 'JT', 'low'][hi]}`;
}
let shares = null;
// Share of all 22,100 flops in each texture group.
function groupShares() {
  if (shares) return shares;
  const RK = '23456789TJQKA', SU = 'cdhs', nm = (x) => RK[x >> 2] + SU[x & 3];
  const cnt = {};
  let tot = 0;
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) for (let c = b + 1; c < 52; c++) {
    const g = texGroup(nm(a) + nm(b) + nm(c));
    cnt[g] = (cnt[g] || 0) + 1; tot++;
  }
  shares = {};
  for (const [g, n] of Object.entries(cnt)) shares[g] = n / tot;
  return shares;
}

// ---- flop equity (Monte Carlo, card removal) ----
// Equity of each combo of heroRange (class -> weight) on this board vs oppRange. Board 3 to 5 cards.
function flopEquities(board, heroRange, oppRange, samples = 400) {
  const bs = boardName(board);
  const b = [];
  for (let i = 0; i < bs.length; i += 2) b.push(parseCard(bs.slice(i, i + 2)));
  const nb = b.length, toDeal = 5 - nb;
  const onBoard = (c) => b.includes(c);
  let seed = 0x2545f491;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const opp = [];
  let oppW = 0;
  for (const [name, w] of Object.entries(oppRange || {})) {
    const id = classIdx[name]; if (id === undefined || !(w > 0)) continue;
    for (const [x, y] of COMBOS[id]) if (!onBoard(x) && !onBoard(y)) { oppW += w; opp.push([x, y, oppW]); }
  }
  const out = {};
  if (!opp.length) return out;
  const h1 = new Int32Array(7), h2 = new Int32Array(7), deck = new Int32Array(52);
  for (const [name, w] of Object.entries(heroRange || {})) {
    const id = classIdx[name]; if (id === undefined || !(w > 0)) continue;
    for (const [x, y] of COMBOS[id]) {
      if (onBoard(x) || onBoard(y)) continue;
      let score = 0, n = 0, guard = 0;
      while (n < samples && guard++ < samples * 20) {
        const t = (rnd() / 4294967296) * oppW;
        let lo = 0, hi = opp.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (opp[m][2] < t) lo = m + 1; else hi = m; }
        const [p, q] = opp[lo];
        if (p === x || p === y || q === x || q === y) continue;
        let k = 0;
        for (let c = 0; c < 52; c++) if (c !== x && c !== y && c !== p && c !== q && !onBoard(c)) deck[k++] = c;
        h1[0] = x; h1[1] = y; h2[0] = p; h2[1] = q;
        for (let j = 0; j < nb; j++) { h1[2 + j] = b[j]; h2[2 + j] = b[j]; }
        if (toDeal >= 1) { const i1 = rnd() % k; h1[2 + nb] = h2[2 + nb] = deck[i1]; deck[i1] = deck[k - 1]; }
        if (toDeal >= 2) { const i2 = rnd() % (k - 1); h1[3 + nb] = h2[3 + nb] = deck[i2]; }
        const s1 = eval7(h1), s2 = eval7(h2);
        score += s1 > s2 ? 1 : s1 === s2 ? 0.5 : 0; n++;
      }
      if (n) out[comboName(x, y)] = +(score / n).toFixed(4);
    }
  }
  return out;
}

// Same, both players, in a worker thread (about 1 s of CPU, so it must not run on the server's event loop).
function flopEquitiesAsync(board, ranges, oop = 'BB', ip = 'SB') {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { realizationEq: true, board, ranges, oop, ip } });
    w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(m.eq)));
    w.once('error', reject);
  });
}
if (!isMainThread && workerData && workerData.realizationEq) {
  try {
    const { board, ranges, oop, ip } = workerData;
    parentPort.postMessage({ eq: { [ip]: flopEquities(board, ranges[ip], ranges[oop]), [oop]: flopEquities(board, ranges[oop], ranges[ip]) } });
  } catch (e) { parentPort.postMessage({ error: String((e && e.stack) || e) }); }
}

// ---- samples ----
// Build a sample from postflop solve stats. OOP = BB, IP = SB in heads-up (positions come from the params).
// eq: stats.rootEq (Rust engine) if present, else the given eq, else null (caller computes it).
function makeSample({ terminalKey, board, pot, ranges, stats, oop = 'BB', ip = 'SB', eq = null, createdAt }) {
  const ev = { [oop]: stats.rootEv.oop, [ip]: stats.rootEv.ip };
  const e = stats.rootEq ? { [oop]: stats.rootEq.oop, [ip]: stats.rootEq.ip } : eq;
  return {
    terminalKey, board: boardName(board), pot: Number(pot), rangesHash: rangesHash(ranges), ranges,
    createdAt: createdAt || new Date().toISOString(),
    solver: { iterations: stats.iterations, exploitabilityPctPot: stats.exploitabilityPctPot, eqSource: stats.rootEq ? 'engine' : 'monte-carlo' },
    ev, eq: e,
  };
}

// Write a sample. Overwrites the same board of the same terminal only with a newer sample.
// Returns the file path, or null if a newer (or same-age) sample is already there.
function saveSample(spotKey, sample, o = {}) {
  if (!sample || !sample.terminalKey || !sample.board || !sample.ev || !sample.eq) throw new Error('incomplete sample');
  const dir = termDir(spotKey, sample.terminalKey, o);
  const file = path.join(dir, `${boardName(sample.board)}.json`);
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old.createdAt && Date.parse(old.createdAt) >= Date.parse(sample.createdAt)) return null;
  } catch (e) { /* no old sample */ }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sample));
  fs.renameSync(tmp, file);
  return file;
}

// Boards sampled for one terminal (from the file names, cheap).
function sampledBoards(spotKey, terminalKey, o = {}) {
  try { return fs.readdirSync(termDir(spotKey, terminalKey, o)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch (e) { return []; }
}
const sampleCount = (spotKey, terminalKey, o = {}) => sampledBoards(spotKey, terminalKey, o).length;
function readSample(spotKey, terminalKey, board, o = {}) {
  try { return JSON.parse(fs.readFileSync(path.join(termDir(spotKey, terminalKey, o), boardName(board) + '.json'), 'utf8')); } catch (e) { return null; }
}

// All sample files of a spot with mtime and size. Version = hash of that list (changes when any sample changes).
function sampleFiles(spotKey, o = {}) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(spotDir(spotKey, o)); } catch (e) { return out; }
  for (const d of dirs.sort()) {
    const full = path.join(spotDir(spotKey, o), d);
    let files = [];
    try { files = fs.readdirSync(full); } catch (e) { continue; }
    for (const f of files.sort()) {
      if (!f.endsWith('.json')) continue;
      try { const st = fs.statSync(path.join(full, f)); out.push({ file: path.join(full, f), rel: d + '/' + f, mtimeMs: st.mtimeMs, size: st.size }); } catch (e) { /* gone */ }
    }
  }
  return out;
}
function samplesVersion(spotKey, o = {}) {
  const files = sampleFiles(spotKey, o);
  return files.length ? sha(files.map((f) => `${f.rel}:${Math.round(f.mtimeMs)}:${f.size}`).join('|'), 16) : null;
}

const parsed = new Map(); // file -> { mtimeMs, size, sample }
function loadSamples(spotKey, o = {}) {
  const out = [];
  for (const f of sampleFiles(spotKey, o)) {
    const c = parsed.get(f.file);
    if (c && c.mtimeMs === f.mtimeMs && c.size === f.size) { out.push(c.sample); continue; }
    try {
      const sample = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      parsed.set(f.file, { mtimeMs: f.mtimeMs, size: f.size, sample });
      out.push(sample);
    } catch (e) { /* half-written or broken: skip */ }
  }
  return out;
}

// ---- table ----
// One terminal's samples -> { SB: [169 R], BB: [169 R], SBavg, BBavg, n, m, groups }.
// o: rIp, rOop (flat R), refHash (ranges hash of the current terminal; default: the newest sample's),
//    halfLifeDays (recency, relative to the newest sample), mismatchWeight (sample from other ranges), mixK.
function terminalR(samples, o = {}) {
  const rFlat = { SB: o.rIp !== undefined ? o.rIp : 1.0, BB: o.rOop !== undefined ? o.rOop : 0.88 };
  const halfLife = (o.halfLifeDays !== undefined ? o.halfLifeDays : 7) * 864e5;
  const mismatch = o.mismatchWeight !== undefined ? o.mismatchWeight : 0.5;
  const K = o.mixK !== undefined ? o.mixK : MIX_K;
  const boards = new Map(); // one sample per board: the newest
  for (const s of samples) { const b = boardName(s.board); const old = boards.get(b); if (!old || Date.parse(s.createdAt) > Date.parse(old.createdAt)) boards.set(b, s); }
  const list = [...boards.values()];
  const n = list.length, m = n / (n + K);
  const out = { n, m: +m.toFixed(4) };
  if (!n) { for (const pos of ['SB', 'BB']) { out[pos] = new Array(N).fill(rFlat[pos]); out[pos + 'avg'] = null; } return out; }
  const newest = Math.max(...list.map((s) => Date.parse(s.createdAt) || 0));
  const ref = o.refHash || list.reduce((a, s) => (Date.parse(s.createdAt) >= Date.parse(a.createdAt) ? s : a)).rangesHash;
  const sh = groupShares();
  const rec = list.map((s) => Math.pow(0.5, (newest - (Date.parse(s.createdAt) || 0)) / halfLife) * (s.rangesHash === ref ? 1 : mismatch));
  const grp = list.map((s) => texGroup(s.board));
  const gRec = {};
  grp.forEach((g, i) => (gRec[g] = (gRec[g] || 0) + rec[i]));
  // Each sampled group counts by its share of all flops; inside a group, newer samples count more.
  const w = list.map((s, i) => (gRec[grp[i]] > 0 ? ((sh[grp[i]] || 0) * rec[i]) / gRec[grp[i]] : 0));
  out.groups = Object.keys(gRec).length;
  for (const pos of ['SB', 'BB']) {
    const ev = new Float64Array(N), pe = new Float64Array(N);
    list.forEach((s, i) => {
      if (!(w[i] > 0) || !s.ev || !s.eq || !s.ev[pos] || !s.eq[pos]) return;
      const rr = s.ranges && s.ranges[pos];
      for (const [combo, e] of Object.entries(s.ev[pos])) {
        const q = s.eq[pos][combo];
        if (q === undefined || !Number.isFinite(e)) continue;
        const c = comboClass(combo);
        const rw = rr ? rr[className(c)] || 0 : 1;
        if (!(rw > 0)) continue;
        ev[c] += w[i] * rw * e; pe[c] += w[i] * rw * s.pot * q;
      }
    });
    let sEv = 0, sPe = 0;
    for (let c = 0; c < N; c++) { sEv += ev[c]; sPe += pe[c]; }
    const avg = sPe > 1e-12 ? clamp(sEv / sPe) : rFlat[pos];
    const R = new Array(N);
    for (let c = 0; c < N; c++) {
      const meas = pe[c] > 1e-9 ? clamp(ev[c] / pe[c]) : avg;
      R[c] = +clamp(m * meas + (1 - m) * rFlat[pos]).toFixed(4);
    }
    out[pos] = R;
    out[pos + 'avg'] = +avg.toFixed(4);
  }
  return out;
}

// rTable for a spot from its samples, in the format engines/hu-preflop reads:
// { key, version, builtAt, info, terminals: { [terminalKey]: { SB, BB, SBavg, BBavg, n, m, pot } }, counts }
// null when the spot has no samples. o: rIp, rOop, currentRanges { [terminalKey]: ranges }, dir, ...
const tableMemo = new Map();
function buildTable(spotKey, o = {}) {
  const version = samplesVersion(spotKey, o);
  if (!version) return null;
  const mk = JSON.stringify([spotKey, version, o.rIp, o.rOop, o.dir, o.halfLifeDays, o.mismatchWeight, o.mixK, o.currentRanges ? sha(o.currentRanges) : null]);
  if (tableMemo.has(mk)) return tableMemo.get(mk);
  const byTerm = new Map();
  for (const s of loadSamples(spotKey, o)) {
    if (!s || !s.terminalKey) continue;
    if (!byTerm.has(s.terminalKey)) byTerm.set(s.terminalKey, []);
    byTerm.get(s.terminalKey).push(s);
  }
  const terminals = {}, counts = {};
  let flops = 0;
  for (const [key, list] of byTerm) {
    const cur = o.currentRanges && o.currentRanges[key];
    const t = terminalR(list, { ...o, refHash: cur ? rangesHash(cur) : undefined });
    t.pot = list[0].pot;
    terminals[key] = t; counts[key] = t.n; flops += t.n;
  }
  const table = {
    key: spotKey, version, builtAt: new Date().toISOString(),
    info: `${flops} flop sample${flops === 1 ? '' : 's'} on ${byTerm.size} spot${byTerm.size === 1 ? '' : 's'}`,
    terminals, counts,
  };
  tableMemo.set(mk, table);
  while (tableMemo.size > 20) tableMemo.delete(tableMemo.keys().next().value);
  return table;
}

module.exports = {
  SAMPLES_DIR, FULL, MIX_K, rangesHash, termHash, termDir, spotDir, texGroup, groupShares,
  flopEquities, flopEquitiesAsync, makeSample, saveSample, readSample, sampledBoards, sampleCount,
  sampleFiles, samplesVersion, loadSamples, terminalR, buildTable,
};
