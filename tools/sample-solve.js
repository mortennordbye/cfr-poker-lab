'use strict';
// Child process for the idle filler (idle.js): runs one postflop solve, saves a realization sample, reports.
// Runs in its own process so the server can stop it at once (child.kill) when the user comes back.
// Message in: { enginePath, spotKey, terminalKey, params: { board, pot, stack, oop, ip, ranges, ... } }
// Message out: { ok, file, iterations, exploitabilityPctPot, ms } or { error }
const RZ = require('../lib/realization');

process.once('message', async (m) => {
  try {
    const eng = require(m.enginePath);
    const P = m.params;
    const t0 = Date.now();
    const st = eng.solveStats ? await eng.solveStats(P) : (await eng.solve(P)).stats;
    if (!st || !st.rootEv) throw new Error('postflop engine gave no rootEv');
    const eq = st.rootEq ? null : {
      [P.oop]: RZ.flopEquities(P.board, P.ranges[P.oop], P.ranges[P.ip]),
      [P.ip]: RZ.flopEquities(P.board, P.ranges[P.ip], P.ranges[P.oop]),
    };
    const sample = RZ.makeSample({ terminalKey: m.terminalKey, board: P.board, pot: P.pot, ranges: P.ranges, stats: st, oop: P.oop, ip: P.ip, eq });
    const file = RZ.saveSample(m.spotKey, sample);
    process.send({ ok: true, file, iterations: st.iterations, exploitabilityPctPot: st.exploitabilityPctPot, ms: Date.now() - t0 }, () => process.exit(0));
  } catch (e) {
    process.send({ error: String((e && e.stack) || e) }, () => process.exit(1));
  }
});
