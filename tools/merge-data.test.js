'use strict';
// Run: node tools/merge-data.test.js   (exit code 1 on failure). Fast: fake engines and tiny files, no real solves.
// Checks shards + merge against a local run of the same input, incremental runs (base data) and --force.
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/reports');
const { parseShard, shardSlice } = require('../lib/shard');
const { mergeData } = require('./merge-data');

let failed = 0;
function check(name, ok, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
  if (!ok) failed++;
}

// ---- shard helpers ----
check('parseShard', JSON.stringify(parseShard('3/10')) === '{"index":3,"count":10}' && parseShard(undefined) === null);
const bad = (s) => { try { parseShard(s); return false; } catch (e) { return true; } };
check('parseShard rejects bad values', bad('0/3') && bad('4/3') && bad('a/b') && bad('2'));
const items = Array.from({ length: 11 }, (_, i) => i);
const parts = [1, 2, 3].map((i) => shardSlice(items, { index: i, count: 3 }));
check('shards: round robin, every item once', parts[0].join() === '0,3,6,9' && parts[1].join() === '1,4,7,10' && parts[2].join() === '2,5,8'
  && parts.flat().sort((a, b) => a - b).join() === items.join());
check('more shards than items: empty shards', shardSlice([1, 2], { index: 3, count: 4 }).length === 0);

// ---- fake engines (same shape as lib/reports.test.js) ----
const RANGES = { BB: { AA: 1, '72o': 1 }, SB: { KK: 1, AKs: 0.5 } };
const fakePreflop = {
  kind: 'hu-preflop',
  async solve() {
    const nodes = {
      n0: { id: 'n0', toAct: 'SB', actions: [{ label: 'Raise 2.5', type: 'raise', child: 'n1' }], hands: {} },
      n1: { id: 'n1', toAct: 'BB', actions: [{ label: 'Call', type: 'call', child: 'n2' }], hands: {} },
      n2: { id: 'n2', toAct: null, actions: [], terminal: { type: 'flop', key: 'SB:Raise 2.5/BB:Call', spotKey: 'testspot', name: 'Raised pot', mass: 0.3,
        flop: { oop: 'BB', ip: 'SB', pot: 5, stack: 97.5, ranges: RANGES } } },
    };
    return { root: 'n0', getNode: (id) => nodes[id] || null };
  },
};
const fakePostflop = {
  kind: 'postflop',
  async solve(P) {
    const hi = R.texture(P.board).highRank / 12;
    const nodes = {
      r: { id: 'r', toAct: P.oop, actions: [{ label: 'Check', type: 'check', child: 'r.0' }, { label: 'Bet 1.65', type: 'bet', child: 'r.1' }], hands: { AsAh: { weight: 1, strategy: [1 - hi, hi] } } },
      'r.0': { id: 'r.0', toAct: P.ip, actions: [{ label: 'Check', type: 'check' }, { label: 'Bet 1.65', type: 'bet' }], hands: { KsKh: { weight: 1, strategy: [0.5, 0.5] } } },
    };
    return { root: 'r', getNode: async (id) => nodes[id] || null, dispose() {},
      stats: { iterations: 10, exploitabilityPctPot: 0.8, evOop: 2 + hi, evIp: 3 - hi, eqOop: 0.5, eqIp: 0.5 } };
  },
};
const engines = { 'hu-preflop': fakePreflop, postflop: fakePostflop };
const quiet = () => {};
const input = { kind: 'hu-preflop', params: { stack: 100 }, terminalKey: 'SB:Raise 2.5/BB:Call', flops: 25 };
const tick = () => new Promise((r) => setTimeout(r, 5));
async function runTo(rep, id, states = ['done', 'partial', 'error']) { for (let i = 0; i < 2000; i++) { const s = rep.status(id); if (s && states.includes(s.status)) return s; await tick(); } return null; }
const strip = (r) => JSON.stringify({ ...r, createdAt: 0, updatedAt: 0, runMs: 0, results: r.results.map((x) => ({ ...x, ms: 0 })) });

// One batch run like the workflow: plan in planDir (seeded from base), copy to each shard, run, merge.
async function batch(tmp, name, { base = null, shards = 3, limit = 0, force = false } = {}) {
  const planDir = path.join(tmp, name, 'plan');
  fs.mkdirSync(path.join(planDir, 'reports'), { recursive: true });
  if (base) for (const f of fs.readdirSync(path.join(base, 'reports'))) fs.copyFileSync(path.join(base, 'reports', f), path.join(planDir, 'reports', f));
  const planRep = R.createReports({ engines, dir: path.join(planDir, 'reports'), samples: false, log: quiet });
  const r = await planRep.prepare(input, { force });
  const todo = R.pendingFlops(r, limit);
  const n = Math.min(shards, todo.length);
  const dirs = [];
  for (let i = 1; i <= n; i++) {
    const d = path.join(tmp, name, `shard-${i}`);
    fs.mkdirSync(path.join(d, 'reports'), { recursive: true });
    fs.copyFileSync(path.join(planDir, 'reports', r.id + '.json'), path.join(d, 'reports', r.id + '.json'));
    const rep = R.createReports({ engines, dir: path.join(d, 'reports'), samples: false, log: quiet });
    rep.start(input, { shard: { index: i, count: n }, limit });
    await runTo(rep, r.id);
    dirs.push(d);
  }
  const out = path.join(tmp, name, 'out');
  const manifest = mergeData({ out, inputs: [...(base ? [{ dir: base, base: true }] : []), ...dirs.map((dir) => ({ dir, base: false }))], log: quiet });
  return { id: r.id, out, manifest, todo, n, dirs };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-data-test-'));
  try {
    // Local run of the same input (one machine, no shards).
    const localDir = path.join(tmp, 'local');
    const local = R.createReports({ engines, dir: localDir, samples: false, log: quiet });
    const id = local.start(input).reportId;
    await runTo(local, id);
    const L = JSON.parse(fs.readFileSync(path.join(localDir, id + '.json'), 'utf8'));

    // Run 1: 3 shards, all 25 flops.
    const b1 = await batch(tmp, 'run1', { shards: 3 });
    const shardFile = (d) => JSON.parse(fs.readFileSync(path.join(d, 'reports', id + '.json'), 'utf8'));
    check('shards: same report id as a local run', b1.id === id);
    check('shards: each shard file is partial with its own flops', b1.dirs.every((d) => shardFile(d).status === 'partial')
      && b1.dirs.map((d) => shardFile(d).results.length).join() === '9,8,8', b1.dirs.map((d) => shardFile(d).results.length).join());
    const M = JSON.parse(fs.readFileSync(path.join(b1.out, 'reports', id + '.json'), 'utf8'));
    check('merge: status done, all flops in flop order', M.status === 'done' && M.results.map((x) => x.board).join() === L.flops.join());
    check('merge: same content as the local run (times aside)', strip(M) === strip(L));
    const st = R.statusOf(M);
    check('merge: the server sees it as done', st.status === 'done' && st.done === 25 && st.total === 25);
    check('manifest: report entry', b1.manifest.reports.length === 1 && b1.manifest.reports[0].id === id && b1.manifest.reports[0].status === 'done'
      && b1.manifest.reports[0].flops === 25 && b1.manifest.reports[0].name === 'Raised pot');
    check('manifest: git sha and time', typeof b1.manifest.createdAt === 'string' && 'gitSha' in b1.manifest);
    let threw = false;
    try { mergeData({ out: b1.out, inputs: [], log: quiet }); } catch (e) { threw = /not empty/.test(e.message); }
    check('merge refuses a folder that is not empty', threw);

    // Incremental: run 2 does only 4 flops (limit) from nothing, run 3 starts from run 2's data and finishes.
    const b2 = await batch(tmp, 'run2', { shards: 3, limit: 4 });
    const M2 = JSON.parse(fs.readFileSync(path.join(b2.out, 'reports', id + '.json'), 'utf8'));
    check('limit: 4 flops, status partial (server: stopped)', M2.status === 'partial' && M2.results.length === 4 && R.statusOf(M2).status === 'stopped');
    check('manifest: partial report', b2.manifest.reports[0].status === 'partial' && b2.manifest.reports[0].done === 4);
    const b3 = await batch(tmp, 'run3', { base: b2.out, shards: 20 });
    check('incremental: plan has only the 21 missing flops, 20 shards', b3.todo.length === 21 && b3.n === 20);
    const M3 = JSON.parse(fs.readFileSync(path.join(b3.out, 'reports', id + '.json'), 'utf8'));
    check('incremental: base + new = the local run', M3.status === 'done' && strip(M3) === strip(L) && M3.createdAt === M2.createdAt);
    const b4 = await batch(tmp, 'run4', { base: b3.out, shards: 20 });
    check('incremental: nothing left -> no shards', b4.todo.length === 0 && b4.n === 0);
    const M4 = JSON.parse(fs.readFileSync(path.join(b4.out, 'reports', id + '.json'), 'utf8'));
    check('no shards: base copied unchanged', JSON.stringify(M4) === JSON.stringify(M3));

    // Force: a new plan (new createdAt) replaces the base report.
    await tick();
    const b5 = await batch(tmp, 'run5', { base: b2.out, shards: 2, force: true, limit: 3 });
    const M5 = JSON.parse(fs.readFileSync(path.join(b5.out, 'reports', id + '.json'), 'utf8'));
    check('force: old results left out, new plan only', M5.results.length === 3 && M5.createdAt !== M2.createdAt && b5.todo.length === 3);

    // Samples: union, newer sample wins, manifest counts per group.
    const S = (d) => path.join(tmp, 'samples', d, 'realization-samples');
    const put = (d, rel, s) => { const f = path.join(S(d), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(s)); };
    put('base', '6max-aaa/111111111111/Ah7d2c.json', { createdAt: '2026-01-01T00:00:00Z', group: 'SRP BTN vs BB', v: 'old' });
    put('base', '6max-aaa/111111111111/Ks9h4h.json', { createdAt: '2026-01-01T00:00:00Z', group: 'SRP BTN vs BB', v: 'base' });
    put('s1', '6max-aaa/111111111111/Ah7d2c.json', { createdAt: '2026-02-01T00:00:00Z', group: 'SRP BTN vs BB', v: 'new' });
    put('s2', '6max-aaa/222222222222/9h8h7h.json', { createdAt: '2026-02-01T00:00:00Z', group: '3BP CO vs BB', v: 's2' });
    put('s2', 'hu-xyz/333333333333/9h8h7h.json', { createdAt: '2026-02-01T00:00:00Z', terminalKey: 'SB:Raise 2.5/BB:Call', v: 'hu' });
    put('s2', '6max-aaa/111111111111/Ks9h4h.json', { createdAt: '2025-12-01T00:00:00Z', group: 'SRP BTN vs BB', v: 'older' });
    const out = path.join(tmp, 'samples', 'out');
    const man = mergeData({ out, inputs: ['base', 's1', 's2'].map((d) => ({ dir: path.dirname(S(d)), base: d === 'base' })), log: quiet });
    const rd = (rel) => JSON.parse(fs.readFileSync(path.join(out, 'realization-samples', rel), 'utf8')).v;
    check('samples: newer wins, older stays out', rd('6max-aaa/111111111111/Ah7d2c.json') === 'new' && rd('6max-aaa/111111111111/Ks9h4h.json') === 'base');
    const cnt = (g) => (man.samples.find((x) => x.group === g) || {}).count;
    check('manifest: sample groups with counts', man.totals.samples === 4 && cnt('SRP BTN vs BB') === 2 && cnt('3BP CO vs BB') === 1
      && cnt('SB:Raise 2.5/BB:Call') === 1 && man.samples.find((x) => x.group === 'SB:Raise 2.5/BB:Call').kind === 'hu-preflop');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
