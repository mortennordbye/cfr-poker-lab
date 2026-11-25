'use strict';
// Native backend of the postflop engine (Node): builds the Rust binary in rs/ with cargo when needed and runs one
// solver process per solve, with JSON lines over stdin/stdout (rs/src/main.rs). index.js uses it through open().
// The static site uses public/browser/postflop-backend.js instead (same interface, WebAssembly in a Web Worker):
// tools/build-web.js puts it in place of this file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RS_DIR = path.join(__dirname, 'rs');
// POSTFLOP_BIN: a prebuilt binary (the container image sets it); then cargo is never run.
const PREBUILT = process.env.POSTFLOP_BIN || null;
const BIN = PREBUILT || path.join(RS_DIR, 'target', 'release', process.platform === 'win32' ? 'postflop-engine.exe' : 'postflop-engine');

let buildPromise = null;
function newestMtime(dir) {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestMtime(f) : fs.statSync(f).mtimeMs);
  }
  return t;
}
function needsBuild() {
  if (PREBUILT) return false;
  if (!fs.existsSync(BIN)) return true;
  const bin = fs.statSync(BIN).mtimeMs;
  return newestMtime(path.join(RS_DIR, 'src')) > bin || fs.statSync(path.join(RS_DIR, 'Cargo.toml')).mtimeMs > bin;
}
function ensureBinary(onProgress) {
  if (!needsBuild()) return Promise.resolve(BIN);
  if (buildPromise) return buildPromise;
  if (onProgress) onProgress(0, 'building the Rust solver (first use, about 1 minute)');
  const env = { ...process.env };
  env.PATH = ['/opt/homebrew/opt/rustup/bin', path.join(os.homedir(), '.cargo', 'bin'), env.PATH || ''].join(path.delimiter);
  buildPromise = new Promise((resolve, reject) => {
    const p = spawn('cargo', ['build', '--release'], { cwd: RS_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT'
      ? 'cargo not found: install Rust (https://rustup.rs) or put cargo in PATH, then retry. The postflop-js engine works without Rust.'
      : 'cargo failed to start: ' + e.message)));
    p.on('exit', (code) => (code === 0 && fs.existsSync(BIN) ? resolve(BIN) : reject(new Error('cargo build --release failed:\n' + err))));
  }).finally(() => { buildPromise = null; });
  return buildPromise;
}

const live = new Set();
process.on('exit', () => { for (const c of live) { try { c.kill('SIGKILL'); } catch { /* ignore */ } } });

// Starts one solver with the config. onMessage(m) gets each JSON message; onExit(err) is called once when the solver
// ends. Returns { send(obj), kill() }. In mode 'stats' and 'estimate' the process ends after its last message.
function open(config, { onMessage, onExit }) {
  const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  live.add(child);
  let buf = '', stderr = '';
  child.on('error', (e) => onExit(new Error('solver process: ' + e.message)));
  child.on('exit', (code, sig) => {
    live.delete(child);
    onExit(new Error(sig ? `solver process stopped (${sig})` : `solver process ended, code ${code}${stderr ? ': ' + stderr.trim().slice(-500) : ''}`));
  });
  child.stdin.on('error', () => { /* process gone: handled by exit */ });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      onMessage(m);
    }
  });
  child.stdin.write(JSON.stringify(config) + '\n');
  if (config.mode !== 'full') child.stdin.end();
  return {
    send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); },
    kill() {
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    },
  };
}

module.exports = {
  name: 'process',
  cpus: Math.max(1, os.cpus().length),
  ready: (onProgress) => ensureBinary(onProgress),
  open,
  ensureBinary,
};
