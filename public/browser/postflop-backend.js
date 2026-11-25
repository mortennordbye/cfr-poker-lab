'use strict';
// Browser backend of the Rust postflop engine (static site only: tools/build-web.js puts it in place of
// engines/postflop/backend.js). Same interface as the native backend, but each solve runs the WebAssembly build of
// engines/postflop/rs in its own module Web Worker (postflop/worker.js, from public/browser/postflop-worker.js).
// The worker answers with the same messages as the native process: info, progress, done, error, node answers.
//
// Two builds (tools/build-wasm.sh): 'mt' runs rayon threads on Web Workers and needs SharedArrayBuffer, so the
// page must be cross-origin isolated (public/browser/sw.js); 'st' is one thread, for pages without isolation.
// Ending a solve ends its worker, which frees all of its memory.
const g = globalThis;
const built = g.__cfrPostflopWasm || {}; // { mt: bool, st: bool }, set by tools/build-web.js
const cpus = Math.max(1, (g.navigator && g.navigator.hardwareConcurrency) || 2);

function variant() {
  if (built.mt && g.crossOriginIsolated) return 'mt';
  return built.st ? 'st' : null;
}

function open(config, { onMessage }) {
  const v = variant();
  const loadError = (msg) => setTimeout(() => onMessage({ type: 'error', error: msg, load: true }));
  if (!v || typeof g.WebAssembly !== 'object') {
    loadError('the WebAssembly solver is not available in this browser');
    return { send() {}, kill() {} };
  }
  let w;
  try { w = new g.Worker(g.__cfrBase + 'postflop/worker.js', { type: 'module', name: 'postflop' }); } catch (e) {
    loadError('could not start the WebAssembly solver: ' + e.message);
    return { send() {}, kill() {} };
  }
  const threads = v === 'mt' ? Math.max(1, config.threads | 0) : 1;
  let loaded = false;
  w.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === 'loaded') { loaded = true; return; }
    onMessage(m);
  };
  // A module that fails to load (404, syntax) gives an error event and no message.
  w.onerror = (e) => {
    if (e.preventDefault) e.preventDefault();
    onMessage({ type: 'error', error: 'WebAssembly solver: ' + (e.message || 'the worker could not load'), load: !loaded });
  };
  w.postMessage({ type: 'start', variant: v, threads, config: JSON.stringify({ ...config, threads }) });
  return {
    send(obj) { w.postMessage({ type: 'query', id: obj.id, path: obj.path }); },
    kill() { w.terminate(); },
  };
}

module.exports = {
  name: 'worker',
  cpus,
  variant,
  ready: () => Promise.resolve(),
  open,
  ensureBinary: () => Promise.resolve(null),
};
