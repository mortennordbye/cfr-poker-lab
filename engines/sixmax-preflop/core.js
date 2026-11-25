'use strict';
// CFR+ core for the 6-max preflop tree. Used by the master thread (spine + its share of subtrees)
// and by helper threads (their share of subtrees). See README.md for the model.
const { N, COMBOS } = require('../../lib/equity');

const H = N; // 169 classes
const PRIOR = new Float64Array(H);
for (let i = 0; i < H; i++) PRIOR[i] = COMBOS[i].length / 1326;

// Transposed matrices for column-sparse products: T[j*H + h] = M[h][j].
//   WnT: conditional probability that an opponent holds class j when hero holds class h.
//   WS[0]: the same times the all-in equity of h vs j (showdown).
//   WS[1]: the same times hero's zero-sum flop share when hero is IP:  E*Rip / (E*Rip + (1-E)*Roop).
//   WS[2]: the same times hero's zero-sum flop share when hero is OOP: E*Roop / (E*Roop + (1-E)*Rip).
function buildMatrices(E, W, rIp, rOop) {
  const WnT = new Float64Array(H * H), WS = [0, 1, 2].map(() => new Float64Array(H * H));
  const share = (e, a, b) => {
    const x = e * a, y = (1 - e) * b;
    return x + y > 0 ? x / (x + y) : 0.5;
  };
  for (let h = 0; h < H; h++) {
    let row = 0;
    for (let j = 0; j < H; j++) row += W[h * H + j];
    for (let j = 0; j < H; j++) {
      const wn = W[h * H + j] / row, e = E[h * H + j];
      WnT[j * H + h] = wn;
      WS[0][j * H + h] = wn * e;
      WS[1][j * H + h] = wn * share(e, rIp, rOop);
      WS[2][j * H + h] = wn * share(e, rOop, rIp);
    }
  }
  return { WnT, WS };
}

function mv(T, x, out) {
  out.fill(0);
  for (let j = 0; j < H; j++) {
    const xj = x[j];
    if (xj === 0) continue;
    const off = j * H;
    for (let h = 0; h < H; h++) out[h] += xj * T[off + h];
  }
}

class Ref {
  constructor(v) { this.v = v || new Float64Array(H); this.A = [null, null, null]; this.B = null; this.sa = [-1, -1, -1]; this.sb = -1; }
  inv() { this.sa[0] = this.sa[1] = this.sa[2] = -1; this.sb = -1; }
}

class Core {
  constructor(tree, P, mats) {
    this.nodes = tree.nodes;
    this.P = P;
    this.WnT = mats.WnT; this.WS = mats.WS;
    this.stamp = 0;
    this.mode = 'cfr'; // cfr | eval | br
    this.br = -1;
    this.t = 1;
    this.spine = false; this.phase = 'run';
    this.slotIO = null; // function(cut) -> { reach:[6 Float64Array], F, V, M }
    this.refs = new Map();
    this.pool = [];
    this.ones = new Ref(new Float64Array(H).fill(1));
    this.evalOut = new Map(); // node idx -> recorded data (eval mode)
  }
  getRef(idx) { let r = this.refs.get(idx); if (!r) { r = new Ref(); this.refs.set(idx, r); } return r; }
  B(ref) { if (ref.sb !== this.stamp) { if (!ref.B) ref.B = new Float64Array(H); mv(this.WnT, ref.v, ref.B); ref.sb = this.stamp; } return ref.B; }
  // kind 0 = showdown equity, 1 = flop share as IP, 2 = flop share as OOP
  A(ref, kind = 0) {
    if (ref.sa[kind] !== this.stamp) { if (!ref.A[kind]) ref.A[kind] = new Float64Array(H); mv(this.WS[kind], ref.v, ref.A[kind]); ref.sa[kind] = this.stamp; }
    return ref.A[kind];
  }
  level(d) {
    let b = this.pool[d];
    if (!b) {
      b = { V: Array.from({ length: 6 }, () => new Float64Array(H)), M: Array.from({ length: 6 }, () => new Float64Array(H)),
        Va: Array.from({ length: 6 }, () => new Float64Array(H)), F: new Float64Array(H), reach: new Array(6), sig: new Float64Array(6 * H) };
      this.pool[d] = b;
    }
    return b;
  }
  ensure(n) {
    if (!n.regret) {
      const k = n.children.length * H;
      n.regret = new Float64Array(k); n.ssum = new Float64Array(k);
    }
  }
  // Current strategy (regret matching) or average strategy into sig.
  strategy(n, avg, sig) {
    this.ensure(n);
    const A = n.children.length, src = avg ? n.ssum : n.regret;
    for (let h = 0; h < H; h++) {
      let s = 0;
      for (let a = 0; a < A; a++) { const x = src[a * H + h]; if (x > 0) s += x; }
      if (s > 0) for (let a = 0; a < A; a++) { const x = src[a * H + h]; sig[a * H + h] = x > 0 ? x / s : 0; }
      else if (avg) {
        // never reached: fall back to the current strategy
        let r = 0;
        for (let a = 0; a < A; a++) { const x = n.regret[a * H + h]; if (x > 0) r += x; }
        for (let a = 0; a < A; a++) { const x = n.regret[a * H + h]; sig[a * H + h] = r > 0 ? (x > 0 ? x / r : 0) : 1 / A; }
      } else for (let a = 0; a < A; a++) sig[a * H + h] = 1 / A;
    }
  }

  terminal(n, reach, F, out) {
    const act = n.active;
    if (n.terminal.type === 'fold') {
      const w = act[0], gain = n.pot - n.inv[w];
      const V = out.V[w], M = out.M[w];
      for (let h = 0; h < H; h++) { V[h] = F[h] * gain; M[h] = F[h]; }
      return;
    }
    if (act.length === 2) {
      for (let k = 0; k < 2; k++) {
        const p = act[k], o = act[1 - k];
        const kind = n.terminal.type === 'showdown' ? 0 : p === n.order[1] ? 1 : 2;
        const A = this.A(reach[o], kind), B = this.B(reach[o]);
        const pr = n.pot, ip = n.inv[p];
        const V = out.V[p], M = out.M[p];
        for (let h = 0; h < H; h++) { const m = F[h] * B[h]; M[h] = m; V[h] = F[h] * (pr * A[h] - ip * B[h]); }
      }
      return;
    }
    // Three players: pairwise-product approximation of the 3-way share (see README).
    for (let k = 0; k < 3; k++) {
      const p = act[k], o1 = act[(k + 1) % 3], o2 = act[(k + 2) % 3];
      const A1 = this.A(reach[o1]), B1 = this.B(reach[o1]), A2 = this.A(reach[o2]), B2 = this.B(reach[o2]);
      const r1 = reach[o1].v;
      let num = 0, den = 0;
      for (let j = 0; j < H; j++) { const w = PRIOR[j] * r1[j]; num += w * A2[j]; den += w * B2[j]; }
      const e12 = den > 0 ? num / den : 0.5;
      const pot = n.pot, ip = n.inv[p];
      const R0 = n.R[k], R1 = n.R[(k + 1) % 3], R2 = n.R[(k + 2) % 3];
      const V = out.V[p], M = out.M[p];
      for (let h = 0; h < H; h++) {
        const m = F[h] * B1[h] * B2[h];
        M[h] = m;
        if (m <= 0) { V[h] = 0; continue; }
        const a1 = A1[h] / B1[h], a2 = A2[h] / B2[h];
        // pairwise-product 3-way equities, then realization, normalized to the pot (zero-sum)
        const q0 = a1 * a2 * R0, q1 = (1 - a1) * e12 * R1, q2 = (1 - a2) * (1 - e12) * R2;
        const z = q0 + q1 + q2;
        const share = z > 0 ? q0 / z : 1 / 3;
        V[h] = m * (pot * share - ip);
      }
    }
  }

  // Returns the level-d buffer with V/M for the active players at n.
  walk(n, reach, F, d) {
    const out = this.level(d);
    for (const q of n.active) { out.V[q].fill(0); out.M[q].fill(0); }
    if (n.terminal) {
      this.terminal(n, reach, F, out);
      if (this.mode === 'eval') {
        const r = {};
        for (const q of n.active) r[q] = Float32Array.from(reach[q].v);
        this.evalOut.set(n.idx, { ranges: r });
      }
      return out;
    }
    const p = n.toAct, A = n.children.length, sig = out.sig;
    const collect = this.spine && this.phase === 'collect';
    const useAvg = this.mode !== 'cfr';
    this.strategy(n, useAvg, sig);
    const hasFold = n.actions[0].type === 'fold';
    const rp = reach[p].v;
    let gotMass = false;
    const nxt = this.level(d + 1);
    for (let step = 0; step < A; step++) {
      const a = hasFold ? (step + 1) % A : step; // fold last
      const c = this.nodes[n.children[a]];
      const isFold = hasFold && a === 0;
      const ref = this.getRef(c.idx);
      const v = ref.v;
      for (let h = 0; h < H; h++) v[h] = rp[h] * sig[a * H + h];
      ref.inv();
      const cr = nxt.reach;
      for (let q = 0; q < 6; q++) cr[q] = reach[q];
      cr[p] = ref;
      let Fc = F;
      if (isFold) {
        const Bf = this.B(ref);
        Fc = nxt.F;
        for (let h = 0; h < H; h++) Fc[h] = F[h] * Bf[h];
      }
      let co;
      if (this.spine && c.cut >= 0) {
        const slot = this.slotIO(c.cut);
        if (collect) {
          for (let q = 0; q < 6; q++) slot.reach[q].set(cr[q].v);
          slot.F.set(Fc);
          continue;
        }
        co = slot;
      } else {
        co = this.walk(c, cr, Fc, d + 1);
      }
      if (!isFold) {
        out.Va[a].set(co.V[p]);
        if (!gotMass) { out.M[p].set(co.M[p]); gotMass = true; }
      }
      for (const q of c.active) {
        if (q === p) continue;
        const V = out.V[q], M = out.M[q], cV = co.V[q], cM = co.M[q];
        for (let h = 0; h < H; h++) { V[h] += cV[h]; M[h] += cM[h]; }
      }
    }
    if (collect) return out;
    const Mp = out.M[p];
    if (hasFold) { const ip = n.inv[p], Va = out.Va[0]; for (let h = 0; h < H; h++) Va[h] = -ip * Mp[h]; }
    const Vp = out.V[p];
    if (this.mode === 'br' && p === this.br) {
      for (let h = 0; h < H; h++) { let m = -Infinity; for (let a = 0; a < A; a++) if (out.Va[a][h] > m) m = out.Va[a][h]; Vp[h] = m; }
      return out;
    }
    for (let h = 0; h < H; h++) { let s = 0; for (let a = 0; a < A; a++) s += sig[a * H + h] * out.Va[a][h]; Vp[h] = s; }
    if (this.mode === 'cfr') {
      const R = n.regret, S = n.ssum, w = this.t;
      for (let a = 0; a < A; a++) {
        const Va = out.Va[a], off = a * H;
        for (let h = 0; h < H; h++) {
          const r = R[off + h] + Va[h] - Vp[h];
          R[off + h] = r > 0 ? r : 0;
          S[off + h] += w * rp[h] * sig[off + h];
        }
      }
    } else if (this.mode === 'eval') {
      const inv = n.inv[p];
      const ev = new Float32Array(A * H), st = new Float32Array(A * H);
      for (let h = 0; h < H; h++) {
        const m = Mp[h];
        for (let a = 0; a < A; a++) {
          st[a * H + h] = sig[a * H + h];
          ev[a * H + h] = hasFold && a === 0 ? 0 : m > 1e-12 ? out.Va[a][h] / m + inv : NaN;
        }
      }
      this.evalOut.set(n.idx, { w: Float32Array.from(rp), st, ev });
    }
    return out;
  }
}

module.exports = { Core, Ref, buildMatrices, mv, PRIOR, H };
