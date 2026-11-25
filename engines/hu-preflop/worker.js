'use strict';
// Runs one solve in a worker thread so the server's event loop stays free.
const { parentPort, workerData } = require('worker_threads');
const { loadEquity } = require('../../lib/equity');
const { solve } = require('./solver');

loadEquity().then(({ E, W }) => {
  const result = solve(E, W, workerData.params, (progress, message) => parentPort.postMessage({ progress, message }), workerData.rTable);
  parentPort.postMessage({ result });
}).catch((err) => parentPort.postMessage({ error: String((err && err.stack) || err) }));
