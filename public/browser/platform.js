'use strict';
// Browser side of lib/platform.js, for the static site only (tools/build-web.js puts it in place of lib/platform.js).
// SHA-1 and base64 in plain JavaScript, and a small file store: the same paths as on disk ('/cache/...'), kept in
// IndexedDB. Reads are synchronous like Node's fs, so the page loads the store once at start (files.ready()) and
// keeps small files (calibration samples, settings) in memory. Big files (solve caches) are read from IndexedDB.

// ---- SHA-1 (hex) of a string, UTF-8 ----
function sha1(str) {
  const msg = new TextEncoder().encode(String(str));
  const n = msg.length, words = ((n + 8) >> 6) + 1, w = new Int32Array(words * 16);
  for (let i = 0; i < n; i++) w[i >> 2] |= msg[i] << (24 - (i & 3) * 8);
  w[n >> 2] |= 0x80 << (24 - (n & 3) * 8);
  w[words * 16 - 1] = n * 8; // messages under 512 MB: the high word stays 0
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const x = new Int32Array(80);
  const rol = (v, s) => (v << s) | (v >>> (32 - s));
  for (let b = 0; b < w.length; b += 16) {
    for (let t = 0; t < 16; t++) x[t] = w[b + t];
    for (let t = 16; t < 80; t++) x[t] = rol(x[t - 3] ^ x[t - 8] ^ x[t - 14] ^ x[t - 16], 1);
    let a = h0, bb = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (bb & c) | (~bb & d) : t < 40 ? bb ^ c ^ d : t < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (rol(a, 5) + f + e + k + x[t]) | 0;
      e = d; d = c; c = rol(bb, 30); bb = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

// ---- base64 for typed arrays ----
function toBase64(ta) {
  const u8 = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s, Type) {
  const bin = atob(s), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Type(u8.buffer);
}

// ---- file store ----
const HOT = 256 * 1024; // files up to this size stay in memory (sync reads)
const meta = new Map(); // path -> { mtimeMs, size, text (if in memory) }
let db = null;

function req(r) { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('cfr-poker-lab', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('meta'); r.result.createObjectStore('data'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function put(file, m, text) {
  if (!db) return Promise.resolve();
  const tx = db.transaction(['meta', 'data'], 'readwrite');
  tx.objectStore('meta').put({ mtimeMs: m.mtimeMs, size: m.size }, file);
  tx.objectStore('data').put(text, file);
  return new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => { console.warn('store: write failed', file, tx.error); resolve(); }; });
}

let readyP = null;
function ready() {
  if (readyP) return readyP;
  readyP = (async () => {
    if (typeof indexedDB === 'undefined') return;
    try {
      db = await openDb();
      const tx = db.transaction(['meta', 'data'], 'readonly');
      const keys = await req(tx.objectStore('meta').getAllKeys());
      const vals = await req(tx.objectStore('meta').getAll());
      const hot = [];
      keys.forEach((k, i) => { meta.set(k, { mtimeMs: vals[i].mtimeMs, size: vals[i].size }); if (vals[i].size <= HOT) hot.push(k); });
      await Promise.all(hot.map(async (k) => { meta.get(k).text = await req(tx.objectStore('data').get(k)); }));
    } catch (e) { db = null; console.warn('store: IndexedDB not available, files are kept in memory only', e); }
  })();
  return readyP;
}

const missing = (file) => Object.assign(new Error(`ENOENT: no such file, '${file}'`), { code: 'ENOENT' });
function set(file, text) {
  const m = { mtimeMs: Date.now(), size: text.length };
  if (text.length <= HOT || !db) m.text = text;
  meta.set(file, m);
  return put(file, m, text);
}

const files = {
  ready,
  exists: (file) => meta.has(file),
  readText(file) {
    const m = meta.get(file);
    if (!m || m.text === undefined) throw missing(file);
    return m.text;
  },
  async readTextAsync(file) {
    const m = meta.get(file);
    if (!m) throw missing(file);
    if (m.text !== undefined) return m.text;
    const t = await req(db.transaction('data').objectStore('data').get(file));
    if (t === undefined) throw missing(file);
    return t;
  },
  writeText(file, text) { set(file, String(text)); },
  writeTextAsync: (file, text) => set(file, String(text)),
  // Names directly below a folder (files and folders), like fs.readdirSync.
  list(dir) {
    const pre = dir.replace(/\/+$/, '') + '/', out = new Set();
    for (const k of meta.keys()) if (k.startsWith(pre)) out.add(k.slice(pre.length).split('/')[0]);
    if (!out.size) throw missing(dir);
    return [...out];
  },
  stat(file) {
    const m = meta.get(file);
    if (!m) throw missing(file);
    return { mtimeMs: m.mtimeMs, size: m.size };
  },
};

module.exports = { sha1, toBase64, fromBase64, files };
