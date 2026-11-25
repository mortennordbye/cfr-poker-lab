// Module Web Worker of the static site (tools/build-web.js copies it to postflop/worker.js): one solve of the Rust
// postflop engine (engines/postflop/rs, AGPL-3.0-or-later, WebAssembly build from tools/build-wasm.sh).
// Source: https://github.com/mortennordbye/cfr-poker-lab
// It answers like the native process (rs/src/main.rs), so engines/postflop/index.js handles both the same way:
//   in:  { type: 'start', variant: 'mt' | 'st', threads, config }   then { type: 'query', id, path }
//   out: { type: 'loaded' }, { type: 'info' }, { type: 'progress' }, { type: 'done', stats } or { type: 'error', error,
//        load }, then { id, node } or { id, error }.
// The solve blocks this worker; queries wait in the message queue until it is done (as on stdin).
let wasm = null, engine = null, dead = null, panicText = null;
self.__postflopPanic = (s) => { panicText = String(s); };

const post = (m) => self.postMessage(m);
const memMB = () => { try { return Math.round(wasm.memory.buffer.byteLength / 1048576); } catch (e) { return 0; } };

// A trap (WebAssembly.RuntimeError) after a panic has the panic text; without one it is an allocation that failed.
// postflop-solver panics with "Memory usage exceeds maximum size" when one block is over 2 GB (wasm32): also memory.
function trapText(err) {
  const text = panicText && panicText.replace(/^panicked at [^\n]*:\n?/, '').trim();
  if (text && !/memory usage exceeds|capacity overflow|allocat/i.test(text)) return 'solver error: ' + text;
  return `out of memory: try a smaller tree (the solver stopped at ${memMB()} MB of WebAssembly memory, the browser limit is 4096 MB${text ? '; ' + text : ''})`;
}
const errText = (err) => (err instanceof WebAssembly.RuntimeError ? trapText(err) : String((err && err.message) || err));

async function start(d) {
  let pkg;
  try {
    pkg = await import(`./${d.variant}/postflop_engine.js`);
    wasm = await pkg.default();
    if (d.variant === 'mt') await pkg.initThreadPool(d.threads);
    engine = new pkg.Engine();
  } catch (err) {
    post({ type: 'error', error: 'could not load the WebAssembly solver: ' + errText(err), load: true });
    return;
  }
  post({ type: 'loaded' });
  try {
    const res = engine.solve(d.config, d.threads, (s) => post(JSON.parse(s)));
    post(JSON.parse(res));
  } catch (err) {
    dead = errText(err);
    post({ type: 'error', error: dead });
  }
}

function query(d) {
  if (dead || !engine) { post({ id: d.id, error: dead || 'no solve' }); return; }
  try { post({ id: d.id, node: JSON.parse(engine.node(JSON.stringify(d.path || []))) }); } catch (err) {
    if (err instanceof WebAssembly.RuntimeError) dead = trapText(err);
    post({ id: d.id, error: dead || errText(err) });
  }
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const d = e.data;
  if (!d) return;
  chain = chain.then(() => (d.type === 'start' ? start(d) : d.type === 'query' ? query(d) : null));
};
