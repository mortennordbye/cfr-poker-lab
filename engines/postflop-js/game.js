'use strict';
// Postflop game: ranges, hand lists, betting tree, showdown data and the vector CFR walk.
// Shared by the main thread (tree for getNode), the coordinator worker and the helper workers.
const { className, eval7, parseCard, cardName, comboName, RANKS } = require('../../lib/equity');

// ---------------------------------------------------------------- combos
const COMBO_A = new Uint8Array(1326), COMBO_B = new Uint8Array(1326);
const COMBO_IDX = new Int32Array(52 * 52).fill(-1);
{
  let k = 0;
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) {
    COMBO_A[k] = a; COMBO_B[k] = b; COMBO_IDX[a * 52 + b] = k; COMBO_IDX[b * 52 + a] = k; k++;
  }
}
const CLASS_ID = new Map();
for (let i = 0; i < 169; i++) CLASS_ID.set(className(i), i);

// Combo indices of a class name like 'AKs', 'AKo', 'AA' or 'AK' (both).
function classCombos(name) {
  const r1 = RANKS.indexOf(name[0].toUpperCase()), r2 = RANKS.indexOf(name[1].toUpperCase());
  if (r1 < 0 || r2 < 0) throw new Error('bad hand: ' + name);
  const kind = (name[2] || '').toLowerCase();
  const out = [];
  for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
    const a = r1 * 4 + s1, b = r2 * 4 + s2;
    if (a === b) continue;
    if (r1 === r2 && s1 >= s2) continue;
    if (r1 !== r2 && kind === 's' && s1 !== s2) continue;
    if (r1 !== r2 && kind === 'o' && s1 === s2) continue;
    out.push(COMBO_IDX[a * 52 + b]);
  }
  return out;
}

// One range token: 'AsKs', 'AKs', 'AK', 'TT+', 'A2s+', 'K9o+', '22-77', 'A2s-A5s'.
function tokenCombos(tok) {
  tok = tok.trim();
  if (!tok) return [];
  if (/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/i.test(tok)) {
    const a = parseCard(tok.slice(0, 2)), b = parseCard(tok.slice(2, 4));
    if (a === b) throw new Error('bad combo: ' + tok);
    return [COMBO_IDX[a * 52 + b]];
  }
  const R = (ch) => { const r = RANKS.indexOf(ch.toUpperCase()); if (r < 0) throw new Error('bad hand: ' + tok); return r; };
  const names = [];
  let m;
  if ((m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so]?)\+$/i))) {
    const hi = R(m[1]), lo = R(m[2]), k = m[3] || '';
    if (hi === lo) for (let r = lo; r <= 12; r++) names.push(RANKS[r] + RANKS[r]);
    else { const h = Math.max(hi, lo); for (let r = Math.min(hi, lo); r < h; r++) names.push(RANKS[h] + RANKS[r] + k); }
  } else if ((m = tok.match(/^([2-9TJQKA])([2-9TJQKA])([so]?)-([2-9TJQKA])([2-9TJQKA])([so]?)$/i))) {
    const a1 = R(m[1]), a2 = R(m[2]), b1 = R(m[4]), b2 = R(m[5]), k = m[3] || '';
    if (a1 === a2 && b1 === b2) for (let r = Math.min(a1, b1); r <= Math.max(a1, b1); r++) names.push(RANKS[r] + RANKS[r]);
    else if (a1 === b1) for (let r = Math.min(a2, b2); r <= Math.max(a2, b2); r++) { if (r !== a1) names.push(RANKS[a1] + RANKS[r] + k); }
    else throw new Error('bad range: ' + tok);
  } else names.push(tok);
  const out = [];
  for (const n of names) out.push(...classCombos(n));
  return out;
}

// Range as string ('AA,AKs:0.5,22+') or object ({ 'AKs': 0.7, 'AsKs': 1, 'TT+': 1 }) -> Float64Array(1326).
function parseRange(r) {
  const w = new Float64Array(1326);
  if (r == null) return w;
  const entries = [];
  if (typeof r === 'string') {
    for (const part of r.split(/[,\s]+/)) {
      if (!part) continue;
      const [t, x] = part.split(':');
      entries.push([t, x === undefined ? 1 : Number(x)]);
    }
  } else for (const [k, v] of Object.entries(r)) entries.push([k, Number(v)]);
  for (const [t, x] of entries) {
    const v = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
    for (const c of tokenCombos(t)) w[c] = v;
  }
  return w;
}

// ---------------------------------------------------------------- hands
// Per player: list of combos with weight > 0 that do not touch the root board.
function makeHands(weights, board) {
  const dead = new Uint8Array(52);
  for (const c of board) dead[c] = 1;
  const idx = [];
  for (let k = 0; k < 1326; k++) if (weights[k] > 0 && !dead[COMBO_A[k]] && !dead[COMBO_B[k]]) idx.push(k);
  const n = idx.length;
  const H = { n, combo: Int32Array.from(idx), c1: new Uint8Array(n), c2: new Uint8Array(n), w: new Float64Array(n),
    names: new Array(n), withCard: [] };
  const lists = Array.from({ length: 52 }, () => []);
  for (let h = 0; h < n; h++) {
    const k = idx[h];
    H.c1[h] = COMBO_A[k]; H.c2[h] = COMBO_B[k]; H.w[h] = weights[k];
    H.names[h] = comboName(COMBO_A[k], COMBO_B[k]);
    lists[COMBO_A[k]].push(h); lists[COMBO_B[k]].push(h);
  }
  H.withCard = lists.map((l) => Int32Array.from(l));
  return H;
}

function linkHands(H0, H1) {
  for (const [A, B] of [[H0, H1], [H1, H0]]) {
    const pos = new Int32Array(1326).fill(-1);
    for (let h = 0; h < B.n; h++) pos[B.combo[h]] = h;
    A.same = new Int32Array(A.n);
    for (let h = 0; h < A.n; h++) A.same[h] = pos[A.combo[h]];
  }
}

// ---------------------------------------------------------------- showdown data
// Per player: hands that do not touch the board, sorted by hand strength (weakest first).
function rankData(board5, Hs) {
  const dead = new Uint8Array(52);
  for (const c of board5) dead[c] = 1;
  const cards = [board5[0], board5[1], board5[2], board5[3], board5[4], 0, 0];
  const idx = [], rk = [];
  for (let p = 0; p < 2; p++) {
    const H = Hs[p], keys = [];
    for (let h = 0; h < H.n; h++) {
      if (dead[H.c1[h]] || dead[H.c2[h]]) continue;
      cards[5] = H.c1[h]; cards[6] = H.c2[h];
      keys.push(eval7(cards) * 65536 + h);
    }
    const K = Float64Array.from(keys).sort();
    const n = K.length, I = new Int32Array(n), Rk = new Int32Array(n);
    for (let i = 0; i < n; i++) { const r = Math.floor(K[i] / 65536); Rk[i] = r; I[i] = K[i] - r * 65536; }
    idx.push(I); rk.push(Rk);
  }
  return { idx, rk };
}

// ---------------------------------------------------------------- params / config
const STREET = { 3: 'flop', 4: 'turn', 5: 'river' };

function parseSizes(v, def) {
  if (v === undefined || v === null || v === '') v = def;
  if (v === undefined || v === null || v === 'none') return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
  const out = [];
  for (let x of arr) {
    if (x === undefined || x === null || x === '') continue;
    x = String(x).trim().toLowerCase().replace('%', '');
    if (x === 'allin' || x === 'a' || x === 'all-in') { out.push('allin'); continue; }
    const n = Number(x.replace(/x$/, ''));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

function parseBoard(s) {
  const str = String(s || '').replace(/[\s,]+/g, '');
  if (str.length % 2 || str.length < 6 || str.length > 10) throw new Error('board must have 3, 4 or 5 cards: ' + s);
  const out = [];
  for (let i = 0; i < str.length; i += 2) out.push(parseCard(str.slice(i, i + 2)));
  if (new Set(out).size !== out.length) throw new Error('duplicate card on board: ' + s);
  return out;
}

// Config used by the tree builder. sizes[player][street] = { bet: [...], raise: [...] }.
function makeConfig(P) {
  const sizes = [{}, {}];
  for (let p = 0; p < 2; p++) for (const st of ['flop', 'turn', 'river']) {
    const pre = p === 0 ? 'oop' : 'ip';
    const cap = st[0].toUpperCase() + st.slice(1);
    sizes[p][st] = {
      bet: parseSizes(P[pre + cap + 'Bets'], P[st + 'Bets']),
      raise: parseSizes(P[pre + cap + 'Raises'], P[st + 'Raises']),
    };
  }
  return { pot0: P.pot, stack: P.stack, sizes, raiseCap: P.raiseCap, allinSpr: P.allinSpr, allinMerge: 0.8 };
}

// ---------------------------------------------------------------- tree
const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => String(r2(x));

// state: { board: [ids], inv: [i0, i1] (since solve root), sInv: [s0, s1] (this street), toAct, bets (this street) }
function legalActions(cfg, s) {
  const p = s.toAct, o = 1 - p;
  const behindP = cfg.stack - s.inv[p], behindO = cfg.stack - s.inv[o];
  const facing = r2(s.sInv[o] - s.sInv[p]);
  const pot = cfg.pot0 + s.inv[0] + s.inv[1];
  const sz = cfg.sizes[p][STREET[s.board.length]];
  const acts = [];
  const allinTo = r2(s.sInv[p] + behindP);
  const add = (type, to) => {
    if (to - s.sInv[p] >= cfg.allinMerge * behindP) { type = 'allin'; to = allinTo; }
    to = r2(to);
    if (acts.some((a) => a.amount === to && (a.type === type || a.type === 'allin' || type === 'allin'))) return;
    acts.push({ type, amount: to });
  };
  if (facing <= 0) {
    acts.push({ type: 'check', amount: 0 });
    if (behindP > 0 && behindO > 0) {
      for (const x of sz.bet) add('bet', x === 'allin' ? allinTo : Math.max(1, x / 100 * pot));
      if (behindP <= cfg.allinSpr * pot) add('allin', allinTo);
    }
  } else {
    acts.push({ type: 'fold', amount: 0 });
    acts.push({ type: 'call', amount: r2(Math.min(facing, behindP)) });
    if (s.bets - 1 < cfg.raiseCap && behindP > facing && behindO > 0) {
      for (const x of sz.raise) add('raise', x === 'allin' ? allinTo : s.sInv[o] + (x - 1) * facing);
      if (behindP <= cfg.allinSpr * (pot + facing)) add('allin', allinTo);
    }
  }
  const keep = acts.filter((a) => a.type === 'fold' || a.type === 'check' || a.type === 'call');
  const aggr = acts.filter((a) => !keep.includes(a)).sort((a, b) => a.amount - b.amount);
  for (const a of [...keep, ...aggr]) {
    a.label = a.type === 'fold' ? 'Fold' : a.type === 'check' ? 'Check' : a.type === 'call' ? 'Call ' + fmt(a.amount)
      : (a.type === 'allin' ? 'Allin ' : a.type === 'bet' ? 'Bet ' : 'Raise ') + fmt(a.amount);
  }
  return [...keep, ...aggr];
}

function applyAction(cfg, s, a) {
  const p = s.toAct, o = 1 - p;
  const inv = s.inv.slice(), sInv = s.sInv.slice();
  if (a.type === 'fold') return { end: 'fold', folder: p, inv, sInv, board: s.board };
  if (a.type === 'check') {
    if (p === 0) return { board: s.board, inv, sInv, toAct: 1, bets: s.bets };
    return { end: 'street', board: s.board, inv, sInv };
  }
  if (a.type === 'call') {
    inv[p] = r2(inv[p] + a.amount); sInv[p] = r2(sInv[p] + a.amount);
    return { end: 'street', board: s.board, inv, sInv };
  }
  const add = r2(a.amount - sInv[p]);
  inv[p] = r2(inv[p] + add); sInv[p] = a.amount;
  return { board: s.board, inv, sInv, toAct: o, bets: s.bets + 1 };
}

// Builds a (sub)tree. ctx: { cfg, nH: [n0, n1], off: 0 (data counter), split: bool, splits: [], ranks: fn|null }
// Node kinds: 'act' (decision), 'chance' (local deal), 'split' (deal handled by helpers), 'fold', 'sd'.
function build(ctx, s) {
  const pot = ctx.cfg.pot0 + s.inv[0] + s.inv[1];
  if (s.end === 'fold') return { kind: 'fold', folder: s.folder, inv: s.inv, sInv: s.sInv, board: s.board, pot };
  if (s.end === 'street') {
    const allin = s.inv[0] >= ctx.cfg.stack || s.inv[1] >= ctx.cfg.stack;
    if (s.board.length === 5 || allin) {
      const node = { kind: 'sd', inv: s.inv, sInv: s.sInv, board: s.board, pot };
      if (ctx.ranks) node.rd = ctx.ranks(s.board);
      return node;
    }
    const dead = new Set(s.board);
    const cards = [];
    for (let c = 0; c < 52; c++) if (!dead.has(c)) cards.push(c);
    const next = { board: null, inv: s.inv, sInv: [0, 0], toAct: 0, bets: 0 };
    const node = { kind: ctx.split ? 'split' : 'chance', inv: s.inv, sInv: s.sInv, board: s.board, pot, cards,
      nDeal: 52 - s.board.length - 4, next };
    if (ctx.split) {
      node.k = ctx.splits.length;
      ctx.splits.push({ k: node.k, next, board: s.board, cards, nDeal: node.nDeal });
    } else {
      node.children = cards.map((c) => build(ctx, { ...next, board: [...s.board, c] }));
    }
    return node;
  }
  const actions = legalActions(ctx.cfg, s);
  const node = { kind: 'act', player: s.toAct, actions, inv: s.inv, sInv: s.sInv, board: s.board, pot,
    toCall: r2(Math.max(0, s.sInv[1 - s.toAct] - s.sInv[s.toAct])), off: ctx.off, children: null };
  ctx.off += actions.length * ctx.nH[s.toAct];
  ctx.nodes = (ctx.nodes || 0) + 1;
  node.children = actions.map((a) => build(ctx, applyAction(ctx.cfg, s, a)));
  return node;
}

function rootState(board) { return { board, inv: [0, 0], sInv: [0, 0], toAct: 0, bets: 0 }; }

// Subtree below split k for dealt card c.
function subState(split, c) { return { ...split.next, board: [...split.board, c] }; }

// Runouts for an all-in showdown before the river: list of { cards: [..], rd }.
function runouts(board, ranks) {
  const dead = new Set(board);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) rest.push(c);
  const out = [];
  if (board.length === 4) for (const c of rest) out.push({ a: c, b: -1, rd: ranks([...board, c]) });
  else for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++)
    out.push({ a: rest[i], b: rest[j], rd: ranks([...board, rest[i], rest[j]]) });
  const nd = 52 - board.length - 4;
  const weight = board.length === 4 ? 1 / nd : 2 / (nd * (nd - 1));
  return { list: out, weight };
}

function makeRankCache(Hs) {
  const cache = new Map();
  return (board5) => {
    const key = board5.slice().sort((a, b) => a - b).join(',');
    let rd = cache.get(key);
    if (!rd) { rd = rankData(board5, Hs); cache.set(key, rd); }
    return rd;
  };
}

// ---------------------------------------------------------------- vector CFR walk
// Values are chips won from the solve root: winner gets pot0 + loser's investment, loser loses own investment.
// cfv[h] = sum over opponent hands h' (compatible) of oppReach(h') * value(h vs h'). Chance factors are applied
// at chance nodes (1 / nDeal), so cfvs stored at a node do not include factors of chance nodes above it.
class Walker {
  constructor(Hs, pot0) {
    this.H = Hs; this.pot0 = pot0;
    this.maxH = Math.max(Hs[0].n, Hs[1].n, 1);
    this.pool = [];
    this.cc = new Float64Array(52);
    this.W = new Float64Array(this.maxH); this.L = new Float64Array(this.maxH); this.T = new Float64Array(this.maxH);
    this.tmp = new Float64Array(this.maxH);
    this.R = null; this.S = null; // current buffers
    this.mode = 'cfr'; this.p = 0; this.dPos = 1; this.dNeg = 0.5; this.dStrat = 0;
    this.splitOut = null; // coordinator: per split k, Float64Array cfv for traverser
  }

  level(d) {
    let L = this.pool[d];
    if (!L) {
      const m = this.maxH;
      L = this.pool[d] = { out: new Float64Array(m), rp: new Float64Array(m), ro: new Float64Array(m),
        sig: new Float64Array(m * 16), acfv: new Float64Array(m * 16) };
    }
    return L;
  }

  // Strategy at node into sig: from regrets (cfr) or from strategy sums (avg).
  strategy(node, sig, avg) {
    const q = node.player, nq = this.H[q].n, nA = node.actions.length, off = node.off;
    const B = avg ? this.S : this.R;
    for (let h = 0; h < nq; h++) {
      let s = 0;
      for (let a = 0; a < nA; a++) { const r = B[off + a * nq + h]; if (r > 0) s += r; }
      if (s > 0) for (let a = 0; a < nA; a++) { const r = B[off + a * nq + h]; sig[a * nq + h] = r > 0 ? r / s : 0; }
      else for (let a = 0; a < nA; a++) sig[a * nq + h] = 1 / nA;
    }
  }

  walk(node, d, rp, ro) {
    switch (node.kind) {
      case 'act': return this.act(node, d, rp, ro);
      case 'chance': return this.chance(node, d, rp, ro);
      case 'fold': return this.fold(node, d, ro);
      case 'sd': return this.showdownNode(node, d, ro);
      case 'split': { const L = this.level(d); L.out.set(this.splitOut[node.k]); return L.out; }
    }
    throw new Error('bad node');
  }

  act(node, d, rp, ro) {
    const p = this.p, q = node.player, nq = this.H[q].n, np = this.H[p].n, no = this.H[1 - p].n;
    const nA = node.actions.length, off = node.off;
    const L = this.level(d), out = L.out, sig = L.sig;
    const mode = this.mode;
    this.strategy(node, sig, mode !== 'cfr');
    if (q !== p) {
      out.fill(0, 0, np);
      const roc = L.ro;
      for (let a = 0; a < nA; a++) {
        let any = 0;
        for (let h = 0; h < no; h++) { const x = ro[h] * sig[a * nq + h]; roc[h] = x; any += x; }
        if (any <= 0) continue;
        const c = this.walk(node.children[a], d + 1, rp, roc);
        for (let h = 0; h < np; h++) out[h] += c[h];
      }
      return out;
    }
    const acfv = L.acfv, rpc = L.rp;
    for (let a = 0; a < nA; a++) {
      for (let h = 0; h < np; h++) rpc[h] = rp[h] * sig[a * np + h];
      const c = this.walk(node.children[a], d + 1, rpc, ro);
      acfv.set(c.subarray(0, np), a * np);
    }
    if (mode === 'br') {
      for (let h = 0; h < np; h++) {
        let m = acfv[h];
        for (let a = 1; a < nA; a++) if (acfv[a * np + h] > m) m = acfv[a * np + h];
        out[h] = m;
      }
      return out;
    }
    for (let h = 0; h < np; h++) {
      let v = 0;
      for (let a = 0; a < nA; a++) v += sig[a * np + h] * acfv[a * np + h];
      out[h] = v;
    }
    if (mode === 'cfr') {
      const R = this.R, S = this.S, dPos = this.dPos, dNeg = this.dNeg, dS = this.dStrat;
      for (let a = 0; a < nA; a++) {
        const base = off + a * np, sb = a * np;
        for (let h = 0; h < np; h++) {
          let r = R[base + h];
          r = r > 0 ? r * dPos : r * dNeg;
          R[base + h] = r + acfv[sb + h] - out[h];
          S[base + h] = S[base + h] * dS + rp[h] * sig[sb + h];
        }
      }
    } else if (mode === 'ev') {
      // Store EV in bb relative to folding now: cfv / (compatible opponent reach) + own investment so far.
      const Hp = this.H[p], Ho = this.H[1 - p], cc = this.cc;
      cc.fill(0);
      let tot = 0;
      for (let h = 0; h < no; h++) { const x = ro[h]; if (x) { tot += x; cc[Ho.c1[h]] += x; cc[Ho.c2[h]] += x; } }
      const inv = node.inv[p], R = this.R;
      for (let h = 0; h < np; h++) {
        const sm = Hp.same[h];
        const den = tot - cc[Hp.c1[h]] - cc[Hp.c2[h]] + (sm >= 0 ? ro[sm] : 0);
        for (let a = 0; a < nA; a++) R[off + a * np + h] = den > 1e-12 ? acfv[a * np + h] / den + inv : NaN;
      }
    }
    return out;
  }

  chance(node, d, rp, ro) {
    const p = this.p, np = this.H[p].n, no = this.H[1 - p].n;
    const Hp = this.H[p], Ho = this.H[1 - p];
    const L = this.level(d), out = L.out, rpc = L.rp, roc = L.ro;
    out.fill(0, 0, np);
    const cards = node.cards;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      roc.set(ro.subarray(0, no));
      const wo = Ho.withCard[c];
      for (let j = 0; j < wo.length; j++) roc[wo[j]] = 0;
      let any = 0;
      for (let h = 0; h < no; h++) any += roc[h];
      if (any <= 0) continue;
      rpc.set(rp.subarray(0, np));
      const wp = Hp.withCard[c];
      for (let j = 0; j < wp.length; j++) rpc[wp[j]] = 0;
      const v = this.walk(node.children[i], d + 1, rpc, roc);
      for (let h = 0; h < np; h++) out[h] += v[h];
      for (let j = 0; j < wp.length; j++) out[wp[j]] -= v[wp[j]];
    }
    const f = 1 / node.nDeal;
    for (let h = 0; h < np; h++) out[h] *= f;
    return out;
  }

  fold(node, d, ro) {
    const p = this.p, Hp = this.H[p], Ho = this.H[1 - p], np = Hp.n, no = Ho.n;
    const out = this.level(d).out, cc = this.cc;
    const u = node.folder === p ? -node.inv[p] : this.pot0 + node.inv[1 - p];
    cc.fill(0);
    let tot = 0;
    for (let h = 0; h < no; h++) { const x = ro[h]; if (x) { tot += x; cc[Ho.c1[h]] += x; cc[Ho.c2[h]] += x; } }
    for (let h = 0; h < np; h++) {
      const sm = Hp.same[h];
      out[h] = u * (tot - cc[Hp.c1[h]] - cc[Hp.c2[h]] + (sm >= 0 ? ro[sm] : 0));
    }
    return out;
  }

  showdownNode(node, d, ro) {
    const p = this.p, np = this.H[p].n;
    const out = this.level(d).out;
    const I = node.inv[0]; // both invested the same at showdown
    const win = this.pot0 + I, lose = -I, tie = this.pot0 / 2;
    if (node.board.length === 5) { this.sweep(node.rd, ro, out, win, lose, tie, -1, -1, 1, true); return out; }
    if (!node.ro) throw new Error('runout data missing');
    out.fill(0, 0, np);
    const list = node.ro.list, w = node.ro.weight;
    for (let i = 0; i < list.length; i++) this.sweep(list[i].rd, ro, out, win, lose, tie, list[i].a, list[i].b, w, false);
    return out;
  }

  // Showdown values on one 5-card board in O(n): adds wgt * value into out (or sets it when reset).
  // Two-pointer merge of the hero's and the opponent's strength-sorted lists, with per-card sums for card removal.
  // b1, b2: extra dealt cards (all-in runout); hands that hold them are skipped.
  sweep(rd, ro, out, win, lose, tie, b1, b2, wgt, reset) {
    const p = this.p, Hp = this.H[p], Ho = this.H[1 - p], np = Hp.n;
    const hi = rd.idx[p], hr = rd.rk[p], oi = rd.idx[1 - p], or = rd.rk[1 - p];
    const nh = hi.length, no = oi.length;
    const W = this.W, Lw = this.L, cc = this.cc, ce = this.ce || (this.ce = new Float64Array(52));
    const pc1 = Hp.c1, pc2 = Hp.c2, oc1 = Ho.c1, oc2 = Ho.c2, same = Hp.same;
    if (reset) out.fill(0, 0, np);
    const chk = b1 >= 0;
    cc.fill(0); ce.fill(0);
    let lo = 0, le = 0, jl = 0, je = 0;
    for (let k = 0; k < nh; k++) {
      const r = hr[k];
      while (jl < no && or[jl] < r) {
        const h = oi[jl++], x = ro[h];
        if (x === 0) continue;
        const a = oc1[h], b = oc2[h];
        if (chk && (a === b1 || b === b1 || a === b2 || b === b2)) continue;
        lo += x; cc[a] += x; cc[b] += x;
      }
      while (je < no && or[je] <= r) {
        const h = oi[je++], x = ro[h];
        if (x === 0) continue;
        const a = oc1[h], b = oc2[h];
        if (chk && (a === b1 || b === b1 || a === b2 || b === b2)) continue;
        le += x; ce[a] += x; ce[b] += x;
      }
      const h = hi[k], a = pc1[h], b = pc2[h];
      W[h] = lo - cc[a] - cc[b];
      Lw[h] = le - ce[a] - ce[b]; // weaker or equal (same combo has equal rank: add it back below)
    }
    // totals
    let tot = le;
    for (let j = je; j < no; j++) {
      const h = oi[j], x = ro[h];
      if (x === 0) continue;
      const a = oc1[h], b = oc2[h];
      if (chk && (a === b1 || b === b1 || a === b2 || b === b2)) continue;
      tot += x; ce[a] += x; ce[b] += x;
    }
    for (let k = 0; k < nh; k++) {
      const h = hi[k], a = pc1[h], b = pc2[h];
      if (chk && (a === b1 || b === b1 || a === b2 || b === b2)) continue;
      const sm = same[h];
      let s = 0;
      if (sm >= 0) { const x = oc1[sm], y = oc2[sm]; if (!(chk && (x === b1 || y === b1 || x === b2 || y === b2))) s = ro[sm]; }
      const T = tot - ce[a] - ce[b] + s;          // compatible opponent reach
      const w = W[h], le2 = Lw[h] + s;             // weaker; weaker or equal
      out[h] += wgt * (win * w + lose * (T - le2) + tie * (le2 - w));
    }
  }
}

// Attach runout data to all-in showdown nodes before the river (walks a built tree).
function attachRunouts(node, ranks) {
  if (node.kind === 'sd' && node.board.length < 5) node.ro = runouts(node.board, ranks);
  if (node.children) for (const c of node.children) attachRunouts(c, ranks);
}

// Normalize strategy sums in place into average strategies (per node, per hand).
function normalize(node, S, Hs) {
  if (node.kind === 'act') {
    const nq = Hs[node.player].n, nA = node.actions.length, off = node.off;
    for (let h = 0; h < nq; h++) {
      let s = 0;
      for (let a = 0; a < nA; a++) s += S[off + a * nq + h];
      for (let a = 0; a < nA; a++) S[off + a * nq + h] = s > 0 ? S[off + a * nq + h] / s : 1 / nA;
    }
  }
  if (node.children) for (const c of node.children) normalize(c, S, Hs);
}

// Builds hands and config from normalized params (same result in every thread).
function setup(P) {
  const board = parseBoard(P.board);
  const w0 = parseRange(P.ranges[P.oop]), w1 = parseRange(P.ranges[P.ip]);
  const H0 = makeHands(w0, board), H1 = makeHands(w1, board);
  if (!H0.n || !H1.n) throw new Error('empty range after board card removal');
  linkHands(H0, H1);
  return { board, Hs: [H0, H1], cfg: makeConfig(P) };
}

module.exports = {
  STREET, COMBO_A, COMBO_B, COMBO_IDX, parseRange, parseBoard, parseSizes, makeHands, linkHands, rankData,
  makeConfig, legalActions, applyAction, build, rootState, subState, runouts, makeRankCache, attachRunouts,
  normalize, setup, Walker, cardName, r2,
};
