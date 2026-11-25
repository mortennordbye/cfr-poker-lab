'use strict';
// Tests for the 6-max preflop engine. Run: node engines/sixmax-preflop/test.js
// Realization samples go to a new temp dir (set before lib/realization.js loads), so the real cache is not touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sixmax-test-'));
process.env.REALIZATION_SAMPLES_DIR = path.join(TMP, 'realization-samples');
const eng = require('./index');
const RZ = require('../../lib/realization');
const { saveSample: saveJobSample, validSource } = require('../../lib/solves');
const { sha1 } = require('../../lib/platform');
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

  // 4) Calibration: terminal fields, mass, and 0 samples = exactly the old (flat) result.
  check('flop terminal has spotKey, key, group, name, mass', f.terminal.spotKey === eng.spotKey({}) && /^6max-[0-9a-f]{12}$/.test(f.terminal.spotKey)
    && f.terminal.key === f.id && f.terminal.group === 'SRP UTG vs BB' && f.terminal.name === 'SRP UTG vs BB (UTG 2.5 / BB call)' && f.terminal.mass > 0,
    `${f.terminal.group} | ${f.terminal.name} | mass ${f.terminal.mass}`);
  const g3 = r.getNode('F-F-F-R2.5-F-R10-C');
  check('3-bet pot group: IP first', !!g3 && !!g3.terminal && g3.terminal.group === '3BP BTN vs BB', g3 && g3.terminal && g3.terminal.group);
  let massSum = 0;
  for (const n of nodes) if (n.terminal && n.terminal.mass !== undefined) massSum += n.terminal.mass;
  check('reach mass of flop terminals is positive and below 1', massSum > 0.05 && massSum < 1.01, massSum.toFixed(4));
  const cal = r.stats.calibration;
  check('calibration info: flat, groups sorted by reach', !!cal && cal.source === 'flat' && cal.groups.length === 45 && cal.terminals.length === 12
    && cal.groups[0].mass >= cal.groups[1].mass && /^flat/.test(r.stats.realization), cal && `${cal.groups[0].name} ${cal.groups[0].mass}; ${r.stats.realization}`);
  const solveKey = { ...eng.normalizeParams({}) }; delete solveKey.maxSeconds; delete solveKey.realization;
  check('cache file without samples = the old key', path.basename(eng.cacheFile({}, null)) === `sixmax-preflop-${sha1(JSON.stringify({ v: 5, P: solveKey })).slice(0, 16)}.json`);

  const IT = 100;
  const same = (a, b) => { if (a.length !== b.length) return Infinity; let d = 0; for (let i = 0; i < a.length; i++) if (!(a[i] === b[i] || (a[i] !== a[i] && b[i] !== b[i]))) d++; return d; };
  const flat = await eng.solve({ iterations: IT, realization: 'flat' }, () => {}, { noCache: true, raw: true });
  const cal0 = await eng.solve({ iterations: IT }, () => {}, { noCache: true, raw: true });
  const groups = [...new Set(nodes.filter((n) => n.terminal && n.terminal.group).map((n) => n.terminal.group))];
  const pos = (g) => { const m = g.match(/^\S+ (\S+) vs (\S+)$/); return { ip: m[1], oop: m[2] }; };
  const flatTable = { version: 'flat', info: 'test', counts: {}, groups: Object.fromEntries(groups.map((g) => {
    const { ip, oop } = pos(g);
    return [g, { ip, oop, [ip]: new Array(169).fill(1.0), [oop]: new Array(169).fill(0.88), n: 1, m: 0.1 }];
  })) };
  const calF = await eng.solve({ iterations: IT }, () => {}, { noCache: true, raw: true, table: flatTable });
  check('0 samples = exactly the flat result', same(flat.raw.data, cal0.raw.data) === 0 && /^flat/.test(cal0.stats.realization), cal0.stats.realization);
  check('table with flat R in every group = exactly the flat result', same(flat.raw.data, calF.raw.data) === 0 && calF.stats.calibratedGroups === 45,
    `${calF.stats.calibratedGroups} groups, matrices ${calF.stats.matrixMB} MB per thread`);
  // More IP realization in SRP BTN vs BB (and BTN vs SB) makes BTN open more.
  const up = { version: 'up', info: 'test', counts: { 'SRP BTN vs BB': 20, 'SRP BTN vs SB': 20 }, groups: {
    'SRP BTN vs BB': { ip: 'BTN', oop: 'BB', BTN: new Array(169).fill(1.15), BB: new Array(169).fill(0.8), n: 20, m: 0.8, BTNavg: 1.15, BBavg: 0.8 },
    'SRP BTN vs SB': { ip: 'BTN', oop: 'SB', BTN: new Array(169).fill(1.15), SB: new Array(169).fill(0.8), n: 20, m: 0.8, BTNavg: 1.15, SBavg: 0.8 },
  } };
  const calUp = await eng.solve({ iterations: IT }, () => {}, { noCache: true, table: up });
  const btnFlat = 1 - freqs(flat.getNode('F-F-F'))[0], btnUp = 1 - freqs(calUp.getNode('F-F-F'))[0];
  check('higher IP R for BTN groups: BTN opens more', btnUp > btnFlat + 0.01, `${(100 * btnFlat).toFixed(1)}% -> ${(100 * btnUp).toFixed(1)}%`);
  const tUp = calUp.getNode('F-F-F-R2.5-F-C').terminal;
  check('calibrated terminal is marked', tUp.calibrated === true && /2 groups/.test(calUp.stats.realization) && calUp.stats.calibration.source === 'samples', calUp.stats.realization);
  check('calibrated solve: exploitability below 5% pot (100 iterations)', calUp.stats.exploitabilityPctPot < 5, calUp.stats.exploitabilityPctPot.toFixed(3) + '%');

  // 5) lib/realization.js groups on synthetic samples (temp dir).
  const o = { dir: path.join(TMP, 'rz') };
  const SK = '6max-test';
  const combos = { AA: 'AsAh', '72o': '7c2d', KK: 'KsKh' };
  const mk = (terminalKey, board, rIp, rOop, group, ip, oop, createdAt = '2026-11-01T00:00:00Z') => {
    const ranges = { [ip]: { AA: 1, '72o': 1 }, [oop]: { KK: 1, '72o': 1 } };
    const ev = { [ip]: { [combos.AA]: 10 * 0.8 * rIp, [combos['72o']]: 10 * 0.2 * rIp }, [oop]: { [combos.KK]: 10 * 0.6 * rOop, [combos['72o']]: 10 * 0.3 * rOop } };
    const eq = { [ip]: { [combos.AA]: 0.8, [combos['72o']]: 0.2 }, [oop]: { [combos.KK]: 0.6, [combos['72o']]: 0.3 } };
    return { terminalKey, board, pot: 10, rangesHash: RZ.rangesHash(ranges), ranges, createdAt, ev, eq, group, ip, oop,
      solver: { iterations: 1, exploitabilityPctPot: 0.1, eqSource: 'engine' } };
  };
  check('group table: 0 samples gives no table', RZ.buildGroupTable(SK, o) === null);
  RZ.saveSample(SK, mk('T1', '8c5d2h', 1.2, 0.7, 'SRP BTN vs BB', 'BTN', 'BB'), o);
  RZ.saveSample(SK, mk('T2', '8c5d2h', 1.2, 0.7, 'SRP BTN vs BB', 'BTN', 'BB'), o); // other terminal, same board: counts too
  RZ.saveSample(SK, mk('T3', '8c5d2h', 0.9, 0.9, '3BP BB vs SB', 'BB', 'SB'), o);
  RZ.saveSample(SK, { ...mk('H1', '8c5d2h', 2, 2, 'x', 'SB', 'BB'), group: undefined, ip: undefined, oop: undefined }, o); // heads-up style: ignored
  const gt = RZ.buildGroupTable(SK, { ...o, rIp: 1, rOop: 0.88 });
  const ci = (h) => IDX[h];
  const e = gt.groups['SRP BTN vs BB'];
  const m2 = 2 / 7, expAA = m2 * 1.2 + (1 - m2) * 1, expKK = m2 * 0.7 + (1 - m2) * 0.88;
  check('group table: two terminals pooled, m = n / (n + 5)', !!e && e.n === 2 && e.terminals === 2 && Math.abs(e.m - m2) < 1e-3 && e.ip === 'BTN' && e.oop === 'BB',
    e && `n ${e.n}, m ${e.m}, terminals ${e.terminals}`);
  check('group table: R per position', Math.abs(e.BTN[ci('AA')] - expAA) < 1e-3 && Math.abs(e.BB[ci('KK')] - expKK) < 1e-3 && Math.abs(e.BTN[ci('72o')] - expAA) < 1e-3,
    `BTN AA ${e.BTN[ci('AA')]} (exp ${expAA.toFixed(4)}), BB KK ${e.BB[ci('KK')]} (exp ${expKK.toFixed(4)})`);
  check('group table: groups kept apart, samples without group ignored', Object.keys(gt.groups).length === 2 && gt.counts['3BP BB vs SB'] === 1 && /3 flop samples in 2 groups/.test(gt.info), gt.info);
  check('group sample count', RZ.groupSampleCount(SK, 'SRP BTN vs BB', o) === 2 && RZ.groupSampleCount(SK, 'none', o) === 0);
  // Same terminal, new ranges: the old sample counts half (mismatch weight), the new one fully.
  const nw = mk('T1', '9c6d3h', 2.0, 0.7, 'SRP BTN vs BB', 'BTN', 'BB');
  nw.ranges = { BTN: { AA: 0.5, '72o': 1 }, BB: { KK: 1, '72o': 1 } }; nw.rangesHash = RZ.rangesHash(nw.ranges);
  RZ.saveSample(SK, nw, o);
  const gr = RZ.groupR(RZ.loadSamples(SK, o).filter((x) => x.group === 'SRP BTN vs BB'), { ip: 'BTN', oop: 'BB', mixK: 0, currentRanges: { T1: nw.ranges } });
  check('group R: current ranges per terminal', gr.n === 3 && gr.BTN[ci('AA')] > 1.2 && gr.BTN[ci('AA')] < 2.0, `AA ${gr.BTN[ci('AA')]}`);

  // 6) Sample hook (lib/solves.js): a postflop solve from a 6-max terminal saves a sample with its group.
  check('source: sixmax needs a group, spotKey must be a plain name', !validSource({ kind: 'sixmax-preflop', spotKey: 'a', terminalKey: 'b' })
    && !!validSource({ kind: 'sixmax-preflop', spotKey: 'a', terminalKey: 'b', group: 'g' })
    && !!validSource({ kind: 'hu-preflop', spotKey: 'a', terminalKey: 'b' }) && !validSource({ kind: 'hu-preflop', spotKey: '../x', terminalKey: 'b' }));
  const ft = f.terminal;
  const rootEv = { oop: { KsKh: 5 }, ip: { AsAh: 7 } }, rootEq = { oop: { KsKh: 0.5 }, ip: { AsAh: 0.6 } };
  const job = { source: { kind: 'sixmax-preflop', spotKey: ft.spotKey, terminalKey: ft.key, group: ft.group },
    params: { board: 'Jd8s7c', pot: ft.flop.pot, stack: ft.flop.stack, oop: ft.flop.oop, ip: ft.flop.ip, ranges: ft.flop.ranges },
    result: { stats: { rootEv, rootEq, iterations: 10, exploitabilityPctPot: 0.5 } } };
  await saveJobSample(job, (x) => x, () => {});
  const saved = job.sample && job.sample.file ? JSON.parse(fs.readFileSync(job.sample.file, 'utf8')) : null;
  check('sample hook: file under the temp dir with group and positions', !!saved && job.sample.file.startsWith(TMP) && saved.group === 'SRP UTG vs BB'
    && saved.ip === 'UTG' && saved.oop === 'BB' && saved.ev.UTG.AsAh === 7 && job.sample.flops === 1 && job.sample.group === 'SRP UTG vs BB', JSON.stringify(job.sample));
  const withSample = RZ.buildGroupTable(ft.spotKey, { rIp: 1, rOop: 0.88 });
  check('sample hook: the engine table sees the sample', !!withSample && withSample.counts['SRP UTG vs BB'] === 1);

  fs.rmSync(TMP, { recursive: true, force: true }); // only the temp dir this test made
  console.log(`${fails ? 'FAILED' : 'OK'} (${fails} failures) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
