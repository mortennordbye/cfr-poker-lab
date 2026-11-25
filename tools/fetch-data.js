'use strict';
// Downloads the precomputed data (GitHub release "data": cfr-data.tar.gz + manifest.json, made by
// .github/workflows/precompute.yml) and unpacks it into cache/. Never overwrites a file that exists: local results
// and samples stay as they are.
//
// Usage: node tools/fetch-data.js [--dest cache] [--repo owner/name] [--tag data] [--only reports]
//        [--manifest <file>] [--require]
// --dest      target folder (default cache/ of this checkout; the Docker volume is /app/cache)
// --only      top folders to unpack, comma list (reports, realization-samples; default both)
// --manifest  also write manifest.json to this file
// --require   exit 1 when there is no data release (default: say so and exit 0)
// --from      a local folder with manifest.json and cfr-data.tar.gz (a downloaded workflow artifact) instead of
//             the release
// Needs Node's fetch and the system tar (to unpack .tar.gz).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const TOPS = ['reports', 'realization-samples'];
const SAFE = /^[\w+-][\w.+-]*$/; // no dot files

function repoName() {
  if (arg('repo')) return String(arg('repo'));
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/);
    if (m) return m[1];
  } catch (e) { /* no git */ }
  return 'mortennordbye/cfr-poker-lab';
}

// GET a release asset. Returns a Buffer, or null on 404.
async function download(url) {
  if (arg('from')) { const f = path.join(String(arg('from')), url.split('/').pop()); return fs.existsSync(f) ? fs.readFileSync(f) : null; }
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'cfr-poker-lab-fetch-data' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Copies the regular files below src/<top> to dest/<top> that do not exist there. Returns { copied, kept }.
function copyNew(src, dest, tops) {
  let copied = 0, kept = 0;
  const walk = (rel) => {
    const full = path.join(src, rel);
    for (const name of fs.readdirSync(full)) {
      if (!SAFE.test(name)) continue;
      const r = path.join(rel, name), st = fs.lstatSync(path.join(src, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) {
        const to = path.join(dest, r);
        if (fs.existsSync(to)) { kept++; continue; }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(src, r), to, fs.constants.COPYFILE_EXCL);
        copied++;
      }
    }
  };
  for (const t of tops) if (fs.existsSync(path.join(src, t)) && fs.lstatSync(path.join(src, t)).isDirectory()) walk(t);
  return { copied, kept };
}

(async () => {
  const repo = repoName(), tag = String(arg('tag', 'data'));
  const dest = path.resolve(String(arg('dest', path.join(__dirname, '..', 'cache'))));
  const tops = arg('only') ? String(arg('only')).split(',').map((s) => s.trim()).filter((t) => TOPS.includes(t)) : TOPS;
  const base = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
  const manifestBuf = await download(`${base}/manifest.json`);
  if (!manifestBuf) {
    console.log(arg('from') ? `no manifest.json in ${arg('from')}` : `no data release "${tag}" in ${repo}`);
    process.exit(arg('require') ? 1 : 0);
  }
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  console.log(`data of ${manifest.createdAt} (git ${String(manifest.gitSha || '?').slice(0, 7)}): ${manifest.totals.reports} reports `
    + `(${manifest.totals.reportsDone} done), ${manifest.totals.samples} samples in ${manifest.samples.length} groups`);
  const tgz = await download(`${base}/cfr-data.tar.gz`);
  if (!tgz) throw new Error(`release "${tag}" has manifest.json but no cfr-data.tar.gz`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-data-'));
  try {
    const file = path.join(tmp, 'cfr-data.tar.gz'), out = path.join(tmp, 'x');
    fs.writeFileSync(file, tgz);
    fs.mkdirSync(out);
    execFileSync('tar', ['-xzf', file, '-C', out], { stdio: 'inherit' });
    fs.mkdirSync(dest, { recursive: true });
    const { copied, kept } = copyNew(out, dest, tops);
    console.log(`${(tgz.length / 1048576).toFixed(1)} MB; ${copied} files added to ${dest}, ${kept} kept (they exist already)`);
    if (arg('manifest')) {
      const mf = path.resolve(String(arg('manifest')));
      fs.mkdirSync(path.dirname(mf), { recursive: true });
      fs.writeFileSync(mf, JSON.stringify(manifest, null, 1));
    }
    for (const r of manifest.reports) console.log(`  report ${r.id} ${r.status} ${r.done}/${r.total}  ${r.name}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
