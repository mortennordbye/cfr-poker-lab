'use strict';
// The part of Node's 'path' module that the shared modules use, for the static site (tools/build-web.js).
// POSIX paths only: the bundle names its modules like '/engines/hu-preflop/index.js'.
function normalize(p) {
  const abs = p.startsWith('/'), out = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(s);
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}
const join = (...parts) => normalize(parts.filter((x) => x !== '').join('/'));
const dirname = (p) => { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i); };
const basename = (p, ext) => { const b = p.replace(/\/+$/, '').split('/').pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
const extname = (p) => { const b = basename(p), i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
function relative(from, to) {
  const a = normalize(from).split('/').filter(Boolean), b = normalize(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
module.exports = { sep: '/', normalize, join, dirname, basename, extname, relative };
