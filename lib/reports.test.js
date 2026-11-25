'use strict';
// Run: node lib/reports.test.js   (exit code 1 on failure). Fast: uses fake engines, no real solves.
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./reports');
const { flopSubset } = require('./flops');

let failed = 0;
function check(name, ok, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
  if (!ok) failed++;
}
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e;

// ---- texture ----
const t1 = R.texture('Ah7d2c'), t2 = R.texture('KsKd5s'), t3 = R.texture('9h8h7h'), t4 = R.texture('QcQdQh');
check('texture rainbow unpaired A-high', t1.suits === 'rainbow' && t1.pairing === 'unpaired' && t1.high === 'A' && t1.highRank === 12, JSON.stringify(t1));
check('texture two-tone paired K-high', t2.suits === 'two-tone' && t2.pairing === 'paired' && t2.high === 'K');
check('texture monotone 9-high', t3.suits === 'monotone' && t3.pairing === 'unpaired' && t3.high === '9' && t3.ranks.join() === '7,6,5');
check('texture trips', t4.pairing === 'trips' && t4.suits === 'rainbow');
let threw = false;
try { R.texture('AhAh2c'); } catch (e) { threw = true; }
check('texture rejects a repeated card', threw);

// ---- action frequencies (weighted by reach) ----
const node = {
  toAct: 'BB',
  actions: [{ label: 'Check', type: 'check', amount: 0 }, { label: 'Bet 2', type: 'bet', amount: 2 }, { label: 'Allin 97', type: 'allin', amount: 97 }],
  hands: { AsAh: { weight: 1, strategy: [0, 1, 0] }, '7c2d': { weight: 0.5, strategy: [1, 0, 0] }, KsKh: { weight: 0.5, strategy: [0, 0.5, 0.5] } },
};
const f = R.actionFreqs(node);
// total weight 2: check 0.5/2 = 0.25, bet (1 + 0.25)/2 = 0.625, allin 0.25/2 = 0.125
check('action frequencies by reach weight', near(f.actions[0].freq, 0.25) && near(f.actions[1].freq, 0.625) && near(f.actions[2].freq, 0.125), JSON.stringify(f.actions.map((a) => a.freq)));
check('bet share = bet + raise + allin', near(f.bet, 0.75) && f.player === 'BB');
check('no actions -> null', R.actionFreqs({ actions: [], hands: {} }) === null && R.actionFreqs(null) === null);

// ---- summary ----
const mk = (board, bet, ipBet, evOop, eqOop, extra = []) => ({
  board, texture: R.texture(board),
  oop: { actions: [{ label: 'Check', type: 'check', amount: 0, freq: 1 - bet }, { label: 'Bet 2', type: 'bet', amount: 2, freq: bet }, ...extra], bet },
  ip: ipBet === null ? null : { actions: [{ label: 'Check', type: 'check', amount: 0, freq: 1 - ipBet }, { label: 'Bet 2', type: 'bet', amount: 2, freq: ipBet }], bet: ipBet },
  ev: { oop: evOop, ip: 5 - evOop }, eq: { oop: eqOop, ip: 1 - eqOop }, exploitabilityPctPot: 0.5,
});
const res = [
  mk('Ah7d2c', 0.2, 0.6, 2, 0.45),
  mk('Ks9h4h', 0.4, 0.5, 2.2, 0.47),
  mk('9h8h7h', 0.6, null, 2.6, 0.52, [{ label: 'Bet 4', type: 'bet', amount: 4, freq: 0 }]),
  mk('KsKd5s', 0.0, 0.8, 1.8, 0.44),
];
const S = R.summarize(res);
const g = (k) => S.find((x) => x.key === k);
check('summary: all flops row', g('all') && g('all').n === 4 && near(g('all').oop.bet, 0.3) && near(g('all').ev.oop, 2.15), JSON.stringify(g('all') && { bet: g('all').oop.bet, ev: g('all').ev }));
check('summary: IP mean only over flops with an IP node', g('all').ip.n === 3 && near(g('all').ip.bet, (0.6 + 0.5 + 0.8) / 3));
check('summary: action missing on a flop counts as 0', near(g('all').oop.actions.find((a) => a.label === 'Bet 4').freq, 0) && g('all').oop.actions.length === 3);
check('summary: action frequencies still add to 1', near(g('all').oop.actions.reduce((s, a) => s + a.freq, 0), 1));
check('summary: texture groups', g('monotone').n === 1 && g('two-tone').n === 2 && g('rainbow').n === 1 && g('paired').n === 1 && g('unpaired').n === 3);
check('summary: high-card groups', g('high-A').n === 1 && g('high-K').n === 2 && g('high-9').n === 1 && !g('high-Q'));
check('summary: EV and equity of both players', near(g('two-tone').ev.oop, 2) && near(g('two-tone').ev.ip, 3) && near(g('two-tone').eq.oop + g('two-tone').eq.ip, 1));
check('summary: empty groups left out', S.every((x) => x.n > 0));

// ---- input ----
const a = R.normalizeInput({ kind: 'hu-preflop', params: { stack: 100 }, terminalKey: 'SB:Raise 2.5/BB:Call' });
const b = R.normalizeInput({ kind: 'hu-preflop', params: { stack: 100 }, terminalKey: 'SB:Raise 2.5/BB:Call', flops: 25, tree: { threads: 4 } });
const c = R.normalizeInput({ kind: 'hu-preflop', params: { stack: 100 }, terminalKey: 'SB:Raise 2.5/BB:Call', flops: 49 });
check('defaults: 25 flops, target 1% pot, 8 threads', a.flops === 25 && a.tree.targetExploitability === 1 && a.tree.threads === 8);
check('report id: same input -> same id, threads do not count', R.reportId(a) === R.reportId(b));
check('report id: other flop count -> other id', R.reportId(a) !== R.reportId(c));
const bad = (x) => { try { R.normalizeInput(x); return false; } catch (e) { return e.status === 400; } };
check('bad input -> status 400', bad({ kind: 'x', terminalKey: 'a' }) && bad({ kind: 'hu-preflop' }) && bad({ kind: 'hu-preflop', terminalKey: 'a', flops: 30 })
  && bad({ spot: { ranges: { BB: 'AA' } } }) && bad({ spot: { ranges: { BB: 'AA', SB: 'KK' }, pot: 0, stack: 10 } }));

// ---- runner with fake engines: full run, a stopped run, resume ----
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
function fakePostflop(o = {}) {
  let calls = 0;
  return {
    kind: 'postflop', calls: () => calls,
    async solve(P) {
      calls++;
      if (o.hangAt && calls === o.hangAt) return new Promise(() => {}); // the process "dies" here
      const hi = R.texture(P.board).highRank / 12; // bet more on high boards: checks the aggregation is per flop
      const root = { id: 'r', toAct: P.oop, actions: [{ label: 'Check', type: 'check', child: 'r.0' }, { label: 'Bet 1.65', type: 'bet', child: 'r.1' }],
        hands: { AsAh: { weight: 1, strategy: [1 - hi, hi] } } };
      const ipNode = { id: 'r.0', toAct: P.ip, actions: [{ label: 'Check', type: 'check' }, { label: 'Bet 1.65', type: 'bet' }],
        hands: { KsKh: { weight: 1, strategy: [0.5, 0.5] } } };
      const nodes = { r: root, 'r.0': ipNode };
      return {
        root: 'r', getNode: async (id) => nodes[id] || null, dispose() {},
        stats: { iterations: 10, exploitabilityPctPot: 0.8, evOop: 2 + hi, evIp: 3 - hi, eqOop: 0.5, eqIp: 0.5,
          rootEv: { oop: { AsAh: 3 }, ip: { KsKh: 2 } }, rootEq: { oop: { AsAh: 0.8 }, ip: { KsKh: 0.2 } } },
      };
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
async function waitFor(fn, ms = 5000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await tick(); } return true; }

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-test-'));
  const RZ = require('./realization');
  const quiet = () => {};
  try {
    const input = { kind: 'hu-preflop', params: { stack: 100 }, terminalKey: 'SB:Raise 2.5/BB:Call', flops: 25 };
    // Run 1 stops at flop 8 (like a killed process).
    const pf1 = fakePostflop({ hangAt: 8 });
    const rep1 = R.createReports({ engines: { 'hu-preflop': fakePreflop, postflop: pf1 }, dir, samples: false, log: quiet });
    const { reportId } = rep1.start(input);
    check('start returns a 16-hex report id', /^[0-9a-f]{16}$/.test(reportId));
    check('running report has partial results', await waitFor(() => (rep1.status(reportId) || {}).done === 7), JSON.stringify((({ status, done, total }) => ({ status, done, total }))(rep1.status(reportId))));
    const p1 = rep1.status(reportId);
    check('partial status: running, 7/25, progress, current board', p1.status === 'running' && p1.total === 25 && near(p1.progress, 7 / 25, 0.01) && p1.current === flopSubset(25)[7]);
    check('spot comes from the terminal', p1.spot.pot === 5 && p1.spot.stack === 97.5 && p1.spot.source.terminalKey === 'SB:Raise 2.5/BB:Call' && p1.name === 'Raised pot');
    check('same input while running -> same id, no second job', rep1.start(input).reportId === reportId && rep1.start(input).status === 'running');

    // A new runner (new process) on the same folder: the report is "stopped", start continues it.
    const pf2 = fakePostflop();
    const rep2 = R.createReports({ engines: { 'hu-preflop': fakePreflop, postflop: pf2 }, dir, samples: false, log: quiet });
    check('after a stop: status stopped, results kept', rep2.status(reportId).status === 'stopped' && rep2.status(reportId).done === 7);
    check('list shows the report', rep2.list().length === 1 && rep2.list()[0].id === reportId && rep2.list()[0].done === 7);
    rep2.start(input);
    check('resume finishes', await waitFor(() => rep2.status(reportId).status === 'done'));
    const s = rep2.status(reportId);
    check('resume solves only the missing flops', pf2.calls() === 18, `${pf2.calls()} solves`);
    check('25 results in flop order, no repeats', s.results.length === 25 && s.results.map((x) => x.board).join() === flopSubset(25).join());
    const x0 = s.results[0];
    check('per flop: OOP root and IP after check', x0.oop.player === 'BB' && x0.ip.player === 'SB' && near(x0.ip.bet, 0.5) && near(x0.oop.bet, x0.texture.highRank / 12));
    check('per flop: EV, equity, exploitability, time', near(x0.ev.oop + x0.ev.ip, 5) && near(x0.eq.oop, 0.5) && x0.exploitabilityPctPot === 0.8 && x0.ms >= 0);
    const all = s.summary.find((x) => x.key === 'all');
    const meanBet = s.results.reduce((a, x) => a + x.oop.bet, 0) / 25;
    check('summary over all 25 flops', all.n === 25 && near(all.oop.bet, meanBet), `OOP bet ${all.oop.bet}`);
    const hiA = s.summary.find((x) => x.key === 'high-A');
    check('A-high flops bet the most (fake engine bets with high card)', hiA && near(hiA.oop.bet, 1) && s.summary.find((x) => x.key === 'high-9').oop.bet < hiA.oop.bet);
    check('done report: start again does not solve again', rep2.start(input).status === 'done' && pf2.calls() === 18);

    // Samples: a hu-preflop terminal saves one sample per flop (into the samples folder of lib/realization.js).
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-samples-'));
    const saveSample = RZ.saveSample;
    let saved = 0;
    RZ.saveSample = (spotKey, sample) => { saved++; return saveSample(spotKey, sample, { dir: sdir }); };
    const rep3 = R.createReports({ engines: { 'hu-preflop': fakePreflop, postflop: fakePostflop() }, dir, log: quiet });
    const id3 = rep3.start({ ...input, flops: 49 }).reportId;
    await waitFor(() => rep3.status(id3).status === 'done');
    RZ.saveSample = saveSample;
    check('49 flops: one sample per flop', saved === 49 && RZ.sampleCount('testspot', 'SB:Raise 2.5/BB:Call', { dir: sdir }) === 49 && rep3.status(id3).results[0].sample === 'saved');
    fs.rmSync(sdir, { recursive: true, force: true });

    // Errors: bad terminal key gives an error status, unknown id gives null.
    const rep4 = R.createReports({ engines: { 'hu-preflop': fakePreflop, postflop: fakePostflop() }, dir, log: quiet, logError: quiet });
    const id4 = rep4.start({ ...input, terminalKey: 'SB:Limp/BB:Check' }).reportId;
    await waitFor(() => rep4.status(id4).status === 'error');
    check('missing terminal -> error status', rep4.status(id4).status === 'error' && /not found/.test(rep4.status(id4).error || ''), rep4.status(id4).error);
    check('unknown or bad id -> null', rep4.status('0123456789abcdef') === null && rep4.status('../x') === null);

    // Direct spot input.
    const rep5 = R.createReports({ engines: { postflop: fakePostflop() }, dir, log: quiet });
    const id5 = rep5.start({ spot: { ranges: { BB: 'AA', SB: 'KK' }, pot: 6, stack: 97, oop: 'BB', ip: 'SB' }, flops: 25 }).reportId;
    await waitFor(() => rep5.status(id5).status === 'done');
    check('direct spot report', rep5.status(id5).results.length === 25 && rep5.status(id5).spot.source === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
