'use strict';
// Sanity checks for the hu-preflop engine. Run: node engines/hu-preflop/test.js
const { loadEquity, COMBOS } = require('../../lib/equity');
const solver = require('./solver');
const engine = require('./index');
const pushfold = require('../pushfold/solver');

let fails = 0;
function check(name, ok, info = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); if (!ok) fails++; }
const combos = (h) => (h.length === 2 ? 6 : h[2] === 's' ? 4 : 12);
// % of all 1326 combos that take each action (weighted by reach).
function actionPct(node) {
  return node.actions.map((_, k) => (100 * Object.entries(node.hands).reduce((s, [h, v]) => s + v.weight * v.strategy[k] * combos(h), 0)) / 1326);
}
function rangePct(node) { return (100 * Object.entries(node.hands).reduce((s, [h, v]) => s + v.weight * combos(h), 0)) / 1326; }

(async () => {
  const { E, W } = await loadEquity();

  // 1) 10bb push/fold must match the old push/fold solver.
  const pf = pushfold.solve(E, W, { stack: 10, ante: 0, iterations: 3000 });
  const hu = solver.solve(E, W, { stack: 10, sbOpen: '', limp: false, iterations: 3000 });
  const root = hu.nodes.n0, bbNode = hu.nodes[root.actions[1].child];
  const push = actionPct(root)[1], pfPush = (100 * pf.sb.actions.push) / 1326;
  const call = (100 * Object.entries(bbNode.hands).reduce((s, [h, v]) => s + v.strategy[1] * combos(h), 0)) / 1326;
  const pfCall = (100 * pf.bb.actions.call) / 1326;
  check('10bb tree is fold/allin only', root.actions.map((a) => a.type).join() === 'fold,allin');
  check('10bb SB push % matches push/fold', Math.abs(push - pfPush) < 0.5 && Math.abs(push - 58.3) < 1, `hu ${push.toFixed(2)}%  pushfold ${pfPush.toFixed(2)}%`);
  check('10bb BB call % matches push/fold', Math.abs(call - pfCall) < 0.5 && Math.abs(call - 37.4) < 1, `hu ${call.toFixed(2)}%  pushfold ${pfCall.toFixed(2)}%`);

  // 2) 100bb default through the engine interface (worker thread + cache).
  try { require('fs').unlinkSync(engine.cacheFile({ stack: 100 })); } catch (e) { /* not cached yet */ }
  const t0 = Date.now();
  let lastProg = 0;
  const res = await engine.solve({ stack: 100 }, (p) => { lastProg = p; });
  const ms = Date.now() - t0;
  console.log(`100bb solve: ${ms} ms, stats ${JSON.stringify(res.stats)}`);
  check('100bb solve time < 20 s', ms < 20000, `${ms} ms`);
  check('progress reached 1', lastProg >= 0.95);
  check('exploitability < 0.5% pot', res.stats.exploitabilityPctPot < 0.5, `${res.stats.exploitabilityPctPot.toFixed(4)}% pot`);

  // Walk the tree: strategies sum to 1, ids resolve, history nodeIds resolve.
  let bad = 0, count = 0;
  const seen = new Set();
  (function walk(id) {
    if (seen.has(id)) return; seen.add(id);
    const n = res.getNode(id); count++;
    if (!n) { bad++; return; }
    for (const h of n.history) if (!res.getNode(h.nodeId)) bad++;
    for (const v of Object.values(n.hands)) {
      const s = v.strategy.reduce((a, b) => a + b, 0);
      if (Math.abs(s - 1) > 1e-3 || v.strategy.length !== n.actions.length || v.ev.length !== n.actions.length) bad++;
    }
    if (n.terminal && n.terminal.type === 'flop' && !n.terminal.flop) bad++;
    n.actions.forEach((a) => walk(a.child));
  })(res.root);
  check('all strategies sum to 1, ids resolve', bad === 0, `${count} nodes, ${bad} problems`);

  const r = res.getNode(res.root);
  const pct = actionPct(r);
  const nonFold = 100 - pct[0];
  console.log('SB root:', r.actions.map((a, k) => `${a.label} ${pct[k].toFixed(1)}%`).join(', '));
  check('100bb SB plays 70-90% of hands', nonFold >= 70 && nonFold <= 92, `${nonFold.toFixed(1)}%`);
  const limpIdx = r.actions.findIndex((a) => a.label === 'Limp');
  const vsLimp = res.getNode(r.actions[limpIdx].child);
  const vl = actionPct(vsLimp).map((x) => (100 * x) / rangePct(vsLimp));
  console.log('BB vs limp:', vsLimp.actions.map((a, k) => `${a.label} ${vl[k].toFixed(1)}%`).join(', '));
  check('BB never folds vs limp (check is free)', vsLimp.actions[0].type === 'check');
  const openIdx = r.actions.findIndex((a) => a.type === 'raise');
  const vsOpen = res.getNode(r.actions[openIdx].child);
  const vo = actionPct(vsOpen).map((x) => (100 * x) / rangePct(vsOpen));
  console.log('BB vs open:', vsOpen.actions.map((a, k) => `${a.label} ${vo[k].toFixed(1)}%`).join(', '));
  check('BB defends most hands vs 2.5x open', vo[0] < 50, `fold ${vo[0].toFixed(1)}%`);
  const aa = r.hands.AA, s72 = r.hands['72o'];
  check('AA EV > 0 and 72o folds more than AA', aa.ev.slice(1).some((x) => x > 0) && s72.strategy[0] >= aa.strategy[0]);

  // 3) Second call hits the cache.
  const t1 = Date.now();
  const res2 = await engine.solve({ stack: 100 });
  check('second solve comes from cache', res2.stats.cached === true, `${Date.now() - t1} ms`);

  // Calibrated realization: a table with R = 1 for both players must give the same result as flat R 1 / 1,
  // and a table that favors premium hands must make AA's EV go up.
  {
    const spot = { stack: 100, sbOpen: '2.25', limp: true, iterations: 600 };
    const flat = solver.solve(E, W, { ...spot, realization: 'flat', rIp: 1, rOop: 1 });
    const keys = Object.values(flat.nodes).filter((n) => n.terminal && n.terminal.type === 'flop').map((n) => n.terminal.key);
    const ones = Array(169).fill(1);
    const t1 = { info: 'test', terminals: Object.fromEntries(keys.map((k) => [k, { SB: ones, BB: ones }])) };
    const cal = solver.solve(E, W, { ...spot, realization: 'calibrated' }, null, t1);
    const d = Math.abs(cal.nodes.n0.hands.AA.ev[2] - flat.nodes.n0.hands.AA.ev[2]);
    check('calibrated table with R=1 equals flat R=1', d < 0.02 && /calibrated/.test(cal.stats.realization), `AA raise EV diff ${d.toFixed(4)}, ${cal.stats.realization}`);
    let bad = 0;
    for (const n of Object.values(cal.nodes)) for (const h of Object.values(n.hands)) { const s = h.strategy.reduce((a, b) => a + b, 0); if (Math.abs(s - 1) > 1e-3) bad++; }
    check('calibrated: strategies sum to 1', bad === 0, `${bad} bad`);
    const prem = ones.slice(); prem[0] = 1.8; // AA
    const t2 = { info: 'test', terminals: Object.fromEntries(keys.map((k) => [k, { SB: prem, BB: ones }])) };
    const up = solver.solve(E, W, { ...spot, realization: 'calibrated' }, null, t2);
    const ev = (sol) => { const h = sol.nodes.n0.hands.AA; return h.strategy.reduce((s, f, i) => s + f * (h.ev[i] || 0), 0); };
    check('calibrated: higher R for AA raises AA EV', ev(up) > ev(cal) + 0.2, `${ev(cal).toFixed(2)} -> ${ev(up).toFixed(2)}`);
  }

  // lib/realization.js on synthetic samples (temp dir, so the real cache is not touched).
  {
    const fs = require('fs'), os = require('os'), path = require('path');
    const RZ = require('../../lib/realization');
    const { COMBOS: CB, className, comboName } = require('../../lib/equity');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-test-'));
    const o = { dir, rIp: 1.0, rOop: 0.88 };
    const ci = (h) => { for (let i = 0; i < 169; i++) if (className(i) === h) return i; return -1; };
    const ranges = { SB: { AA: 1, KQs: 1, '72o': 1 }, BB: { QQ: 1, JTs: 1, '83o': 1 } };
    // A sample where every combo of pos has equity 0.5 and EV = pot * 0.5 * R[pos] (R may depend on the class).
    const mk = (key, board, R, createdAt, extra = {}) => {
      const ev = { SB: {}, BB: {} }, eq = { SB: {}, BB: {} };
      for (const pos of ['SB', 'BB']) for (const h of Object.keys(ranges[pos])) for (const [a, b] of CB[ci(h)]) {
        const r = typeof R[pos] === 'object' ? R[pos][h] : R[pos];
        ev[pos][comboName(a, b)] = 10 * 0.5 * r; eq[pos][comboName(a, b)] = 0.5;
      }
      return { terminalKey: key, board, pot: 10, rangesHash: RZ.rangesHash(ranges), ranges, createdAt, ev, eq, ...extra };
    };
    const spot = 'testspot';
    const now = Date.parse('2026-11-25T12:00:00Z'), iso = (d) => new Date(now - d * 864e5).toISOString();

    check('realization: 0 samples gives no table', RZ.buildTable(spot, o) === null);
    {
      const spotT = { stack: 100, sbOpen: '2.25', limp: true, iterations: 400 };
      const flat = solver.solve(E, W, { ...spotT, realization: 'flat' });
      const keys = Object.values(flat.nodes).filter((n) => n.terminal && n.terminal.type === 'flop').map((n) => n.terminal.key);
      const zero = { info: 'zero', terminals: Object.fromEntries(keys.map((k) => [k, RZ.terminalR([], o)])) };
      const cal0 = solver.solve(E, W, { ...spotT, realization: 'calibrated' }, null, null);
      const calZ = solver.solve(E, W, { ...spotT, realization: 'calibrated' }, null, zero);
      const d0 = Math.abs(cal0.nodes.n0.hands.AA.ev[2] - flat.nodes.n0.hands.AA.ev[2]);
      const dZ = Math.abs(calZ.nodes.n0.hands.AA.ev[2] - flat.nodes.n0.hands.AA.ev[2]);
      check('realization: 0 samples = flat R result', d0 === 0 && dZ < 1e-9, `no table diff ${d0}, empty terminals diff ${dZ}`);
      const t = flat.nodes[Object.keys(flat.nodes).find((id) => flat.nodes[id].terminal && flat.nodes[id].terminal.type === 'flop')].terminal;
      check('flop terminal has name, spotKey, mass', !!t.name && t.spotKey === solver.spotKey(spotT) && t.mass > 0, `${t.name}, mass ${t.mass}`);
      const names = Object.values(flat.nodes).filter((n) => n.terminal && n.terminal.type === 'flop').map((n) => n.terminal.name);
      check('terminal names readable', names.includes('Raised pot (SB 2.25 / BB call)') && names.includes('Limped pot (SB limp / BB check)'), names.join('; '));
    }

    // Mixing toward flat R with few samples: n = 1 -> m = 1/6.
    RZ.saveSample(spot, mk('K1', 'Jd8s7c', { SB: 1.5, BB: 0.6 }, iso(0)), o);
    let tb = RZ.buildTable(spot, o), e = tb.terminals.K1;
    const expSB = (1 / 6) * 1.5 + (5 / 6) * 1.0, expBB = (1 / 6) * 0.6 + (5 / 6) * 0.88;
    check('realization: 1 sample mixes toward flat (m = 1/6)', e.n === 1 && Math.abs(e.SB[ci('AA')] - expSB) < 1e-3 && Math.abs(e.BB[ci('QQ')] - expBB) < 1e-3,
      `SB AA ${e.SB[ci('AA')]} (exp ${expSB.toFixed(4)}), BB QQ ${e.BB[ci('QQ')]} (exp ${expBB.toFixed(4)})`);
    check('realization: class with no data gets the mixed position average', Math.abs(e.SB[ci('T9s')] - expSB) < 1e-3, `T9s ${e.SB[ci('T9s')]}`);
    check('realization: table counts', tb.counts.K1 === 1 && /1 flop sample/.test(tb.info), tb.info);
    // Overwrite only with a newer sample.
    check('realization: older sample does not overwrite', RZ.saveSample(spot, mk('K1', 'Jd8s7c', { SB: 3, BB: 3 }, iso(1)), o) === null);
    const v1 = RZ.samplesVersion(spot, o);

    // Texture weighting: 1 rainbow low board with R 1, 5 monotone ace-high boards with R 2 (user-picked).
    const sh = RZ.groupShares();
    const gA = RZ.texGroup('8c5d2h'), gB = RZ.texGroup('AhTh4h');
    RZ.saveSample(spot, mk('K2', '8c5d2h', { SB: 1, BB: 1 }, iso(0)), o);
    for (const b of ['AhTh4h', 'AsJs3s', 'AdQd6d', 'Ac9c5c', 'AhKh2h']) RZ.saveSample(spot, mk('K2', b, { SB: 2, BB: 2 }, iso(0)), o);
    const exp = (sh[gA] * 1 + sh[gB] * 2) / (sh[gA] + sh[gB]);
    const r2_ = RZ.terminalR(RZ.loadSamples(spot, o).filter((x) => x.terminalKey === 'K2'), { ...o, mixK: 0 });
    check('realization: texture groups count by their share of all flops', Math.abs(r2_.SBavg - exp) < 1e-3 && r2_.SBavg < 1.5,
      `measured ${r2_.SBavg} (expected ${exp.toFixed(4)}; unweighted would be 1.833; shares ${gA} ${sh[gA].toFixed(4)}, ${gB} ${sh[gB].toFixed(4)})`);
    check('realization: m = n / (n + 5) with 6 flops', Math.abs(RZ.buildTable(spot, o).terminals.K2.m - 6 / 11) < 1e-3);
    check('realization: version changes when samples change', RZ.samplesVersion(spot, o) !== v1);

    // Recency: same texture group, old sample (30 days) R 2, new sample R 1 -> close to 1.
    RZ.saveSample(spot, mk('K3', '9c6d3h', { SB: 2, BB: 2 }, iso(30)), o);
    RZ.saveSample(spot, mk('K3', '9d6c3s', { SB: 1, BB: 1 }, iso(0)), o);
    const r3 = RZ.terminalR(RZ.loadSamples(spot, o).filter((x) => x.terminalKey === 'K3'), { ...o, mixK: 0 });
    check('realization: newer samples count more', r3.SBavg < 1.1, `measured ${r3.SBavg}`);
    // Ranges mismatch: other-range sample gets half weight.
    const other = { SB: { AA: 0.5 }, BB: { QQ: 1 } };
    RZ.saveSample(spot, mk('K4', '9c6d3h', { SB: 2, BB: 2 }, iso(0), { rangesHash: RZ.rangesHash(other) }), o);
    RZ.saveSample(spot, mk('K4', '9d6c3s', { SB: 1, BB: 1 }, iso(0)), o);
    const r4 = RZ.terminalR(RZ.loadSamples(spot, o).filter((x) => x.terminalKey === 'K4'), { ...o, mixK: 0, refHash: RZ.rangesHash(ranges) });
    check('realization: sample from other ranges counts less', Math.abs(r4.SBavg - (1 + 0.5 * 2) / 1.5) < 1e-3, `measured ${r4.SBavg}`);
    // Clamp.
    RZ.saveSample(spot, mk('K5', 'Jd8s7c', { SB: 9, BB: 0.01 }, iso(0)), o);
    const r5 = RZ.terminalR(RZ.loadSamples(spot, o).filter((x) => x.terminalKey === 'K5'), { ...o, mixK: 0 });
    check('realization: R clamped to [0.2, 3]', r5.SB[ci('AA')] === 3 && r5.BB[ci('QQ')] === 0.2);
    // Flop equity sanity: AA vs 72o on a dry board is far ahead.
    const fe = RZ.flopEquities('Kc8d3h', { AA: 1 }, { '72o': 1 }, 300);
    const avgEq = Object.values(fe).reduce((a, b) => a + b, 0) / Object.keys(fe).length;
    check('realization: flop equity AA vs 72o on Kc8d3h > 0.85', Object.keys(fe).length === 6 && avgEq > 0.85, avgEq.toFixed(3));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
  process.exit(fails ? 1 : 0);
})();
