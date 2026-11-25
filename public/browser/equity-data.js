'use strict';
// Browser side of lib/equity-data.js, for the static site only (tools/build-web.js): fetches equity.json
// (lib/equity.json, copied next to the page) instead of reading it from disk.
let json = null;

async function loadEquity() {
  if (!json) {
    json = fetch(globalThis.__cfrBase + 'equity.json').then((r) => {
      if (!r.ok) throw new Error('equity.json: HTTP ' + r.status);
      return r.json();
    });
    json.catch(() => { json = null; });
  }
  const d = await json;
  return { E: Float64Array.from(d.E), W: Float64Array.from(d.W), samples: d.samples };
}

module.exports = { loadEquity };
