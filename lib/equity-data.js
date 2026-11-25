'use strict';
// Node side of loadEquity(): reads lib/equity.json, or builds it with one worker thread per CPU core.
// tools/build-web.js swaps this file for public/browser/equity-data.js (fetches equity.json) in the static site.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { N, classOf, samplePair, setSeed } = require('./equity');

// W[i*N+j] = number of combo pairs (class i vs class j) that share no card.
function comboWeights() {
  const all = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) all.push([a, b, classOf(a, b)]);
  const W = new Float64Array(N * N);
  for (const x of all) for (const y of all) {
    if (x[0] === y[0] || x[0] === y[1] || x[1] === y[0] || x[1] === y[1]) continue;
    W[x[2] * N + y[2]]++;
  }
  return W;
}

if (!isMainThread && workerData && workerData.equityWorker) {
  setSeed(workerData.seed);
  const { pairs, samples } = workerData;
  const out = new Float64Array(pairs.length / 2);
  for (let p = 0; p < out.length; p++) {
    out[p] = samplePair(pairs[2 * p], pairs[2 * p + 1], samples);
    if (p % 200 === 0) parentPort.postMessage({ progress: p });
  }
  parentPort.postMessage({ done: out });
}

// Builds the table with one worker per CPU core.
async function buildEquity(samples, log = console.log) {
  const pairs = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) pairs.push([i, j]);
  const nw = Math.max(1, os.cpus().length);
  const chunks = Array.from({ length: nw }, () => []);
  pairs.forEach((p, k) => chunks[k % nw].push(p));
  const E = new Float64Array(N * N).fill(0.5);
  const progress = new Array(nw).fill(0);
  const t0 = Date.now();
  await Promise.all(chunks.map((chunk, w) => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { equityWorker: true, pairs: chunk.flat(), samples, seed: 12345 + w * 7919 } });
    worker.on('message', (m) => {
      if (m.progress !== undefined) {
        progress[w] = m.progress;
        if (w === 0) log(`equity: ${Math.round((100 * progress.reduce((a, b) => a + b, 0)) / pairs.length)}%`);
      } else {
        chunk.forEach(([i, j], k) => { E[i * N + j] = m.done[k]; E[j * N + i] = 1 - m.done[k]; });
        resolve();
      }
    });
    worker.on('error', reject);
  })));
  log(`equity: done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return E;
}

const FILE = path.join(__dirname, 'equity.json');

async function loadEquity(samples = 100000) {
  if (fs.existsSync(FILE)) {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { E: Float64Array.from(d.E), W: Float64Array.from(d.W), samples: d.samples };
  }
  console.log(`equity.json not found. Calculating it now (${samples} boards per hand pair).`);
  const E = await buildEquity(samples);
  const W = comboWeights();
  fs.writeFileSync(FILE, JSON.stringify({ samples, E: Array.from(E, (x) => +x.toFixed(5)), W: Array.from(W) }));
  return { E, W, samples };
}

module.exports = { loadEquity, buildEquity, comboWeights };
