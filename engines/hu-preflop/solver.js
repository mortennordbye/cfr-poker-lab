'use strict';
// Heads-up preflop solver (SB vs BB), ChipEV, CFR+ with alternating updates and linear averaging.
// Pure functions: used by worker.js (in a worker thread) and by test.js.
// Money: "bets" are street bets without antes. Utilities are SB's change in chips from the start of the hand.
const { N, COMBOS, className } = require('../../lib/equity');

const VERSION = 5; // 5: flop terminals carry name, spotKey and mass

function parseSizes(v, def) {
  if (Array.isArray(v)) return v.map(Number).filter((x) => Number.isFinite(x) && x > 0);
  if (v === undefined || v === null) return def;
  return String(v).split(/[\s,;]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);
}
function bool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'string') return !/^(false|0|no|off)$/i.test(v);
  return !!v;
}
function clampNum(v, lo, hi, def) {
  const n = v === null || v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

function normalizeParams(p = {}) {
  return {
    stack: clampNum(p.stack, 2, 300, 100),
    ante: clampNum(p.ante, 0, 2, 0),
    sbOpen: parseSizes(p.sbOpen, [2.5]).map((x) => Math.round(x * 100) / 100).sort((a, b) => a - b),
    limp: bool(p.limp, true),
    isoSize: clampNum(p.isoSize, 0, 50, 4),
    threeBetX: clampNum(p.threeBetX, 0, 10, 4),
    fourBetX: clampNum(p.fourBetX, 0, 10, 2.2),
    rIp: clampNum(p.rIp, 0.5, 1.5, 1.0),
    rOop: clampNum(p.rOop, 0.5, 1.5, 0.88),
    realization: p.realization === 'flat' ? 'flat' : 'calibrated',
    iterations: Math.round(clampNum(p.iterations, 10, 20000, 1500)),
  };
}

const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => String(r2(x));

// ---- Tree ----
function buildTree(P) {
  const S = P.stack, A = P.ante, M = S - A; // M = max street bet (all-in)
  const POS = ['SB', 'BB'];
  const nodes = [];
  function add(n) { n.idx = nodes.length; nodes.push(n); return n; }

  function terminal(parent, bets, type, history) {
    const inv = [A + bets[0], A + bets[1]];
    const pot = inv[0] + inv[1];
    const n = { player: -1, bets, history, pot, inv, type, key: history.map((h) => h.pos + ':' + h.label).join('/') };
    if (type === 'foldSB') { n.mat = 0; n.P = 0; n.beta = -inv[0]; }
    else if (type === 'foldBB') { n.mat = 0; n.P = 0; n.beta = inv[1]; }
    else if (type === 'showdown') { n.mat = 1; n.P = pot; n.beta = -inv[0]; }
    else { n.mat = 2; n.P = pot; n.beta = -inv[0]; } // flop
    return add(n);
  }

  // rc = number of raises so far. limped = SB limped.
  function decision(bets, p, rc, history, first) {
    const o = 1 - p;
    const n = add({ player: p, bets, history, inv: [A + bets[0], A + bets[1]], pot: 2 * A + bets[0] + bets[1], actions: [] });
    const toCall = bets[o] - bets[p];
    n.toCall = toCall;
    const label = (s) => s;
    const hist = (lab) => history.concat([{ pos: POS[p], street: 'preflop', label: lab, nodeIdx: n.idx }]);
    const acts = [];
    if (toCall > 0) acts.push({ label: 'Fold', type: 'fold', amount: 0, make: (h) => terminal(n, bets, p === 0 ? 'foldSB' : 'foldBB', h) });
    if (toCall === 0) {
      acts.push({ label: 'Check', type: 'check', amount: 0, make: (h) => terminal(n, bets, 'flop', h) });
    } else if (first) {
      if (P.limp) acts.push({ label: 'Limp', type: 'call', amount: toCall, make: (h) => decision([bets[o], bets[o]], o, 0, h, false) });
    } else {
      const nb = [bets[o], bets[o]];
      acts.push({ label: 'Call', type: 'call', amount: r2(toCall), make: (h) => terminal(n, nb, bets[o] >= M - 1e-9 ? 'showdown' : 'flop', h) });
    }
    if (bets[o] < M - 1e-9) {
      let sizes;
      if (first) sizes = P.sbOpen;
      else if (rc === 0) sizes = P.isoSize > 0 ? [P.isoSize] : [];
      else if (rc === 1) sizes = P.threeBetX > 0 ? [bets[o] * P.threeBetX] : [];
      else if (rc === 2) sizes = P.fourBetX > 0 ? [bets[o] * P.fourBetX] : [];
      else sizes = [];
      const minRaise = Math.max(bets[o] + Math.max(bets[o] - bets[p], 1), 2);
      const seen = new Set();
      for (let s of sizes) {
        s = r2(s);
        if (s < minRaise - 1e-9 || s > 0.8 * M || seen.has(s)) continue; // too big -> the all-in covers it
        seen.add(s);
        acts.push({ label: `Raise ${fmt(s)}`, type: 'raise', amount: s, make: (h) => decision(p === 0 ? [s, bets[1]] : [bets[0], s], o, rc + 1, h, false) });
      }
      acts.push({ label: `Allin ${fmt(M)}`, type: 'allin', amount: r2(M), make: (h) => decision(p === 0 ? [M, bets[1]] : [bets[0], M], o, rc + 1, h, false) });
    }
    for (const a of acts) {
      const child = a.make(hist(a.label));
      n.actions.push({ label: a.label, type: a.type, amount: a.amount, child: child.idx });
    }
    return n;
  }

  decision([0.5, 1], 0, 0, [], true);
  return nodes;
}

// ---- Matrices ----
function buildMatrices(E, W, P) {
  const NN = N * N;
  const WE = new Float64Array(NN), WF = new Float64Array(NN);
  const WT = new Float64Array(NN), WET = new Float64Array(NN), WFT = new Float64Array(NN);
  // Flop share for SB (IP): pot * equity * R for each side, normalized so the game stays zero-sum.
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const k = i * N + j, e = E[k];
    const a = e * P.rIp, b = (1 - e) * P.rOop;
    const f = a + b > 0 ? a / (a + b) : 0.5;
    WE[k] = W[k] * e; WF[k] = W[k] * f;
    const kt = j * N + i;
    WT[kt] = W[k]; WET[kt] = WE[k]; WFT[kt] = WF[k];
  }
  return { SB: [W, WE, WF], BB: [WT, WET, WFT] };
}

// Calibrated realization: each flop terminal with an entry in rTable.terminals gets its own share matrix,
// share_SB(i, j) = E*Rsb[i] / (E*Rsb[i] + (1-E)*Rbb[j]) (zero-sum). Terminals without an entry keep flat R (mat 2).
function addTerminalMatrices(nodes, mats, E, W, rTable) {
  const used = [];
  if (!rTable || !rTable.terminals) return used;
  for (const n of nodes) {
    if (n.player >= 0 || n.type !== 'flop') continue;
    const t = rTable.terminals[n.key];
    if (!t) continue;
    const WF = new Float64Array(N * N), WFT = new Float64Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const k = i * N + j, e = E[k];
      const a = e * t.SB[i], b = (1 - e) * t.BB[j];
      const f = a + b > 0 ? a / (a + b) : 0.5;
      WF[k] = W[k] * f; WFT[j * N + i] = WF[k];
    }
    n.mat = mats.SB.length;
    mats.SB.push(WF); mats.BB.push(WFT);
    used.push(n.key);
  }
  return used;
}

function matvec(Mx, v, out) {
  for (let i = 0; i < N; i++) {
    let s = 0; const o = i * N;
    for (let j = 0; j < N; j++) s += Mx[o + j] * v[j];
    out[i] = s;
  }
  return out;
}

// cfv of player p at a terminal, given the opponent's reach.
function terminalValue(n, p, opp, mats) {
  const m = p === 0 ? mats.SB : mats.BB;
  const base = matvec(m[0], opp, new Float64Array(N));
  const sign = p === 0 ? 1 : -1;
  if (n.mat === 0) { for (let i = 0; i < N; i++) base[i] *= sign * n.beta; return base; }
  const x = matvec(m[n.mat], opp, new Float64Array(N));
  for (let i = 0; i < N; i++) base[i] = sign * (n.P * x[i] + n.beta * base[i]);
  return base;
}

function regretStrategy(reg, nA, out) {
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let a = 0; a < nA; a++) s += reg[i * nA + a];
    for (let a = 0; a < nA; a++) out[i * nA + a] = s > 0 ? reg[i * nA + a] / s : 1 / nA;
  }
  return out;
}

function solve(E, W, rawParams, onProgress, rTable) {
  const P = normalizeParams(rawParams);
  const t0 = Date.now();
  const nodes = buildTree(P);
  const mats = buildMatrices(E, W, P);
  const calibrated = P.realization === 'calibrated' ? addTerminalMatrices(nodes, mats, E, W, rTable) : [];
  for (const n of nodes) if (n.player >= 0) {
    const nA = n.actions.length;
    n.reg = new Float64Array(N * nA); n.sum = new Float64Array(N * nA); n.cur = new Float64Array(N * nA);
  }

  function cfr(n, p, own, opp, t) {
    if (n.player < 0) return terminalValue(n, p, opp, mats);
    const nA = n.actions.length;
    const s = regretStrategy(n.reg, nA, n.cur);
    if (n.player === p) {
      const vals = [], v = new Float64Array(N);
      for (let a = 0; a < nA; a++) {
        const own2 = new Float64Array(N);
        for (let i = 0; i < N; i++) own2[i] = own[i] * s[i * nA + a];
        const va = cfr(nodes[n.actions[a].child], p, own2, opp, t);
        vals.push(va);
        for (let i = 0; i < N; i++) v[i] += s[i * nA + a] * va[i];
      }
      for (let a = 0; a < nA; a++) {
        const va = vals[a];
        for (let i = 0; i < N; i++) {
          const k = i * nA + a;
          const r = n.reg[k] + va[i] - v[i];
          n.reg[k] = r > 0 ? r : 0;
          n.sum[k] += t * own[i] * s[k];
        }
      }
      return v;
    }
    const v = new Float64Array(N);
    const sc = Float64Array.from(s);
    for (let a = 0; a < nA; a++) {
      const opp2 = new Float64Array(N);
      for (let i = 0; i < N; i++) opp2[i] = opp[i] * sc[i * nA + a];
      const va = cfr(nodes[n.actions[a].child], p, own, opp2, t);
      for (let i = 0; i < N; i++) v[i] += va[i];
    }
    return v;
  }

  const ones = new Float64Array(N).fill(1);
  const iters = P.iterations;
  let lastReport = 0;
  for (let t = 1; t <= iters; t++) {
    cfr(nodes[0], 0, ones, ones, t);
    cfr(nodes[0], 1, ones, ones, t);
    if (onProgress && (Date.now() - lastReport > 250 || t === iters)) {
      lastReport = Date.now();
      onProgress((0.95 * t) / iters, `iteration ${t} / ${iters}`);
    }
  }

  // Average strategy
  for (const n of nodes) if (n.player >= 0) {
    const nA = n.actions.length;
    n.avg = new Float64Array(N * nA);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let a = 0; a < nA; a++) s += n.sum[i * nA + a];
      for (let a = 0; a < nA; a++) n.avg[i * nA + a] = s > 0 ? n.sum[i * nA + a] / s : 1 / nA;
    }
  }

  // Evaluate the average strategy: reach of both players, per-action cfv for the actor.
  function evalNode(n, reach) {
    n.reach = [Float64Array.from(reach[0]), Float64Array.from(reach[1])];
    if (n.player < 0) return [terminalValue(n, 0, reach[1], mats), terminalValue(n, 1, reach[0], mats)];
    const p = n.player, o = 1 - p, nA = n.actions.length;
    const vp = new Float64Array(N), vo = new Float64Array(N);
    n.actVals = [];
    for (let a = 0; a < nA; a++) {
      const r2_ = [reach[0], reach[1]];
      const own2 = new Float64Array(N);
      for (let i = 0; i < N; i++) own2[i] = reach[p][i] * n.avg[i * nA + a];
      r2_[p] = own2;
      const v = evalNode(nodes[n.actions[a].child], r2_);
      n.actVals.push(v[p]);
      for (let i = 0; i < N; i++) { vp[i] += n.avg[i * nA + a] * v[p][i]; vo[i] += v[o][i]; }
    }
    n.oppMass = matvec(p === 0 ? mats.SB[0] : mats.BB[0], reach[o], new Float64Array(N));
    return p === 0 ? [vp, vo] : [vo, vp];
  }
  const rootVals = evalNode(nodes[0], [ones, ones]);

  // Best response value for player p against the average strategy of the other.
  function br(n, p, opp) {
    if (n.player < 0) return terminalValue(n, p, opp, mats);
    const nA = n.actions.length;
    if (n.player === p) {
      const v = new Float64Array(N).fill(-Infinity);
      for (let a = 0; a < nA; a++) {
        const va = br(nodes[n.actions[a].child], p, opp);
        for (let i = 0; i < N; i++) if (va[i] > v[i]) v[i] = va[i];
      }
      return v;
    }
    const v = new Float64Array(N);
    for (let a = 0; a < nA; a++) {
      const opp2 = new Float64Array(N);
      for (let i = 0; i < N; i++) opp2[i] = opp[i] * n.avg[i * nA + a];
      const va = br(nodes[n.actions[a].child], p, opp2);
      for (let i = 0; i < N; i++) v[i] += va[i];
    }
    return v;
  }
  let totalW = 0;
  for (let k = 0; k < N * N; k++) totalW += W[k];
  const sum = (v) => v.reduce((a, b) => a + b, 0);
  const brSB = sum(br(nodes[0], 0, ones)), brBB = sum(br(nodes[0], 1, ones));
  const gap = (brSB + brBB) / totalW; // bb per hand (sum of both players' gains)
  const startPot = 1.5 + 2 * P.ante;
  const stats = {
    iterations: iters,
    exploitabilityPctPot: (100 * gap) / 2 / startPot,
    exploitabilityBb: gap / 2,
    sbValueBb: sum(rootVals[0]) / totalW,
    nodes: nodes.length,
    ms: Date.now() - t0,
    realization: calibrated.length ? `calibrated (${calibrated.length} flop spots${rTable.info ? ', ' + rTable.info : ''})` : (P.realization === 'calibrated' ? 'flat (no calibration table for this spot)' : 'flat'),
  };
  stats.spotKey = spotKey(P);
  return { params: P, stats, nodes: exportNodes(nodes, P, new Set(calibrated), W, totalW) };
}

// ---- Export to the CONTRACT node format ----
const rnd = (x, d) => { const f = 10 ** d; return Math.round(x * f) / f; };

function exportNodes(nodes, P, calibrated = new Set(), W = null, totalW = 0) {
  const S = P.stack, A = P.ante, POS = ['SB', 'BB'];
  const sk = spotKey(P);
  const id = (idx) => 'n' + idx;
  const out = {};
  for (const n of nodes) {
    const players = [0, 1].map((s) => ({
      pos: POS[s], stack: r2(S - A - n.bets[s]), invested: r2(A + n.bets[s]),
      folded: (n.type === 'foldSB' && s === 0) || (n.type === 'foldBB' && s === 1),
    }));
    const node = {
      id: id(n.idx), street: 'preflop', board: [], pot: r2(n.pot), players,
      history: n.history.map((h) => ({ pos: h.pos, street: h.street, label: h.label, nodeId: id(h.nodeIdx) })),
      toAct: n.player >= 0 ? POS[n.player] : null,
      toCall: n.player >= 0 ? r2(n.toCall) : 0,
      actions: n.player >= 0 ? n.actions.map((a) => ({ label: a.label, type: a.type, amount: a.amount, child: id(a.child) })) : [],
      handKind: 'class',
      hands: {},
      terminal: null,
    };
    if (n.player >= 0) {
      const p = n.player, nA = n.actions.length, inv = n.inv[p];
      for (let i = 0; i < N; i++) {
        const w = n.reach[p][i];
        if (w <= 1e-6) continue;
        const mass = n.oppMass[i];
        node.hands[className(i)] = {
          weight: rnd(w, 4),
          strategy: Array.from({ length: nA }, (_, a) => rnd(n.avg[i * nA + a], 4)),
          ev: Array.from({ length: nA }, (_, a) => (mass > 1e-9 ? rnd(n.actVals[a][i] / mass + inv, 3) : null)),
        };
      }
      node.note = 'EV in bb relative to folding now (= change of the stack behind). Flop terminals: pot x equity x R, normalized to stay zero-sum.';
    } else {
      const t = n.type === 'foldSB' || n.type === 'foldBB' ? 'fold' : n.type;
      node.terminal = { type: t };
      if (t === 'flop') {
        const rg = (r) => { const o = {}; for (let i = 0; i < N; i++) if (r[i] > 1e-4) o[className(i)] = rnd(r[i], 4); return o; };
        node.terminal.flop = { oop: 'BB', ip: 'SB', pot: r2(n.pot), stack: r2(S - A - n.bets[0]), ranges: { BB: rg(n.reach[1]), SB: rg(n.reach[0]) } };
        node.terminal.key = n.key;
        node.terminal.spotKey = sk;
        node.terminal.name = terminalName(n.key);
        // Share of all deals that reach this terminal: sum_ij W_ij reachSB_i reachBB_j / sum W.
        if (W && totalW > 0) {
          let m = 0;
          for (let i = 0; i < N; i++) { const a = n.reach[0][i]; if (a <= 0) continue; for (let j = 0; j < N; j++) m += W[i * N + j] * a * n.reach[1][j]; }
          node.terminal.mass = rnd(m / totalW, 5);
        }
        node.note = calibrated.has(n.key)
          ? 'Flop terminal: valued with realization per hand, measured by postflop solves (calibrated), normalized to stay zero-sum.'
          : `Flop terminal: valued as pot x equity x R (IP SB R=${P.rIp}, OOP BB R=${P.rOop}), normalized to stay zero-sum.`;
      }
      // Ranges of both players that reach this terminal, so the UI can show them.
      node.ranges = { SB: {}, BB: {} };
      for (let i = 0; i < N; i++) {
        if (n.reach[0][i] > 1e-4) node.ranges.SB[className(i)] = rnd(n.reach[0][i], 4);
        if (n.reach[1][i] > 1e-4) node.ranges.BB[className(i)] = rnd(n.reach[1][i], 4);
      }
    }
    out[node.id] = node;
  }
  return out;
}

// Readable name for a flop terminal from its key ('SB:Raise 2.25/BB:Call').
function terminalName(key) {
  const steps = String(key || '').split('/').filter(Boolean).map((x) => { const i = x.indexOf(':'); return { pos: x.slice(0, i), label: x.slice(i + 1) }; });
  const limped = steps.length && steps[0].label === 'Limp';
  const raises = steps.filter((s) => /^(Raise|Allin)/.test(s.label)).length;
  const short = steps.map((s) => {
    const m = s.label.match(/^(?:Raise|Allin) (.+)$/);
    return `${s.pos} ${m ? m[1] : s.label.toLowerCase()}`;
  }).join(' / ');
  let base;
  if (limped) base = raises === 0 ? 'Limped pot' : raises === 1 ? 'Iso-raised pot' : raises === 2 ? 'Limp / iso / 3-bet pot' : 'Limp / 4-bet pot';
  else base = raises <= 1 ? 'Raised pot' : raises === 2 ? '3-bet pot' : raises === 3 ? '4-bet pot' : `${raises + 1}-bet pot`;
  return `${base} (${short})`;
}

// Spot key: the params that define the tree. A calibration table belongs to one spot.
function spotKey(raw) {
  const P = normalizeParams(raw);
  const k = { stack: P.stack, ante: P.ante, sbOpen: P.sbOpen, limp: P.limp, isoSize: P.isoSize, threeBetX: P.threeBetX, fourBetX: P.fourBetX };
  return require('crypto').createHash('sha1').update(JSON.stringify(k)).digest('hex').slice(0, 12);
}

module.exports = { VERSION, normalizeParams, buildTree, solve, spotKey, terminalName, COMBOS };
