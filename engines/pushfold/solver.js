'use strict';
// CFR+ solver for heads-up push/fold.
// SB: all-in or fold. BB (facing all-in): call or fold.
// stack = starting stack in bb (includes the ante). Both players post the ante.
const { N, COMBOS, className } = require('../../lib/equity');

function solve(E, W, { stack = 10, ante = 0, iterations = 3000 } = {}) {
  const S = stack, a = ante;
  const t0 = Date.now();
  // Utilities for SB in absolute chips (change from the start of the hand). BB gets the negative.
  const uFold = -(0.5 + a);       // SB folds
  const uSteal = 1 + a;           // SB pushes, BB folds
  const uCall = new Float64Array(N * N); // SB pushes, BB calls
  for (let k = 0; k < N * N; k++) uCall[k] = E[k] * 2 * S - S;

  const rowW = new Float64Array(N), colW = new Float64Array(N);
  let totalW = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { rowW[i] += W[i * N + j]; colW[j] += W[i * N + j]; totalW += W[i * N + j]; }

  const rSB = new Float64Array(N * 2), rBB = new Float64Array(N * 2);
  const avgSB = new Float64Array(N), avgBB = new Float64Array(N);
  const p = new Float64Array(N), c = new Float64Array(N);
  let wSum = 0;

  const match = (r, i) => {
    const x = Math.max(r[2 * i], 0), y = Math.max(r[2 * i + 1], 0);
    return x + y > 0 ? x / (x + y) : 0.5;
  };

  for (let t = 1; t <= iterations; t++) {
    // SB update (action 0 = push, 1 = fold)
    for (let j = 0; j < N; j++) c[j] = match(rBB, j);
    for (let i = 0; i < N; i++) {
      p[i] = match(rSB, i);
      let vPush = 0;
      for (let j = 0; j < N; j++) {
        const w = W[i * N + j];
        if (w) vPush += w * ((1 - c[j]) * uSteal + c[j] * uCall[i * N + j]);
      }
      const vFold = rowW[i] * uFold;
      const v = p[i] * vPush + (1 - p[i]) * vFold;
      rSB[2 * i] = Math.max(rSB[2 * i] + vPush - v, 0);
      rSB[2 * i + 1] = Math.max(rSB[2 * i + 1] + vFold - v, 0);
    }
    // BB update (action 0 = call, 1 = fold), against the SB strategy of this iteration
    for (let i = 0; i < N; i++) p[i] = match(rSB, i);
    for (let j = 0; j < N; j++) {
      let vCall = 0, reach = 0;
      for (let i = 0; i < N; i++) {
        const w = W[i * N + j] * p[i];
        if (w) { vCall -= w * uCall[i * N + j]; reach += w; }
      }
      const vFold = -reach * uSteal;
      const v = c[j] * vCall + (1 - c[j]) * vFold;
      rBB[2 * j] = Math.max(rBB[2 * j] + vCall - v, 0);
      rBB[2 * j + 1] = Math.max(rBB[2 * j + 1] + vFold - v, 0);
    }
    // Linear averaging (later iterations count more)
    for (let i = 0; i < N; i++) { avgSB[i] += t * p[i]; avgBB[i] += t * match(rBB, i); }
    wSum += t;
  }
  for (let i = 0; i < N; i++) { avgSB[i] /= wSum; avgBB[i] /= wSum; }

  // ---- EVs and exploitability of the average strategy ----
  const sb = [], bb = [];
  let brSB = 0, brBB = 0, value = 0, pushCombos = 0, callCombos = 0;
  for (let i = 0; i < N; i++) {
    let vPush = 0;
    for (let j = 0; j < N; j++) {
      const w = W[i * N + j];
      if (w) vPush += w * ((1 - avgBB[j]) * uSteal + avgBB[j] * uCall[i * N + j]);
    }
    const vFold = rowW[i] * uFold;
    brSB += Math.max(vPush, vFold);
    value += avgSB[i] * vPush + (1 - avgSB[i]) * vFold;
    const evPush = vPush / rowW[i] - uFold; // EV relative to folding (fold = 0)
    sb.push({ hand: className(i), combos: COMBOS[i].length, freq: avgSB[i], ev: { push: evPush, fold: 0 }, evHand: avgSB[i] * evPush });
    pushCombos += avgSB[i] * COMBOS[i].length;
  }
  for (let j = 0; j < N; j++) {
    let uIfCall = 0, uIfFold = 0, reach = 0;
    for (let i = 0; i < N; i++) {
      const w = W[i * N + j];
      if (!w) continue;
      const foldPart = (1 - avgSB[i]) * uFold * w;
      uIfCall += foldPart + avgSB[i] * w * uCall[i * N + j];
      uIfFold += foldPart + avgSB[i] * w * uSteal;
      reach += avgSB[i] * w;
    }
    brBB += Math.min(uIfCall, uIfFold); // BB picks what is worst for SB
    let evCall = null;
    if (reach > 1e-9) {
      let s = 0;
      for (let i = 0; i < N; i++) s -= W[i * N + j] * avgSB[i] * uCall[i * N + j];
      evCall = s / reach + uSteal; // relative to folding (fold = 0)
    }
    bb.push({ hand: className(j), combos: COMBOS[j].length, freq: avgBB[j], ev: { call: evCall, fold: 0 }, evHand: evCall === null ? 0 : avgBB[j] * evCall });
    callCombos += avgBB[j] * COMBOS[j].length;
  }
  const gap = (brSB - brBB) / totalW; // bb
  const pot = 1.5 + 2 * a;
  return {
    stack: S, ante: a, iterations,
    ms: Date.now() - t0,
    sbValue: value / totalW,                 // SB result per hand, in bb, from start of hand
    exploitability: gap / 2,                 // bb per hand (average over both players)
    exploitabilityPctPot: (100 * gap) / 2 / pot,
    sb: { strategy: sb, actions: { push: pushCombos, fold: 1326 - pushCombos } },
    bb: { strategy: bb, actions: { call: callCombos, fold: 1326 - callCombos } },
  };
}

module.exports = { solve };
