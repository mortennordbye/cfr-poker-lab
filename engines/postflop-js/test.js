'use strict';
// Run: node engines/postflop/test.js   (exit code 1 on failure)
const E = require('./index');

let failed = 0;
function check(name, ok, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
  if (!ok) failed++;
}
const sec = (ms) => (ms / 1000).toFixed(2) + ' s';

// Every decision node reachable in the first levels: strategies sum to 1, weights in 0..1.
function checkStrategies(r, maxNodes) {
  const queue = [r.root];
  let nodes = 0, bad = 0, hands = 0;
  while (queue.length && nodes < maxNodes) {
    const n = r.getNode(queue.shift());
    nodes++;
    for (const h of Object.values(n.hands)) {
      hands++;
      const s = h.strategy.reduce((a, b) => a + b, 0);
      if (Math.abs(s - 1) > 1e-3 || h.weight < 0 || h.weight > 1 + 1e-9 || h.strategy.length !== n.actions.length) bad++;
    }
    for (const a of n.actions) if (a.type !== 'deal' || Math.random() < 0.05) queue.push(a.child);
  }
  return { nodes, hands, bad };
}

function decreasing(hist) {
  // allow small noise: last value well below the first and no big jump up
  if (hist.length < 2) return true;
  for (let i = 1; i < hist.length; i++) if (hist[i][1] > hist[i - 1][1] * 1.25 + 0.05) return false;
  return hist[hist.length - 1][1] < hist[0][1];
}

(async () => {
  // 1. Toy river: IP has nuts (KK = set of kings, 3 combos) and air (98, 16 combos at 25% = 4 combos),
  // OOP has only bluff catchers (JJ). OOP cannot bet, IP can bet pot only, no raises.
  // Theory at a pot-size bet: bluffs = 1/3 of IP's betting range, OOP calls 50%.
  {
    const t = Date.now();
    const r = await E.solve({
      board: 'KsTh7d4c2s', pot: 10, stack: 100, oop: 'BB', ip: 'SB',
      ranges: { BB: { JJ: 1 }, SB: { KK: 1, '98': 0.25 } },
      riverBets: '100', riverRaises: 'none', oopRiverBets: 'none', allinSpr: 0,
      iterations: 3000, targetExploitability: 0.01,
    });
    const ms = Date.now() - t;
    const root = r.getNode(r.root);
    check('toy: OOP has only check', root.actions.length === 1 && root.actions[0].type === 'check');
    const ip = r.getNode(root.actions[0].child);
    const bi = ip.actions.findIndex((a) => a.type === 'bet');
    let value = 0, bluff = 0, air = 0;
    for (const [name, h] of Object.entries(ip.hands)) {
      const f = h.weight * h.strategy[bi];
      if (name[0] === 'K') value += f; else { bluff += f; air += h.weight; }
    }
    const ratio = bluff / (value + bluff);
    check('toy: IP bluff share of betting range ~ 1/3', Math.abs(ratio - 1 / 3) < 0.03,
      `bluff share ${ratio.toFixed(3)}, value bets ${value.toFixed(2)} of 3 combos, air bets ${(bluff / air * 100).toFixed(1)}%`);
    const oop = r.getNode(ip.actions[bi].child);
    const ci = oop.actions.findIndex((a) => a.type === 'call');
    let cw = 0, tw = 0;
    for (const h of Object.values(oop.hands)) { cw += h.weight * h.strategy[ci]; tw += h.weight; }
    check('toy: OOP calls ~ 50%', Math.abs(cw / tw - 0.5) < 0.03, `call ${(cw / tw * 100).toFixed(1)}%`);
    // EV check: bluff catcher is indifferent, so call EV ~ fold EV = 0.
    const jj = Object.values(oop.hands)[0];
    check('toy: OOP call EV ~ 0 (indifferent)', Math.abs(jj.ev[ci]) < 0.3, `call EV ${jj.ev[ci]} bb, fold EV ${jj.ev[0]}`);
    check('toy: exploitability small', r.stats.exploitabilityPctPot < 0.1, `${r.stats.exploitabilityPctPot}% pot, ${r.stats.iterations} iterations, ${sec(ms)}`);
  }

  // 2. Default river solve: strategies sum to 1, exploitability goes down and ends small.
  {
    const t = Date.now();
    const r = await E.solve({ board: 'Jd8s7c2h3d' });
    const ms = Date.now() - t;
    const s = checkStrategies(r, 200);
    check('river: strategies sum to 1, weights in 0..1', s.bad === 0, `${s.nodes} nodes, ${s.hands} hands checked`);
    check('river: exploitability decreases', decreasing(r.stats.history),
      r.stats.history.map((x) => `${x[0]}:${x[1].toFixed(2)}`).join(' '));
    check('river: exploitability <= 0.5% pot', r.stats.exploitabilityPctPot <= 0.5, `${r.stats.exploitabilityPctPot}% pot`);
    check('river: solve < 2 s', ms < 2000, `${sec(ms)}, ${r.stats.iterations} iterations, combos ${r.stats.combos}`);
    const ev = r.stats.evOop + r.stats.evIp;
    check('river: EVs of both players add up to the pot', Math.abs(ev - 6) < 0.05, `${r.stats.evOop} + ${r.stats.evIp}`);
  }

  // 3a. Turn solve.
  {
    const t = Date.now();
    const r = await E.solve({ board: 'Jd8s7c2h' });
    const ms = Date.now() - t;
    const s = checkStrategies(r, 300);
    check('turn: strategies sum to 1', s.bad === 0, `${s.nodes} nodes`);
    check('turn: exploitability decreases', decreasing(r.stats.history));
    check('turn: solve < 20 s', ms < 20000,
      `${sec(ms)}, ${r.stats.iterations} iterations, exploitability ${r.stats.exploitabilityPctPot}% pot, ${r.stats.decisionNodes} decision nodes, ${r.stats.memoryMB} MB`);
    // node format spot check
    const root = r.getNode(r.root);
    const x = r.getNode(root.actions[0].child), xx = r.getNode(x.actions[0].child);
    check('turn: check-check goes to a river deal node', xx.toAct === null && xx.actions.length === 48 && xx.actions[0].type === 'deal');
    const rv = r.getNode(xx.actions[0].child);
    check('turn: river node has history with nodeIds', rv.street === 'river' && rv.history.length === 3 && rv.history[2].nodeId === xx.id,
      JSON.stringify(rv.history.map((h) => h.label)));
  }

  // 3b. Small flop solve (narrow ranges, one bet size per street).
  {
    const t = Date.now();
    const r = await E.solve({
      board: 'Jd8s7c',
      ranges: { BB: '22-TT,A2s-AJs,KTs+,QTs+,JTs,T9s,98s,87s,76s,ATo-AJo,KJo,QJo', SB: '22+,A8s+,K9s+,QTs+,JTs,T9s,98s,ATo+,KJo+,QJo' },
      iterations: 200, targetExploitability: 1,
    });
    const ms = Date.now() - t;
    const s = checkStrategies(r, 300);
    check('small flop: strategies sum to 1', s.bad === 0, `${s.nodes} nodes`);
    check('small flop: exploitability decreases', decreasing(r.stats.history));
    check('small flop: exploitability <= 1% pot', r.stats.exploitabilityPctPot <= 1,
      `${sec(ms)}, ${r.stats.iterations} iterations, ${r.stats.exploitabilityPctPot}% pot, combos ${r.stats.combos}, ${r.stats.memoryMB} MB`);
  }

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
