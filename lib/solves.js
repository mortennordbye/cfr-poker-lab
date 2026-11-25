'use strict';
// Solve jobs behind the HTTP API (CONTRACT.md): start, status, node, and the realization sample that a postflop
// solve from a hu-preflop or sixmax-preflop flop terminal saves. Used by server.js and by the static site's in-page API
// (public/browser/local-api.js), so both answer the same way.
const RZ = require('./realization');

// Per-combo calibration data (rootEv, rootEq) is large and only used here: leave it out of status answers.
function slimStats(st) {
  if (!st || (!st.rootEv && !st.rootEq)) return st;
  const { rootEv, rootEq, ...rest } = st;
  return rest;
}

// A postflop solve started from a preflop flop terminal (params.source) saves a realization sample.
// sixmax-preflop samples also carry the terminal's group; their count is per group (the unit the engine calibrates).
// rel(file) gives the file name shown in the status answer.
async function saveSample(job, rel = (f) => f, log = console.log) {
  const src = job.source, st = job.result && job.result.stats;
  const P = { ...job.params, ...((job.result && job.result.params) || {}) };
  const board = String(P.board || '').replace(/\s+/g, '');
  if (!st || !st.rootEv) { job.sample = { error: 'engine gave no rootEv' }; return; }
  if (board.length !== 6) { job.sample = { error: 'samples are for flop solves only' }; return; }
  const oop = P.oop || 'BB', ip = P.ip || 'SB';
  const ranges = job.params.ranges;
  const eq = st.rootEq ? null : await RZ.flopEquitiesAsync(board, ranges, oop, ip);
  const group = src.kind === 'sixmax-preflop' ? src.group : undefined;
  const sample = RZ.makeSample({ terminalKey: src.terminalKey, board, pot: P.pot, ranges, stats: st, oop, ip, eq, group });
  const file = RZ.saveSample(src.spotKey, sample);
  const flops = group ? RZ.groupSampleCount(src.spotKey, group) : RZ.sampleCount(src.spotKey, src.terminalKey);
  job.sample = file ? { file: rel(file), flops, ...(group ? { group } : {}) } : { skipped: 'a newer sample exists' };
  log(`realization sample ${file ? 'saved: ' + rel(file) : 'skipped (newer exists)'} (${src.terminalKey} ${board})`);
}

// params.source of a postflop solve: { kind: 'hu-preflop', spotKey, terminalKey } or
// { kind: 'sixmax-preflop', spotKey, terminalKey, group }. Anything else: no sample.
function validSource(source) {
  if (!source || !source.spotKey || !source.terminalKey) return null;
  if (!/^[\w-]{1,64}$/.test(String(source.spotKey))) return null; // it names a folder
  if (source.kind === 'hu-preflop') return source;
  if (source.kind === 'sixmax-preflop' && source.group) return source;
  return null;
}

// engines: { kind: engine }. maxSolves: finished solves kept in memory. maxPostflop: finished postflop solves kept.
// onStart(kind, params): called for each new solve (server.js: idle filler). rel: see saveSample.
function createSolves({ engines, maxSolves = 4, maxPostflop = Infinity, onStart = () => {}, rel, log = console.log, logError = console.error }) {
  const solves = new Map(); // solveId -> { status, progress, message, result, error, kind, source, sample }

  function start(kind, params = {}) {
    const engine = engines[kind];
    if (!engine) { const e = new Error(`unknown kind: ${kind}`); e.status = 400; throw e; }
    const solveId = globalThis.crypto.randomUUID();
    const { source, ...engineParams } = params || {};
    const src = validSource(source);
    onStart(kind, params);
    const job = { kind, params, source: src, sample: null, status: 'running', progress: 0, message: 'starting', result: null, error: null };
    solves.set(solveId, job);
    // Keep memory bounded: a flop solve can use 1.5 to 3 GB. Drop the oldest finished solves,
    // and (before a new postflop solve starts) the oldest finished postflop solves over their own limit.
    const drop = (id, j) => {
      solves.delete(id);
      // Engines that hold resources (e.g. a solver process) free them here.
      if (j.result && typeof j.result.dispose === 'function') { try { j.result.dispose(); } catch (e) { /* ignore */ } }
    };
    for (const [id, j] of solves) {
      if (solves.size <= maxSolves) break;
      if (j.status !== 'running') drop(id, j);
    }
    if (kind.startsWith('postflop')) {
      const done = [...solves].filter(([id, j]) => id !== solveId && j.kind.startsWith('postflop') && j.status !== 'running');
      // The new solve counts too, so keep maxPostflop - 1 old ones.
      for (const [id, j] of done.slice(0, Math.max(0, done.length - (maxPostflop - 1)))) drop(id, j);
    }
    engine.solve(engineParams, (progress, message) => { job.progress = progress; if (message) job.message = message; })
      .then(async (result) => {
        job.result = result;
        if (src) { try { await saveSample(job, rel, log); } catch (e) { job.sample = { error: e.message }; logError('realization sample failed:', e); } }
        job.status = 'done'; job.progress = 1; job.message = 'done';
      })
      .catch((err) => { job.status = 'error'; job.error = String((err && err.stack) || err); logError(err); });
    return solveId;
  }

  // GET /api/solve/:id answer, or null.
  function status(solveId) {
    const job = solves.get(solveId);
    if (!job) return null;
    return { kind: job.kind, params: job.params, status: job.status, progress: job.progress, message: job.message, error: job.error,
      stats: job.result && slimStats(job.result.stats), root: job.result && job.result.root, sample: job.sample };
  }

  // GET /api/solve/:id/node answer: { node } or { error } (both with an HTTP status).
  async function node(solveId, nodeId) {
    const job = solves.get(solveId);
    if (!job || !job.result) return { status: 404, error: 'solve not ready' };
    const n = await job.result.getNode(nodeId || job.result.root); // may be sync or a Promise
    if (!n) return { status: 404, error: 'no such node' };
    return { status: 200, node: n };
  }

  const isBusy = () => [...solves.values()].some((j) => j.status === 'running');
  return { start, status, node, isBusy };
}

module.exports = { createSolves, saveSample, slimStats, validSource };
