'use strict';
// Calibrates equity realization per hand for the 6-max preflop engine (batch run).
//
// Loop:
//   1. Solve preflop with engines/sixmax-preflop (round 1: flat R, see --start; later rounds: the calibrated table).
//   2. Group the heads-up flop terminals into realization groups ('SRP BTN vs BB', pot type x IP x OOP) and pick
//      the groups with the most reach (or the ones given with --group). In each group, take its terminals with the
//      most reach (--terms).
//   3. Solve each picked terminal on the flop subset (lib/flops.js) with the postflop engine (lib/postflop.js:
//      the native Rust engine if it exists). Each solve is saved as a sample (lib/realization.js), in the same files
//      that "Solve flop" in the UI writes. A sample with the current ranges is not solved again, so a stopped run
//      resumes where it was. Jobs run board by board over all groups (boards in round robin over suit textures), so a run stopped by --budgetMin leaves every
//      group with about the same number of flops.
//   4. lib/realization.js builds the group table from all samples; the next preflop solve uses it.
//
// Usage: node tools/calibrate-sixmax.js [--dir <samples dir>] [spot: --stack 100 --ante 0 --open 0 ...]
//        [--groups 8 | --group "3BP CO vs BB,4BP CO vs BB"] [--terms 1] [--flops 20] [--rounds 1]
//        [--parallel 1] [--threads 4] [--target 1] [--maxSeconds 300] [--maxExpl 3] [--budgetMin 0] [--iterations 1000] [--start flat] [--dry]
// --maxExpl: a solve that ends above this exploitability (% pot) is not saved, and such an old sample is solved again.
// --start: preflop solve that gives the terminals and ranges of round 1: flat (default; stays the same while samples
//          are added, so chunked runs resume) or calibrated (uses the samples that exist).
// --dir (or --samples-dir): sample folder (default cache/realization-samples, the folder the server reads).
// --preset <name>: spot and options from tools/presets.json ("sixmax-calibration"); flags given on the command line win.
//
// Batch runs on many machines (.github/workflows/precompute.yml):
//   --plan plan.json [--force]   round 1 without solves: pick the terminals and write the missing jobs (board x
//                                terminal, sorted by group) with their spots to plan.json. --force: also jobs whose
//                                sample exists. No final preflop solve.
//   --jobs plan.json --shard i/n solve shard i of n of the plan's jobs (round robin, lib/shard.js), save the samples,
//                                no preflop solve. --budgetMin works the same.
// With env GITHUB_STEP_SUMMARY, the time per flop goes into the job summary.
const fs = require('fs');
const path = require('path');

// ---- args ----
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
// The sample folder must be set before lib/realization.js loads.
const dirArg = arg('dir') || arg('samples-dir');
if (dirArg) process.env.REALIZATION_SAMPLES_DIR = path.resolve(String(dirArg));

const { flopSubset } = require('../lib/flops');
const { COMBOS, className } = require('../lib/equity');
const six = require('../engines/sixmax-preflop');
const postflop = require('../lib/postflop');
const RZ = require('../lib/realization');
const { parseShard, shardSlice } = require('../lib/shard');

const PRESET = (() => {
  const name = arg('preset');
  if (!name) return {};
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'presets.json'), 'utf8'))['sixmax-calibration'];
  if (!all[name]) { console.error(`unknown preset ${name}; presets: ${Object.keys(all).join(', ')}`); process.exit(1); }
  return all[name];
})();
// Flag value, else preset value, else default.
const opt = (name, def) => arg(name, PRESET[name] !== undefined ? PRESET[name] : def);

const SPOT_KEYS = ['stack', 'ante', 'open', 'sbOpen', 'threeBetIP', 'threeBetOOP', 'squeezeAdd', 'fourBet', 'coldCalls', 'sbLimp', 'maxPlayers', 'rIp', 'rOop'];
const spot = { ...(PRESET.spot || {}) };
for (const k of SPOT_KEYS) if (arg(k) !== undefined) spot[k] = arg(k);
// --group on the command line replaces the preset's groups (and its --groups count).
const groupArg = arg('group') || (arg('groups') === undefined ? PRESET.group : undefined);
const OPT = {
  groups: Number(opt('groups', 8)), group: groupArg ? String(groupArg).split(',').map((s) => s.trim()).filter(Boolean) : null,
  terms: Number(opt('terms', 1)), flops: Number(opt('flops', 20)), rounds: Number(opt('rounds', 1)),
  parallel: Number(opt('parallel', 1)), threads: Number(opt('threads', 4)), target: Number(opt('target', 1)),
  maxSeconds: Number(opt('maxSeconds', 300)), maxExpl: Number(opt('maxExpl', 3)), budgetMin: Number(opt('budgetMin', 0)), iterations: Number(opt('iterations', 1000)),
  start: String(opt('start', 'flat')), dry: !!arg('dry', false),
  plan: arg('plan') ? String(arg('plan')) : null, jobs: arg('jobs') ? String(arg('jobs')) : null, force: !!arg('force', false),
  shard: parseShard(arg('shard')),
};
if (OPT.plan || OPT.jobs) OPT.rounds = 1;

const P0 = six.normalizeParams(spot);
const KEY = six.spotKey(P0);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const IDX = {}; for (let i = 0; i < 169; i++) IDX[className(i)] = i;

function freqs(n) {
  let tot = 0; const acts = n.actions.map(() => 0);
  for (const [h, d] of Object.entries(n.hands)) { const c = COMBOS[IDX[h]].length * d.weight; tot += c; d.strategy.forEach((s, a) => { acts[a] += c * s; }); }
  return acts.map((x) => (tot > 0 ? x / tot : 0));
}

function summary(sol, label) {
  let id = sol.root;
  const rfi = [];
  for (const pos of ['UTG', 'HJ', 'CO', 'BTN', 'SB']) { const n = sol.getNode(id); rfi.push(`${pos} ${(100 * (1 - freqs(n)[0])).toFixed(1)}%`); id = n.actions[0].child; }
  log(`${label}: RFI ${rfi.join(', ')} | exploitability ${sol.stats.exploitabilityPctPot.toFixed(3)}% pot | ${sol.stats.realization}`);
}

// All heads-up flop terminals of a solve: [{ key, group, name, flop, mass }].
function flopTerminals(sol) {
  const out = [], seen = new Set(), stack = [sol.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = sol.getNode(id);
    if (n.terminal) { if (n.terminal.group && n.terminal.flop) out.push({ key: n.terminal.key, group: n.terminal.group, name: n.terminal.name, flop: n.terminal.flop, mass: n.terminal.mass || 0 }); continue; }
    for (const a of n.actions) stack.push(a.child);
  }
  return out;
}

// Board order for the jobs: round robin over suit textures (mono, two-tone, rainbow), each in subset order. A run
// stopped early then has every suit texture, not only the first boards of the subset.
function spread(boards) {
  const by = new Map();
  for (const b of boards) { const k = RZ.texGroup(b).split('-')[0]; if (!by.has(k)) by.set(k, []); by.get(k).push(b); }
  const lists = [...by.values()], out = [];
  for (let i = 0; out.length < boards.length; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

// Appends markdown to the GitHub job summary (if the env names one).
function summaryOut(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

// Solves one job (terminal t on board) and saves the sample. Returns { saved, expl, ms, iterations }.
async function solveJob(t, board, label) {
  const { pot, stack, ranges, oop, ip } = t.flop;
  const t0 = Date.now();
  const st = await postflop.solveStats({ board, pot, stack, oop, ip, ranges, targetExploitability: OPT.target, maxSeconds: OPT.maxSeconds, threads: OPT.threads });
  const ms = Date.now() - t0;
  if (!(st.exploitabilityPctPot <= OPT.maxExpl)) { // not converged (time limit, busy machine): no sample
    log(`${label}: ${t.group} ${board} expl ${(+st.exploitabilityPctPot).toFixed(2)}% > ${OPT.maxExpl}%: not saved`);
    return { saved: false, expl: st.exploitabilityPctPot, ms, iterations: st.iterations };
  }
  const eq = st.rootEq ? null : { [oop]: RZ.flopEquities(board, ranges[oop], ranges[ip]), [ip]: RZ.flopEquities(board, ranges[ip], ranges[oop]) };
  RZ.saveSample(KEY, RZ.makeSample({ terminalKey: t.key, board, pot, ranges, stats: st, oop, ip, eq, group: t.group }));
  return { saved: true, expl: st.exploitabilityPctPot, ms, iterations: st.iterations };
}

// --jobs plan.json --shard i/n: solve this shard's jobs of the plan. No preflop solve.
async function runShard() {
  const plan = JSON.parse(fs.readFileSync(OPT.jobs, 'utf8'));
  if (plan.spotKey !== KEY) throw new Error(`plan is for spot ${plan.spotKey}, the flags give ${KEY}`);
  const jobs = shardSlice(plan.jobs, OPT.shard);
  const tStart = Date.now(), rows = [];
  const label = OPT.shard ? `shard ${OPT.shard.index}/${OPT.shard.count}` : 'jobs';
  log(`${label}: ${jobs.length} of ${plan.jobs.length} jobs, samples in ${RZ.spotDir(KEY)}, ${OPT.threads} threads`);
  let left = 0;
  for (const [k, j] of jobs.entries()) {
    if (OPT.budgetMin && Date.now() - tStart > OPT.budgetMin * 60e3) { left = jobs.length - k; break; }
    const t = { key: j.key, ...plan.terminals[j.key] };
    const r = await solveJob(t, j.board, label);
    rows.push({ group: t.group, board: j.board, ...r });
    log(`${label}: ${k + 1}/${jobs.length} ${t.group} ${j.board} expl ${(+r.expl).toFixed(2)}% (${(r.ms / 1000).toFixed(0)} s)${r.saved ? '' : ' not saved'}`);
  }
  const wallS = (Date.now() - tStart) / 1000;
  if (left) log(`${label}: budget reached, ${left} jobs left for a later run`);
  log(`${label}: ${rows.filter((r) => r.saved).length} samples saved in ${wallS.toFixed(0)} s`);
  summaryOut([
    `### 6-max calibration ${plan.spotKey} ${label}`,
    '', `${rows.length} flops solved (${rows.filter((r) => r.saved).length} saved${left ? `, ${left} left by the time budget` : ''}) in ${wallS.toFixed(0)} s wall time (${(wallS / 60).toFixed(1)} min).`,
    '', '| group | board | solve s | iterations | exploitability % pot | saved |', '| --- | --- | ---: | ---: | ---: | --- |',
    ...rows.map((r) => `| ${r.group} | ${r.board} | ${(r.ms / 1000).toFixed(1)} | ${r.iterations} | ${(+r.expl).toFixed(3)} | ${r.saved ? 'yes' : 'no'} |`),
    rows.length ? `| mean | | ${(rows.reduce((a, r) => a + r.ms, 0) / rows.length / 1000).toFixed(1)} | | | |` : '', '',
  ].join('\n'));
}

(async () => {
  if (OPT.jobs) { await runShard(); process.exit(0); }
  const flops = spread(flopSubset(OPT.flops));
  const tStart = Date.now();
  log(`spot ${JSON.stringify(spot)} key ${KEY}; samples in ${RZ.spotDir(KEY)}; ${flops.length} flops, ${OPT.rounds} round(s), ` +
    `${OPT.parallel} parallel solves x ${OPT.threads} threads, target ${OPT.target}% pot${OPT.budgetMin ? `, budget ${OPT.budgetMin} min` : ''}`);
  let stopped = false; // budget reached: no final solve, the next run goes on
  for (let round = 1; round <= OPT.rounds; round++) {
    // Round 1 takes its terminals and ranges from the flat preflop solve (unless --start calibrated). That solve does
    // not change when samples are added, so the ranges hash of each terminal stays the same and a run stopped by
    // --budgetMin resumes with the samples it saved. Later rounds use the calibrated solve (new ranges, new samples).
    const base = round === 1 && OPT.start !== 'calibrated' ? 'flat' : 'calibrated';
    const sol = await six.solve({ ...spot, iterations: OPT.iterations, realization: base }, () => {});
    summary(sol, `round ${round} preflop (${base})`);
    const terms = flopTerminals(sol);
    const gm = new Map();
    for (const t of terms) { const g = gm.get(t.group) || { group: t.group, mass: 0, terms: [] }; g.mass += t.mass; g.terms.push(t); gm.set(t.group, g); }
    const all = [...gm.values()].sort((a, b) => b.mass - a.mass);
    const picked = OPT.group ? OPT.group.map((g) => gm.get(g)).filter(Boolean) : all.slice(0, OPT.groups);
    if (OPT.group && picked.length !== OPT.group.length) log(`unknown group(s): ${OPT.group.filter((g) => !gm.has(g)).join(', ')}`);
    const total = all.reduce((s, g) => s + g.mass, 0);
    log(`round ${round}: ${all.length} groups, heads-up flop reach ${(100 * total).toFixed(1)}% of deals; picked ${picked.length} (${(100 * picked.reduce((s, g) => s + g.mass, 0)).toFixed(1)}%):`);
    const chosen = [];
    for (const g of picked) {
      const ts = g.terms.sort((a, b) => b.mass - a.mass).slice(0, OPT.terms);
      chosen.push(...ts);
      log(`   ${g.group}: ${(100 * g.mass).toFixed(2)}% in ${g.terms.length} terminal(s); solving ${ts.map((t) => `${t.name} pot ${t.flop.pot} stack ${t.flop.stack} (${(100 * t.mass).toFixed(2)}%)`).join('; ')}`);
    }
    if (OPT.dry) break;

    let jobs = [];
    for (const board of flops) for (const t of chosen) {
      const old = OPT.force ? null : RZ.readSample(KEY, t.key, board);
      const good = old && !(old.solver && old.solver.exploitabilityPctPot > OPT.maxExpl);
      if (good && old.rangesHash === RZ.rangesHash(t.flop.ranges)) continue; // already sampled with these ranges
      jobs.push({ t, board });
    }
    if (OPT.plan || OPT.shard) {
      // Group-major order (terminal by terminal, boards in spread order): round robin over shards then gives each
      // shard about the same mix of groups (SRP solves take much longer than 3-bet and 4-bet pots).
      const order = new Map(chosen.map((t, i) => [t.key, i]));
      jobs.sort((a, b) => order.get(a.t.key) - order.get(b.t.key) || flops.indexOf(a.board) - flops.indexOf(b.board));
    }
    if (OPT.shard && !OPT.plan) {
      // A shard without a plan file: this machine's part of the missing jobs. Each shard sees the same samples
      // folder state at the start, else the lists differ; the plan file (--plan, then --jobs) avoids that.
      jobs = shardSlice(jobs, OPT.shard);
      log(`shard ${OPT.shard.index}/${OPT.shard.count}: ${jobs.length} jobs`);
    }
    if (OPT.plan) {
      const terminals = Object.fromEntries(chosen.map((t) => [t.key, { group: t.group, name: t.name, mass: t.mass, flop: t.flop }]));
      const plan = { job: 'sixmax-calibration', spot, spotKey: KEY, flops, groups: picked.map((g) => g.group), count: jobs.length,
        done: chosen.length * flops.length - jobs.length, terminals, jobs: jobs.map(({ t, board }) => ({ key: t.key, board })) };
      fs.writeFileSync(OPT.plan, JSON.stringify(plan));
      log(`plan: ${jobs.length} jobs to solve, ${plan.done} samples already current; written to ${OPT.plan}`);
      process.exit(0);
    }
    log(`round ${round}: ${jobs.length} solves to run (${chosen.length * flops.length - jobs.length} samples already current)`);
    let done = 0, skipped = 0, failed = 0;
    const t0 = Date.now();
    await pool(jobs, OPT.parallel, async ({ t, board }) => {
      if (OPT.budgetMin && Date.now() - tStart > OPT.budgetMin * 60e3) { skipped++; return; }
      const r = await solveJob(t, board, `round ${round}`);
      if (!r.saved) { failed++; return; }
      done++;
      const el = (Date.now() - t0) / 1000;
      log(`round ${round}: ${done}/${jobs.length} ${t.group} ${board} expl ${(+r.expl).toFixed(2)}% ` +
        `(${(r.ms / 1000).toFixed(0)} s) | elapsed ${(el / 60).toFixed(1)} min, left ~${((el / done) * (jobs.length - done) / 60).toFixed(0)} min`);
    });
    if (skipped) log(`round ${round}: budget reached, ${skipped} solves left for a later run`);
    if (failed) log(`round ${round}: ${failed} solves above ${OPT.maxExpl}% pot, not saved`);

    const currentRanges = Object.fromEntries(chosen.map((t) => [t.key, t.flop.ranges]));
    const table = RZ.buildGroupTable(KEY, { rIp: P0.rIp, rOop: P0.rOop, currentRanges });
    for (const g of picked) {
      const e = table && table.groups[g.group];
      if (!e) continue;
      const show = (pos) => ['AA', 'KK', 'AKo', 'T9s', '76s', 'K9o', '72o'].map((h) => `${h} ${e[pos][IDX[h]].toFixed(2)}`).join(' ');
      log(`R ${g.group}: ${e.n} flops, m ${e.m} | ${e.ip} (IP) avg ${e[e.ip + 'avg']} [${show(e.ip)}] | ${e.oop} (OOP) avg ${e[e.oop + 'avg']} [${show(e.oop)}]`);
    }
    log(`round ${round}: table ${table ? table.version + ' (' + table.info + ')' : 'none'}`);
    if (skipped) { stopped = true; break; }
  }
  if (!OPT.dry && !stopped && !OPT.shard) summary(await six.solve({ ...spot, iterations: OPT.iterations }, () => {}), 'final preflop (calibrated)');
  log(`done in ${((Date.now() - tStart) / 60e3).toFixed(1)} min`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
