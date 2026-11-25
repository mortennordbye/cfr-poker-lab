'use strict';
// In-page stand-in for server.js on the static site (tools/build-web.js, GitHub Pages). It answers the same /api/
// calls (CONTRACT.md) with the engines in Web Workers, through the same job code (lib/solves.js). The Rust engine
// 'postflop' runs as WebAssembly (public/browser/postflop-backend.js), with the same default trees as local mode.
// Not here: the idle filler (/api/idle answers 404, so the UI hides it).
// Flop reports are read-only here: GET /api/reports and /api/report/:id answer from the precomputed data that the
// Pages build puts in data/ (manifest.json, reports/<id>.json; tools/fetch-data.js). POST /api/report needs the server.
const { createSolves } = require('../../lib/solves');
const reportsLib = require('../../lib/reports');
const { files } = require('../../lib/platform');
const { loadEquity } = require('../../lib/equity');
const pushfold = require('../../engines/pushfold/solver');
const hu = require('../../engines/hu-preflop');
const sixmax = require('../../engines/sixmax-preflop');
const postflopJs = require('../../engines/postflop-js');
const postflop = require('../../engines/postflop');
const postflopBackend = require('./postflop-backend');

// Threads per solve: the CPU count, at most 4 (the engines' own limit). 6-max needs SharedArrayBuffer for more
// than one thread, which needs cross-origin isolation (public/browser/sw.js).
const THREADS = Math.max(1, Math.min(4, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2));
const SIX_THREADS = globalThis.crossOriginIsolated ? THREADS : 1;
// A browser tab has less memory than the server: refuse trees above this size (the engine checks it before it builds).
const MAX_MEMORY_MB = 2500;
// WebAssembly (wasm32) memory ends at 4 GB. The tree must fit with room for the rest of the module.
const WASM_MAX_MEMORY_MB = 3600;

const postflopJsSolve = (p, onProgress) => postflopJs.solve({ threads: THREADS, maxMemoryMB: MAX_MEMORY_MB, ...p }, onProgress);

// Rust engine as WebAssembly: always compressed (16-bit storage, half the memory). If the WebAssembly build cannot
// load, the solve runs on postflop-js instead (smaller default trees).
async function postflopSolve(p, onProgress) {
  try {
    return await postflop.solve({ compress: true, maxMemoryMB: WASM_MAX_MEMORY_MB, ...p }, onProgress);
  } catch (e) {
    if (!e.wasmLoad) throw e;
    console.warn('postflop (WebAssembly) did not load, using postflop-js:', e.message);
    if (onProgress) onProgress(0, 'WebAssembly solver not available: using the JavaScript engine');
    return postflopJsSolve(p, onProgress);
  }
}
const WASM = typeof WebAssembly === 'object' && postflopBackend.variant() !== null;

const engines = {
  'hu-preflop': hu,
  ...(WASM ? { postflop: { ...postflop, solve: postflopSolve } } : {}),
  'sixmax-preflop': { ...sixmax, solve: (p, onProgress) => sixmax.solve(p, onProgress, { threads: SIX_THREADS }) },
  'postflop-js': {
    ...postflopJs, title: 'Heads-up postflop (JS)',
    solve: postflopJsSolve,
  },
};

// One finished solve at a time holds a postflop tree (up to 3.6 GB in a worker). Dropping it ends its worker.
const solves = createSolves({ engines, maxSolves: 3, maxPostflop: 1 });

// ---- precomputed reports (data/ next to the page) ----
const dataUrl = (name) => new URL('data/' + name, (globalThis.document && document.baseURI) || globalThis.location.href).href;
let manifestP = null;
function manifest() {
  if (!manifestP) manifestP = fetch(dataUrl('manifest.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return manifestP;
}
// Server shape (lib/reports.js statusOf); an incomplete report says so, it cannot be continued here.
function readOnly(s) {
  if (s.status === 'stopped') s.message = `precomputed: ${s.done} of ${s.total} flops (run it locally to finish)`;
  return s;
}
async function reportList() {
  const m = await manifest();
  return m && Array.isArray(m.reports)
    ? m.reports.map(({ flops, ...e }) => readOnly({ ...e, status: e.status === 'done' ? 'done' : 'stopped' })) : [];
}
async function reportStatus(id) {
  const m = await manifest();
  if (!/^[0-9a-f]{16}$/.test(id) || !m || !(m.reports || []).some((r) => r.id === id)) return null;
  const res = await fetch(dataUrl(`reports/${id}.json`));
  return res.ok ? readOnly(reportsLib.statusOf(await res.json())) : null;
}

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
  if (p === '/api/reports' && method === 'GET') return [200, await reportList()];
  if (p === '/api/report' && method === 'POST') return [404, { error: 'flop reports run in local mode only (node server.js or Docker); this page shows the precomputed ones' }];
  m = p.match(/^\/api\/report\/([\w-]+)$/);
  if (m && method === 'GET') { const r = await reportStatus(m[1]); return r ? [200, r] : [404, { error: 'no such report' }]; }
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

module.exports = { fetch: apiFetch, THREADS, SIX_THREADS, postflopVariant: postflopBackend.variant };
