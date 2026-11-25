'use strict';
// Plan step of .github/workflows/precompute.yml: finds the work that is still missing and writes the shard matrix.
// For each task it runs the tool's --plan mode (no flop solves) against the current data (--base, from
// tools/fetch-data.js), puts the plan files in --work (an artifact for the shards) and gives each task
// min(missing work, --shards) shards. A task with nothing missing gets no shard.
//
// Usage: node tools/precompute-plan.js --work <dir> [--base <dir>] [--force] [--shards 20]
//          (--job flop-report|sixmax-calibration --preset <name> --flops <n> [--limit <n>] | --smoke)
// --smoke: the pull request test (a 2-flop report and a 2-flop calibration, tiny trees, 2 shards each).
// Writes count and matrix to $GITHUB_OUTPUT and a short table to $GITHUB_STEP_SUMMARY when those are set.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const MAX_SHARDS = 20; // jobs at the same time on the free plan

function tasks() {
  if (arg('smoke')) {
    return [
      { task: 't1', job: 'flop-report', preset: 'smoke', flops: '25', limit: '2', shards: 2 },
      { task: 't2', job: 'sixmax-calibration', preset: 'smoke', flops: '2', limit: '0', shards: 2 },
    ];
  }
  const job = String(arg('job', ''));
  if (!['flop-report', 'sixmax-calibration'].includes(job)) throw new Error('--job must be flop-report or sixmax-calibration');
  return [{ task: 't1', job, preset: String(arg('preset')), flops: String(arg('flops', '25')), limit: String(arg('limit', '0') || '0'),
    shards: Number(arg('shards', MAX_SHARDS)) }];
}

const node = (args) => execFileSync(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });

function plan({ task, job, preset, flops, limit }, { work, base, force }) {
  const dir = path.join(work, task);
  const file = path.join(dir, 'plan.json');
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  const f = force ? ['--force'] : [];
  if (job === 'flop-report') {
    // The report file comes from the data (unless --force). The spot is solved without samples (flat realization),
    // so every run of the same input gets the same spot.
    const noSamples = fs.mkdtempSync(path.join(dir, 'no-samples-'));
    const baseReports = path.join(base, 'reports');
    if (!force && fs.existsSync(baseReports)) for (const n of fs.readdirSync(baseReports)) if (/^[0-9a-f]{16}\.json$/.test(n)) fs.copyFileSync(path.join(baseReports, n), path.join(dir, 'reports', n));
    node([path.join(__dirname, 'flop-report.js'), '--preset', preset, '--flops', flops, '--limit', limit, ...f,
      '--reports-dir', path.join(dir, 'reports'), '--samples-dir', noSamples, '--plan', file]);
    fs.rmSync(noSamples, { recursive: true, force: true });
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const n of fs.readdirSync(path.join(dir, 'reports'))) if (n !== p.id + '.json') fs.rmSync(path.join(dir, 'reports', n)); // shards need only this one
  } else {
    node([path.join(__dirname, 'calibrate-sixmax.js'), '--preset', preset, '--flops', flops, ...f,
      '--samples-dir', path.join(base, 'realization-samples'), '--plan', file]);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const work = path.resolve(String(arg('work', 'work')));
  const base = path.resolve(String(arg('base', path.join(work, '..', 'no-base'))));
  const force = !!arg('force');
  const include = [], md = [];
  for (const t of tasks()) {
    const p = plan(t, { work, base, force });
    const n = Math.min(p.count, Math.max(1, Math.min(MAX_SHARDS, Number(t.shards) || 1)));
    for (let i = 1; i <= n; i++) include.push({ task: t.task, job: t.job, preset: t.preset, flops: t.flops, limit: t.limit, shard: `${i}/${n}`, name: `${t.task}-${i}-of-${n}` });
    const what = p.job === 'flop-report' ? `report ${p.id} (${p.name}), ${p.done} of ${p.total} flops done` : `spot ${p.spotKey}, groups ${p.groups.join(', ')}, ${p.done} samples current`;
    console.log(`${t.task} ${t.job} ${t.preset}: ${p.count} to solve, ${n} shard(s); ${what}`);
    md.push(`| ${t.job} | ${t.preset} | ${what} | ${p.count} | ${n} |`);
  }
  const matrix = JSON.stringify({ include });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `count=${include.length}\nmatrix=${matrix}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Plan', '', '| job | preset | data | to solve | shards |', '| --- | --- | --- | ---: | ---: |', ...md,
      '', include.length ? '' : 'Nothing is missing: no shards run.', ''].join('\n'));
  }
  console.log(`${include.length} shard(s)`);
}

try { main(); } catch (e) { console.error(e.message || e); process.exit(1); }
