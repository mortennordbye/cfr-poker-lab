'use strict';
// Joins the outputs of batch shards (tools/flop-report.js and tools/calibrate-sixmax.js with --shard, see
// .github/workflows/precompute.yml) into one data folder, plus the data that was there before (--base).
//
// Usage: node tools/merge-data.js --out <new dir> [--base <old data dir>] <shard dir> [<shard dir> ...]
//        node tools/merge-data.js --notes manifest.json      prints the text of the release "data"
// Each input folder has the layout of cache/: reports/<id>.json and realization-samples/<spotKey>/<terminal>/<board>.json.
// Output: the same layout plus manifest.json.
//
// Reports: the files of one id are joined into one file with the results of all flops, in the same format and with
// the same id as a local run of the same input (status 'done' when every flop has a result, else 'partial', which
// the server shows as "stopped" and a local run continues). The shards of one run start from the same plan file
// (same createdAt). Only the files with the newest createdAt of an id are joined: after a --force plan the new
// results replace the old ones. Reports that only the base has are copied unchanged.
// Samples: one file per path; when two inputs have the same path, the newer sample (createdAt) wins, the same rule
// as lib/realization.js saveSample.
// manifest.json: { version, createdAt, gitSha, reports: [{ id, name, status, done, total, flops, ... }],
//   samples: [{ spotKey, group, count }], totals }.
const fs = require('fs');
const path = require('path');
const R = require('../lib/reports');

const MANIFEST_VERSION = 1;
const REPORT_FILE = /^[0-9a-f]{16}\.json$/;
const SAFE = /^[\w+-][\w.+-]*$/; // one path part of a sample file (no dot files)

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function listDir(d) { try { return fs.readdirSync(d); } catch (e) { return []; } }

// { id: [ { file, r, base } ] } over all inputs.
function collectReports(inputs) {
  const by = new Map();
  for (const { dir, base } of inputs) {
    const rd = path.join(dir, 'reports');
    for (const f of listDir(rd).filter((x) => REPORT_FILE.test(x)).sort()) {
      let r;
      try { r = readJson(path.join(rd, f)); } catch (e) { throw new Error(`${path.join(rd, f)}: not valid JSON (${e.message})`); }
      if (r.id !== f.slice(0, -5)) throw new Error(`${path.join(rd, f)}: id ${r.id} does not match the file name`);
      if (!by.has(r.id)) by.set(r.id, []);
      by.get(r.id).push({ file: path.join(rd, f), r, base });
    }
  }
  return by;
}

// Joins the files of one report id. Returns { r, note }.
function mergeReport(list) {
  const shards = list.filter((x) => !x.base);
  if (!shards.length) return { r: list[0].r, note: 'base only' };
  // Newest plan (createdAt) wins; files of an older plan of the same id are left out (a --force plan, or a run
  // that published a newer plan while this one ran).
  const head = list.map((x) => x.r.createdAt).sort().pop();
  const use = list.filter((x) => x.r.createdAt === head);
  const left = list.length - use.length;
  const first = use[0].r;
  for (const { r, file } of use) {
    if (r.version !== first.version) throw new Error(`${file}: report version ${r.version}, other shards ${first.version}`);
    if (JSON.stringify(r.input) !== JSON.stringify(first.input) || JSON.stringify(r.spot) !== JSON.stringify(first.spot)
      || JSON.stringify(r.flops) !== JSON.stringify(first.flops)) throw new Error(`${file}: input, spot or flops differ from the other shards of ${r.id}`);
  }
  const byBoard = new Map();
  for (const { r } of use) for (const x of r.results || []) if (!byBoard.has(x.board)) byBoard.set(x.board, x);
  const results = first.flops.filter((b) => byBoard.has(b)).map((b) => byBoard.get(b));
  const latest = use.map((x) => x.r).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).pop();
  const done = results.length === first.flops.length;
  const r = {
    id: first.id, version: first.version, createdAt: first.createdAt, status: done ? 'done' : 'partial',
    input: first.input, spot: first.spot, name: first.name, engine: latest.engine, tree: first.tree, flops: first.flops,
    results, runMs: results.reduce((s, x) => s + (Number(x.ms) || 0), 0), error: null,
    updatedAt: latest.updatedAt, summary: R.summarize(results),
  };
  return { r, note: `${use.length} file(s)${left ? `, ${left} older file(s) left out` : ''}, ${results.length} of ${first.flops.length} flops` };
}

// Sample files: Map rel -> { file, createdAt } (newest wins).
function collectSamples(inputs) {
  const out = new Map();
  for (const { dir } of inputs) {
    const root = path.join(dir, 'realization-samples');
    for (const spot of listDir(root)) {
      if (!SAFE.test(spot)) continue;
      for (const term of listDir(path.join(root, spot))) {
        if (!SAFE.test(term)) continue;
        for (const f of listDir(path.join(root, spot, term))) {
          if (!SAFE.test(f) || !f.endsWith('.json')) continue;
          const file = path.join(root, spot, term, f);
          if (!fs.statSync(file).isFile()) continue;
          let s;
          try { s = readJson(file); } catch (e) { console.warn(`skipped ${file}: not valid JSON`); continue; }
          const rel = `${spot}/${term}/${f}`;
          const old = out.get(rel);
          if (!old || Date.parse(s.createdAt) > Date.parse(old.s.createdAt)) out.set(rel, { file, s, spot });
        }
      }
    }
  }
  return out;
}

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim(); } catch (e) { return null; }
}

// Merges inputs ([{ dir, base }]) into out (must not exist or be empty). Returns the manifest.
function mergeData({ out, inputs, log = console.log }) {
  if (fs.existsSync(out) && listDir(out).length) throw new Error(`${out} is not empty`);
  fs.mkdirSync(path.join(out, 'reports'), { recursive: true });
  const reports = [];
  for (const [id, list] of [...collectReports(inputs)].sort()) {
    const { r, note } = mergeReport(list);
    fs.writeFileSync(path.join(out, 'reports', id + '.json'), JSON.stringify(r));
    const e = R.listEntry(R.statusOf(r));
    reports.push({ ...e, status: r.status, flops: r.flops.length });
    log(`report ${id} (${r.name}): ${r.status}, ${note}`);
  }
  const samples = collectSamples(inputs);
  const groups = new Map();
  for (const [rel, { file, s, spot }] of [...samples].sort()) {
    const dest = path.join(out, 'realization-samples', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    const g = s.group || s.terminalKey || '?';
    const k = spot + '\u0000' + g;
    if (!groups.has(k)) groups.set(k, { spotKey: spot, group: g, kind: s.group ? 'sixmax-preflop' : 'hu-preflop', count: 0 });
    groups.get(k).count++;
  }
  const manifest = {
    version: MANIFEST_VERSION, createdAt: new Date().toISOString(), gitSha: gitSha(),
    reports: reports.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    samples: [...groups.values()],
    totals: { reports: reports.length, reportsDone: reports.filter((x) => x.status === 'done').length, samples: samples.size },
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
  log(`merged: ${reports.length} reports (${manifest.totals.reportsDone} done), ${samples.size} samples in ${groups.size} groups -> ${out}`);
  return manifest;
}

// Markdown tables of a manifest (GitHub job summary).
function summaryMd(m) {
  return ['### Data', '', `${m.totals.reports} reports (${m.totals.reportsDone} done), ${m.totals.samples} samples.`, '',
    '| report | name | flops | status |', '| --- | --- | --- | --- |', ...m.reports.map((r) => `| ${r.id} | ${r.name} | ${r.done}/${r.total} | ${r.status} |`), '',
    '| spot | group | samples |', '| --- | --- | ---: |', ...m.samples.map((s) => `| ${s.spotKey} | ${s.group} | ${s.count} |`), ''].join('\n');
}
// Text of the release "data".
function releaseNotes(m) {
  return [`Precomputed data for cfr-poker-lab, made by the Precompute workflow (git ${String(m.gitSha).slice(0, 7)}, ${m.createdAt}).`,
    'Get it with `just data` (or `node tools/fetch-data.js`). Each run replaces the assets.', '',
    `${m.totals.reports} reports (${m.totals.reportsDone} done), ${m.totals.samples} realization samples.`, '',
    ...m.reports.map((r) => `- report ${r.id}: ${r.name}, ${r.done}/${r.total} flops, ${r.status}`)].join('\n');
}

module.exports = { mergeData, mergeReport, collectSamples, summaryMd, releaseNotes, MANIFEST_VERSION };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--notes') { console.log(releaseNotes(readJson(argv[1]))); process.exit(0); }
  const inputs = [];
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--base') { const d = argv[++i]; if (fs.existsSync(d)) inputs.unshift({ dir: d, base: true }); else console.log(`no base data at ${d}`); }
    else inputs.push({ dir: argv[i], base: false });
  }
  if (!out) { console.error('usage: node tools/merge-data.js --out <dir> [--base <dir>] <shard dir>...  |  --notes <manifest.json>'); process.exit(2); }
  try {
    const m = mergeData({ out, inputs });
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd(m));
  } catch (e) { console.error(e.message); process.exit(1); }
}
