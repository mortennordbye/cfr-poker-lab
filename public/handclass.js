'use strict';
// Hand classes on a board (made hand + draws), a 5 to 7 card evaluator and range vs range equity.
// One file for Node (lib/handclass.js re-exports it) and the browser (a plain <script> in index.html, and
// importScripts() in equity-worker.js): the local server and the static site both serve public/ as it is.
// Card id = rank * 4 + suit, rank 0 = '2' ... 12 = 'A', suits 'cdhs' (the same as lib/equity.js).
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.cfrHandclass = m;
})(typeof self !== 'undefined' ? self : this, function () {
  const RANKS = '23456789TJQKA';
  const SUITS = 'cdhs';

  // Made hands, best first. A combo has one made class and zero or more draws.
  const MADE = ['straight flush', 'quads', 'full house', 'flush', 'straight', 'set', 'trips', 'two pair',
    'overpair', 'top pair', 'middle pair', 'weak pair', 'ace high', 'nothing'];
  const DRAWS = ['flush draw', 'open-ended', 'gutshot', 'backdoor flush draw'];

  function parseCard(s) {
    const r = RANKS.indexOf(String(s)[0].toUpperCase()), u = SUITS.indexOf(String(s)[1].toLowerCase());
    if (r < 0 || u < 0) throw new Error('bad card: ' + s);
    return r * 4 + u;
  }
  const cardName = (c) => RANKS[c >> 2] + SUITS[c & 3];
  // 'KsKh' -> [id, id]
  const parseCombo = (name) => [parseCard(name.slice(0, 2)), parseCard(name.slice(2, 4))];

  // Highest straight in a rank bit mask (bit r = rank r), -1 if none. 3 = the wheel A-2-3-4-5.
  function straightHigh(mask) {
    for (let r = 12; r >= 4; r--) {
      const m = 0x1f << (r - 4);
      if ((mask & m) === m) return r;
    }
    if ((mask & 0x100f) === 0x100f) return 3;
    return -1;
  }
  function topBits(mask, n) {
    let out = 0, k = 0;
    for (let r = 12; r >= 0 && k < n; r--) if (mask & (1 << r)) { out = (out << 4) | r; k++; }
    while (k < n) { out <<= 4; k++; }
    return out;
  }

  // Best five of 5 to 7 cards. Higher = better; category = score >> 20 (0 high card ... 8 straight flush).
  // For 7 cards the score is the same number as eval7 in lib/equity.js (lib/handclass.test.js checks it).
  const counts = new Int32Array(13), sm = new Int32Array(4), sc = new Int32Array(4);
  function score(cards, n = cards.length) {
    counts.fill(0); sm.fill(0); sc.fill(0);
    let mask = 0;
    for (let i = 0; i < n; i++) {
      const c = cards[i], r = c >> 2, s = c & 3;
      counts[r]++; sm[s] |= 1 << r; sc[s]++; mask |= 1 << r;
    }
    for (let s = 0; s < 4; s++) {
      if (sc[s] >= 5) {
        const sf = straightHigh(sm[s]);
        if (sf >= 0) return (8 << 20) | (sf << 16);
        return (5 << 20) | topBits(sm[s], 5);
      }
    }
    let quad = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
    for (let r = 12; r >= 0; r--) {
      const k = counts[r];
      if (k === 4) quad = r;
      else if (k === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
      else if (k === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
    }
    if (quad >= 0) return (7 << 20) | (quad << 16) | (topBits(mask & ~(1 << quad), 1) << 12);
    if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return (6 << 20) | (t1 << 16) | (Math.max(t2, p1) << 12);
    const st = straightHigh(mask);
    if (st >= 0) return (4 << 20) | (st << 16);
    if (t1 >= 0) return (3 << 20) | (t1 << 16) | (topBits(mask & ~(1 << t1), 2) << 8);
    if (p1 >= 0 && p2 >= 0) return (2 << 20) | (p1 << 16) | (p2 << 12) | (topBits(mask & ~(1 << p1) & ~(1 << p2), 1) << 8);
    if (p1 >= 0) return (1 << 20) | (p1 << 16) | (topBits(mask & ~(1 << p1), 3) << 4);
    return topBits(mask, 5);
  }

  // Made class of hole cards [a, b] on a board of 3 to 5 card ids. Ranks are seen from the hole cards:
  // a pair on the board alone does not count, and a straight or better that the board makes alone does not count.
  function madeClass(hole, board) {
    const all = hole.concat(board);
    const cat = score(all) >> 20;
    const boardPlays = board.length >= 5 && score(board) === score(all);
    if (!boardPlays && cat >= 4) return MADE[8 - cat];
    const h1 = hole[0] >> 2, h2 = hole[1] >> 2;
    const bc = new Array(13).fill(0);
    for (const c of board) bc[c >> 2]++;
    const ranks = [];
    for (let r = 12; r >= 0; r--) if (bc[r]) ranks.push(r);
    if (h1 === h2) {
      if (bc[h1] >= 1) return 'set';            // two on the board too = quads, counted above
      if (h1 > ranks[0]) return 'overpair';
      if (h1 > ranks[1]) return 'middle pair';  // between the top and the second board rank
      return 'weak pair';
    }
    if (bc[h1] >= 2 || bc[h2] >= 2) return 'trips';
    if (bc[h1] && bc[h2]) return 'two pair';
    const p = bc[h1] ? h1 : bc[h2] ? h2 : -1;
    if (p >= 0) return p === ranks[0] ? 'top pair' : p === ranks[1] ? 'middle pair' : 'weak pair';
    return h1 === 12 || h2 === 12 ? 'ace high' : 'nothing';
  }

  // Draws (flop and turn only). Each draw needs at least one hole card.
  function draws(hole, board, made) {
    if (board.length >= 5) return [];
    const out = [];
    const mi = MADE.indexOf(made || madeClass(hole, board));
    // Suits: four of a suit = flush draw, three on the flop = backdoor flush draw.
    if (mi > MADE.indexOf('flush')) {
      let fd = false, bd = false;
      for (let s = 0; s < 4; s++) {
        const nh = (hole[0] & 3) === s ? 1 + ((hole[1] & 3) === s ? 1 : 0) : (hole[1] & 3) === s ? 1 : 0;
        if (!nh) continue;
        let n = nh;
        for (const c of board) if ((c & 3) === s) n++;
        if (n === 4) fd = true;
        else if (n === 3 && board.length === 3) bd = true;
      }
      if (fd) out.push('flush draw');
      else if (bd) out.push('backdoor flush draw');
    }
    // Straights: count the ranks that make a straight with the hole cards but not with the board alone.
    if (mi > MADE.indexOf('straight')) {
      let mask = 0, bmask = 0;
      for (const c of hole) mask |= 1 << (c >> 2);
      for (const c of board) { mask |= 1 << (c >> 2); bmask |= 1 << (c >> 2); }
      let outs = 0;
      for (let r = 0; r < 13; r++) {
        const bit = 1 << r;
        if (straightHigh(mask | bit) >= 0 && straightHigh(bmask | bit) < 0) outs++;
      }
      if (outs >= 2) out.push('open-ended');
      else if (outs === 1) out.push('gutshot');
    }
    return out;
  }

  // { made, draws } for a combo name ('AhKd') or ids, on board names or ids.
  function classify(hole, board) {
    const h = typeof hole === 'string' ? parseCombo(hole) : hole;
    const b = (board || []).map((c) => (typeof c === 'string' ? parseCard(c) : c));
    const made = madeClass(h, b);
    return { made, draws: draws(h, b, made) };
  }

  // Preflop hand groups (by class name 'AKs', 'T9o', '77').
  const GROUPS = ['pairs', 'suited aces', 'suited broadways', 'offsuit broadways', 'suited connectors/gappers', 'other suited', 'other offsuit'];
  function handGroup(cls) {
    const a = RANKS.indexOf(cls[0]), b = RANKS.indexOf(cls[1]);
    if (a === b) return 'pairs';
    const hi = Math.max(a, b), lo = Math.min(a, b), suited = cls[2] === 's';
    const broad = lo >= 8; // T or higher
    if (suited && hi === 12) return 'suited aces';
    if (broad) return suited ? 'suited broadways' : 'offsuit broadways';
    // Connectors and one- or two-gappers (A-2 counts as connected through the wheel: it is a suited ace above).
    if (suited && hi - lo <= 3) return 'suited connectors/gappers';
    return suited ? 'other suited' : 'other offsuit';
  }

  // Equity of every combo of two ranges on a board (3 to 5 cards), against the other range.
  // ranges: [[ [a, b, weight], ... ], [ ... ]]. All river cards are enumerated on the turn and river.
  // On the flop, `samples` random turn+river runouts are used (0 or >= 1081 = all of them).
  // Returns { eq: [Float64Array, Float64Array], runouts }: eq in input order, NaN for a dead combo or one with no
  // possible opponent hand.
  function rangeEquity(board, ranges, opts = {}) {
    const used = new Uint8Array(52);
    for (const c of board) used[c] = 1;
    const R = ranges.map((r) => r.map((x, i) => [x[0], x[1], x[2], i]).filter((x) => x[2] > 0 && !used[x[0]] && !used[x[1]]));
    const free = [];
    for (let c = 0; c < 52; c++) if (!used[c]) free.push(c);
    const need = 5 - board.length;
    let runouts = [];
    if (need === 0) runouts = [[]];
    else if (need === 1) runouts = free.map((c) => [c]);
    else {
      for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) runouts.push([free[i], free[j]]);
      const n = opts.samples || 0;
      if (n > 0 && n < runouts.length) {
        let seed = (opts.seed || 12345) >>> 0;
        const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
        for (let i = runouts.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = runouts[i]; runouts[i] = runouts[j]; runouts[j] = t; }
        runouts = runouts.slice(0, n);
      }
    }
    const num = R.map((r) => new Float64Array(r.length)), den = R.map((r) => new Float64Array(r.length));
    const cards = new Int32Array(7);
    for (let i = 0; i < board.length; i++) cards[2 + i] = board[i];
    // Per runout: score every live combo, sort both ranges together by score, then sweep. Weight of opponent hands
    // below (and tied with) each combo, minus those that share a card with it (per-card sums), plus the same combo.
    const items = [];
    for (const ro of runouts) {
      for (let i = 0; i < need; i++) cards[2 + board.length + i] = ro[i];
      items.length = 0;
      for (let p = 0; p < 2; p++) {
        const r = R[p];
        for (let k = 0; k < r.length; k++) {
          const a = r[k][0], b = r[k][1];
          if (ro.includes(a) || ro.includes(b)) continue;
          cards[0] = a; cards[1] = b;
          items.push({ p, k, a, b, w: r[k][2], s: score(cards, 7) });
        }
      }
      items.sort((x, y) => x.s - y.s);
      // Totals per player: all weight, weight per card, weight per exact combo.
      const tot = [0, 0], card = [new Float64Array(52), new Float64Array(52)], same = [new Map(), new Map()];
      for (const it of items) {
        tot[it.p] += it.w; card[it.p][it.a] += it.w; card[it.p][it.b] += it.w;
        const key = it.a * 52 + it.b;
        same[it.p].set(key, (same[it.p].get(key) || 0) + it.w);
      }
      const below = [0, 0], cBelow = [new Float64Array(52), new Float64Array(52)], sBelow = [new Map(), new Map()];
      for (let i = 0; i < items.length;) {
        let j = i;
        while (j < items.length && items[j].s === items[i].s) j++;
        const tie = [0, 0], cTie = [new Map(), new Map()], sTie = [new Map(), new Map()];
        for (let k = i; k < j; k++) {
          const it = items[k];
          tie[it.p] += it.w;
          cTie[it.p].set(it.a, (cTie[it.p].get(it.a) || 0) + it.w);
          cTie[it.p].set(it.b, (cTie[it.p].get(it.b) || 0) + it.w);
          const key = it.a * 52 + it.b;
          sTie[it.p].set(key, (sTie[it.p].get(key) || 0) + it.w);
        }
        for (let k = i; k < j; k++) {
          const it = items[k], o = 1 - it.p, key = it.a * 52 + it.b;
          const sameO = same[o].get(key) || 0;
          const all = tot[o] - card[o][it.a] - card[o][it.b] + sameO;
          if (all <= 0) continue;
          const lo = below[o] - cBelow[o][it.a] - cBelow[o][it.b] + (sBelow[o].get(key) || 0);
          const eq = tie[o] - (cTie[o].get(it.a) || 0) - (cTie[o].get(it.b) || 0) + (sTie[o].get(key) || 0);
          num[it.p][it.k] += lo + eq / 2;
          den[it.p][it.k] += all;
        }
        for (let k = i; k < j; k++) {
          const it = items[k], key = it.a * 52 + it.b;
          below[it.p] += it.w; cBelow[it.p][it.a] += it.w; cBelow[it.p][it.b] += it.w;
          sBelow[it.p].set(key, (sBelow[it.p].get(key) || 0) + it.w);
        }
        i = j;
      }
    }
    // Back to the order of the input (NaN for combos that are dead on this board).
    const eq = ranges.map((r) => new Float64Array(r.length).fill(NaN));
    R.forEach((r, p) => r.forEach((x, k) => { if (den[p][k] > 0) eq[p][x[3]] = num[p][k] / den[p][k]; }));
    return { eq, runouts: runouts.length };
  }

  return { RANKS, SUITS, MADE, DRAWS, GROUPS, parseCard, cardName, parseCombo, score, madeClass, draws, classify, handGroup, rangeEquity };
});
