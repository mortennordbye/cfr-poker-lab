'use strict';
// The part of Node's 'worker_threads' that the engines use, on top of Web Workers (static site only, see
// tools/build-web.js). new Worker(file, { workerData, transferList }) starts worker.js, which loads bundle.js and
// runs the module `file`, with parentPort and workerData set like in Node.
//
// The page creates every Web Worker, also the ones a worker asks for: a worker that waits in Atomics.wait
// (sixmax-preflop) could not start a worker of its own. Each worker talks to its creator over its own MessageChannel.
// Messages with __wt carry worker events ('error', 'exit') next to the normal messages.
const g = globalThis;
const isPage = typeof window !== 'undefined';
const init = g.__cfrInit || null; // set by worker.js in a worker: { id, file, workerData, port }

class Emitter {
  constructor() { this._ev = {}; }
  on(ev, fn) { (this._ev[ev] = this._ev[ev] || []).push({ fn, once: false }); return this; }
  once(ev, fn) { (this._ev[ev] = this._ev[ev] || []).push({ fn, once: true }); return this; }
  off(ev, fn) { this._ev[ev] = (this._ev[ev] || []).filter((x) => x.fn !== fn); return this; }
  emit(ev, ...args) {
    const list = this._ev[ev] || [];
    this._ev[ev] = list.filter((x) => !x.once);
    for (const x of list) x.fn(...args);
    return list.length > 0;
  }
  listenerCount(ev) { return (this._ev[ev] || []).length; }
}
Emitter.prototype.addListener = Emitter.prototype.on;
Emitter.prototype.removeListener = Emitter.prototype.off;

// Node-style on/once for native ports (sixmax-preflop/worker.js waits for one message on a MessageChannel port).
if (typeof MessagePort !== 'undefined' && !MessagePort.prototype.once) {
  MessagePort.prototype.on = function on(ev, fn) {
    if (ev === 'message') { this.addEventListener('message', (e) => fn(e.data)); this.start(); }
    return this;
  };
  MessagePort.prototype.once = function once(ev, fn) {
    if (ev === 'message') { this.addEventListener('message', (e) => fn(e.data), { once: true }); this.start(); }
    return this;
  };
}

// ---- page: the real Web Workers ----
const real = new Map(); // id -> { w, parent }
function spawnReal(req, transfer, parent) {
  const w = new g.Worker(g.__cfrBase + 'worker.js');
  real.set(req.id, { w, parent });
  w.onmessage = (e) => {
    const d = e.data;
    if (d && d.__spawn) spawnReal(d.__spawn, d.transfer, req.id);
    else if (d && d.__kill) killTree(d.__kill);
  };
  w.onerror = (e) => console.error('worker error:', e.message);
  w.postMessage({ __init: req, base: g.__cfrBase }, transfer);
}
// Stop a worker and all workers it started (Node stops nested workers with their parent too).
function killTree(id) {
  for (const [cid, r] of real) if (r.parent === id) killTree(cid);
  const r = real.get(id);
  if (r) { r.w.terminate(); real.delete(id); }
}
const kill = (id) => (isPage ? killTree(id) : g.postMessage({ __kill: id }));

let seq = 0;
class Worker extends Emitter {
  constructor(file, opts = {}) {
    super();
    const ch = new MessageChannel();
    this._id = (init ? init.id + '.' : 'w') + ++seq;
    this._exited = false;
    this._port = ch.port1;
    this._port.onmessage = (e) => {
      const d = e.data;
      if (d && d.__wt === 'error') { const err = new Error(d.message); err.stack = d.stack || err.stack; this.emit('error', err); }
      else if (d && d.__wt === 'exit') this._exit(d.code);
      else this.emit('message', d);
    };
    const req = { id: this._id, file: String(file), workerData: opts.workerData === undefined ? null : opts.workerData, port: ch.port2 };
    const transfer = [ch.port2, ...(opts.transferList || [])];
    if (isPage) spawnReal(req, transfer, null);
    else g.postMessage({ __spawn: req, transfer }, transfer);
  }
  _exit(code) {
    if (this._exited) return;
    this._exited = true;
    kill(this._id);
    this._port.close();
    this.emit('exit', code);
  }
  postMessage(msg, transfer) { this._port.postMessage(msg, transfer || []); }
  terminate() {
    if (!this._exited) { kill(this._id); setTimeout(() => this._exit(1)); }
    return Promise.resolve(1);
  }
  ref() { return this; }
  unref() { return this; }
}

// ---- worker side ----
let parentPort = null;
if (init) {
  const port = init.port;
  parentPort = new Emitter();
  const on = parentPort.on, once = parentPort.once;
  const listen = () => { if (!port.onmessage) port.onmessage = (e) => parentPort.emit('message', e.data); };
  parentPort.on = function (ev, fn) { if (ev === 'message') listen(); return on.call(this, ev, fn); };
  parentPort.once = function (ev, fn) { if (ev === 'message') listen(); return once.call(this, ev, fn); };
  parentPort.addListener = parentPort.on;
  parentPort.postMessage = (msg, transfer) => port.postMessage(msg, transfer || []);
  // Node: closing the port lets the worker end. Here the creator stops it (messages sent before still arrive).
  parentPort.close = () => port.postMessage({ __wt: 'exit', code: 0 });
  g.__cfrExit = (code) => { port.postMessage({ __wt: 'exit', code: code | 0 }); g.close(); };
  const fail = (err) => {
    port.postMessage({ __wt: 'error', message: String((err && err.message) || err), stack: err && err.stack });
    port.postMessage({ __wt: 'exit', code: 1 });
  };
  g.addEventListener('error', (e) => fail(e.error || e.message));
  g.addEventListener('unhandledrejection', (e) => fail(e.reason));
}

function receiveMessageOnPort() { throw new Error('receiveMessageOnPort is not available in the browser'); }

module.exports = {
  Worker, MessageChannel: g.MessageChannel, MessagePort: g.MessagePort, receiveMessageOnPort,
  isMainThread: !init, parentPort, workerData: init ? init.workerData : null, threadId: init ? init.id : 0,
};
