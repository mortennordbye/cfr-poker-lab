'use strict';
// Solve threads. Role 'coord': owns the root-street tree, runs DCFR, spawns helpers.
// Role 'helper': owns subtrees below the first chance level (one per split k and dealt card c).
// Each iteration per traverser: (1) coordinator walks the root street forward to get reaches at the split nodes,
// (2) every thread walks its subtrees and returns summed cfvs per split, (3) coordinator walks the root street
// again with those cfvs and updates its regrets. Subtree regrets are updated in step 2.
const { parentPort, workerData, Worker } = require('worker_threads');
const G = require('./game');

function makeOwner(P, Hs, cfg, splits, owned) {
  const ranks = G.makeRankCache(Hs);
  const subs = [];
  let bytes = 0, nodes = 0;
  for (const [k, c] of owned) {
    const ctx = { cfg, nH: [Hs[0].n, Hs[1].n], off: 0, split: false, splits: [], ranks };
    const root = G.build(ctx, G.subState(splits[k], c));
    G.attachRunouts(root, ranks);
    const R = new Float32Array(ctx.off), S = new Float32Array(ctx.off);
    bytes += ctx.off * 8; nodes += ctx.nodes || 0;
    subs.push({ k, c, root, R, S });
  }
  return { subs, walker: new G.Walker(Hs, cfg.pot0), Hs, bytes, nodes };
}

// Walks owned subtrees. inputs[k] = { rp, ro } at split k. Returns acc[k] = sum over owned cards of cfv (no 1/nDeal).
function runJob(owner, msg) {
  const W = owner.walker, Hs = owner.Hs, p = msg.p, o = 1 - p;
  W.mode = msg.mode; W.p = p; W.dPos = msg.dPos; W.dNeg = msg.dNeg; W.dStrat = msg.dStrat;
  const np = Hs[p].n, no = Hs[o].n;
  const rpc = new Float64Array(W.maxH), roc = new Float64Array(W.maxH);
  const acc = [];
  for (const sub of owner.subs) {
    const inp = msg.inputs[sub.k];
    if (!inp) continue;
    roc.set(inp.ro);
    const wo = Hs[o].withCard[sub.c];
    for (let j = 0; j < wo.length; j++) roc[wo[j]] = 0;
    let any = 0;
    for (let h = 0; h < no; h++) any += roc[h];
    if (!acc[sub.k]) acc[sub.k] = new Float64Array(np);
    if (any <= 0) continue;
    rpc.set(inp.rp);
    const wp = Hs[p].withCard[sub.c];
    for (let j = 0; j < wp.length; j++) rpc[wp[j]] = 0;
    W.R = sub.R; W.S = sub.S;
    const v = W.walk(sub.root, 0, rpc, roc);
    const a = acc[sub.k];
    for (let h = 0; h < np; h++) a[h] += v[h];
    for (let j = 0; j < wp.length; j++) a[wp[j]] -= v[wp[j]];
  }
  return acc;
}

function finishOwner(owner) {
  const out = [], transfer = [];
  for (const s of owner.subs) {
    G.normalize(s.root, s.S, owner.Hs);
    out.push({ k: s.k, c: s.c, R: s.R, S: s.S });
    transfer.push(s.R.buffer, s.S.buffer);
  }
  return { out, transfer };
}

// ---------------------------------------------------------------- helper
function helper() {
  const P = workerData.params;
  const { Hs, cfg } = G.setup(P);
  const owner = makeOwner(P, Hs, cfg, workerData.splits, workerData.owned);
  parentPort.postMessage({ type: 'ready', bytes: owner.bytes, nodes: owner.nodes });
  parentPort.on('message', (msg) => {
    try {
      if (msg.type === 'job') parentPort.postMessage({ type: 'result', acc: runJob(owner, msg) });
      else if (msg.type === 'finish') {
        const { out, transfer } = finishOwner(owner);
        parentPort.postMessage({ type: 'buffers', subs: out }, transfer);
        parentPort.close();
      }
    } catch (e) { parentPort.postMessage({ type: 'error', error: String(e.stack || e) }); }
  });
}

// ---------------------------------------------------------------- coordinator
function startHelper(data) {
  const w = new Worker(__filename, { workerData: data });
  const queue = [];
  let failed = null;
  w.on('message', (m) => {
    if (m.type === 'error') { failed = new Error(m.error); }
    const r = queue.shift();
    if (r) { if (m.type === 'error') r.reject(new Error(m.error)); else r.resolve(m); }
  });
  w.on('error', (e) => { failed = e; while (queue.length) queue.shift().reject(e); });
  w.on('exit', (code) => { if (code && !failed) { failed = new Error('helper exit ' + code); while (queue.length) queue.shift().reject(failed); } });
  return {
    w,
    next() { return new Promise((resolve, reject) => { if (failed) reject(failed); else queue.push({ resolve, reject }); }); },
    send(msg, transfer) { w.postMessage(msg, transfer); return this.next(); },
  };
}

async function coord() {
  const P = workerData.params;
  const t0 = Date.now();
  const progress = (fraction, message, extra) => parentPort.postMessage({ type: 'progress', fraction, message, ...extra });
  const { board, Hs, cfg } = G.setup(P);
  const nH = [Hs[0].n, Hs[1].n];
  const ranks = G.makeRankCache(Hs);
  const ctx = { cfg, nH, off: 0, split: board.length < 5, splits: [], ranks };
  progress(0, 'building tree');
  const root = G.build(ctx, G.rootState(board));
  const splits = ctx.splits;

  // Memory estimate: one subtree per split times the number of cards.
  let estBytes = ctx.off * 8, estNodes = ctx.nodes || 0;
  for (const s of splits) {
    const c2 = { cfg, nH, off: 0, split: false, splits: [], ranks: null };
    G.build(c2, G.subState(s, s.cards[0]));
    estBytes += c2.off * 8 * s.cards.length; estNodes += (c2.nodes || 0) * s.cards.length;
  }
  const estMB = estBytes / 1048576;
  if (estMB > P.maxMemoryMB) {
    throw new Error(`tree too large: about ${Math.round(estMB)} MB for ${estNodes} decision nodes (limit ${P.maxMemoryMB} MB). ` +
      'Use fewer bet sizes, a lower raise cap or smaller ranges.');
  }
  G.attachRunouts(root, ranks);
  const R = new Float32Array(ctx.off), S = new Float32Array(ctx.off);

  // Distribute (k, card) subtrees over threads (thread 0 = this coordinator).
  const pairs = [];
  for (const s of splits) for (const c of s.cards) pairs.push([s.k, c]);
  const nT = pairs.length ? Math.max(1, Math.min(P.threads, 4, pairs.length)) : 1;
  const shares = Array.from({ length: nT }, () => []);
  pairs.forEach((x, i) => shares[i % nT].push(x));
  progress(0, `building ${pairs.length} subtrees on ${nT} threads (about ${Math.round(estMB)} MB)`);
  const helpers = [];
  for (let i = 1; i < nT; i++) {
    const h = startHelper({ role: 'helper', params: P, splits, owned: shares[i] });
    helpers.push(h);
  }
  const ready = helpers.map((h) => h.next());
  const own = makeOwner(P, Hs, cfg, splits, shares[0]);
  await Promise.all(ready);
  const W = own.walker;
  const splitOut = splits.map(() => null);
  const wInit = [Hs[0].w, Hs[1].w];

  // Phase 1: reaches at split nodes.
  function collect(node, rp, ro, mode, p, inputs) {
    if (node.kind === 'split') { inputs[node.k] = { rp: Float64Array.from(rp), ro: Float64Array.from(ro) }; return; }
    if (node.kind !== 'act') return;
    const q = node.player, nq = nH[q], nA = node.actions.length;
    const sig = new Float64Array(nA * nq);
    W.R = R; W.S = S;
    W.strategy(node, sig, mode !== 'cfr');
    for (let a = 0; a < nA; a++) {
      if (q === p) {
        const x = new Float64Array(nq);
        for (let h = 0; h < nq; h++) x[h] = rp[h] * sig[a * nq + h];
        collect(node.children[a], x, ro, mode, p, inputs);
      } else {
        const x = new Float64Array(nq);
        let any = 0;
        for (let h = 0; h < nq; h++) { x[h] = ro[h] * sig[a * nq + h]; any += x[h]; }
        if (any > 0) collect(node.children[a], rp, x, mode, p, inputs);
      }
    }
  }

  async function pass(mode, p, t) {
    // Discounted CFR: positive regrets x t^1.5/(t^1.5+1), negative regrets set to 0 (CFR+ style; the paper's
    // beta = 0, i.e. x 0.5, stalled near 0.8% pot on trees with big overbets), strategy sum x ((t-1)/t)^3.
    const ta = Math.pow(t, 1.5);
    const job = { type: 'job', mode, p, dPos: ta / (ta + 1), dNeg: 0, dStrat: Math.pow((t - 1) / t, 3), inputs: null };
    if (splits.length) {
      const inputs = new Array(splits.length).fill(null);
      collect(root, wInit[p], wInit[1 - p], mode, p, inputs);
      job.inputs = inputs;
      const waits = helpers.map((h) => h.send(job));
      const mine = runJob(own, job);
      const all = [mine, ...(await Promise.all(waits)).map((m) => m.acc)];
      for (const s of splits) {
        const o = new Float64Array(nH[p]);
        for (const acc of all) { const a = acc[s.k]; if (a) for (let h = 0; h < o.length; h++) o[h] += a[h]; }
        for (let h = 0; h < o.length; h++) o[h] /= s.nDeal;
        splitOut[s.k] = o;
      }
    }
    W.mode = mode; W.p = p; W.dPos = job.dPos; W.dNeg = job.dNeg; W.dStrat = job.dStrat;
    W.R = R; W.S = S; W.splitOut = splitOut;
    return Float64Array.from(W.walk(root, 0, wInit[p], wInit[1 - p]).subarray(0, nH[p]));
  }

  // Sum of weights of all compatible hand pairs (normalizes values to an expectation).
  let Z = 0;
  {
    const [A, B] = Hs;
    let tot = 0;
    const cc = new Float64Array(52);
    for (let h = 0; h < B.n; h++) { tot += B.w[h]; cc[B.c1[h]] += B.w[h]; cc[B.c2[h]] += B.w[h]; }
    for (let h = 0; h < A.n; h++) Z += A.w[h] * (tot - cc[A.c1[h]] - cc[A.c2[h]] + (A.same[h] >= 0 ? B.w[A.same[h]] : 0));
  }
  const dot = (w, v) => { let s = 0; for (let h = 0; h < v.length; h++) s += w[h] * v[h]; return s; };

  async function exploitability(t) {
    const b0 = dot(wInit[0], await pass('br', 0, t)) / Z, b1 = dot(wInit[1], await pass('br', 1, t)) / Z;
    return { pct: ((b0 + b1 - cfg.pot0) / 2) / cfg.pot0 * 100, br: [b0, b1] };
  }

  const tStart = Date.now();
  let t = 0, expl = null, lastCheck = 0, iterMs = 0;
  const history = [];
  while (t < P.iterations) {
    t++;
    const ti = Date.now();
    await pass('cfr', 0, t);
    await pass('cfr', 1, t);
    iterMs = Date.now() - ti;
    const elapsed = (Date.now() - tStart) / 1000;
    const every = iterMs > 300 ? 5 : 10;
    const last = t === P.iterations || elapsed > P.maxSeconds;
    if (t - lastCheck >= every || last || t === 1) {
      lastCheck = t;
      expl = (await exploitability(t)).pct;
      history.push([t, expl]);
      progress(Math.min(0.97, Math.max(t / P.iterations, Math.min(1, P.targetExploitability / Math.max(expl, 1e-9)))),
        `iteration ${t}/${P.iterations}, exploitability ${expl.toFixed(3)}% pot`, { iteration: t, exploitability: expl });
      if (expl <= P.targetExploitability) break;
    } else if (iterMs > 200) {
      progress(Math.min(0.97, t / P.iterations), `iteration ${t}/${P.iterations}, exploitability ${expl === null ? '?' : expl.toFixed(3)}% pot`,
        { iteration: t, exploitability: expl });
    }
    if (last) break;
  }
  const solveMs = Date.now() - tStart;
  const evVec = [await pass('ev', 0, t), await pass('ev', 1, t)];
  const ev = [dot(wInit[0], evVec[0]) / Z, dot(wInit[1], evVec[1]) / Z];
  // EV per combo at the root for both players (bb won from this point; nobody has bet yet, so it is the
  // combo's share of the pot). evVec[p][h] is summed over compatible opponent combos, so divide by their weight.
  const rootEv = [{}, {}];
  for (let p = 0; p < 2; p++) {
    const A = Hs[p], B = Hs[1 - p], cc = new Float64Array(52);
    let tot = 0;
    for (let h = 0; h < B.n; h++) { tot += B.w[h]; cc[B.c1[h]] += B.w[h]; cc[B.c2[h]] += B.w[h]; }
    for (let h = 0; h < A.n; h++) {
      const ow = tot - cc[A.c1[h]] - cc[A.c2[h]] + (A.same[h] >= 0 ? B.w[A.same[h]] : 0);
      if (A.w[h] > 0 && ow > 1e-12) rootEv[p][A.names[h]] = +(evVec[p][h] / ow).toFixed(4);
    }
  }
  // Each EV pass wrote EVs (bb, relative to folding) into R at the traverser's own nodes.
  G.normalize(root, S, Hs);
  const subs = [], transfer = [R.buffer, S.buffer];
  const mine = finishOwner(own);
  subs.push(...mine.out); transfer.push(...mine.transfer);
  for (const h of helpers) {
    const m = await h.send({ type: 'finish' });
    for (const s of m.subs) { subs.push(s); transfer.push(s.R.buffer, s.S.buffer); }
  }
  const stats = {
    iterations: t, exploitabilityPctPot: expl === null ? null : +expl.toFixed(4), ms: Date.now() - t0, solveMs,
    threads: nT, decisionNodes: estNodes, memoryMB: Math.round(estMB), combos: nH.slice(),
    evOop: +ev[0].toFixed(3), evIp: +ev[1].toFixed(3), history,
    rootEv: { oop: rootEv[0], ip: rootEv[1] },
  };
  parentPort.postMessage({ type: 'done', stats, R, S, subs }, transfer);
}

if (workerData && workerData.role === 'helper') helper();
else if (workerData && workerData.role === 'coord') {
  coord().catch((e) => parentPort.postMessage({ type: 'error', error: String((e && e.stack) || e) }));
}
