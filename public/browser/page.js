'use strict';
// Page entry of the static site (tools/build-web.js): the in-page API (window.cfrLocalApi, used by app.js and
// pushfold.html), the browser-mode banner, and the service worker for cross-origin isolation (public/browser/sw.js).
const localApi = require('./local-api');

const README = 'https://github.com/mortennordbye/cfr-poker-lab#getting-started';
const CLOSED = 'browserBannerClosed';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window: not remembered */ } },
};
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } },
};

// Cross-origin isolation: the first visit installs the service worker, then loads the page once more with its
// headers. API calls wait for that, so no solve starts in the page that is about to reload.
function isolate() {
  if (window.crossOriginIsolated || !window.isSecureContext || !('serviceWorker' in navigator)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 4000); // no answer from the service worker: go on with one thread for 6-max
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      if (session.get('coiReload')) { clearTimeout(timer); resolve(); return; } // tried once: go on without it
      session.set('coiReload', '1');
      location.reload();
    }).catch((e) => { console.warn('service worker:', e); clearTimeout(timer); resolve(); });
  });
}
const isolated = isolate();

window.cfrLocalApi = {
  fetch: async (input, init) => { await isolated; return localApi.fetch(input, init); },
  threads: localApi.THREADS,
};

function banner() {
  const top = document.getElementById('top');
  if (!top || store.get(CLOSED)) return;
  const b = document.createElement('div');
  b.className = 'banner';
  b.id = 'browserBanner';
  b.innerHTML = '<span>Browser mode: solves run on your computer, inside this page, with the JavaScript engines. '
    + 'This is slow: a flop solve takes 2 to 6 minutes, and large trees can run out of memory. '
    + `For full speed and the Rust engine, run it locally with Docker: <code>just up</code> (<a href="${README}" target="_blank" rel="noopener">README</a>)</span>`
    + '<button type="button" class="close" title="Close" aria-label="Close">&times;</button>';
  b.querySelector('.close').onclick = () => { store.set(CLOSED, '1'); b.remove(); window.dispatchEvent(new Event('resize')); };
  top.before(b);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner); else banner();
