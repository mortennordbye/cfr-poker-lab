'use strict';
// Run: node engines/postflop/test.js   (exit code 1 on failure). Uses at most 8 threads.
// Set QUICK=1 to skip the default-tree flop solve.
const E = require('./index');
const J = require('../postflop-js');

let failed = 0;
function check(name, ok, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
  if (!ok) failed++;
}
const sec = (ms) => (ms / 1000).toFixed(2) + ' s';
const THREADS = 8;

// Overall action frequencies at a node (weighted by reach), keyed by action label.
function freqs(n) {
  const f = {}, tot = Object.values(n.hands).reduce((s, h) => s + h.weight, 0);
  n.actions.forEach((a, i) => { f[a.label] = Object.values(n.hands).reduce((s, h) => s + h.weight * h.strategy[i], 0) / tot; });
  return f;
}
const maxDiff = (a, b) => Math.max(...Object.keys(a).map((k) => Math.abs(a[k] - (b[k] === undefined ? 9 : b[k]))));

// Breadth-first walk: strategies sum to 1, weights in 0..1, every child id resolves. Some deal children are followed.
async function walk(r, maxNodes) {
  const queue = [r.root];
  let nodes = 0, bad = 0, hands = 0, deals = 0, missing = 0;
  while (queue.length && nodes < maxNodes) {
    const n = await r.getNode(queue.shift());
    if (!n) { missing++; continue; }
    nodes++;
    if (n.actions.length && n.actions[0].type === 'deal') deals++;
    for (const h of Object.values(n.hands)) {
      hands++;
      const s = h.strategy.reduce((a, b) => a + b, 0);
      if (Math.abs(s - 1) > 2e-3 || h.weight < 0 || h.weight > 1 + 1e-6 || h.strategy.length !== n.actions.length) bad++;
    }
    n.actions.forEach((a, i) => { if (a.type !== 'deal' || i % 12 === 0) queue.push(a.child); });
  }
  return { nodes, hands, bad, deals, missing };
}

(async () => {
  // 1. Toy river (same as postflop-js): IP nuts (KK, 3 combos) + air (98 at 25%), OOP bluff catchers (JJ).
  {
    const t = Date.now();
    const r = await E.solve({
      board: 'KsTh7d4c2s', pot: 10, stack: 100, oop: 'BB', ip: 'SB',
      ranges: { BB: { JJ: 1 }, SB: { KK: 1, '98': 0.25 } },
      riverBets: '100', riverRaises: 'none', oopRiverBets: 'none', allinSpr: 0, iterations: 3000, targetExploitability: 0.01, threads: THREADS,
    });
    const ms = Date.now() - t;
    const root = await r.getNode(r.root);
    check('toy: OOP has only check', root.actions.length === 1 && root.actions[0].type === 'check');
    const ip = await r.getNode(root.actions[0].child);
    const bi = ip.actions.findIndex((a) => a.type === 'bet');
    let value = 0, bluff = 0, air = 0;
    for (const [name, h] of Object.entries(ip.hands)) {
      const f = h.weight * h.strategy[bi];
      if (name[0] === 'K') value += f; else { bluff += f; air += h.weight; }
    }
    const ratio = bluff / (value + bluff);
    check('toy: IP bluff share of betting range ~ 1/3', Math.abs(ratio - 1 / 3) < 0.03,
      `bluff share ${ratio.toFixed(3)}, value bets ${value.toFixed(2)} of 3 combos, air bets ${(bluff / air * 100).toFixed(1)}%`);
    const oop = await r.getNode(ip.actions[bi].child);
    const ci = oop.actions.findIndex((a) => a.type === 'call');
    let cw = 0, tw = 0;
    for (const h of Object.values(oop.hands)) { cw += h.weight * h.strategy[ci]; tw += h.weight; }
    check('toy: OOP calls ~ 50%', Math.abs(cw / tw - 0.5) < 0.03, `call ${(cw / tw * 100).toFixed(1)}%`);
    const jj = Object.values(oop.hands)[0];
    check('toy: OOP call EV ~ 0 (indifferent)', Math.abs(jj.ev[ci]) < 0.3, `call EV ${jj.ev[ci]} bb, fold EV ${jj.ev[0]}`);
    check('toy: exploitability small', r.stats.exploitabilityPctPot < 0.1, `${r.stats.exploitabilityPctPot}% pot, ${r.stats.iterations} iterations, ${sec(ms)}`);
    r.dispose();
  }

  // 2. Same small trees in both engines (no merging, no forced all-in, donk = normal bets): results agree.
  const same = { allinSpr: 0, forceAllinSpr: 0, mergeThreshold: 0, donkBets: 'same', targetExploitability: 0.2, iterations: 2000 };
  const spots = [
    ['river', { board: 'Jd8s7c2h3d', riverBets: '75', riverRaises: 'none', raiseCap: 0 }],
    ['turn', { board: 'Jd8s7c2h', turnBets: '66', turnRaises: 'allin', riverBets: '75', riverRaises: 'none', raiseCap: 1 }],
  ];
  for (const [name, sp] of spots) {
    const t1 = Date.now();
    const r = await E.solve({ ...sp, ...same, threads: THREADS });
    const msR = Date.now() - t1;
    const t2 = Date.now();
    const j = await J.solve({ ...sp, ...same, threads: 4 });
    const msJ = Date.now() - t2;
    let treeSame = true, fd = 0;
    for (const id of ['r', 'r.0', 'r.1']) {
      const a = await r.getNode(id), b = j.getNode(id);
      if (!a || !b || a.actions.map((x) => x.label).join('|') !== b.actions.map((x) => x.label).join('|')) {
        treeSame = false;
        console.log('   tree differs at', id, a && a.actions.map((x) => x.label), b && b.actions.map((x) => x.label));
        continue;
      }
      if (a.toAct) fd = Math.max(fd, maxDiff(freqs(a), freqs(b)));
    }
    check(`${name}: same tree in both engines`, treeSame);
    const dEv = Math.max(Math.abs(r.stats.evOop - j.stats.evOop), Math.abs(r.stats.evIp - j.stats.evIp));
    check(`${name}: root EVs agree with postflop-js (< 0.1 bb)`, dEv < 0.1,
      `rust ${r.stats.evOop}/${r.stats.evIp}, js ${j.stats.evOop}/${j.stats.evIp}`);
    check(`${name}: action frequencies agree with postflop-js (< 3%)`, fd < 0.03, `max diff ${(fd * 100).toFixed(2)}%`);
    console.log(`      ${name}: rust ${sec(msR)} (${r.stats.iterations} it, ${r.stats.exploitabilityPctPot}% pot), js ${sec(msJ)} (${j.stats.iterations} it, ${j.stats.exploitabilityPctPot}% pot)`);
    // 3. Structure checks on the same solves.
    const ev = r.stats.evOop + r.stats.evIp, pot = 6;
    check(`${name}: root EVs add up to the pot`, Math.abs(ev - pot) < 0.02, `${r.stats.evOop} + ${r.stats.evIp} = ${ev.toFixed(3)}`);
    const w = await walk(r, name === 'river' ? 200 : 400);
    check(`${name}: strategies sum to 1, weights in 0..1, ids resolve`, w.bad === 0 && w.missing === 0 && w.nodes >= 5,
      `${w.nodes} nodes, ${w.hands} hands, ${w.deals} deal nodes`);
    if (name === 'turn') {
      check('turn: walk reached a deal node', w.deals > 0);
      const xx = await r.getNode('r.0.0');
      const rv = await r.getNode(xx.actions[0].child);
      check('turn: check-check -> deal node with 48 cards -> river node with history',
        xx.toAct === null && xx.actions.length === 48 && rv.street === 'river' && rv.history.length === 3
        && rv.history[2].type === 'deal' && rv.history[2].pos === null && rv.history[2].nodeId === xx.id,
        JSON.stringify(rv.history.map((h) => h.label)));
      const h0 = Object.values((await r.getNode('r')).hands)[0];
      check('turn: nodes carry per-hand equity', h0.equity >= 0 && h0.equity <= 1, `equity ${h0.equity}`);
    }
    r.dispose();
  }

  // 3b. Suit isomorphism: on a monotone turn every legal river card must still be clickable.
  {
    const r = await E.solve({ board: 'Ah7h2h5h', ranges: { BB: 'KK-55,KQs,QJs', SB: 'AA-88,AK,KQ' }, turnBets: '66', turnRaises: 'none',
      riverBets: '75', riverRaises: 'none', targetExploitability: 0.5, threads: THREADS });
    const deal = await r.getNode('r.0.0');
    let ok = 0;
    const seen = new Set();
    for (const a of deal.actions) {
      const n = await r.getNode(a.child);
      if (n && n.board.length === 5 && n.board[4] === a.label && Object.keys(n.hands).length) { ok++; seen.add(a.label); }
    }
    check('iso: every river card on a monotone turn resolves to its own board', ok === deal.actions.length && deal.actions.length === 48,
      `${ok}/${deal.actions.length} cards`);
    // Isomorphic cards: Kc and Kd give mirrored results (same strategy for the mirrored combo).
    const ia = deal.actions.findIndex((a) => a.label === 'Kc'), ib = deal.actions.findIndex((a) => a.label === 'Kd');
    const na = await r.getNode(deal.actions[ia].child), nb = await r.getNode(deal.actions[ib].child);
    const sa = na.hands.QdQc, sb = nb.hands.QdQc; // QdQc on Kc mirrors QcQd -> 'QdQc' on Kd (same name)
    const same = sa && sb && sa.strategy.every((x, i) => Math.abs(x - sb.strategy[i]) < 1e-3) && sa.ev.every((x, i) => Math.abs(x - sb.ev[i]) < 1e-3);
    check('iso: mirrored river cards give the same strategy and EV', same,
      sa && sb ? `QdQc on Kc: ${sa.strategy} / ${sa.ev}, on Kd: ${sb.strategy} / ${sb.ev}` : 'missing');
    r.dispose();
  }

  // 4 + 5. Default-tree flop solve with the default ranges; rootEv / rootEq.
  if (!process.env.QUICK) {
    const t = Date.now();
    let lastMsg = '';
    const r = await E.solve({ board: 'Jd8s7c', threads: THREADS }, (f, m) => { lastMsg = m; });
    const ms = Date.now() - t;
    const s = r.stats;
    console.log(`      flop Jd8s7c default tree: ${sec(ms)} total, solve ${sec(s.solveMs)}, ${s.iterations} iterations, ` +
      `${s.exploitabilityPctPot}% pot, memory ${s.memoryMB} MB (raw ${s.memoryRawMB} MB, compressed ${s.compressed}), peak RSS ${s.peakRssMB} MB, ${s.threads} threads, combos ${s.combos}`);
    check('flop: reaches target or stops at a limit', s.exploitabilityPctPot <= 0.5 || s.iterations >= 1000, `${s.exploitabilityPctPot}% pot (${lastMsg})`);
    check('flop: EVs add up to the pot', Math.abs(s.evOop + s.evIp - 6) < 0.03, `${s.evOop} + ${s.evIp}`);
    const root = await r.getNode('r');
    console.log('      root actions:', root.actions.map((a) => a.label).join(', '));
    const b = await r.getNode(root.actions[root.actions.length - 1].child);
    console.log('      after OOP', root.actions[root.actions.length - 1].label + ':', b.actions.map((a) => a.label).join(', '));
    const evs = [...Object.values(s.rootEv.oop), ...Object.values(s.rootEv.ip)];
    const eqs = [...Object.values(s.rootEq.oop), ...Object.values(s.rootEq.ip)];
    check('rootEv / rootEq present for both players', Object.keys(s.rootEv.oop).length === s.combos[0] && Object.keys(s.rootEq.ip).length === s.combos[1],
      `${Object.keys(s.rootEv.oop).length} + ${Object.keys(s.rootEv.ip).length} combos`);
    check('rootEq in [0, 1]', eqs.every((x) => x >= 0 && x <= 1), `min ${Math.min(...eqs)}, max ${Math.max(...eqs)}`);
    check('rootEv >= 0 at the root', evs.every((x) => x >= -1e-3), `min ${Math.min(...evs)}, max ${Math.max(...evs)}`);
    const avgEq = (side) => {
      const h = s.rootEq[side];
      return Object.keys(h).reduce((a, k) => a + h[k], 0) / Object.keys(h).length;
    };
    console.log(`      mean eq oop ${avgEq('oop').toFixed(3)}, ip ${avgEq('ip').toFixed(3)}; e.g. AsAh ev ${s.rootEv.ip.AsAh} eq ${s.rootEq.ip.AsAh}`);
    r.dispose();
  }

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
