'use strict';
// Builds the static site (browser mode, GitHub Pages) into dist/ (or the folder in argv[2]). Plain Node, no packages.
//
//   dist/index.html, pushfold.html, app.js, app.css   the UI from public/, with bundle.js added
//   dist/bundle.js    the CommonJS modules the engines need, wrapped in a small require() loader
//   dist/worker.js    Web Worker entry (public/browser/worker.js)
//   dist/sw.js        service worker for cross-origin isolation (public/browser/sw.js)
//   dist/equity.json  lib/equity.json
//
// The engines run unchanged. Node-only modules are swapped for their browser versions (ALIAS), and the two Node
// built-ins they use come from public/browser/ (BUILTIN). Any other built-in stops the build.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));

// Module id (path from the repo root) -> file used in the browser.
const ALIAS = {
  '/lib/platform.js': 'public/browser/platform.js',
  '/lib/equity-data.js': 'public/browser/equity-data.js',
};
const BUILTIN = {
  path: '/public/browser/path.js',
  worker_threads: '/public/browser/worker_threads.js',
};
// The page entry, and the files that engines start as workers (new Worker(path.join(__dirname, 'worker.js'))).
const ENTRIES = [
  '/public/browser/page.js',
  '/engines/hu-preflop/worker.js',
  '/engines/sixmax-preflop/worker.js',
  '/engines/postflop-js/worker.js',
  '/lib/realization.js',
];

const abs = (id) => path.join(ROOT, ALIAS[id] || id.slice(1));
function resolve(from, spec) {
  if (BUILTIN[spec]) return BUILTIN[spec];
  if (!spec.startsWith('.')) throw new Error(`${from}: require('${spec}') is a Node built-in or package, not available in the browser`);
  const base = path.posix.join(path.posix.dirname(from), spec);
  for (const id of [base, base + '.js', base + '/index.js']) {
    if (ALIAS[id] || (fs.existsSync(abs(id)) && fs.statSync(abs(id)).isFile())) return id;
  }
  throw new Error(`${from}: cannot resolve require('${spec}')`);
}

// Collect all modules reachable from the entries.
const modules = new Map(); // id -> { code, deps: { spec: id } }
const todo = [...ENTRIES, ...Object.values(BUILTIN)];
while (todo.length) {
  const id = todo.pop();
  if (modules.has(id)) continue;
  const code = fs.readFileSync(abs(id), 'utf8');
  const deps = {};
  // Comments are left out, so a require() named in a comment does not count.
  const src = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  for (const m of src.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    deps[m[2]] = resolve(id, m[2]);
    todo.push(deps[m[2]]);
  }
  modules.set(id, { code, deps });
}

const ids = [...modules.keys()].sort();
let bundle = `'use strict';
// cfr-poker-lab browser bundle, built by tools/build-web.js. Do not edit: edit the source files and build again.
// Modules: ${ids.length}. Licensed AGPL-3.0, source: https://github.com/mortennordbye/cfr-poker-lab
(function (g) {
  var defs = {}, deps = {}, cache = {};
  var builtin = ${JSON.stringify(BUILTIN)};
  if (!g.process) g.process = { env: {}, argv: [], pid: 1, platform: 'browser', exit: function (c) { if (g.__cfrExit) g.__cfrExit(c); } };
  if (!g.__cfrBase && g.document && g.document.currentScript) g.__cfrBase = new URL('.', g.document.currentScript.src).href;
  // One thread for 6-max preflop when the page is not cross-origin isolated (no SharedArrayBuffer).
  if (typeof g.SharedArrayBuffer === 'undefined') g.SharedArrayBuffer = ArrayBuffer;
  function load(id) {
    if (cache[id]) return cache[id].exports;
    if (!defs[id]) throw new Error('module not in the bundle: ' + id);
    var module = cache[id] = { id: id, exports: {} };
    var dir = id.slice(0, id.lastIndexOf('/')) || '/';
    defs[id].call(module.exports, module.exports, function (spec) { return load(deps[id][spec]); }, module, id, dir);
    return module.exports;
  }
  g.__cfr = { require: function (id) { return load(builtin[id] || id); } };
`;
for (const id of ids) {
  const { code, deps } = modules.get(id);
  bundle += `\n// ---- ${id}${ALIAS[id] ? ' (browser version: ' + ALIAS[id] + ')' : ''}\n`;
  bundle += `deps[${JSON.stringify(id)}] = ${JSON.stringify(deps)};\n`;
  bundle += `defs[${JSON.stringify(id)}] = function (exports, require, module, __filename, __dirname) {\n${code}\n};\n`;
}
bundle += `
  if (g.document) g.__cfr.require('/public/browser/page.js');
})(self);
`;

// Write the site.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const PUB = path.join(ROOT, 'public');
for (const f of fs.readdirSync(PUB)) {
  if (f === 'browser') continue;
  fs.cpSync(path.join(PUB, f), path.join(OUT, f), { recursive: true });
}
const addBundle = (file, before) => {
  const p = path.join(OUT, file), html = fs.readFileSync(p, 'utf8');
  if (!html.includes(before)) throw new Error(`${file}: '${before}' not found`);
  fs.writeFileSync(p, html.replace(before, '<script src="bundle.js"></script>\n' + before));
};
addBundle('index.html', '<script src="app.js"></script>');
addBundle('pushfold.html', '<script>');
fs.writeFileSync(path.join(OUT, 'bundle.js'), bundle);
fs.copyFileSync(path.join(PUB, 'browser', 'worker.js'), path.join(OUT, 'worker.js'));
fs.copyFileSync(path.join(PUB, 'browser', 'sw.js'), path.join(OUT, 'sw.js'));
fs.copyFileSync(path.join(ROOT, 'lib', 'equity.json'), path.join(OUT, 'equity.json'));

const size = (f) => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB';
console.log(`built ${path.relative(ROOT, OUT) || OUT}: ${ids.length} modules, bundle.js ${size('bundle.js')}, equity.json ${size('equity.json')}`);
