'use strict';
// Generic server: loads every engine in engines/*/index.js and serves public/. See CONTRACT.md.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEquity } = require('./lib/equity');
const pushfold = require('./engines/pushfold/solver');
const { createSolves } = require('./lib/solves');
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

const idle = createIdleFiller({
  engines,
  isBusy: () => solves.isBusy(),
  idleMs: Number(process.env.IDLE_MS) || 5 * 60e3,
  solveParams: process.env.IDLE_SOLVE_PARAMS ? JSON.parse(process.env.IDLE_SOLVE_PARAMS) : {}, // test override
  kind: process.env.IDLE_KIND || null, // test override; default 'postflop' if loaded, else 'postflop-js'
  settingsFile: path.join(__dirname, 'cache', 'idle.json'),
});

const solves = createSolves({
  engines, maxSolves: MAX_SOLVES, maxPostflop: MAX_POSTFLOP_SOLVES,
  onStart: (kind, params) => { if (kind === 'hu-preflop') idle.noteHuSpot(params); },
  rel: (file) => path.relative(__dirname, file),
});

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
        try { return json(res, 200, { solveId: solves.start(kind, params) }); }
        catch (e) { if (e.status === 400) return json(res, 400, { error: e.message }); throw e; }
      }
      let m = p.match(/^\/api\/solve\/([\w-]+)$/);
      if (m) {
        const st = solves.status(m[1]);
        return st ? json(res, 200, st) : json(res, 404, { error: 'no such solve' });
      }
      m = p.match(/^\/api\/solve\/([\w-]+)\/node$/);
      if (m) {
        const r = await solves.node(m[1], url.searchParams.get('id'));
        return json(res, r.status, r.node || { error: r.error });
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
