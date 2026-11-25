'use strict';
// Run: node tools/presets.test.js [--solve]   (exit code 1 on failure).
// Checks tools/presets.json against the engines and .github/workflows/precompute.yml:
// - every preset has the fields its tool reads, and the workflow's preset choice list has every preset;
// - every flop-report preset names a heads-up flop terminal of its preflop tree. 6-max: the node id in the game tree
//   (no solve; node ids are the action path, the same ids a solve result has). Heads-up: a preflop solve (about 2 s).
// --solve: also solves each distinct 6-max preflop spot once (cached in cache/, minutes when not cached) and resolves
// every terminal through lib/reports.js like a flop report does; prints the reach of each terminal.
const fs = require('fs');
const path = require('path');
const R = require('../lib/reports');
const T6 = require('../engines/sixmax-preflop/tree');

const solveAll = process.argv.includes('--solve');
let failed = 0;
function check(name, ok, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
  if (!ok) failed++;
}

const presets = JSON.parse(fs.readFileSync(path.join(__dirname, 'presets.json'), 'utf8'));
const reportPresets = presets['flop-report'];
const calPresets = presets['sixmax-calibration'];

// ---- workflow choice list ----
const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'precompute.yml'), 'utf8');
// The input "preset" of workflow_dispatch: its lines up to the next input; options as a list or as [a, b].
const m = wf.match(/\n {6}preset:\n((?: {8,}.*\n)+)/);
const block = m ? m[1] : '';
const inline = block.match(/^ {8}options: \[([^\]]*)\]/m);
const options = (inline ? inline[1].split(',') : [...block.matchAll(/^ {10}- (.+)$/gm)].map((x) => x[1]))
  .map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
const names = [...new Set([...Object.keys(reportPresets), ...Object.keys(calPresets)])];
const missing = names.filter((n) => !options.includes(n));
check('workflow preset choices list every preset', m && missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${options.length} choices`);
const unknown = options.filter((n) => !names.includes(n));
check('workflow preset choices are all presets', unknown.length === 0, unknown.join(', '));

// ---- fields ----
for (const [name, p] of Object.entries(reportPresets)) {
  const ok = typeof p.title === 'string' && p.title && ['hu-preflop', 'sixmax-preflop'].includes(p.kind)
    && p.params && typeof p.params === 'object' && typeof p.terminal === 'string' && p.terminal
    && (p.tree === undefined || typeof p.tree === 'object');
  check(`flop-report ${name}: fields`, ok);
  // The input the report tool builds from the preset must pass the report's input check.
  let err = null;
  try { R.normalizeInput({ kind: p.kind, params: p.params, terminalKey: p.terminal, flops: 95, tree: p.tree || {} }); } catch (e) { err = e.message; }
  check(`flop-report ${name}: valid report input`, !err, err || '');
}
for (const [name, p] of Object.entries(calPresets)) {
  check(`sixmax-calibration ${name}: fields`, typeof p.title === 'string' && p.spot && typeof p.spot === 'object' && (p.group || p.groups));
}

// ---- 6-max terminals in the game tree (no solve) ----
const trees = new Map();
for (const [name, p] of Object.entries(reportPresets)) {
  if (p.kind !== 'sixmax-preflop') continue;
  const P = T6.normalizeParams(p.params);
  const k = JSON.stringify(P);
  if (!trees.has(k)) trees.set(k, T6.buildTree(P));
  const n = trees.get(k).nodes.find((x) => x.id === p.terminal);
  const ok = n && n.terminal && n.terminal.type === 'flop' && n.active.length === 2;
  check(`flop-report ${name}: ${p.terminal} is a heads-up flop terminal`, !!ok, ok ? `${n.name}, pot ${n.pot}` : '');
}

// ---- terminals of solved preflop spots (heads-up always, 6-max with --solve) ----
(async () => {
  const engines = {};
  for (const dir of ['hu-preflop', 'sixmax-preflop']) { const e = require(`../engines/${dir}/index.js`); engines[e.kind] = e; }
  const groups = new Map(); // one solve per distinct (kind, params)
  for (const [name, p] of Object.entries(reportPresets)) {
    if (p.kind === 'sixmax-preflop' && !solveAll) continue;
    const k = JSON.stringify([p.kind, engines[p.kind].normalizeParams ? engines[p.kind].normalizeParams(p.params) : p.params]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push([name, p]);
  }
  for (const list of groups.values()) {
    const [, first] = list[0];
    const t0 = Date.now();
    const res = await engines[first.kind].solve(first.params, () => {});
    console.log(`      solved ${first.kind} ${JSON.stringify(first.params)} in ${((Date.now() - t0) / 1000).toFixed(1)} s${res.stats && res.stats.cached ? ' (cache)' : ''}`);
    for (const [name, p] of list) {
      let n = null, err = null;
      try { n = await R.findTerminal(res, p.terminal); } catch (e) { err = e.message; }
      const f = n && n.terminal && n.terminal.flop;
      const ok = !!(f && f.ranges && f.oop && f.ip && f.pot > 0);
      const mass = n && n.terminal.mass;
      check(`flop-report ${name}: resolves in the solve`, ok, err || (ok ? `${f.oop} vs ${f.ip}, pot ${f.pot}, stack ${f.stack}, reach ${mass === undefined ? '-' : (100 * mass).toFixed(2) + '%'}` : ''));
    }
    if (typeof res.dispose === 'function') res.dispose();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
