'use strict';
// Run: node lib/handclass.test.js   (exit code 1 on failure).
const H = require('./handclass');
const { eval7 } = require('./equity');

let failed = 0;
function check(name, ok, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
  if (!ok) failed++;
}
let seed = 7;
const rnd = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
function deal(n) {
  const out = [];
  while (out.length < n) { const c = rnd(52); if (!out.includes(c)) out.push(c); }
  return out;
}
const board = (s) => s.match(/../g).map(H.parseCard);
// Combo count per made class and per draw for every combo that does not touch the board.
function counts(b) {
  const made = {}, dr = {};
  for (let a = 0; a < 52; a++) for (let c = a + 1; c < 52; c++) {
    if (b.includes(a) || b.includes(c)) continue;
    const k = H.classify([a, c], b);
    made[k.made] = (made[k.made] || 0) + 1;
    for (const d of k.draws) dr[d] = (dr[d] || 0) + 1;
  }
  return { made, dr };
}

// 1. The evaluator gives the same score as eval7 (lib/equity.js).
{
  let same = 0;
  const N = 50000;
  for (let i = 0; i < N; i++) { const c = deal(7); if (H.score(c) === eval7(c)) same++; }
  check('score() equals eval7 on random 7-card hands', same === N, `${same}/${N}`);
}

// 2. Known boards.
{
  const k = counts(board('9c8d2s'));
  check('9c8d2s: sets = 9', k.made.set === 9, String(k.made.set));
  check('9c8d2s: two pair = 27 (98, 92, 82)', k.made['two pair'] === 27, String(k.made['two pair']));
  check('9c8d2s: overpairs = 30 (TT-AA)', k.made.overpair === 30, String(k.made.overpair));
  check('9c8d2s: open-ended = 48 (JT, T7, 76)', k.dr['open-ended'] === 48, String(k.dr['open-ended']));
  check('9c8d2s: gutshots = 96 (QJ, QT, J7, T6, 75, 65)', k.dr.gutshot === 96, String(k.dr.gutshot));
  check('9c8d2s: no flush draws on a rainbow flop', !k.dr['flush draw'], String(k.dr['flush draw'] || 0));
  check('9c8d2s: straights = 0', !k.made.straight, String(k.made.straight || 0));
  // Top pair: one 9 (3 left) with any card that is not 9, 8, 2 (40 cards) = 120.
  check('9c8d2s: top pair = 120', k.made['top pair'] === 120, String(k.made['top pair']));
  const total = Object.values(k.made).reduce((s, x) => s + x, 0);
  check('9c8d2s: every combo has one made class (1176)', total === 1176, String(total));
}
{
  const k = counts(board('Kh9h4c'));
  check('Kh9h4c: flush draws = 55 (two of the 11 hearts left)', k.dr['flush draw'] === 55, String(k.dr['flush draw']));
  // Backdoor flush draws: two clubs (C(12,2) = 66) or one heart with a card that is not a heart (11 * 38 = 418).
  check('Kh9h4c: backdoor flush draws = 484', k.dr['backdoor flush draw'] === 484, String(k.dr['backdoor flush draw']));
  check('Kh9h4c: sets = 9', k.made.set === 9, String(k.made.set));
}
{
  // Turn with a flush on board side: 4 spades, a single spade in hand makes a flush.
  const b = board('As7s4s2s');
  const k = counts(b);
  // Spades left: 9. Combos with at least one spade: 9*39 + C(9,2) = 351 + 36 = 387; 5s3s / 5s6s / 3s6s... are flushes
  // too (the straight flush 5s3s needs A2345 of spades: As 2s 4s + 3s 5s = straight flush).
  const flushes = (k.made.flush || 0) + (k.made['straight flush'] || 0);
  check('As7s4s2s: flush or straight flush = 387 combos with a spade', flushes === 387, String(flushes));
  check('As7s4s2s: straight flush = 1 (5s3s)', k.made['straight flush'] === 1, String(k.made['straight flush']));
}
{
  // River where the board plays: a straight on board, AdKd and 2c3c have no better hand.
  const b = board('9c8d7h6sTc');
  check('board straight plays: 2c3d = nothing', H.classify('3d2c', b).made === 'nothing');
  check('board straight plays: AdKh = ace high', H.classify('AdKh', b).made === 'ace high');
  check('board straight improved: Js4d = straight', H.classify('Js4d', b).made === 'straight');
  check('river: no draws', H.classify('Js4d', b).draws.length === 0);
  check('paired board: 7h7d on Kc7s2d = set', H.classify('7h7d', board('Kc7s2d')).made === 'set');
  check('paired board: Ah7d on 7c7s2d = trips', H.classify('Ah7d', board('7c7s2d')).made === 'trips');
  check('paired board: AhKd on 7c7s2d = ace high', H.classify('AhKd', board('7c7s2d')).made === 'ace high');
  check('paired board: 9h9d on 7c7s2d = overpair', H.classify('9h9d', board('7c7s2d')).made === 'overpair');
  check('9h9d on Kc7s2d = middle pair', H.classify('9h9d', board('Kc7s2d')).made === 'middle pair');
  check('5h5d on Kc7s2d = weak pair', H.classify('5h5d', board('Kc7s2d')).made === 'weak pair');
  check('Qh7d on Kc7s2d = middle pair', H.classify('Qh7d', board('Kc7s2d')).made === 'middle pair');
  check('Qh2d on Kc7s2d = weak pair', H.classify('Qh2d', board('Kc7s2d')).made === 'weak pair');
  check('7h7d on 7c7s2d = quads', H.classify('7h7d', board('7c7s2d')).made === 'quads');
  check('2h2d on 7c7s2d = full house', H.classify('2h2d', board('7c7s2d')).made === 'full house');
}

// 3. Made class agrees with the eval7 category (5 to 7 cards seen from the hole cards).
{
  const allowed = {
    'straight flush': [8], quads: [7], 'full house': [6], flush: [5], straight: [4], set: [3], trips: [3], 'two pair': [2],
    overpair: [1, 2], 'top pair': [1, 2], 'middle pair': [1, 2], 'weak pair': [1, 2], 'ace high': [0, 1, 2, 3, 4, 5, 6, 7, 8], nothing: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  };
  let bad = 0, n = 0;
  for (let i = 0; i < 20000; i++) {
    const c = deal(7), h = c.slice(0, 2), b = c.slice(2);
    const made = H.madeClass(h, b), cat = eval7(c) >> 20;
    // When the board plays (its own five cards are the best hand), the hole cards are classed without it.
    if (H.score(b) === eval7(c)) continue;
    n++;
    // 'ace high' and 'nothing' may have a board-only hand (pair, trips, two pair on board, or the board plays).
    if (!allowed[made].includes(cat)) bad++;
    else if (made !== 'ace high' && made !== 'nothing' && cat >= 4 && MADE_CAT(made) !== cat) bad++;
  }
  function MADE_CAT(m) { return 8 - H.MADE.indexOf(m); }
  check('made class agrees with eval7 category on random rivers', bad === 0, `${bad} bad of ${n}`);
}

// 4. Range vs range equity: exact on the river and turn, agrees with brute force, and both players add to 100%.
function brute(b, A, B) {
  // Exact equity of each combo in A vs B over all runouts.
  const used = new Set(b), free = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) free.push(c);
  const need = 5 - b.length, runs = [];
  if (need === 0) runs.push([]);
  else if (need === 1) for (const c of free) runs.push([c]);
  else for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) runs.push([free[i], free[j]]);
  return A.map(([a1, a2]) => {
    let num = 0, den = 0;
    for (const ro of runs) {
      if (ro.includes(a1) || ro.includes(a2)) continue;
      const bb = b.concat(ro), sa = eval7([a1, a2, ...bb]);
      for (const [v1, v2, w] of B) {
        if ([a1, a2, ...ro].includes(v1) || [a1, a2, ...ro].includes(v2)) continue;
        const sv = eval7([v1, v2, ...bb]);
        num += w * (sa > sv ? 1 : sa === sv ? 0.5 : 0); den += w;
      }
    }
    return den ? num / den : NaN;
  });
}
function randomRange(b, n) {
  const out = [], seen = new Set();
  while (out.length < n) {
    const a = rnd(52), c = rnd(52);
    if (a === c || b.includes(a) || b.includes(c)) continue;
    const k = Math.min(a, c) * 52 + Math.max(a, c);
    if (seen.has(k)) continue;
    seen.add(k); out.push([Math.max(a, c), Math.min(a, c), 0.1 + (rnd(90) / 100)]);
  }
  return out;
}
// Weighted average equity of player p, weighted by weight x live opponent weight (so the two add to exactly 1).
function avgEq(b, R, eq, p) {
  let num = 0, den = 0;
  R[p].forEach(([a, c, w], k) => {
    let ow = 0;
    for (const [x, y, v] of R[1 - p]) if (x !== a && x !== c && y !== a && y !== c) ow += v;
    if (!Number.isNaN(eq[p][k])) { num += w * ow * eq[p][k]; den += w * ow; }
  });
  return num / den;
}
for (const [name, bs, nA, nB] of [['river', 'Kh9h4c7d2s', 60, 70], ['turn', 'Jd8s7c2h', 25, 30]]) {
  const b = board(bs), A = randomRange(b, nA), B = randomRange(b, nB);
  const t0 = Date.now();
  const r = H.rangeEquity(b, [A, B]);
  const ms = Date.now() - t0;
  const ref = brute(b, A, B);
  let maxErr = 0;
  ref.forEach((x, k) => { if (!Number.isNaN(x)) maxErr = Math.max(maxErr, Math.abs(x - r.eq[0][k])); });
  check(`${name}: equity equals brute force`, maxErr < 1e-9, `max error ${maxErr.toExponential(2)}, ${r.runouts} runouts, ${ms} ms`);
  const s = avgEq(b, [A, B], r.eq, 0) + avgEq(b, [A, B], r.eq, 1);
  check(`${name}: average equities add to 100%`, Math.abs(s - 1) < 1e-9, (100 * s).toFixed(6) + '%');
}
{
  // Flop, full ranges (about 1000 combos each): time for all runouts and for 300 samples.
  const b = board('Jd8s7c');
  const full = [];
  for (let a = 0; a < 52; a++) for (let c = 0; c < a; c++) if (!b.includes(a) && !b.includes(c)) full.push([a, c, 1]);
  let t0 = Date.now();
  const all = H.rangeEquity(b, [full, full]);
  const msAll = Date.now() - t0;
  const s = avgEq(b, [full, full], all.eq, 0);
  check('flop, full vs full range: average equity 50%', Math.abs(s - 0.5) < 1e-9, `${(100 * s).toFixed(4)}%, ${all.runouts} runouts, ${msAll} ms`);
  t0 = Date.now();
  const smp = H.rangeEquity(b, [full, full], { samples: 300 });
  const msS = Date.now() - t0;
  let maxErr = 0;
  smp.eq[0].forEach((x, k) => { if (!Number.isNaN(x)) maxErr = Math.max(maxErr, Math.abs(x - all.eq[0][k])); });
  check('flop, 300 sampled runouts: per-combo error below 6%', maxErr < 0.06, `max error ${(100 * maxErr).toFixed(2)}%, ${msS} ms`);
}

// 5. Preflop hand groups.
{
  const g = { AA: 'pairs', AKs: 'suited aces', A2s: 'suited aces', KQs: 'suited broadways', AKo: 'offsuit broadways', KTo: 'offsuit broadways',
    '98s': 'suited connectors/gappers', '64s': 'suited connectors/gappers', '93s': 'other suited', K2s: 'other suited', '72o': 'other offsuit', A5o: 'other offsuit', J9s: 'suited connectors/gappers' };
  const bad = Object.entries(g).filter(([c, x]) => H.handGroup(c) !== x);
  check('hand groups', !bad.length, bad.map(([c]) => `${c}=${H.handGroup(c)}`).join(' '));
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
