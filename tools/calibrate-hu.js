'use strict';
// Calibrates equity realization per hand for the heads-up preflop engine (batch run).
//
// Loop (see plan-realization.html):
//   1. Solve preflop (round 1: the table from the samples that exist, or flat R; later: the table from the round before).
//   2. For each flop terminal with enough reach, solve it on a sample of flops with the postflop engine.
//   3. Each solve is saved as a sample in cache/realization-samples/<spot>/... (lib/realization.js), the same cache
//      that "Solve flop" in the UI and the idle filler write. A sample with the current ranges is not solved again,
//      so a stopped run resumes where it was.
//   4. lib/realization.js builds the table from all samples (texture-weighted, recency, mixed with flat R).
//
// Usage: node tools/calibrate-hu.js --stack 100 --sbOpen 2.25 --limp true [--flops 20] [--rounds 3]
//        [--parallel 2] [--target 1] [--maxSeconds 300] [--minMass 0.005] [--dry]
const { loadEquity, N, className } = require('../lib/equity');
const { flopSubset } = require('../lib/flops');
const hu = require('../engines/hu-preflop/solver');
const postflop = require('../lib/postflop');
const RZ = require('../lib/realization');

// ---- args ----
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const spot = {};
for (const k of ['stack', 'ante', 'sbOpen', 'limp', 'isoSize', 'threeBetX', 'fourBetX']) if (arg(k) !== undefined) spot[k] = arg(k);
const OPT = {
  flops: Number(arg('flops', 20)), rounds: Number(arg('rounds', 3)), parallel: Number(arg('parallel', 2)),
  target: Number(arg('target', 1)), maxSeconds: Number(arg('maxSeconds', 300)), minMass: Number(arg('minMass', 0.005)),
  dry: !!arg('dry', false),
};

const KEY = hu.spotKey(spot);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const P0 = hu.normalizeParams(spot);

function summary(sol, label) {
  const root = sol.nodes.n0;
  const c = (k) => (k.length === 2 ? 6 : k.endsWith('s') ? 4 : 12);
  const tot = root.actions.map((a, i) => a.label + ' ' + ((100 * Object.entries(root.hands).reduce((x, [k, h]) => x + h.weight * h.strategy[i] * c(k), 0)) / 1326).toFixed(1) + '%');
  const hand = (h) => { const x = root.hands[h]; if (!x) return `${h} -`; const ev = x.strategy.reduce((s, f, i) => s + f * (x.ev[i] || 0), 0); return `${h} ${root.actions.map((a, i) => a.label.split(' ')[0][0] + Math.round(100 * x.strategy[i])).join('/')} EV ${ev.toFixed(2)}`; };
  log(`${label}: ${tot.join(' | ')}`);
  log(`   ${['AA', 'KK', 'AKo', 'A2s', '93o', '72o', 'T2o'].map(hand).join('  ')}`);
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

// ---- main ----
(async () => {
  const { E, W } = await loadEquity();
  const flops = flopSubset(OPT.flops);
  log(`spot ${JSON.stringify(spot)} key ${KEY}; ${flops.length} flops, ${OPT.rounds} rounds, ${OPT.parallel} parallel solves`);
  let table = RZ.buildTable(KEY, { rIp: P0.rIp, rOop: P0.rOop });

  for (let round = 1; round <= OPT.rounds; round++) {
    const sol = hu.solve(E, W, { ...spot, realization: table ? 'calibrated' : 'flat', iterations: 1500 }, null, table);
    summary(sol, `round ${round} preflop (${table ? 'calibrated, ' + table.info : 'flat R'})`);
    const terms = Object.values(sol.nodes).filter((n) => n.terminal && n.terminal.type === 'flop')
      .map((n) => ({ key: n.terminal.key, name: n.terminal.name, flop: n.terminal.flop, mass: n.terminal.mass || 0 }))
      .filter((t) => t.mass >= OPT.minMass).sort((a, b) => b.mass - a.mass);
    log(`round ${round}: ${terms.length} flop spots: ${terms.map((t) => `${t.name} (pot ${t.flop.pot}, ${(100 * t.mass).toFixed(1)}% of deals)`).join('; ')}`);
    if (OPT.dry) return;

    const jobs = [];
    for (const t of terms) for (const board of flops) {
      const old = RZ.readSample(KEY, t.key, board);
      if (old && old.rangesHash === RZ.rangesHash(t.flop.ranges)) continue; // already sampled with these ranges
      jobs.push({ t, board });
    }
    log(`round ${round}: ${jobs.length} solves to run (${terms.length * flops.length - jobs.length} samples already current)`);
    let done = 0;
    const t0 = Date.now();
    await pool(jobs, OPT.parallel, async ({ t, board }) => {
      const { pot, stack, ranges } = t.flop;
      const st = await postflop.solveStats({ board, pot, stack, oop: 'BB', ip: 'SB', ranges, targetExploitability: OPT.target, maxSeconds: OPT.maxSeconds, threads: 4 });
      const eq = st.rootEq ? null : { BB: RZ.flopEquities(board, ranges.BB, ranges.SB), SB: RZ.flopEquities(board, ranges.SB, ranges.BB) };
      RZ.saveSample(KEY, RZ.makeSample({ terminalKey: t.key, board, pot, ranges, stats: st, eq }));
      done++;
      const el = (Date.now() - t0) / 1000;
      log(`round ${round}: ${done}/${jobs.length} ${t.name} ${board} expl ${st.exploitabilityPctPot}% ` +
        `(${((st.solveMs || st.ms || 0) / 1000).toFixed(0)} s) | elapsed ${(el / 60).toFixed(1)} min, left ~${((el / done) * (jobs.length - done) / 60).toFixed(0)} min`);
    });

    const currentRanges = Object.fromEntries(terms.map((t) => [t.key, t.flop.ranges]));
    table = RZ.buildTable(KEY, { rIp: P0.rIp, rOop: P0.rOop, currentRanges });
    const idx = (h) => { for (let i = 0; i < N; i++) if (className(i) === h) return i; return -1; };
    for (const t of terms) {
      const e = table && table.terminals[t.key];
      if (!e) continue;
      const show = (pos) => ['AA', 'KK', 'AKo', '76s', '93o', '72o'].map((h) => `${h} ${e[pos][idx(h)].toFixed(2)}`).join(' ');
      log(`R ${t.name}: ${e.n} flops, m ${e.m} | SB avg ${e.SBavg} [${show('SB')}] | BB avg ${e.BBavg} [${show('BB')}]`);
    }
    log(`round ${round}: table ${table ? table.version + ' (' + table.info + ')' : 'none'}; samples in ${RZ.spotDir(KEY)}`);
  }
  const final = hu.solve(E, W, { ...spot, realization: 'calibrated', iterations: 1500 }, null, table);
  summary(final, 'final preflop (calibrated)');
  log('done');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
