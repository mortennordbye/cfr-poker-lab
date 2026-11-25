'use strict';
// Idle filler (server module, off by default): when the UI has been quiet for IDLE_MS (default 5 min) and no
// solve runs, solve one more flop for the realization calibration of the last used hu-preflop spot.
// Pick: terminal with the best score mass / (samples + 1) among terminals with mass >= 0.5% of deals,
// first flop of lib/flops.js flopSubset(20) not sampled there yet. The postflop solve runs in a child process
// (tools/sample-solve.js) so a new API request can stop it at once.
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { flopSubset } = require('./lib/flops');
const RZ = require('./lib/realization');

const MIN_MASS = 0.005;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[idle]', ...a);

function createIdleFiller({ engines, isBusy, idleMs = 5 * 60e3, solveParams = {}, kind: forceKind = null, settingsFile }) {
  const S = { enabled: false, lastSpot: null, lastActivity: Date.now(), running: null, starting: false, last: null, backoffUntil: 0 };
  try { Object.assign(S, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch (e) { /* defaults */ }
  S.enabled = !!S.enabled;
  const save = () => { try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify({ enabled: S.enabled, lastSpot: S.lastSpot })); } catch (e) { /* optional */ } };

  function postKind() { return forceKind && engines[forceKind] ? forceKind : engines.postflop ? 'postflop' : engines['postflop-js'] ? 'postflop-js' : null; }
  function enginePath(kind) { return path.join(__dirname, 'engines', kind, 'index.js'); }

  function cancel(why) {
    const r = S.running;
    if (!r) return;
    S.running = null;
    try { r.child.kill('SIGKILL'); } catch (e) { /* gone */ }
    log(`cancelled ${r.name} ${r.board} (${why}) after ${((Date.now() - r.startedAt) / 1000).toFixed(1)} s`);
    S.last = { ...info(r), result: 'cancelled', at: new Date().toISOString() };
  }

  // Every API request from the UI (except /api/idle) counts as activity and stops a running idle solve.
  function touch() { S.lastActivity = Date.now(); S.backoffUntil = 0; if (S.running) cancel('new request'); }
  function noteHuSpot(params) { S.lastSpot = params; save(); }
  function setEnabled(v) {
    S.enabled = !!v; save();
    log(S.enabled ? `enabled (after ${Math.round(idleMs / 1000)} s without requests)` : 'disabled');
    if (!S.enabled) cancel('disabled');
  }
  const info = (r) => r && { kind: r.kind, spotKey: r.spotKey, terminalKey: r.terminalKey, name: r.name, board: r.board, startedAt: new Date(r.startedAt).toISOString() };
  function status() {
    return { enabled: S.enabled, idleMs, idleForMs: Date.now() - S.lastActivity, running: info(S.running), last: S.last, hasSpot: !!S.lastSpot };
  }

  async function pickJob() {
    const hu = engines['hu-preflop'];
    if (!S.lastSpot || !hu) return { skip: 'no hu-preflop spot used yet' };
    const kind = postKind();
    if (!kind) return { skip: 'no postflop engine loaded' };
    const res = await hu.solve(S.lastSpot, () => {});
    const terms = [], seen = new Set();
    const walk = async (id) => {
      if (seen.has(id)) return; seen.add(id);
      const n = await res.getNode(id);
      if (!n) return;
      if (n.terminal && n.terminal.type === 'flop' && n.terminal.flop) terms.push(n.terminal);
      for (const a of n.actions || []) await walk(a.child);
    };
    await walk(res.root);
    const boards = flopSubset(RZ.FULL);
    let best = null;
    for (const t of terms) {
      if (!((t.mass || 0) >= MIN_MASS)) continue;
      const done = new Set(RZ.sampledBoards(t.spotKey, t.key));
      const board = boards.find((b) => !done.has(b));
      if (!board) continue;
      const score = t.mass / (done.size + 1);
      if (!best || score > best.score) best = { score, t, board, n: done.size };
    }
    if (!best) return { skip: `all ${terms.length} flop terminals have ${RZ.FULL} flops` };
    return { kind, ...best };
  }

  async function start() {
    S.starting = true;
    const t0 = S.lastActivity;
    try {
      const job = await pickJob();
      if (S.lastActivity !== t0 || !S.enabled) return; // the user came back while we picked
      if (job.skip) { log(`nothing to do: ${job.skip}`); S.backoffUntil = Date.now() + idleMs; return; }
      const { t, board, kind } = job;
      const f = t.flop;
      const params = { board, pot: f.pot, stack: f.stack, oop: f.oop, ip: f.ip, ranges: f.ranges, targetExploitability: 1, maxSeconds: 300, threads: 4, ...solveParams };
      const child = fork(path.join(__dirname, 'tools', 'sample-solve.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      const r = { child, kind, spotKey: t.spotKey, terminalKey: t.key, name: t.name || t.key, board, startedAt: Date.now() };
      S.running = r;
      log(`solving ${r.name} on ${board} with ${kind} (${job.n} flops so far, reach ${(100 * t.mass).toFixed(1)}% of deals)`);
      child.on('message', (m) => {
        if (S.running !== r) return;
        if (m.ok) {
          log(`sample saved: ${r.name} ${board}, ${m.iterations} iterations, exploitability ${m.exploitabilityPctPot}% pot, ${(m.ms / 1000).toFixed(1)} s`);
          S.last = { ...info(r), result: 'saved', file: m.file, ms: m.ms, at: new Date().toISOString() };
        } else {
          log(`solve failed: ${m.error}`);
          S.last = { ...info(r), result: 'error', error: m.error, at: new Date().toISOString() };
          S.backoffUntil = Date.now() + idleMs;
        }
      });
      child.on('exit', (code) => {
        if (S.running !== r) return; // cancelled: already logged
        S.running = null;
        if (code && !(S.last && S.last.board === board)) { log(`solve process stopped, code ${code}`); S.backoffUntil = Date.now() + idleMs; }
      });
      child.send({ enginePath: enginePath(kind), spotKey: t.spotKey, terminalKey: t.key, params });
    } catch (e) {
      log(`error: ${e.message}`);
      S.backoffUntil = Date.now() + idleMs;
    } finally { S.starting = false; }
  }

  function tick() {
    if (!S.enabled || S.running || S.starting) return;
    const now = Date.now();
    if (now - S.lastActivity < idleMs || now < S.backoffUntil || isBusy()) return;
    start();
  }
  const timer = setInterval(tick, Math.max(250, Math.min(10e3, idleMs / 5)));
  timer.unref();

  return { touch, noteHuSpot, setEnabled, status, cancel, stop() { clearInterval(timer); cancel('server stop'); } };
}

module.exports = { createIdleFiller };
