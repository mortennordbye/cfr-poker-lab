'use strict';
// Tests for the 6-max preflop engine. Run: node engines/sixmax-preflop/test.js
const eng = require('./index');
const { COMBOS, className } = require('../../lib/equity');

const IDX = {}; for (let i = 0; i < 169; i++) IDX[className(i)] = i;
let fails = 0;
function check(name, ok, info = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); if (!ok) fails++; }

function freqs(n) {
  let tot = 0; const acts = n.actions.map(() => 0);
  for (const [h, d] of Object.entries(n.hands)) {
    const c = COMBOS[IDX[h]].length * d.weight; tot += c;
    d.strategy.forEach((s, a) => { acts[a] += c * s; });
  }
  return acts.map((x) => (tot > 0 ? x / tot : 0));
}

function allNodes(r) {
  const out = [], stack = [r.root];
  while (stack.length) { const n = r.getNode(stack.pop()); out.push(n); for (const a of n.actions) stack.push(a.child); }
  return out;
}

(async () => {
  const t0 = Date.now();
  // 1) 100bb cash, no ante, 2.5 open, CONTRACT realization (IP 1.0, OOP 0.88).
  const r = await eng.solve({ iterations: 300 }, () => {}, { noCache: true });
  console.log(`solve: ${r.stats.iterations} iterations in ${(r.stats.ms / 1000).toFixed(1)} s, exploitability ${r.stats.exploitabilityPctPot.toFixed(3)}% pot`);
  const nodes = allNodes(r);
  let bad = 0, badEv = 0, aaFold = 0, decisions = 0;
  for (const n of nodes) {
    if (n.terminal) continue;
    decisions++;
    for (const [h, d] of Object.entries(n.hands)) {
      const s = d.strategy.reduce((a, b) => a + b, 0);
      if (Math.abs(s - 1) > 1e-3 || d.strategy.length !== n.actions.length) bad++;
      if (n.actions[0].type === 'fold' && d.ev[0] !== 0) badEv++;
      if (h === 'AA' && d.weight > 0.01 && n.actions[0].type === 'fold' && d.strategy[0] > 0.02) aaFold++;
    }
  }
  check('strategies sum to 1 at every node', bad === 0, `${decisions} decision nodes, ${bad} bad`);
  check('EV of fold is 0', badEv === 0);
  check('AA never folds (where it has reach)', aaFold === 0, `${aaFold} nodes`);
  check('exploitability below 2% pot', r.stats.exploitabilityPctPot < 2, r.stats.exploitabilityPctPot.toFixed(3) + '%');

  const rfi = {};
  let id = r.root;
  for (const pos of ['UTG', 'HJ', 'CO', 'BTN', 'SB']) {
    const n = r.getNode(id);
    const f = freqs(n);
    rfi[pos] = 1 - f[0];
    id = n.actions[0].child;
  }
  console.log('RFI (open + allin), 100bb cash, R 1.0 / 0.88:');
  for (const [p, v] of Object.entries(rfi)) console.log(`   ${p.padEnd(4)} ${(100 * v).toFixed(1)}%`);
  check('UTG open 15-20%', rfi.UTG > 0.15 && rfi.UTG < 0.20);
  check('HJ open 18-24%', rfi.HJ > 0.18 && rfi.HJ < 0.24);
  check('CO open 24-31%', rfi.CO > 0.24 && rfi.CO < 0.31);
  // With R_ip = 1.0 the blinds defend very wide, so BTN opens a bit less than in published solver charts (see README).
  check('BTN open 33-50%', rfi.BTN > 0.33 && rfi.BTN < 0.50);
  check('SB has a raising range (> 25%)', rfi.SB > 0.25);
  const utg = r.getNode('root');
  check('72o folds UTG', utg.hands['72o'].strategy[0] > 0.98, JSON.stringify(utg.hands['72o'].strategy));
  check('AA opens UTG', utg.hands.AA.strategy[0] < 0.01);
  const f = r.getNode('R2.5-F-F-F-F-C');
  check('flop terminal has both ranges', f.terminal && f.terminal.type === 'flop' && f.terminal.flop.oop === 'BB' && f.terminal.flop.ip === 'UTG'
    && Object.keys(f.terminal.flop.ranges.UTG).length > 10 && Object.keys(f.terminal.flop.ranges.BB).length > 10 && !!f.ranges);

  // 2) A bit more IP realization gives BTN opens closer to published solver charts.
  const r2 = await eng.solve({ iterations: 300, rIp: 1.08 }, () => {}, { noCache: true });
  const btn = 1 - freqs(r2.getNode('F-F-F'))[0];
  console.log(`   BTN open with R_ip 1.08: ${(100 * btn).toFixed(1)}%`);
  check('BTN open 40-50% with R_ip 1.08', btn > 0.40 && btn < 0.50);

  // 3) MTT screenshot line: 100bb, BB ante 1, HJ opens 2.1, CO 3-bets 8.4, BB 4-bets 21 or goes allin.
  const r3 = await eng.solve({ ante: 1, iterations: 60 }, () => {}, { noCache: true });
  const bb = r3.getNode('F-R2.1-R8.4-F-F');
  check('MTT line: BB faces 8.4 with Raise 21 and Allin', !!bb && bb.toAct === 'BB' && bb.actions.some((a) => a.label === 'Raise 21') && bb.actions.some((a) => a.type === 'allin'),
    bb ? bb.actions.map((a) => a.label).join(', ') : 'missing');
  check('MTT pot at that node is 13', bb && Math.abs(bb.pot - 13) < 1e-9, bb && String(bb.pot));

  console.log(`${fails ? 'FAILED' : 'OK'} (${fails} failures) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
