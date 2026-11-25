'use strict';
// The Node-only parts that the shared modules need: SHA-1, base64 for typed arrays, and file storage.
// tools/build-web.js swaps this file for public/browser/platform.js (IndexedDB, pure-JS SHA-1) in the static site,
// so engines and lib/ keep one copy of their logic.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

const toBase64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
function fromBase64(s, Type) {
  const buf = Buffer.from(s, 'base64');
  return new Type(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

// File storage. Paths are absolute. readText, list and stat throw when the file or folder is missing.
const files = {
  exists: (file) => fs.existsSync(file),
  readText: (file) => fs.readFileSync(file, 'utf8'),
  readTextAsync: (file) => fs.promises.readFile(file, 'utf8'),
  // Atomic: a reader never sees a half-written file.
  writeText(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  },
  async writeTextAsync(file, text) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, text);
  },
  list: (dir) => fs.readdirSync(dir),
  stat(file) { const st = fs.statSync(file); return { mtimeMs: st.mtimeMs, size: st.size }; },
};

module.exports = { sha1, toBase64, fromBase64, files };
