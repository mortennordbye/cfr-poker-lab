'use strict';
// Worker threads for the 6-max preflop solve.
// role 'master': owns the spine (top of the tree) and some subtrees, runs the iteration loop,
//                starts the helpers and packs the result.
// role 'helper': owns some subtrees; runs one walk per command from the master.
// Sync: SharedArrayBuffer + Atomics (one barrier per phase), results via MessageChannel.
const { Worker, parentPort, workerData, MessageChannel } = require('worker_threads');
const { loadEquity } = require('../../lib/equity');
const { buildTree } = require('./tree');
const { Core, Ref, buildMatrices, PRIOR, H } = require('./core');

const SLOT = 19 * H; // reach 6*H, F H, V 6*H, M 6*H
const C_GEN = 0, C_DONE = 1, C_CMD = 2, C_ARG = 3;
const CMD_CFR = 1, CMD_EVAL = 2, CMD_BR = 3, CMD_DUMP = 4, CMD_EXIT = 9;

function slotViews(f64, k) {
  const base = k * SLOT;
  const view = (o, n) => f64.subarray(base + o, base + o + n);
  const reach = [], V = [], M = [];
  for (let q = 0; q < 6; q++) reach.push(view(q * H, H));
  const F = view(6 * H, H);
  for (let q = 0; q < 6; q++) V.push(view(7 * H + q * H, H));
  for (let q = 0; q < 6; q++) M.push(view(13 * H + q * H, H));
  return { reach, F, V, M, refs: reach.map((v) => new Ref(v)) };
}

// Run the walks for this thread's own cuts.
function runCuts(core, nodes, myCuts, slots) {
  core.spine = false;
  for (const k of myCuts) {
    const n = nodes[cutRoot[k]];
    const s = slots[k];
    for (const r of s.refs) r.inv();
    const out = core.walk(n, s.refs, s.F, 1);
    for (const q of n.active) { s.V[q].set(out.V[q]); s.M[q].set(out.M[q]); }
  }
}

let cutRoot = [];

// calib: [{ group, ip: [169 R], oop: [169 R] }] for the groups with a calibrated table (index.js), or [].
// Heads-up flop terminals of those groups use the group's share matrices (n.kIp, n.kOop); the others flat R.
function setup(P, E, W, nThreads, calib = []) {
  const tree = buildTree(P);
  const nodes = tree.nodes;
  const kind = new Map(calib.map((g, k) => [g.group, 3 + 2 * k]));
  for (const n of nodes) if (n.group && kind.has(n.group)) { n.kIp = kind.get(n.group); n.kOop = n.kIp + 1; }
  // Work estimate per subtree, used to pick cut points and balance threads.
  const work = new Float64Array(nodes.length);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    let w = n.terminal ? (n.terminal.type === 'fold' ? 0.3 : 2 + n.active.length) : 1;
    for (const c of n.children) w += work[c];
    work[i] = w;
  }
  const total = work[tree.root];
  let cuts = [tree.root];
  for (;;) {
    let bi = -1, bw = -1;
    cuts.forEach((c, i) => { if (!nodes[c].terminal && work[c] > bw) { bw = work[c]; bi = i; } });
    if (bi < 0 || bw < total / (nThreads * 10)) break;
    const c = cuts[bi];
    nodes[c].spine = true;
    cuts.splice(bi, 1, ...nodes[c].children);
  }
  for (const n of nodes) n.cut = -1;
  cuts.forEach((c, k) => { nodes[c].cut = k; });
  // Greedy (largest first) assignment of cuts to threads.
  const load = new Float64Array(nThreads), owner = new Int32Array(cuts.length);
  cuts.map((c, k) => k).sort((a, b) => work[cuts[b]] - work[cuts[a]]).forEach((k) => {
    let t = 0; for (let i = 1; i < nThreads; i++) if (load[i] < load[t]) t = i;
    owner[k] = t; load[t] += work[cuts[k]];
  });
  return { tree, nodes, cuts, owner, load, total, mats: buildMatrices(E, W, P.rIp, P.rOop, calib) };
}

async function helperMain() {
  const { P, sab, ctrlSab, index, nThreads, port, calib } = workerData;
  const { E, W } = await loadEquity();
  const S = setup(P, E, W, nThreads, calib);
  cutRoot = S.cuts;
  const core = new Core(S.tree, P, S.mats);
  const f64 = new Float64Array(sab), ctrl = new Int32Array(ctrlSab);
  const slots = S.cuts.map((c, k) => slotViews(f64, k));
  const mine = S.cuts.map((c, k) => k).filter((k) => S.owner[k] === index);
  let gen = 0;
  Atomics.add(ctrl, C_DONE, 1); Atomics.notify(ctrl, C_DONE); // ready
  for (;;) {
    Atomics.wait(ctrl, C_GEN, gen);
    gen = Atomics.load(ctrl, C_GEN);
    const cmd = Atomics.load(ctrl, C_CMD), arg = Atomics.load(ctrl, C_ARG);
    if (cmd === CMD_EXIT) break;
    if (cmd === CMD_DUMP) {
      const out = [];
      for (const [idx, d] of core.evalOut) out.push([idx, d]);
      port.postMessage(out);
    } else {
      core.stamp++;
      core.mode = cmd === CMD_CFR ? 'cfr' : cmd === CMD_EVAL ? 'eval' : 'br';
      if (cmd === CMD_CFR) core.t = arg; else if (cmd === CMD_BR) core.br = arg;
      runCuts(core, S.nodes, mine, slots);
    }
    Atomics.add(ctrl, C_DONE, 1); Atomics.notify(ctrl, C_DONE);
  }
  process.exit(0);
}

async function masterMain() {
  const { P, threads, calib } = workerData;
  const t0 = Date.now();
  const nThreads = Math.max(1, Math.min(4, threads || 4));
  const { E, W } = await loadEquity();
  const S = setup(P, E, W, nThreads, calib);
  cutRoot = S.cuts;
  const nodes = S.nodes;
  const sab = new SharedArrayBuffer(S.cuts.length * SLOT * 8);
  const ctrlSab = new SharedArrayBuffer(64);
  const f64 = new Float64Array(sab), ctrl = new Int32Array(ctrlSab);
  const slots = S.cuts.map((c, k) => slotViews(f64, k));
  const core = new Core(S.tree, P, S.mats);
  core.slotIO = (k) => slots[k];
  const mine = S.cuts.map((c, k) => k).filter((k) => S.owner[k] === 0);
  const helpers = [], ports = [];
  for (let i = 1; i < nThreads; i++) {
    const ch = new MessageChannel();
    helpers.push(new Worker(__filename, { workerData: { role: 'helper', P, sab, ctrlSab, index: i, nThreads, port: ch.port2, calib }, transferList: [ch.port2] }));
    ports.push(ch.port1);
  }
  // Wait until helpers are ready.
  const waitDone = (n) => { for (;;) { const d = Atomics.load(ctrl, C_DONE); if (d >= n) return; Atomics.wait(ctrl, C_DONE, d, 1000); } };
  waitDone(nThreads - 1);
  let gen = 0;
  const command = (cmd, arg) => {
    core.stamp++;
    core.mode = cmd === CMD_CFR ? 'cfr' : cmd === CMD_EVAL ? 'eval' : 'br';
    if (cmd === CMD_CFR) core.t = arg; else if (cmd === CMD_BR) core.br = arg;
    const F1 = new Float64Array(H).fill(1);
    const rootReach = new Array(6).fill(core.ones);
    core.ones.inv();
    core.spine = true; core.phase = 'collect';
    core.walk(nodes[S.tree.root], rootReach, F1, 0);
    Atomics.store(ctrl, C_DONE, 0);
    Atomics.store(ctrl, C_CMD, cmd); Atomics.store(ctrl, C_ARG, arg | 0);
    Atomics.store(ctrl, C_GEN, ++gen); Atomics.notify(ctrl, C_GEN);
    runCuts(core, nodes, mine, slots);
    waitDone(nThreads - 1);
    core.stamp++;
    core.spine = true; core.phase = 'run';
    const out = core.walk(nodes[S.tree.root], rootReach, F1, 0);
    core.spine = false;
    // Root value per player in bb (average over the deal).
    const vals = [];
    for (let q = 0; q < 6; q++) { let s = 0; for (let h = 0; h < H; h++) s += PRIOR[h] * out.V[q][h]; vals.push(s); }
    return vals;
  };

  const iters = P.iterations, maxMs = P.maxSeconds * 1000;
  let t = 0, lastReport = 0;
  parentPort.postMessage({ progress: 0, message: `solving: ${nodes.length} nodes, ${S.cuts.length} subtrees on ${nThreads} threads` });
  while (t < iters) {
    t++;
    command(CMD_CFR, t);
    const el = Date.now() - t0;
    if (el - lastReport > 500 || t === iters) {
      lastReport = el;
      parentPort.postMessage({ progress: Math.min(0.97, Math.max(t / iters, el / maxMs) * 0.97), message: `iteration ${t}/${iters}` });
    }
    if (el > maxMs) break;
  }
  const solveMs = Date.now() - t0;
  parentPort.postMessage({ progress: 0.97, message: 'computing EVs and exploitability' });
  const ev = command(CMD_EVAL, 0);
  // Collect eval data from all threads.
  const evalData = new Map(core.evalOut);
  // Each helper posts its eval data once. Received with an await (not receiveMessageOnPort), so this also runs
  // in a browser Web Worker (tools/build-web.js).
  const dumps = ports.map((port) => new Promise((resolve) => port.once('message', resolve)));
  Atomics.store(ctrl, C_DONE, 0); Atomics.store(ctrl, C_CMD, CMD_DUMP);
  Atomics.store(ctrl, C_GEN, ++gen); Atomics.notify(ctrl, C_GEN);
  waitDone(nThreads - 1);
  for (const out of await Promise.all(dumps)) for (const [idx, d] of out) evalData.set(idx, d);
  let expl = 0;
  const gains = [];
  for (let b = 0; b < 6; b++) {
    const br = command(CMD_BR, b);
    gains.push(br[b] - ev[b]);
    expl += br[b] - ev[b];
  }
  Atomics.store(ctrl, C_CMD, CMD_EXIT); Atomics.store(ctrl, C_GEN, ++gen); Atomics.notify(ctrl, C_GEN);

  // Pack: per decision node the hands with weight >= THR: [hand, w, st x A, ev x A].
  const THR = 5e-4;
  const offs = new Int32Array(nodes.length + 1);
  const mass = new Float32Array(nodes.length); // terminals: share of all deals that reach them
  const chunks = [];
  let len = 0;
  for (const n of nodes) {
    offs[n.idx] = len;
    const d = evalData.get(n.idx);
    if (!d) continue;
    let arr;
    if (d.ranges) {
      mass[n.idx] = d.mass;
      // terminal: dense ranges of the active players, in n.active order
      arr = new Float32Array(n.active.length * H);
      n.active.forEach((q, k) => arr.set(d.ranges[q], k * H));
    } else {
      const A = n.children.length, rec = 2 + 2 * A, tmp = [];
      for (let h = 0; h < H; h++) {
        if (!(d.w[h] >= THR)) continue;
        tmp.push(h, d.w[h]);
        for (let a = 0; a < A; a++) tmp.push(d.st[a * H + h]);
        for (let a = 0; a < A; a++) tmp.push(d.ev[a * H + h]);
      }
      arr = Float32Array.from(tmp);
      void rec;
    }
    chunks.push(arr); len += arr.length;
  }
  offs[nodes.length] = len;
  const data = new Float32Array(len);
  let o = 0; for (const c of chunks) { data.set(c, o); o += c.length; }
  const rootPot = 1.5 + P.ante;
  const stats = {
    iterations: t,
    exploitabilityPctPot: (100 * (expl / 6)) / rootPot,
    exploitabilityBb: expl / 6,
    brGainBb: Object.fromEntries(['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map((p, i) => [p, +gains[i].toFixed(4)])),
    evBb: Object.fromEntries(['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map((p, i) => [p, +ev[i].toFixed(4)])),
    ms: Date.now() - t0,
    solveMs,
    nodes: nodes.length,
    threads: nThreads,
    calibratedGroups: calib.length,
    matrixMB: +((S.mats.WS.length + 1) * H * H * 8 / 1e6).toFixed(2), // per thread
  };
  parentPort.postMessage({ result: { offs, data, mass, stats } }, [offs.buffer, data.buffer, mass.buffer]);
}

if (workerData && workerData.role === 'helper') helperMain().catch((e) => { console.error(e); process.exit(1); });
else if (workerData && workerData.role === 'master') masterMain().catch((e) => { parentPort.postMessage({ error: String(e.stack || e) }); });
