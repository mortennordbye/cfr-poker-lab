'use strict';
// Game tree for 6-max preflop. See README.md for the rules and the simplifications.
// Seats in preflop order: 0 UTG, 1 HJ, 2 CO, 3 BTN, 4 SB, 5 BB.
const POS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
// Postflop order: SB acts first, BTN last. Higher = more in position.
const POST = [2, 3, 4, 5, 0, 1];

const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => String(r2(x));

function normalizeParams(raw = {}) {
  const num = (v, lo, hi, def) => {
    const n = v === null || v === undefined || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const bool = (v, def) => (v === undefined || v === null || v === '' ? def : v === true || v === 'true' || v === 1 || v === '1');
  const ante = num(raw.ante, 0, 3, 0);
  const mtt = ante > 0;
  const P = {
    stack: num(raw.stack, 10, 300, 100),
    ante,
    open: num(raw.open, 0, 10, 0),
    sbOpen: num(raw.sbOpen, 0, 10, 0),
    threeBetIP: num(raw.threeBetIP, 0, 10, 0),
    threeBetOOP: num(raw.threeBetOOP, 0, 10, 0),
    squeezeAdd: num(raw.squeezeAdd, 0, 3, 1),
    fourBet: num(raw.fourBet, 0, 5, 0),
    coldCalls: bool(raw.coldCalls, true),
    sbLimp: bool(raw.sbLimp, false),
    maxPlayers: Math.round(num(raw.maxPlayers, 2, 3, 3)),
    rIp: num(raw.rIp, 0.5, 1.5, 1.0),
    rOop: num(raw.rOop, 0.5, 1.5, 0.88),
    iterations: Math.round(num(raw.iterations, 10, 20000, 1000)),
    maxSeconds: num(raw.maxSeconds, 5, 1800, 240),
  };
  // 0 = auto: cash-like sizes without ante, MTT-like sizes with a BB ante.
  if (!P.open) P.open = mtt ? 2.1 : 2.5;
  if (!P.sbOpen) P.sbOpen = mtt ? 2.5 : 3.0;
  if (!P.threeBetIP) P.threeBetIP = mtt ? 4.0 : 3.0;
  if (!P.threeBetOOP) P.threeBetOOP = mtt ? 5.0 : 4.0;
  if (!P.fourBet) P.fourBet = 2.5;
  return P;
}

// Build the tree. Returns { nodes } where each node is a plain object; children by index.
function buildTree(P) {
  const S = P.stack;
  const cap = S - P.ante; // all-in amount for every player (no side pots, see README)
  const nodes = [];

  function makeRoot() {
    const bet = [0, 0, 0, 0, 0.5, 1];
    const s = {
      bet, ante: [0, 0, 0, 0, 0, P.ante], folded: [false, false, false, false, false, false],
      acted: [false, false, false, false, false, false],
      cur: 1, level: 0, openTo: 0, lastRaiser: -1, raiseTo: [], callers: 0, vol: [false, false, false, false, false, false],
      toAct: 0,
    };
    return s;
  }
  const clone = (s) => ({ ...s, bet: s.bet.slice(), ante: s.ante, folded: s.folded.slice(), acted: s.acted.slice(), vol: s.vol.slice(), raiseTo: s.raiseTo.slice() });
  const inv = (s, p) => s.bet[p] + s.ante[p];
  const pot = (s) => { let t = 0; for (let p = 0; p < 6; p++) t += inv(s, p); return t; };
  const isAllin = (s, p) => s.bet[p] >= cap - 1e-9;
  const active = (s) => [0, 1, 2, 3, 4, 5].filter((p) => !s.folded[p]);

  // Next player to act after p, or -1 if the betting round is closed.
  function nextToAct(s, p) {
    for (let k = 1; k <= 6; k++) {
      const q = (p + k) % 6;
      if (s.folded[q] || isAllin(s, q)) continue;
      if (!s.acted[q] || s.bet[q] < s.cur - 1e-9) return q;
    }
    return -1;
  }

  function matched(s) { let n = 0; for (let p = 0; p < 6; p++) if (!s.folded[p] && s.bet[p] >= s.cur - 1e-9) n++; return n; }

  function raiseSize(s, p) {
    // Size of a normal (non all-in) raise for p, or 0 if none.
    if (s.level === 0) {
      if (s.cur > 1 + 1e-9) return 0;
      if (p === 4) return P.sbOpen;
      if (p === 5) return 3.5; // BB raise vs SB limp
      return P.open;
    }
    if (s.level === 1) {
      const ip = POST[p] > POST[s.lastRaiser];
      const m = ip ? P.threeBetIP : P.threeBetOOP;
      return s.cur * m + s.callers * s.cur * P.squeezeAdd;
    }
    if (s.level === 2) return s.cur * P.fourBet;
    return 0; // 5-bet: all-in only
  }

  function add(s, id, label, history, terminal) {
    const idx = nodes.length;
    const node = { idx, id, s, history, terminal, actions: [], children: [], toAct: -1 };
    nodes.push(node);
    return node;
  }

  function finishOrNext(s, p) {
    // After p acted: terminal or next decision.
    const act = active(s);
    if (act.length === 1) return { type: 'fold', winner: act[0] };
    const q = nextToAct(s, p);
    if (q >= 0) return null;
    const live = act.filter((x) => !isAllin(s, x));
    if (live.length <= 1 && act.some((x) => isAllin(s, x))) return { type: 'showdown' };
    return { type: 'flop' };
  }

  function options(s, p) {
    const toCall = r2(s.cur - s.bet[p]);
    const acts = [];
    if (toCall > 1e-9) acts.push({ type: 'fold', label: 'Fold', code: 'F', amount: 0 });
    else acts.push({ type: 'check', label: 'Check', code: 'X', amount: 0 });
    if (toCall > 1e-9) {
      let ok = true;
      if (s.cur >= cap - 1e-9) {
        // facing all-in: call allowed if the player cap allows it
        ok = matched(s) + 1 <= P.maxPlayers;
      } else if (s.level === 0) {
        ok = p === 4 && P.sbLimp; // only SB may limp
      } else {
        const capN = s.level === 1 ? P.maxPlayers : 2;
        ok = matched(s) + 1 <= capN;
        const cold = !s.vol[p] && !(p === 5 && s.level === 1);
        if (cold && !P.coldCalls) ok = false;
      }
      if (ok) acts.push({ type: 'call', label: s.level === 0 ? 'Limp' : 'Call', code: 'C', amount: r2(s.cur) });
    }
    if (s.cur < cap - 1e-9) {
      const rs = raiseSize(s, p);
      if (rs > s.cur + 1e-9 && rs < 0.6 * cap) {
        acts.push({ type: 'raise', label: 'Raise ' + fmt(rs), code: 'R' + fmt(rs), amount: r2(rs) });
      }
      acts.push({ type: 'allin', label: 'Allin ' + fmt(cap), code: 'A', amount: r2(cap) });
    }
    return acts;
  }

  function expand(node) {
    const s = node.s;
    if (node.terminal) return;
    const p = s.toAct;
    node.toAct = p;
    const acts = options(s, p);
    for (const a of acts) {
      const c = clone(s);
      c.acted[p] = true;
      if (a.type === 'fold') c.folded[p] = true;
      else if (a.type === 'call') { c.bet[p] = Math.min(c.cur, cap); c.vol[p] = true; if (c.level >= 1) c.callers++; }
      else if (a.type === 'raise' || a.type === 'allin') {
        c.bet[p] = a.amount; c.cur = a.amount; c.vol[p] = true;
        c.level = c.level + 1; c.lastRaiser = p; c.callers = 0;
        for (let q = 0; q < 6; q++) if (q !== p) c.acted[q] = false;
      }
      const term = finishOrNext(c, p);
      const id = (node.id === 'root' ? '' : node.id + '-') + a.code;
      const hist = node.history.concat([{ pos: POS[p], street: 'preflop', label: a.label, nodeId: node.id, seat: p }]);
      if (!term) c.toAct = nextToAct(c, p);
      const child = add(c, id, a.label, hist, term);
      node.actions.push(a);
      node.children.push(child.idx);
    }
  }

  const root = add(makeRoot(), 'root', '', [], null);
  for (let i = 0; i < nodes.length; i++) expand(nodes[i]);

  // Precompute per node: pot, inv[6], active list, and for terminals the realization factors.
  for (const n of nodes) {
    const s = n.s;
    n.pot = r2(pot(s));
    n.inv = [0, 1, 2, 3, 4, 5].map((p) => r2(inv(s, p)));
    n.active = active(s);
    n.folded = s.folded.slice();
    n.toCall = n.toAct >= 0 ? r2(s.cur - s.bet[n.toAct]) : 0;
    // Only option is Fold (player cap reached): the solver keeps the node, the UI skips it.
    n.forced = !n.terminal && n.actions.length === 1;
    if (n.terminal && n.terminal.type !== 'fold') {
      const order = n.active.slice().sort((a, b) => POST[a] - POST[b]);
      const last = order[order.length - 1];
      n.R = n.active.map((p) => (n.terminal.type === 'showdown' ? 1 : p === last ? P.rIp : P.rOop));
      n.order = order;
    }
  }
  return { nodes, root: root.idx, cap };
}

module.exports = { POS, POST, normalizeParams, buildTree };

if (require.main === module) {
  const P = normalizeParams(JSON.parse(process.argv[2] || '{}'));
  const t0 = Date.now();
  const { nodes } = buildTree(P);
  const c = { fold: 0, flop: 0, showdown: 0, dec: 0, flop3: 0, sd3: 0 };
  let edges = 0;
  for (const n of nodes) {
    if (!n.terminal) { c.dec++; edges += n.children.length; continue; }
    c[n.terminal.type]++;
    if (n.active.length === 3) c[n.terminal.type === 'flop' ? 'flop3' : 'sd3']++;
  }
  console.log(P, nodes.length, 'nodes', edges, 'edges', c, Date.now() - t0, 'ms');
  const want = process.argv[3];
  if (want) { const n = nodes.find((x) => x.id === want); console.log(n && n.actions.map((a) => a.label), n && n.history.map((h) => h.pos + ' ' + h.label)); }
}
