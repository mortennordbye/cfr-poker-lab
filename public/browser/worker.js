'use strict';
// Web Worker entry of the static site (tools/build-web.js). The page sends { __init: { id, file, workerData, port },
// base }; this loads bundle.js and runs the module `file` with worker_threads set up (public/browser/worker_threads.js).
self.onmessage = (e) => {
  const d = e.data;
  if (!d || !d.__init) return;
  self.onmessage = null;
  self.__cfrBase = d.base;
  self.__cfrInit = d.__init;
  try {
    importScripts(d.base + 'bundle.js');
    self.__cfr.require('worker_threads'); // installs the error handlers first
    self.__cfr.require(d.__init.file);
  } catch (err) {
    d.__init.port.postMessage({ __wt: 'error', message: String((err && err.message) || err), stack: err && err.stack });
    d.__init.port.postMessage({ __wt: 'exit', code: 1 });
  }
};
