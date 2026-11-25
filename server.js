'use strict';
// Generic server: loads every engine in engines/*/index.js and serves public/. See CONTRACT.md.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadEquity } = require('./lib/equity');
const pushfold = require('./engines/pushfold/solver');
const RZ = require('./lib/realization');
const { createIdleFiller } = require('./idle');

const PORT = Number(process.env.PORT) || 8787;
// 127.0.0.1 by default: the app has no login. The container sets 0.0.0.0 and publishes the port on loopback only.
const HOST = process.env.HOST || '127.0.0.1';
// Finished solves kept in memory (a flop solve holds ~1.6 GB). The container lowers this.
const MAX_SOLVES = Math.max(1, Number(process.env.MAX_SOLVES) || 4);
// Finished postflop solves kept (each holds a solver process with 1.5 to 3 GB). Default: no extra limit.
const MAX_POSTFLOP_SOLVES = Math.max(1, Number(process.env.MAX_POSTFLOP_SOLVES) || Infinity);
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Load engines that exist. A broken engine must not stop the others.
const engines = {};
for (const dir of fs.readdirSync(path.join(__dirname, 'engines'))) {
  const file = path.join(__dirname, 'engines', dir, 'index.js');
  if (!fs.existsSync(file)) continue;
  if ((process.env.SKIP_ENGINES || '').split(',').includes(dir)) { console.log(`engine skipped: ${dir}`); continue; } // for tests
  try { const e = require(file); engines[e.kind] = e; console.log(`engine loaded: ${e.kind}`); }
  catch (err) { console.error(`engine ${dir} failed to load:`, err.message); }
}

const solves = new Map(); // solveId -> { status, progress, message, result, error, kind, source, sample }

const idle = createIdleFiller({
  engines,
  isBusy: () => [...solves.values()].some((j) => j.status === 'running'),
  idleMs: Number(process.env.IDLE_MS) || 5 * 60e3,
  solveParams: process.env.IDLE_SOLVE_PARAMS ? JSON.parse(process.env.IDLE_SOLVE_PARAMS) : {}, // test override
  kind: process.env.IDLE_KIND || null, // test override; default 'postflop' if loaded, else 'postflop-js'
  settingsFile: path.join(__dirname, 'cache', 'idle.json'),
});

// A postflop solve started from a hu-preflop flop terminal (params.source) saves a realization sample.
async function saveSample(job) {
  const src = job.source, st = job.result && job.result.stats;
  const P = { ...job.params, ...((job.result && job.result.params) || {}) };
  const board = String(P.board || '').replace(/\s+/g, '');
  if (!st || !st.rootEv) { job.sample = { error: 'engine gave no rootEv' }; return; }
  if (board.length !== 6) { job.sample = { error: 'samples are for flop solves only' }; return; }
  const oop = P.oop || 'BB', ip = P.ip || 'SB';
  const ranges = job.params.ranges;
  const eq = st.rootEq ? null : await RZ.flopEquitiesAsync(board, ranges, oop, ip);
  const sample = RZ.makeSample({ terminalKey: src.terminalKey, board, pot: P.pot, ranges, stats: st, oop, ip, eq });
  const file = RZ.saveSample(src.spotKey, sample);
  job.sample = file ? { file: path.relative(__dirname, file), flops: RZ.sampleCount(src.spotKey, src.terminalKey) } : { skipped: 'a newer sample exists' };
  console.log(`realization sample ${file ? 'saved: ' + path.relative(__dirname, file) : 'skipped (newer exists)'} (${src.terminalKey} ${board})`);
}

// Per-combo calibration data (rootEv, rootEq) is large and only used on the server: leave it out of status answers.
function slimStats(st) {
  if (!st || (!st.rootEv && !st.rootEq)) return st;
  const { rootEv, rootEq, ...rest } = st;
  return rest;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}
function num(v, lo, hi, def) {
  const n = v === null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

loadEquity().then(({ E, W }) => {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/') && p !== '/api/idle') idle.touch();
      if (p === '/api/idle') {
        if (req.method === 'POST') { const b = await readBody(req); if (b.enabled !== undefined) idle.setEnabled(!!b.enabled); }
        return json(res, 200, idle.status());
      }
      if (p === '/api/engines') {
        return json(res, 200, Object.values(engines).map(({ kind, title, params }) => ({ kind, title, params })));
      }
      if (p === '/api/solve' && req.method === 'POST') {
        const { kind, params = {} } = await readBody(req);
        const engine = engines[kind];
        if (!engine) return json(res, 400, { error: `unknown kind: ${kind}` });
        const solveId = crypto.randomUUID();
        const { source, ...engineParams } = params || {};
        const src = source && source.kind === 'hu-preflop' && source.spotKey && source.terminalKey ? source : null;
        if (kind === 'hu-preflop') idle.noteHuSpot(params);
        const job = { kind, params, source: src, sample: null, status: 'running', progress: 0, message: 'starting', result: null, error: null };
        solves.set(solveId, job);
        // Keep memory bounded: a flop solve can use 1.5 to 3 GB. Drop the oldest finished solves,
        // and (before a new postflop solve starts) the oldest finished postflop solves over their own limit.
        const drop = (id, j) => {
          solves.delete(id);
          // Engines that hold resources (e.g. a solver process) free them here.
          if (j.result && typeof j.result.dispose === 'function') { try { j.result.dispose(); } catch (e) { /* ignore */ } }
        };
        for (const [id, j] of solves) {
          if (solves.size <= MAX_SOLVES) break;
          if (j.status !== 'running') drop(id, j);
        }
        if (kind.startsWith('postflop')) {
          const done = [...solves].filter(([id, j]) => id !== solveId && j.kind.startsWith('postflop') && j.status !== 'running');
          // The new solve counts too, so keep MAX_POSTFLOP_SOLVES - 1 old ones.
          for (const [id, j] of done.slice(0, Math.max(0, done.length - (MAX_POSTFLOP_SOLVES - 1)))) drop(id, j);
        }
        engine.solve(engineParams, (progress, message) => { job.progress = progress; if (message) job.message = message; })
          .then(async (result) => {
            job.result = result;
            if (src) { try { await saveSample(job); } catch (e) { job.sample = { error: e.message }; console.error('realization sample failed:', e); } }
            job.status = 'done'; job.progress = 1; job.message = 'done';
          })
          .catch((err) => { job.status = 'error'; job.error = String((err && err.stack) || err); console.error(err); });
        return json(res, 200, { solveId });
      }
      let m = p.match(/^\/api\/solve\/([\w-]+)$/);
      if (m) {
        const job = solves.get(m[1]);
        if (!job) return json(res, 404, { error: 'no such solve' });
        return json(res, 200, { kind: job.kind, params: job.params, status: job.status, progress: job.progress, message: job.message, error: job.error,
          stats: job.result && slimStats(job.result.stats), root: job.result && job.result.root, sample: job.sample });
      }
      m = p.match(/^\/api\/solve\/([\w-]+)\/node$/);
      if (m) {
        const job = solves.get(m[1]);
        if (!job || !job.result) return json(res, 404, { error: 'solve not ready' });
        const node = await job.result.getNode(url.searchParams.get('id') || job.result.root); // may be sync or a Promise
        if (!node) return json(res, 404, { error: 'no such node' });
        return json(res, 200, node);
      }
      if (p === '/api/pushfold') {
        const q = url.searchParams;
        return json(res, 200, pushfold.solve(E, W, {
          stack: num(q.get('stack'), 1.5, 200, 10), ante: num(q.get('ante'), 0, 2, 0),
          iterations: Math.round(num(q.get('iterations'), 10, 50000, 3000)),
        }));
      }
      // Static files from public/
      const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
      const file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      console.error(err);
      json(res, 500, { error: String(err.message || err) });
    }
  }).listen(PORT, HOST, () => console.log(`Solver running at http://localhost:${PORT}` + (HOST !== '127.0.0.1' ? ` (listening on ${HOST})` : '')));
});
