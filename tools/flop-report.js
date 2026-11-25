'use strict';
// Flop report from the command line (lib/reports.js): solves one flop spot on 25, 49 or 95 flops and prints the
// summary by texture. Same files as the server (cache/reports/<id>.json): run it again to continue a stopped report.
//
// Usage:
//   node tools/flop-report.js --terminal 'SB:Raise 2.5/BB:Call' [--kind hu-preflop] [--params '{"stack":100}']
//        [--flops 25] [--target 1] [--maxSeconds 300] [--threads 8] [--tree '{"flopBets":"33,75"}']
//   node tools/flop-report.js --spot spot.json [--flops 25]       spot.json = { ranges, pot, stack, oop, ip }
//   node tools/flop-report.js --list [--kind hu-preflop] [--params ...]   lists the flop terminals of the spot
// Env: REPORTS_DIR (report files), REALIZATION_SAMPLES_DIR (samples).
const fs = require('fs');
const path = require('path');
const R = require('../lib/reports');

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pct = (x) => (x === null || x === undefined ? '   -' : (100 * x).toFixed(1).padStart(5) + '%');

const engines = {};
for (const dir of ['hu-preflop', 'sixmax-preflop', 'postflop', 'postflop-js']) {
  try { const e = require(path.join(__dirname, '..', 'engines', dir, 'index.js')); engines[e.kind] = e; } catch (e) { /* not loaded */ }
}

(async () => {
  const kind = arg('kind', 'hu-preflop');
  const params = JSON.parse(arg('params', '{}'));
  if (arg('list')) {
    const res = await engines[kind].solve(params, () => {});
    const seen = new Set(), out = [];
    const walk = async (id) => {
      if (seen.has(id)) return; seen.add(id);
      const n = await res.getNode(id);
      if (!n) return;
      if (n.terminal && n.terminal.type === 'flop' && n.terminal.flop) out.push({ key: n.terminal.key || n.id, name: n.terminal.name || '', mass: n.terminal.mass, pot: n.terminal.flop.pot });
      for (const a of n.actions || []) await walk(a.child);
    };
    await walk(res.root);
    for (const t of out.sort((a, b) => (b.mass || 0) - (a.mass || 0))) console.log(`${t.key.padEnd(40)} pot ${String(t.pot).padEnd(6)} reach ${t.mass === undefined ? '-' : (100 * t.mass).toFixed(1) + '%'}  ${t.name}`);
    process.exit(0);
  }
  const tree = JSON.parse(arg('tree', '{}'));
  for (const [k, a] of [['targetExploitability', 'target'], ['maxSeconds', 'maxSeconds'], ['threads', 'threads'], ['iterations', 'iterations']]) {
    if (arg(a) !== undefined) tree[k] = Number(arg(a));
  }
  const input = arg('spot')
    ? { spot: JSON.parse(fs.readFileSync(arg('spot'), 'utf8')), flops: Number(arg('flops', 25)), tree }
    : { kind, params, terminalKey: arg('terminal'), flops: Number(arg('flops', 25)), tree };

  const reports = R.createReports({ engines, log });
  const t0 = Date.now();
  const { reportId } = reports.start(input);
  log(`report ${reportId}, file ${path.join(reports.dir, reportId + '.json')}`);
  let s;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    s = reports.status(reportId);
    if (s.status === 'done' || s.status === 'error') break;
  }
  if (s.status === 'error') { console.error('report failed:', s.error || s.message); process.exit(1); }
  log(`done: ${s.total} flops, solve time ${(s.runMs / 1000).toFixed(0)} s in all runs, this run ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
  console.log(`\n${s.name}  (pot ${s.spot.pot}, stack ${s.spot.stack}, ${s.spot.oop} OOP vs ${s.spot.ip} IP)`);
  console.log('group                n   OOP bet  IP bet(after check)  EV OOP  EV IP   Eq OOP  Eq IP   expl');
  for (const g of s.summary) {
    console.log(`${g.label.padEnd(18)} ${String(g.n).padStart(3)}   ${pct(g.oop && g.oop.bet)}   ${pct(g.ip && g.ip.bet)}              `
      + `${String(g.ev.oop).padStart(6)}  ${String(g.ev.ip).padStart(6)}  ${pct(g.eq.oop)} ${pct(g.eq.ip)}  ${g.exploitabilityPctPot}`);
  }
  console.log('\nboard    texture                  OOP bet  IP bet   EV OOP  EV IP   time');
  for (const x of s.results) {
    console.log(`${x.board}   ${`${x.texture.suits} ${x.texture.pairing} ${x.texture.high}`.padEnd(24)} ${pct(x.oop && x.oop.bet)}  ${pct(x.ip && x.ip.bet)}  `
      + `${String(x.ev.oop).padStart(6)}  ${String(x.ev.ip).padStart(6)}  ${(x.ms / 1000).toFixed(1)} s`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
