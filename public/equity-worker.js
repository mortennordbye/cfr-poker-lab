'use strict';
// Web Worker for the Equity chart and the Table (public/app.js): equity of every combo of two ranges on a board,
// when the engine does not send it. Uses rangeEquity() from handclass.js (exact on the turn and river, sampled
// runouts on the flop). Message in: { id, board: [card ids], ranges: [[[a, b, w], ...], [...]], samples }.
// Message out: { id, eq: [[...], [...]], runouts, ms } or { id, error }.
importScripts('handclass.js');
self.onmessage = (e) => {
  const { id, board, ranges, samples } = e.data || {};
  try {
    const t0 = Date.now();
    const r = self.cfrHandclass.rangeEquity(board, ranges, { samples });
    self.postMessage({ id, eq: r.eq.map((a) => Array.from(a)), runouts: r.runouts, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
