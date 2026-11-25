'use strict';
// In-page stand-in for server.js on the static site (tools/build-web.js, GitHub Pages). It answers the same /api/
// calls (CONTRACT.md) with the JavaScript engines in Web Workers, through the same job code (lib/solves.js).
// Not here: the Rust engine 'postflop' and the idle filler (/api/idle answers 404, so the UI hides it).
const { createSolves } = require('../../lib/solves');
const { files } = require('../../lib/platform');
const { loadEquity } = require('../../lib/equity');
const pushfold = require('../../engines/pushfold/solver');
const hu = require('../../engines/hu-preflop');
const sixmax = require('../../engines/sixmax-preflop');
const postflopJs = require('../../engines/postflop-js');

// Threads per solve: the CPU count, at most 4 (the engines' own limit). 6-max needs SharedArrayBuffer for more
// than one thread, which needs cross-origin isolation (public/browser/sw.js).
const THREADS = Math.max(1, Math.min(4, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2));
const SIX_THREADS = globalThis.crossOriginIsolated ? THREADS : 1;
// A browser tab has less memory than the server: refuse trees above this size (the engine checks it before it builds).
const MAX_MEMORY_MB = 2500;

const engines = {
  'hu-preflop': hu,
  'sixmax-preflop': { ...sixmax, solve: (p, onProgress) => sixmax.solve(p, onProgress, { threads: SIX_THREADS }) },
  'postflop-js': {
    ...postflopJs, title: 'Heads-up postflop (JS)',
    solve: (p, onProgress) => postflopJs.solve({ threads: THREADS, maxMemoryMB: MAX_MEMORY_MB, ...p }, onProgress),
  },
};

// One solve at a time holds a postflop tree (hundreds of MB to 2 GB in this tab).
const solves = createSolves({ engines, maxSolves: 3, maxPostflop: 1 });

function num(v, lo, hi, def) {
  const n = v === null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

async function handle(method, url, body) {
  const p = url.pathname;
  if (p === '/api/engines') return [200, Object.values(engines).map(({ kind, title, params }) => ({ kind, title, params }))];
  if (p === '/api/solve' && method === 'POST') {
    const { kind, params = {} } = body;
    try { return [200, { solveId: solves.start(kind, params) }]; } catch (e) { return [e.status || 500, { error: e.message }]; }
  }
  let m = p.match(/^\/api\/solve\/([\w-]+)$/);
  if (m) { const st = solves.status(m[1]); return st ? [200, st] : [404, { error: 'no such solve' }]; }
  m = p.match(/^\/api\/solve\/([\w-]+)\/node$/);
  if (m) { const r = await solves.node(m[1], url.searchParams.get('id')); return [r.status, r.node || { error: r.error }]; }
  if (p === '/api/pushfold') {
    const q = url.searchParams, { E, W } = await loadEquity();
    return [200, pushfold.solve(E, W, {
      stack: num(q.get('stack'), 1.5, 200, 10), ante: num(q.get('ante'), 0, 2, 0),
      iterations: Math.round(num(q.get('iterations'), 10, 50000, 3000)),
    })];
  }
  return [404, { error: 'not available in browser mode: ' + p }];
}

// fetch() for the UI: /api/ paths are answered here, everything else goes to the network.
async function apiFetch(input, init = {}) {
  const url = new URL(String(input), 'http://page');
  if (!url.pathname.startsWith('/api/')) return fetch(input, init);
  await files.ready();
  let status, out;
  try { [status, out] = await handle((init.method || 'GET').toUpperCase(), url, init.body ? JSON.parse(init.body) : {}); }
  catch (e) { console.error(e); status = 500; out = { error: String((e && e.message) || e) }; }
  return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
}

module.exports = { fetch: apiFetch, THREADS, SIX_THREADS };
