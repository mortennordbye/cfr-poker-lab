'use strict';
// Generic solver browser. Talks to the HTTP API in CONTRACT.md and renders any engine's nodes.
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const RANKS = 'AKQJT98765432';           // grid order
  const RANK_UP = '23456789TJQKA';         // card id order
  const SUIT_SYM = { s: '&#9824;', h: '&#9829;', d: '&#9830;', c: '&#9827;' };

  const S = {
    engines: [], kind: null,
    frame: null,      // { solveId, kind, params, stats, root }
    parents: [],      // stack of { frame, nodeId } for solves started from a terminal node
    node: null, nodeCache: new Map(), nodeVals: new Map(),
    view: 'strategy', tab: 'hands', sel: null, hover: null, rangeSide: null,
    boardPick: [], polling: null,
    filters: new Set(),   // Filters tab: 'group:<name>', 'class:<name>', 'act:<label>'; kept while you move through the tree
    tableSort: { col: 'combos', dir: -1 }, tableOpen: new Set(),
    oppChild: null,       // first child node where another player acts (the opponent's range when nobody else acted yet)
  };
  const HC = window.cfrHandclass;

  // ---------- API ----------
  // On the static site (tools/build-web.js) the page answers /api/ itself: window.cfrLocalApi.
  const send = window.cfrLocalApi ? window.cfrLocalApi.fetch : fetch;
  async function api(path, body) {
    const r = await send(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  async function getNode(solveId, id) {
    const key = solveId + '|' + id;
    if (!S.nodeCache.has(key)) S.nodeCache.set(key, api(`/api/solve/${solveId}/node?id=${encodeURIComponent(id)}`));
    try { const v = await S.nodeCache.get(key); S.nodeVals.set(key, v); return v; } catch (e) { S.nodeCache.delete(key); throw e; }
  }

  // ---------- Hand helpers ----------
  function cellName(r, c) {
    if (r === c) return RANKS[r] + RANKS[r];
    return r < c ? RANKS[r] + RANKS[c] + 's' : RANKS[c] + RANKS[r] + 'o';
  }
  function comboClass(name) { // 'KsKh' -> 'KK'
    const a = name[0], b = name[2], sa = name[1], sb = name[3];
    if (a === b) return a + b;
    const [hi, lo] = RANK_UP.indexOf(a) > RANK_UP.indexOf(b) ? [a, b] : [b, a];
    return hi + lo + (sa === sb ? 's' : 'o');
  }
  function classCombos(cls) {
    const a = cls[0], b = cls[1], out = [], suits = 'shdc';
    if (a === b) { for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) out.push(a + suits[i] + b + suits[j]); return out; }
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      if (cls[2] === 's' && i !== j) continue;
      if (cls[2] === 'o' && i === j) continue;
      out.push(a + suits[i] + b + suits[j]);
    }
    return out;
  }
  const nCombos = (cls) => (cls.length === 2 ? 6 : cls[2] === 's' ? 4 : 12);
  function cardHtml(name, cls = '') {
    const r = name[0], s = name[1].toLowerCase();
    return `<div class="card ${s} ${cls}" data-card="${esc(name)}">${r === 'T' ? 'T' : esc(r)}<small>${SUIT_SYM[s] || ''}</small></div>`;
  }

  function fmtEv(x) { const s = x.toFixed(Math.abs(x) >= 10 ? 1 : 2); return /^-0\.0+$/.test(s) ? s.slice(1) : s; }

  // ---------- Colors ----------
  function actionColors(actions) {
    const sizes = [...new Set(actions.filter((a) => a.type === 'bet' || a.type === 'raise').map((a) => a.amount))].sort((x, y) => x - y);
    const shades = ['--r1', '--r2', '--r3', '--r4'];
    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    return actions.map((a) => {
      if (a.type === 'fold') return css('--fold');
      if (a.type === 'check' || a.type === 'call') return css('--call');
      if (a.type === 'allin') return css('--allin');
      if (a.type === 'bet' || a.type === 'raise') {
        const k = sizes.indexOf(a.amount), n = sizes.length;
        const idx = n === 1 ? 1 : Math.round((k * (shades.length - 1)) / (n - 1));
        return css(shades[idx]);
      }
      return '#666';
    });
  }

  // ---------- Aggregation into 169 cells ----------
  function aggregate(node) {
    const nA = node.actions.length, cells = {};
    const get = (c) => cells[c] || (cells[c] = { w: 0, n: nCombos(c), s: new Array(nA).fill(0), ev: new Array(nA).fill(0), evw: new Array(nA).fill(0), combos: [] });
    for (const [name, h] of Object.entries(node.hands || {})) {
      const isCombo = node.handKind === 'combo';
      const cls = isCombo ? comboClass(name) : name;
      const c = get(cls);
      const list = isCombo ? [name] : classCombos(cls);
      for (const cb of list) {
        c.w += h.weight;
        c.combos.push({ name: cb, weight: h.weight, strategy: h.strategy, ev: h.ev });
        for (let a = 0; a < nA; a++) {
          c.s[a] += h.weight * (h.strategy[a] || 0);
          if (h.ev && h.ev[a] !== null && h.ev[a] !== undefined) { c.ev[a] += h.weight * h.ev[a]; c.evw[a] += h.weight; }
        }
      }
    }
    for (const c of Object.values(cells)) {
      if (c.w > 0) c.s = c.s.map((x) => x / c.w);
      c.ev = c.ev.map((x, a) => (c.evw[a] > 0 ? x / c.evw[a] : null));
      let e = 0, any = false;
      c.s.forEach((f, a) => { if (c.ev[a] !== null && f > 0) { e += f * c.ev[a]; any = true; } });
      c.handEv = any ? e : null;
    }
    return cells;
  }
  function rangeCells(range) { // { cls or combo: weight } -> cells
    const cells = {};
    for (const [name, w] of Object.entries(range || {})) {
      const cls = name.length === 4 ? comboClass(name) : name;
      const c = cells[cls] || (cells[cls] = { w: 0, n: nCombos(cls) });
      c.w += name.length === 4 ? w : w * c.n;
    }
    return cells;
  }

  // ---------- Spot setup ----------
  function renderParams() {
    const eng = S.engines.find((e) => e.kind === S.kind);
    const form = $('#params'); form.innerHTML = '';
    if (!eng) return;
    const saved = store.get('params:' + eng.kind) || {};
    for (const p of eng.params || []) {
      const v = saved[p.name] !== undefined ? saved[p.name] : p.default;
      const lab = el('label', 'fld'); lab.title = p.label || p.name;
      let input;
      if (p.type === 'boolean') {
        lab.className = 'fld chk';
        input = el('input'); input.type = 'checkbox'; input.checked = !!v;
        lab.append(input, el('span', '', esc(p.label || p.name)));
      } else {
        if (p.options || p.type === 'select') {
          input = el('select');
          for (const o of p.options || []) { const opt = el('option', '', esc(o.label || o.value || o)); opt.value = o.value !== undefined ? o.value : o; input.append(opt); }
          input.value = v;
        } else if (p.type === 'number') {
          input = el('input'); input.type = 'number';
          if (p.min !== undefined) input.min = p.min; if (p.max !== undefined) input.max = p.max;
          input.step = p.step || 'any'; input.value = v;
        } else if (p.type === 'json' || (v !== null && typeof v === 'object')) {
          input = el('textarea'); input.value = JSON.stringify(v); input.dataset.json = '1';
        } else {
          input = el('input'); input.type = 'text'; input.value = Array.isArray(v) ? v.join(',') : (v ?? '');
        }
        lab.append(el('span', '', esc(p.label || p.name)), input);
      }
      input.name = p.name; input.dataset.type = p.type;
      form.append(lab);
    }
  }
  function readParams() {
    const out = {};
    for (const input of $('#params').querySelectorAll('[name]')) {
      const t = input.dataset.type;
      if (input.type === 'checkbox') out[input.name] = input.checked;
      else if (t === 'number') out[input.name] = input.value === '' ? undefined : Number(input.value);
      else if (input.dataset.json) { try { out[input.name] = JSON.parse(input.value); } catch (e) { out[input.name] = input.value; } }
      else out[input.name] = input.value;
    }
    store.set('params:' + S.kind, out);
    return out;
  }
  function spotLine(frame) {
    if (!frame) return '';
    const eng = S.engines.find((e) => e.kind === frame.kind);
    const bits = Object.entries(frame.params || {}).filter(([, v]) => v === null || typeof v !== 'object').map(([k, v]) => {
      const p = eng && (eng.params || []).find((x) => x.name === k);
      return `${esc(p ? p.name : k)} ${esc(v)}`;
    });
    return `<b>${esc(eng ? eng.title : frame.kind)}</b>${bits.length ? ' &middot; ' + bits.join(' &middot; ') : ''}`;
  }

  // ---------- Solving ----------
  function setProgress(on, frac = 0, msg = '') {
    const p = $('#progress'); p.classList.toggle('hidden', !on);
    p.querySelector('.fill').style.width = `${Math.round(100 * frac)}%`;
    p.querySelector('.msg').textContent = msg;
    $('#solveBtn').disabled = on;
  }
  async function startSolve(kind, params, parent) {
    setProgress(true, 0, 'starting');
    try {
      const { solveId } = await api('/api/solve', { kind, params });
      const st = await waitSolve(solveId);
      if (parent) S.parents.push(parent); else S.parents = [];
      // A new calibration sample changes the preflop solution: mark the open preflop solves as out of date.
      // goParent() solves them again when the user goes back.
      if (st.sample && st.sample.file) for (const p of S.parents) if (p.frame.kind === 'hu-preflop') p.frame.stale = true;
      S.frame = { solveId, kind, params, stats: st.stats, root: st.root, sample: st.sample };
      store.set('lastSolve', { kind, params });
      await go(st.root);
    } catch (e) {
      showError(e.message);
    } finally { setProgress(false); }
  }
  function waitSolve(solveId) {
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const st = await api(`/api/solve/${solveId}`);
          setProgress(true, st.progress || 0, `${Math.round(100 * (st.progress || 0))}% ${st.message || ''}`);
          if (st.status === 'done') return resolve(st);
          if (st.status === 'error') return reject(new Error(st.error || 'solve failed'));
          setTimeout(tick, 300);
        } catch (e) { reject(e); }
      };
      tick();
    });
  }
  function showError(msg) {
    $('#extra').innerHTML = `<div class="box"><h3>Error</h3><div class="err">${esc(msg)}</div></div>`;
  }

  // ---------- Navigation ----------
  async function go(nodeId) {
    const node = await getNode(S.frame.solveId, nodeId);
    await Promise.all((node.history || []).map((h) => getNode(S.frame.solveId, h.nodeId).catch(() => null)));
    S.oppChild = await firstOtherChild(node);
    if (!S.node || S.node.id !== node.id) S.tableOpen.clear();
    S.node = node; S.sel = null; S.hover = null; S.boardPick = [];
    if (node.terminal) S.rangeSide = S.rangeSide && termRanges(node)[S.rangeSide] ? S.rangeSide : Object.keys(termRanges(node))[0] || null;
    location.hash = `s=${S.frame.solveId}&n=${encodeURIComponent(nodeId)}`;
    render();
  }
  async function goParent(i, nodeId) {
    const p = S.parents[i];
    if (p.frame.stale) {
      // Same params give the same tree, so the node ids stay valid in the new solve.
      setProgress(true, 0, 'updating preflop with the new calibration sample');
      try {
        const { solveId } = await api('/api/solve', { kind: p.frame.kind, params: p.frame.params });
        const st = await waitSolve(solveId);
        p.frame = { ...p.frame, solveId, stats: st.stats, root: st.root, sample: null, stale: false, refreshed: true };
      } catch (e) { showError(e.message); } finally { setProgress(false); }
    }
    S.parents = S.parents.slice(0, i);
    S.frame = p.frame;
    await go(nodeId);
  }

  // ---------- Rendering ----------
  // Grid fills the free height of the main area (setup panel and action bar may change it).
  function sizeGrid() {
    const main = $('#main'), tabs = $('#viewtabs');
    const h = main.clientHeight - tabs.offsetHeight - 30, w = window.innerWidth - 480;
    const size = Math.max(260, Math.min(h, w));
    $('#grid').style.setProperty('--size', size + 'px');
    // The other views may be wider than the grid (Ranges: two grids side by side), up to twice its size.
    $('#view').style.setProperty('--size', size + 'px');
    $('#view').style.setProperty('--vw', Math.max(size, Math.min(w, 2 * size + 10)) + 'px');
  }
  window.addEventListener('resize', sizeGrid);

  // Download the node on screen as JSON, with the solve it belongs to (the server keeps solves in memory only).
  function exportNode() {
    const n = S.node, f = S.frame;
    if (!n || !f) return;
    const data = {
      exportedAt: new Date().toISOString(),
      solve: { solveId: f.solveId, kind: f.kind, params: f.params, stats: f.stats, root: f.root },
      node: n,
    };
    const name = [f.kind, n.street, (n.board || []).join(''), n.id].filter(Boolean).join('-').replace(/[^\w.-]+/g, '_').slice(0, 120);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = el('a'); a.href = url; a.download = name + '.json';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('#exportBtn').onclick = exportNode;

  function render() {
    $('#spotline').innerHTML = spotLine(S.frame);
    $('#exportBtn').classList.remove('hidden');
    $('#empty').classList.add('hidden');
    S.cells = S.node.toAct ? aggregate(S.node) : null;
    renderActionBar();
    sizeGrid();
    renderGrid();
    renderRight();
  }

  // all = every board card up to this street (first board column of a solve that starts on the turn or river).
  function streetCards(node, street, all) {
    const b = node.board || [];
    const end = street === 'flop' ? 3 : street === 'turn' ? 4 : street === 'river' ? 5 : 0;
    return all ? b.slice(0, end) : b.slice(Math.max(0, end === 3 ? 0 : end - 1), end);
  }
  function boardCol(node, street, all) {
    const c = el('div', 'col board');
    c.innerHTML = `<div class="hd"><span>${esc(street[0].toUpperCase() + street.slice(1))}</span><span class="st">${node.pot !== undefined ? esc(+node.pot.toFixed(2)) + ' bb' : ''}</span></div><div class="cards">${streetCards(node, street, all).map((x) => cardHtml(x)).join('')}</div>`;
    return c;
  }
  function decisionCol(node, pos, chosenLabel, onClick, isCur) {
    const c = el('div', 'col' + (isCur ? ' cur' : ''));
    const pl = (node.players || []).find((p) => p.pos === pos);
    c.innerHTML = `<div class="hd"><span>${esc(pos || '')}</span><span class="st">${pl ? esc(+pl.stack.toFixed(2)) : ''}</span></div>`;
    const colors = actionColors(node.actions || []);
    (node.actions || []).forEach((a, k) => {
      const d = el('div', 'a', esc(a.label));
      if (a.label === chosenLabel) { d.classList.add('chosen'); d.style.background = colors[k]; }
      if (isCur) d.onclick = (ev) => { ev.stopPropagation(); go(a.child); };
      c.append(d);
    });
    if (onClick) c.onclick = onClick;
    return c;
  }
  function renderActionBar() {
    const bar = $('#actionbar'); bar.innerHTML = '';
    let prevStreet = null;
    // A dealt card has no column of its own: the next street's board column shows it, and a click
    // on that board column goes back to the card picker (pendingDeal).
    let pendingDeal = null;
    const addBoard = (node, street) => {
      const bc = boardCol(node, street, prevStreet === null || prevStreet === 'preflop');
      if (pendingDeal) { bc.onclick = pendingDeal; bc.title = 'Pick another card'; bc.classList.add('pick'); pendingDeal = null; }
      bar.append(bc);
    };
    const addCols = (frameSolveId, history, parentIdx) => {
      for (const h of history) {
        const key = frameSolveId + '|' + h.nodeId;
        const node = S.nodeVals.get(key);
        if (!node) continue;
        const onClick = parentIdx === undefined ? () => go(h.nodeId) : () => goParent(parentIdx, h.nodeId);
        if (h.type === 'deal' || (node.actions || []).some((a) => a.type === 'deal')) { pendingDeal = onClick; continue; }
        if (node.street !== 'preflop' && node.street !== prevStreet) addBoard(node, node.street);
        prevStreet = node.street;
        const col = decisionCol(node, h.pos, h.label, onClick, false);
        if (parentIdx !== undefined) col.classList.add('parent');
        bar.append(col);
      }
    };
    S.parents.forEach((p, i) => addCols(p.frame.solveId, p.node.history || [], i));
    addCols(S.frame.solveId, S.node.history || []);
    const n = S.node;
    if (n.street !== 'preflop' && n.street !== prevStreet && !(n.actions || []).some((a) => a.type === 'deal')) addBoard(n, n.street);
    if (n.toAct) bar.append(decisionCol(n, n.toAct, null, null, true));
    else if (n.terminal) {
      const t = n.terminal.type;
      const txt = t === 'flop' ? 'Flop' : t === 'showdown' ? 'Showdown' : 'Fold';
      const c = el('div', 'col end', `<div><b>${txt}</b></div><div>${esc(+n.pot.toFixed(2))} bb pot</div>`);
      bar.append(c);
    } else if ((n.actions || []).some((a) => a.type === 'deal')) {
      bar.append(el('div', 'col end', '<div><b>Deal</b></div><div>pick a card</div>'));
    }
    bar.scrollLeft = bar.scrollWidth;
  }

  function termRanges(n) {
    if (n.terminal && n.terminal.flop && n.terminal.flop.ranges) return n.terminal.flop.ranges;
    return n.ranges || {};
  }

  function renderGrid() {
    const n = S.node, grid = $('#grid'), head = $('#gridHead');
    grid.innerHTML = ''; head.innerHTML = '';
    const deal = (n.actions || []).filter((a) => a.type === 'deal');
    const picker = $('#picker'), view = $('#view');
    const other = !deal.length && S.view !== 'strategy' && S.view !== 'ev';
    picker.classList.toggle('hidden', !deal.length);
    grid.classList.toggle('hidden', !!deal.length || other);
    view.classList.toggle('hidden', !other);
    if (deal.length) { renderDealPicker(deal); return; }
    if (other) { renderView(); return; }

    if (n.terminal) {
      const ranges = termRanges(n), sides = Object.keys(ranges);
      head.innerHTML = sides.length ? `Range <span class="seg">${sides.map((s) => `<button data-side="${esc(s)}" class="${s === S.rangeSide ? 'on' : ''}">${esc(s)}</button>`).join('')}</span>` : '<span>No ranges for this node</span>';
      head.querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => { S.rangeSide = b.dataset.side; renderGrid(); renderRight(); }));
      const cells = rangeCells(ranges[S.rangeSide] || {});
      for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
        const name = cellName(r, c), d = cells[name], frac = d ? d.w / d.n : 0;
        const cell = el('div', 'cell' + (frac <= 0 ? ' zero' : '') + (frac > 0 && !cellPasses(name, null) ? ' dimf' : ''));
        cell.innerHTML = `<div class="bars" style="height:${(100 * frac).toFixed(1)}%"><div style="width:100%;background:#4c7a5a"></div></div><span class="nm">${name}</span>${frac > 0 ? `<span class="ev">${frac < 0.005 ? '&lt;1' : Math.round(100 * frac)}%</span>` : ''}`;
        grid.append(cell);
      }
      return;
    }

    const cells = S.cells || aggregate(n), colors = actionColors(n.actions);
    S.cells = cells;
    head.innerHTML = `<b>${esc(n.toAct || '')}</b> to act`;
    let maxAbs = 0;
    if (S.view === 'ev') for (const c of Object.values(cells)) if (c.handEv !== null) maxAbs = Math.max(maxAbs, Math.abs(c.handEv));
    for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
      const name = cellName(r, c), d = cells[name];
      const frac = d ? Math.min(1, d.w / d.n) : 0;
      const cell = el('div', 'cell' + (frac <= 1e-6 ? ' zero' : '') + (S.sel === name ? ' sel' : '') + (frac > 1e-6 && !cellPasses(name, d) ? ' dimf' : ''));
      cell.dataset.name = name;
      let bars = '';
      if (d && frac > 1e-6) {
        if (S.view === 'ev') {
          const x = d.handEv === null || !maxAbs ? 0 : d.handEv / maxAbs;
          const col = x >= 0 ? `rgba(79,167,90,${0.25 + 0.75 * x})` : `rgba(217,87,74,${0.25 + 0.75 * -x})`;
          bars = `<div class="bars" style="height:${(100 * frac).toFixed(1)}%"><div style="width:100%;background:${col}"></div></div>`;
        } else {
          bars = `<div class="bars" style="height:${(100 * frac).toFixed(1)}%">${d.s.map((f, a) => (f > 0.0005 ? `<div style="width:${(100 * f).toFixed(2)}%;background:${colors[a]}"></div>` : '')).join('')}</div>`;
        }
      }
      const ev = d && d.handEv !== null && frac > 1e-6 ? `<span class="ev">${fmtEv(d.handEv)}</span>` : '';
      cell.innerHTML = `${bars}<span class="nm">${name}</span>${ev}`;
      cell.onmouseenter = () => { S.hover = name; if (!S.sel) renderHands(); };
      cell.onclick = () => { S.sel = S.sel === name ? null : name; grid.querySelectorAll('.cell.sel').forEach((x) => x.classList.remove('sel')); if (S.sel) cell.classList.add('sel'); renderHands(); };
      grid.append(cell);
    }
  }

  function renderDealPicker(deal) {
    const picker = $('#picker');
    const avail = new Map(deal.map((a) => [a.label, a]));
    let html = '<h3>Deal the next card</h3><div class="deck">';
    for (const s of 'shdc') for (const r of RANKS) { const nm = r + s; html += cardHtml(nm, avail.has(nm) ? '' : 'off'); }
    picker.innerHTML = html + '</div>';
    picker.querySelectorAll('.card').forEach((c) => { const a = avail.get(c.dataset.card); if (a) c.onclick = () => go(a.child); });
  }

  function renderRight() {
    const n = S.node;
    const pot = n.pot || 0, tc = n.toCall || 0;
    $('#potline').innerHTML = `<span>Pot <b>${+pot.toFixed(2)}</b> bb</span>` + (n.toAct ? `<span>To call <b>${+tc.toFixed(2)}</b></span><span>Pot odds <b>${tc > 0 ? ((100 * tc) / (pot + tc)).toFixed(1) + '%' : '-'}</b></span>` : '') + `<span>Street <b>${esc(n.street)}</b></span>`;
    const sum = $('#summary'), sbar = $('#stackbar');
    sum.innerHTML = ''; sbar.innerHTML = '';
    if (n.toAct && n.actions.length) {
      const colors = actionColors(n.actions);
      const cells = S.cells || aggregate(n);
      let total = 0; const per = new Array(n.actions.length).fill(0);
      for (const c of Object.values(cells)) { total += c.w; c.s.forEach((f, a) => (per[a] += f * c.w)); }
      n.actions.forEach((a, k) => {
        const pct = total ? (100 * per[k]) / total : 0;
        const b = el('div', 'abox', `<div class="t">${esc(a.label)}</div><div class="p">${pct.toFixed(1)}%</div><div class="c">${per[k].toFixed(1)} combos</div>`);
        b.style.background = colors[k]; b.style.cursor = 'pointer'; b.title = 'Go to this action';
        b.onclick = () => go(a.child);
        sum.append(b);
        const seg = el('div'); seg.style.width = pct + '%'; seg.style.background = colors[k]; sbar.append(seg);
      });
      sbar.classList.remove('hidden');
    } else sbar.classList.add('hidden');
    renderHands();
    renderStats();
    renderSummaryTab();
    renderFiltersTab();
    renderBlockersTab();
    renderExtra();
  }

  function renderHands() {
    const box = $('#tab-hands'), n = S.node;
    if (!n.toAct) {
      box.innerHTML = n.terminal ? `<div class="muted">Terminal node (${esc(n.terminal.type)}). The grid shows the ${esc(S.rangeSide || '')} range that reaches it.</div>` : '<div class="muted">Chance node.</div>';
      return;
    }
    const name = S.sel || S.hover;
    const d = name && S.cells && S.cells[name];
    if (!d) { box.innerHTML = '<div class="muted">Hover or click a cell to see its combos.</div>'; return; }
    const colors = actionColors(n.actions);
    let html = `<div class="hp-title"><b>${esc(name)}</b><span class="muted">${(d.w).toFixed(2)} / ${d.n} combos &middot; EV ${d.handEv === null ? '-' : d.handEv.toFixed(2)} bb${S.sel ? ' &middot; locked' : ''}</span></div><div class="combos">`;
    for (const cb of d.combos) {
      html += `<div class="combo"><div class="ch"><div class="mini">${cardHtml(cb.name.slice(0, 2))}${cardHtml(cb.name.slice(2, 4))}</div><span class="muted">${(100 * cb.weight).toFixed(0)}%</span></div>`;
      html += `<div class="bar">${cb.strategy.map((f, a) => `<div style="width:${(100 * f).toFixed(2)}%;background:${colors[a]}"></div>`).join('')}</div>`;
      n.actions.forEach((a, k) => {
        const ev = cb.ev && cb.ev[k] !== null && cb.ev[k] !== undefined ? fmtEv(cb.ev[k]) : '-';
        html += `<div class="row"><span><span class="dot" style="background:${colors[k]}"></span>${esc(a.label)}</span><span>${(100 * (cb.strategy[k] || 0)).toFixed(1)}% &nbsp; ${ev}</span></div>`;
      });
      html += '</div>';
    }
    box.innerHTML = html + '</div><div class="note">Per action: frequency, EV in bb (fold = 0).</div>';
  }

  function renderStats() {
    const st = (S.frame && S.frame.stats) || {};
    const rows = [];
    const fmt = (v) => (typeof v === 'number' ? (Math.abs(v) < 1 && v !== 0 ? v.toPrecision(3) : +v.toFixed(2)) : esc(String(v)));
    if (st.iterations !== undefined) rows.push(['Iterations', fmt(st.iterations)]);
    if (st.exploitabilityPctPot !== undefined) rows.push(['Exploitability', st.exploitabilityPctPot === null ? '-' : st.exploitabilityPctPot.toFixed(3) + '% pot']);
    if (st.ms !== undefined) rows.push(['Solve time', (st.ms / 1000).toFixed(2) + ' s']);
    for (const [k, v] of Object.entries(st)) if (!['iterations', 'exploitabilityPctPot', 'ms'].includes(k) && (typeof v !== 'object' || v === null)) rows.push([esc(k), fmt(v)]);
    $('#tab-stats').innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` + calibHtml(st.calibration) + (S.frame && S.frame.refreshed ? '<div class="note">Updated with the new calibration sample.</div>' : '') + sampleHtml(S.frame && S.frame.sample) + (S.node.note ? `<div class="note">${esc(S.node.note)}</div>` : '');
  }
  // Realization mode and flops sampled per flop terminal (20 = full).
  function calibHtml(c) {
    if (!c) return '';
    const rows = (c.terminals || []).map((t) => {
      const f = Math.min(1, t.flops / (t.full || 20));
      const reach = t.mass !== undefined ? ` (${(100 * t.mass).toFixed(1)}% of deals)` : '';
      return `<div class="row" title="${esc(t.key)}${esc(reach)}; weight of measured R m = ${t.m}"><span>${esc(t.name || t.key)}</span><span class="n">${t.flops} flop${t.flops === 1 ? '' : 's'}</span><div class="meter"><div style="width:${(100 * f).toFixed(0)}%"></div></div></div>`;
    }).join('');
    const src = c.mode === 'flat' ? '' : c.source === 'samples' ? '' : c.source === 'batch table' ? ' (batch table)' : ' (no samples yet: flat R)';
    return `<div class="calib"><div class="hd"><span>Realization: <b>${esc(c.mode)}</b>${esc(src)}</span><span class="muted">${((c.terminals || [])[0] || {}).full || 20} flops = full</span></div>${rows}</div>`;
  }
  function sampleHtml(s) {
    if (!s) return '';
    if (s.file) return `<div class="note">Calibration sample saved: ${s.flops} flop${s.flops === 1 ? '' : 's'} for this preflop spot.</div>`;
    return `<div class="note">No calibration sample: ${esc(s.error || s.skipped || '')}</div>`;
  }

  function renderExtra() {
    const n = S.node, box = $('#extra');
    box.innerHTML = '';
    if (!n.terminal) { if (n.note && S.tab === 'hands') box.innerHTML = `<div class="note">${esc(n.note)}</div>`; return; }
    const f = n.terminal.flop;
    let html = `<div class="box"><h3>${esc(n.terminal.type === 'flop' ? 'Flop' : n.terminal.type)}</h3>`;
    if (f) {
      const combos = (r) => Object.values(rangeCells(r)).reduce((s, c) => s + c.w, 0).toFixed(1);
      html += `<dl class="kv"><dt>Pot</dt><dd>${+f.pot.toFixed(2)} bb</dd><dt>Stack behind</dt><dd>${+f.stack.toFixed(2)} bb</dd><dt>SPR</dt><dd>${(f.stack / f.pot).toFixed(2)}</dd><dt>OOP</dt><dd>${esc(f.oop)} (${combos(f.ranges[f.oop])} combos)</dd><dt>IP</dt><dd>${esc(f.ip)} (${combos(f.ranges[f.ip])} combos)</dd></dl>`;
      // The Rust engine ('postflop') if loaded, else the old JS engine.
      const post = S.engines.find((e) => e.kind === 'postflop') || S.engines.find((e) => e.kind === 'postflop-js');
      if (post) {
        html += `<h3 style="margin-top:12px">Pick a flop</h3><div class="deck" id="flopDeck">`;
        for (const s of 'shdc') for (const r of RANKS) html += cardHtml(r + s, S.boardPick.includes(r + s) ? 'pick' : '');
        html += `</div><div style="margin-top:10px;display:flex;gap:10px;align-items:center"><div class="cards">${S.boardPick.map((c) => cardHtml(c)).join('')}</div><button class="primary" id="solveFlop" ${S.boardPick.length === 3 ? '' : 'disabled'}>Solve flop</button><button class="ghost" id="randFlop">Random</button></div>`;
      } else {
        html += '<div class="note">The postflop engine is not loaded, so this flop cannot be solved here yet.</div>';
      }
    }
    if (n.note) html += `<div class="note">${esc(n.note)}</div>`;
    box.innerHTML = html + '</div>';
    const deck = $('#flopDeck');
    if (deck) {
      deck.querySelectorAll('.card').forEach((c) => (c.onclick = () => {
        const nm = c.dataset.card, i = S.boardPick.indexOf(nm);
        if (i >= 0) S.boardPick.splice(i, 1); else if (S.boardPick.length < 3) S.boardPick.push(nm);
        renderExtra();
      }));
      $('#randFlop').onclick = () => {
        const all = []; for (const s of 'shdc') for (const r of RANKS) all.push(r + s);
        S.boardPick = [];
        while (S.boardPick.length < 3) { const c = all[Math.floor(Math.random() * all.length)]; if (!S.boardPick.includes(c)) S.boardPick.push(c); }
        renderExtra();
      };
      $('#solveFlop').onclick = () => {
        const params = { board: S.boardPick.join(''), pot: f.pot, stack: f.stack, oop: f.oop, ip: f.ip, ranges: f.ranges };
        // From a hu-preflop flop terminal: the server saves a realization sample when the solve is done.
        if (S.frame.kind === 'hu-preflop' && n.terminal.key && n.terminal.spotKey) params.source = { kind: 'hu-preflop', spotKey: n.terminal.spotKey, terminalKey: n.terminal.key };
        const post = S.engines.find((e) => e.kind === 'postflop') || S.engines.find((e) => e.kind === 'postflop-js');
        startSolve(post.kind, params, { frame: S.frame, nodeId: n.id, node: n });
      };
    }
  }

  // ---------- Ranges of both players at a node ----------
  // The engines send only the range of the player to act. The opponent's range comes from the last history node
  // where the opponent acted (reach there x frequency of the action taken), or, when the opponent has not acted
  // yet in this solve, from the first child node where the opponent acts (S.oppChild, loaded in go()).
  async function firstOtherChild(node) {
    if (!node.toAct) return null;
    const folded = new Set((node.players || []).filter((p) => p.folded).map((p) => p.pos));
    if ((node.history || []).some((h) => h.pos && h.pos !== node.toAct && !folded.has(h.pos))) return null;
    for (const a of node.actions || []) {
      if (a.type === 'fold') continue;
      const c = await getNode(S.frame.solveId, a.child).catch(() => null);
      if (c && c.toAct && c.toAct !== node.toAct) return c;
    }
    return null;
  }
  const isCombo = (name) => name.length === 4;
  // { kind: 'class' | 'combo', w: { name: weight per combo } } of `pos` from its last action in the history.
  function histRange(n, pos) {
    const h = n.history || [];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].pos !== pos) continue;
      const hn = S.nodeVals.get(S.frame.solveId + '|' + h[i].nodeId);
      if (!hn || !hn.actions) return null;
      const next = i + 1 < h.length ? h[i + 1].nodeId : n.id;
      let k = hn.actions.findIndex((a) => a.child === next);
      if (k < 0) k = hn.actions.findIndex((a) => a.label === h[i].label);
      if (k < 0) return null;
      const w = {};
      for (const [nm, x] of Object.entries(hn.hands || {})) { const v = x.weight * (x.strategy[k] || 0); if (v > 1e-7) w[nm] = v; }
      return { kind: hn.handKind || 'class', w };
    }
    return null;
  }
  const handsRange = (node) => ({ kind: node.handKind || 'class', w: Object.fromEntries(Object.entries(node.hands || {}).map(([k, h]) => [k, h.weight])) });
  // [[pos, range], ...]: the player to act first, then one opponent. Terminal nodes: both players still in.
  function nodeRanges(n) {
    const out = [];
    if (n.toAct) {
      out.push([n.toAct, handsRange(n)]);
      const folded = new Set((n.players || []).filter((p) => p.folded).map((p) => p.pos));
      const h = n.history || [];
      let opp = null;
      for (let i = h.length - 1; i >= 0 && !opp; i--) if (h[i].pos && h[i].pos !== n.toAct && !folded.has(h[i].pos)) opp = h[i].pos;
      if (opp) { const r = histRange(n, opp); if (r) out.push([opp, r]); }
      else if (S.oppChild && S.node === n) out.push([S.oppChild.toAct, handsRange(S.oppChild)]);
      return out.map(([p, r]) => [p, cleanRange(r, n.board)]);
    }
    const tr = termRanges(n);
    if (Object.keys(tr).length) {
      for (const [pos, r] of Object.entries(tr)) out.push([pos, { kind: Object.keys(r).some(isCombo) ? 'combo' : 'class', w: r }]);
      return out;
    }
    for (const p of n.players || []) { const r = histRange(n, p.pos); if (r) out.push([p.pos, cleanRange(r, n.board)]); }
    return out.slice(0, 2);
  }
  // Drop combos that share a card with the board (cards dealt after the opponent's last action).
  function cleanRange(r, board) {
    if (r.kind !== 'combo' || !board || !board.length) return r;
    const w = {};
    for (const [nm, x] of Object.entries(r.w)) if (!board.includes(nm.slice(0, 2)) && !board.includes(nm.slice(2, 4))) w[nm] = x;
    return { kind: r.kind, w };
  }
  // [[comboName, weight], ...] of a range (classes are expanded; board cards removed).
  function rangeCombos(r, board) {
    const out = [], b = board || [];
    for (const [nm, w] of Object.entries(r.w)) {
      if (!(w > 0)) continue;
      for (const cb of isCombo(nm) ? [nm] : classCombos(nm)) if (!b.includes(cb.slice(0, 2)) && !b.includes(cb.slice(2, 4))) out.push([cb, w]);
    }
    return out;
  }
  const rangeTotal = (r) => Object.values(rangeCells(r.w)).reduce((s, c) => s + c.w, 0);

  // ---------- Hand classes (cached per board) ----------
  const classCache = new Map();
  function comboClassOn(cb, board) {
    const key = board.join('');
    let m = classCache.get(key);
    if (!m) { m = new Map(); classCache.set(key, m); if (classCache.size > 20) classCache.delete(classCache.keys().next().value); }
    let k = m.get(cb);
    if (!k) { k = HC.classify(cb, board); m.set(cb, k); }
    return k;
  }
  const hasBoard = (n) => (n.board || []).length >= 3;
  const needsBoard = (what) => `<div class="vempty">${esc(what)} needs a board. Solve a flop from a flop terminal first.</div>`;

  // ---------- Filters ----------
  // Chips of one kind are OR'ed, kinds are AND'ed. A chip for an action that this node does not have is ignored.
  function filterSets(n) {
    const g = [], c = [], a = [];
    for (const f of S.filters) {
      const [kind, v] = [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)];
      if (kind === 'group') g.push(v);
      else if (kind === 'class' && hasBoard(n)) c.push(v);
      else if (kind === 'act') { const k = (n.actions || []).findIndex((x) => x.label === v); if (k >= 0 && n.toAct) a.push(k); }
    }
    return { g, c, a, any: g.length + c.length + a.length > 0 };
  }
  // One combo (or a preflop class with its strategy) passes the filters.
  function comboPasses(name, strategy, n, fs) {
    if (fs.g.length && !fs.g.includes(HC.handGroup(isCombo(name) ? comboClass(name) : name))) return false;
    if (fs.c.length) {
      if (!isCombo(name)) return false;
      const k = comboClassOn(name, n.board);
      if (!fs.c.includes(k.made) && !k.draws.some((d) => fs.c.includes(d))) return false;
    }
    if (fs.a.length && !(strategy && fs.a.some((k) => (strategy[k] || 0) > 0.005))) return false;
    return true;
  }
  // A grid cell passes when one of its combos passes (d = aggregated cell of the player to act; null = a range
  // without strategy, where action chips do not apply).
  function cellPasses(name, d) {
    const n = S.node, fs = filterSets(n);
    if (!fs.any) return true;
    if (d && d.combos.length && n.handKind === 'combo') return d.combos.some((cb) => comboPasses(cb.name, cb.strategy, n, fs));
    if (d && d.combos.length) return comboPasses(name, d.combos[0].strategy, n, fs);
    const noAct = { ...fs, a: [] };
    if (hasBoard(n) && fs.c.length) return classCombos(name).some((cb) => !n.board.includes(cb.slice(0, 2)) && !n.board.includes(cb.slice(2, 4)) && comboPasses(cb, null, n, noAct));
    return comboPasses(name, null, n, noAct);
  }

  // ---------- Equity (engine value, else computed in a Web Worker) ----------
  let eqWorker = null, eqSeq = 0;
  const eqPending = new Map(), eqCache = new Map();
  function equityWorker() {
    if (eqWorker) return eqWorker;
    eqWorker = new Worker('equity-worker.js');
    eqWorker.onmessage = (e) => { const p = eqPending.get(e.data.id); if (!p) return; eqPending.delete(e.data.id); if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data); };
    eqWorker.onerror = (e) => { for (const p of eqPending.values()) p.reject(new Error(e.message || 'equity worker failed')); eqPending.clear(); eqWorker = null; };
    return eqWorker;
  }
  function workerEquity(board, ranges, samples) {
    return new Promise((resolve, reject) => {
      const id = ++eqSeq;
      eqPending.set(id, { resolve, reject });
      equityWorker().postMessage({ id, board, ranges, samples });
    });
  }
  // Flop: all 1176 turn+river runouts while the work stays small (about 1 s for two 1000-combo ranges), else a
  // random sample of them. The turn and river are always exact.
  const flopSamples = (nA, nB) => { const k = Math.floor(2.6e6 / Math.max(1, nA + nB)); return k >= 1176 ? 0 : Math.max(200, k); };
  // Average equity of side p, weighted by combo weight x opponent weight that does not share a card with the combo,
  // so the two players' averages add to 100% (card removal included).
  function avgEquity(list, eq, opp) {
    const tot = opp.reduce((s, x) => s + x[1], 0), card = new Map(), same = new Map();
    for (const [cb, w] of opp) { for (const c of [cb.slice(0, 2), cb.slice(2, 4)]) card.set(c, (card.get(c) || 0) + w); same.set(cb, (same.get(cb) || 0) + w); }
    let num = 0, den = 0;
    list.forEach(([cb, w]) => {
      const e = eq.get(cb);
      if (e === undefined || Number.isNaN(e)) return;
      const ow = tot - (card.get(cb.slice(0, 2)) || 0) - (card.get(cb.slice(2, 4)) || 0) + (same.get(cb) || 0);
      num += w * ow * e; den += w * ow;
    });
    return den > 0 ? num / den : null;
  }
  // { status: 'done', sides: [{ pos, list, eq: Map, avg, src }], note } | { status: 'running' } | { status: 'error' } | null.
  function nodeEquity(n, onDone) {
    if (!hasBoard(n)) return null;
    const key = S.frame.solveId + '|' + n.id;
    const c = eqCache.get(key);
    if (c) return c;
    const sides = nodeRanges(n);
    if (sides.length < 2) return { status: 'error', error: 'only one range is known at this node' };
    const lists = sides.map(([, r]) => rangeCombos(r, n.board));
    const engine = n.toAct && n.handKind === 'combo' && Object.values(n.hands || {}).some((h) => typeof h.equity === 'number');
    const st = { status: 'running' };
    eqCache.set(key, st);
    const board = n.board.map(HC.parseCard);
    const t0 = performance.now();
    workerEquity(board, lists.map((l) => l.map(([cb, w]) => [...HC.parseCombo(cb), w])), board.length === 3 ? flopSamples(lists[0].length, lists[1].length) : 0).then((r) => {
      const res = { status: 'done', sides: [], ms: Math.round(performance.now() - t0), runouts: r.runouts };
      sides.forEach(([pos], p) => {
        const eq = new Map();
        let src = 'computed';
        if (p === 0 && engine) { src = 'engine'; for (const [cb, h] of Object.entries(n.hands)) if (typeof h.equity === 'number') eq.set(cb, h.equity); }
        else lists[p].forEach(([cb], k) => eq.set(cb, r.eq[p][k]));
        res.sides.push({ pos, list: lists[p], eq, src });
      });
      res.sides.forEach((sd, p) => (sd.avg = avgEquity(sd.list, sd.eq, lists[1 - p])));
      eqCache.set(key, res);
      if (eqCache.size > 200) eqCache.delete(eqCache.keys().next().value);
      if (onDone) onDone(res);
    }, (e) => { eqCache.set(key, { status: 'error', error: e.message }); if (onDone) onDone(null); });
    return st;
  }
  const rerenderIfHere = (n, views) => () => { if (S.node === n && views.includes(S.view)) renderView(); };

  // ---------- Views over the grid (Ranges, Breakdown, Equity chart, Table) ----------
  function renderView() {
    const n = S.node, box = $('#view'), head = $('#gridHead');
    head.innerHTML = n.toAct ? `<b>${esc(n.toAct)}</b> to act` : n.terminal ? `Terminal (${esc(n.terminal.type)})` : '';
    if (S.view === 'ranges') return renderRanges(box);
    if (S.view === 'table') return renderTable(box);
    if (S.view === 'breakdown') return renderBreakdown(box);
    if (S.view === 'equity') return renderEquityChart(box);
  }
  const pct = (x, d = 1) => (100 * x).toFixed(d) + '%';
  const RANGE_COLORS = ['79,167,90', '76,138,214'];

  function renderRanges(box) {
    const n = S.node, sides = nodeRanges(n);
    if (!sides.length) { box.innerHTML = '<div class="vempty">No ranges at this node.</div>'; return; }
    const live = hasBoard(n) ? 1326 - comboBlockedByBoard(n.board) : 1326;
    const cellsBy = sides.map(([, r]) => rangeCells(r.w));
    let html = '<div class="rgrids">';
    sides.forEach(([pos, r], i) => {
      const tot = rangeTotal(r);
      html += `<div class="rside"><div class="rhd"><b>${esc(pos)}</b> range: ${tot.toFixed(1)} combos (${pct(tot / live, 0)})${i === 0 && n.toAct ? ' &middot; to act' : ''}</div><div class="grid mini">`;
      for (let rr = 0; rr < 13; rr++) for (let c = 0; c < 13; c++) {
        const name = cellName(rr, c), d = cellsBy[i][name], frac = d ? Math.min(1, d.w / d.n) : 0;
        const dim = frac > 0 && !cellPasses(name, i === 0 && S.cells ? S.cells[name] : null) ? ' dimf' : '';
        html += `<div class="cell${frac <= 1e-6 ? ' zero' : ''}${dim}" data-name="${name}" style="${frac > 1e-6 ? `background:rgba(${RANGE_COLORS[i]},${(0.12 + 0.88 * frac).toFixed(3)})` : ''}"><span class="nm">${name}</span></div>`;
      }
      html += '</div></div>';
    });
    html += '</div><div class="rinfo" id="rangeInfo">Hover a cell: weight and combos of both players.</div>';
    if (sides.length < 2) html += '<div class="note">The other player\'s range is not known at this node.</div>';
    box.innerHTML = html;
    box.querySelectorAll('.grid.mini .cell').forEach((cell) => (cell.onmouseenter = () => {
      const name = cell.dataset.name, nc = nCombosOn(name, n.board);
      $('#rangeInfo').innerHTML = `<b>${esc(name)}</b> ` + sides.map(([pos], i) => {
        const d = cellsBy[i][name], w = d ? d.w : 0;
        return `&middot; ${esc(pos)} <b>${w.toFixed(2)}</b> / ${nc} combos (${pct(nc ? w / nc : 0, 0)})`;
      }).join(' ');
    }));
  }
  function comboBlockedByBoard(board) { const k = board.length; return 1326 - ((52 - k) * (51 - k)) / 2; }
  const nCombosOn = (cls, board) => (board && board.length ? classCombos(cls).filter((cb) => !board.includes(cb.slice(0, 2)) && !board.includes(cb.slice(2, 4))).length : nCombos(cls));

  // Table: one row per hand class of the player to act; postflop rows open into combos.
  function renderTable(box) {
    const n = S.node;
    if (!n.toAct) { renderRangeTable(box); return; }
    const cells = S.cells, colors = actionColors(n.actions), fs = filterSets(n);
    const eqRes = hasBoard(n) ? nodeEquity(n, rerenderIfHere(n, ['table'])) : null;
    const eqMap = eqRes && eqRes.status === 'done' ? eqRes.sides[0].eq : null;
    const engineEq = n.handKind === 'combo' && Object.values(n.hands).some((h) => typeof h.equity === 'number');
    const comboEq = (cb) => { const h = n.hands[cb]; if (h && typeof h.equity === 'number') return h.equity; const e = eqMap && eqMap.get(cb); return e === undefined || Number.isNaN(e) ? null : e; };
    const showEq = hasBoard(n);
    const rows = [];
    for (const [name, d] of Object.entries(cells)) {
      if (!(d.w > 1e-6)) continue;
      const combos = d.combos.filter((cb) => !fs.any || comboPasses(n.handKind === 'combo' ? cb.name : name, cb.strategy, n, fs));
      if (!combos.length) continue;
      let eq = null;
      if (showEq) { let a = 0, b = 0; for (const cb of d.combos) { const e = comboEq(cb.name); if (e !== null) { a += cb.weight * e; b += cb.weight; } } eq = b > 0 ? a / b : null; }
      rows.push({ name, d, eq, combos, live: nCombosOn(name, n.board) });
    }
    const key = (r, col) => (col === 'hand' ? -handOrder(r.name) : col === 'combos' ? r.d.w : col === 'weight' ? r.d.w / r.live : col === 'ev' ? (r.d.handEv === null ? -1e9 : r.d.handEv) : col === 'eq' ? (r.eq === null ? -1 : r.eq) : r.d.s[+col.slice(1)]);
    const { col, dir } = S.tableSort;
    rows.sort((a, b) => dir * (key(a, col) - key(b, col)) || handOrder(a.name) - handOrder(b.name));
    const th = (c, label, cls = '') => `<th data-col="${c}" class="${cls}${col === c ? ' sorted' : ''}">${label}${col === c ? (dir < 0 ? ' &#9662;' : ' &#9652;') : ''}</th>`;
    let html = `<table class="htable"><thead><tr>${th('hand', 'Hand', 'l')}${th('combos', 'Combos')}${th('weight', 'Weight')}`;
    n.actions.forEach((a, k) => (html += th('a' + k, `<span class="dot" style="background:${colors[k]}"></span>${esc(a.label)}`)));
    html += `${th('ev', 'EV')}${showEq ? th('eq', 'Equity') : ''}</tr></thead><tbody>`;
    const fmtEq = (e) => (e === null ? (eqRes && eqRes.status === 'running' ? '&hellip;' : '-') : pct(e));
    for (const r of rows) {
      const open = n.handKind === 'combo' && S.tableOpen.has(r.name);
      html += `<tr class="hrow" data-name="${r.name}"><td class="l">${n.handKind === 'combo' ? `<span class="tw">${open ? '&#9662;' : '&#9656;'}</span>` : ''}${r.name}</td><td>${r.d.w.toFixed(2)}</td><td>${pct(r.d.w / r.live)}</td>`;
      r.d.s.forEach((f) => (html += `<td>${pct(f)}</td>`));
      html += `<td>${r.d.handEv === null ? '-' : fmtEv(r.d.handEv)}</td>${showEq ? `<td>${fmtEq(r.eq)}</td>` : ''}</tr>`;
      if (open) {
        for (const cb of r.combos) {
          let ev = null, any = false, e = 0;
          (cb.strategy || []).forEach((f, a) => { if (cb.ev && cb.ev[a] !== null && cb.ev[a] !== undefined && f > 0) { e += f * cb.ev[a]; any = true; } });
          ev = any ? e : null;
          html += `<tr class="crow"><td class="l"><span class="mini">${cardHtml(cb.name.slice(0, 2))}${cardHtml(cb.name.slice(2, 4))}</span></td><td>${cb.weight.toFixed(2)}</td><td>${pct(cb.weight)}</td>`;
          (cb.strategy || []).forEach((f) => (html += `<td>${pct(f)}</td>`));
          html += `<td>${ev === null ? '-' : fmtEv(ev)}</td>${showEq ? `<td>${fmtEq(comboEq(cb.name))}</td>` : ''}</tr>`;
        }
      }
    }
    html += '</tbody></table>';
    const src = showEq ? (engineEq ? 'Equity from the engine.' : eqRes && eqRes.status === 'done' ? `Equity computed in the page (${eqRes.runouts} runouts, ${eqRes.ms} ms).` : eqRes && eqRes.status === 'error' ? 'Equity: ' + esc(eqRes.error) : 'Equity: computing...') : '';
    box.innerHTML = `<div class="tscroll">${html}</div><div class="note">${rows.length} hands${fs.any ? ' (filtered)' : ''}. Click a header to sort${n.handKind === 'combo' ? ', a row to show its combos' : ''}. ${src}</div>`;
    box.querySelectorAll('th[data-col]').forEach((t) => (t.onclick = () => {
      const c = t.dataset.col;
      S.tableSort = { col: c, dir: S.tableSort.col === c ? -S.tableSort.dir : c === 'hand' ? 1 : -1 };
      renderTable(box);
    }));
    if (n.handKind === 'combo') box.querySelectorAll('tr.hrow').forEach((tr) => (tr.onclick = () => {
      const nm = tr.dataset.name;
      if (S.tableOpen.has(nm)) S.tableOpen.delete(nm); else S.tableOpen.add(nm);
      const sc = box.querySelector('.tscroll').scrollTop;
      renderTable(box);
      box.querySelector('.tscroll').scrollTop = sc;
    }));
  }
  // Grid order: AA first, then AKs, AQs ... (row by row).
  function handOrder(name) {
    const cls = isCombo(name) ? comboClass(name) : name;
    const a = RANKS.indexOf(cls[0]), b = RANKS.indexOf(cls[1]);
    return cls.length === 2 ? a * 13 + a : cls[2] === 's' ? a * 13 + b : b * 13 + a;
  }
  // Terminal nodes: the ranges that reach them, one column pair per player.
  function renderRangeTable(box) {
    const n = S.node, sides = nodeRanges(n);
    if (!sides.length) { box.innerHTML = '<div class="vempty">No hands at this node.</div>'; return; }
    const cells = sides.map(([, r]) => rangeCells(r.w));
    const names = [...new Set(cells.flatMap((c) => Object.keys(c)))].filter((nm) => cellPasses(nm, null)).sort((a, b) => handOrder(a) - handOrder(b));
    let html = `<table class="htable"><thead><tr><th class="l">Hand</th>${sides.map(([p]) => `<th>${esc(p)} combos</th><th>${esc(p)} weight</th>`).join('')}</tr></thead><tbody>`;
    for (const nm of names) html += `<tr><td class="l">${nm}</td>${cells.map((c) => { const d = c[nm]; return d ? `<td>${d.w.toFixed(2)}</td><td>${pct(d.w / nCombosOn(nm, n.board))}</td>` : '<td>-</td><td>-</td>'; }).join('')}</tr>`;
    box.innerHTML = `<div class="tscroll">${html}</tbody></table></div><div class="note">No player to act at this node: the table lists the ranges that reach it.</div>`;
  }

  // Breakdown: the range of the player to act by hand class on the board.
  function classRows(n, list, strategyOf) {
    const rows = new Map(), drows = new Map();
    const mk = () => ({ w: 0, s: new Array((n.actions || []).length).fill(0), ev: 0, evw: 0 });
    let total = 0;
    for (const [cb, w] of list) {
      const k = comboClassOn(cb, n.board), h = strategyOf ? strategyOf(cb) : null;
      total += w;
      for (const [map, key] of [[rows, k.made], ...k.draws.map((d) => [drows, d])]) {
        const r = map.get(key) || map.set(key, mk()).get(key);
        r.w += w;
        if (h) {
          h.strategy.forEach((f, a) => (r.s[a] += w * f));
          let e = 0, any = false;
          h.strategy.forEach((f, a) => { if (h.ev && h.ev[a] !== null && h.ev[a] !== undefined && f > 0) { e += f * h.ev[a]; any = true; } });
          if (any) { r.ev += w * e; r.evw += w; }
        }
      }
    }
    for (const r of [...rows.values(), ...drows.values()]) { if (r.w > 0) r.s = r.s.map((x) => x / r.w); r.ev = r.evw > 0 ? r.ev / r.evw : null; }
    return { rows, drows, total };
  }
  function stratBar(s, colors) {
    return `<div class="sbar">${s.map((f, a) => (f > 0.0005 ? `<div style="width:${(100 * f).toFixed(2)}%;background:${colors[a]}" title="${(100 * f).toFixed(1)}%"></div>` : '')).join('')}</div>`;
  }
  function renderBreakdown(box) {
    const n = S.node;
    if (!hasBoard(n)) { box.innerHTML = needsBoard('Breakdown'); return; }
    const sides = nodeRanges(n);
    if (!sides.length) { box.innerHTML = '<div class="vempty">No ranges at this node.</div>'; return; }
    const [pos, r] = sides[0];
    const list = rangeCombos(r, n.board);
    const colors = n.toAct ? actionColors(n.actions) : [];
    const { rows, drows, total } = classRows(n, list, n.toAct ? (cb) => n.hands[cb] : null);
    const line = (name, x) => {
      if (!x) return `<tr class="z"><td class="l">${esc(name)}</td><td>0</td><td>0%</td>${n.toAct ? '<td></td><td></td>' : ''}</tr>`;
      return `<tr><td class="l">${esc(name)}</td><td>${x.w.toFixed(1)}</td><td>${pct(total ? x.w / total : 0)}</td>${n.toAct ? `<td class="bcell">${stratBar(x.s, colors)}</td><td>${x.ev === null ? '-' : fmtEv(x.ev)}</td>` : ''}</tr>`;
    };
    const head = (t) => `<tr><th class="l">${t}</th><th>Combos</th><th>Share</th>${n.toAct ? '<th>Strategy</th><th>EV</th>' : ''}</tr>`;
    let html = `<div class="rhd"><b>${esc(pos)}</b> range: ${total.toFixed(1)} combos on ${n.board.map((c) => cardHtml(c, 'inl')).join('')}</div>`;
    if (n.toAct) html += `<div class="legend">${n.actions.map((a, k) => `<span><span class="dot" style="background:${colors[k]}"></span>${esc(a.label)}</span>`).join('')}</div>`;
    html += `<table class="htable bd"><thead>${head('Made hand')}</thead><tbody>`;
    for (const m of HC.MADE) html += line(m, rows.get(m));
    const sumMade = [...rows.values()].reduce((s, x) => s + x.w, 0);
    html += `<tr class="tot"><td class="l">Total</td><td>${sumMade.toFixed(1)}</td><td>${pct(total ? sumMade / total : 0)}</td>${n.toAct ? '<td></td><td></td>' : ''}</tr></tbody>`;
    if (n.board.length < 5) {
      html += `<thead>${head('Draws')}</thead><tbody>`;
      for (const d of HC.DRAWS) html += line(d, drows.get(d));
      html += '</tbody>';
    }
    html += '</table><div class="note">A combo has one made hand and can also be in the draw list. Pairs are seen from the hole cards; a hand that only plays the board counts as ace high or nothing.</div>';
    box.innerHTML = `<div class="tscroll">${html}</div>`;
  }

  // Equity chart: each range sorted by equity, x = share of the range (by weight).
  function renderEquityChart(box) {
    const n = S.node;
    if (!hasBoard(n)) { box.innerHTML = needsBoard('Equity chart'); return; }
    const res = nodeEquity(n, rerenderIfHere(n, ['equity']));
    if (!res || res.status === 'running') { box.innerHTML = '<div class="vempty">Computing equity&hellip;</div>'; return; }
    if (res.status === 'error') { box.innerHTML = `<div class="vempty">No equity chart: ${esc(res.error)}</div>`; return; }
    const W = 600, Hh = 400, L = 44, R = 12, T = 14, B = 34;
    const xs = (f) => L + f * (W - L - R), ys = (e) => T + (1 - e) * (Hh - T - B);
    let svg = `<svg viewBox="0 0 ${W} ${Hh}" class="eqsvg" role="img" aria-label="Equity distribution">`;
    for (const e of [0, 0.25, 0.5, 0.75, 1]) svg += `<line x1="${L}" x2="${W - R}" y1="${ys(e)}" y2="${ys(e)}" class="gl"/><text x="${L - 6}" y="${ys(e) + 4}" class="ax" text-anchor="end">${e * 100}%</text>`;
    for (const f of [0, 0.25, 0.5, 0.75, 1]) svg += `<text x="${xs(f)}" y="${Hh - B + 16}" class="ax" text-anchor="middle">${f * 100}%</text>`;
    svg += `<text x="${(L + W - R) / 2}" y="${Hh - 4}" class="ax" text-anchor="middle">share of range (sorted by equity)</text>`;
    res.sides.forEach((sd, i) => {
      const pts = sd.list.map(([cb, w]) => [sd.eq.get(cb), w]).filter(([e]) => e !== undefined && !Number.isNaN(e)).sort((a, b) => a[0] - b[0]);
      const tot = pts.reduce((s, x) => s + x[1], 0);
      let acc = 0, d = '';
      for (const [e, w] of pts) { d += `${d ? 'L' : 'M'}${xs(acc / tot).toFixed(1)},${ys(e).toFixed(1)}`; acc += w; d += `L${xs(acc / tot).toFixed(1)},${ys(e).toFixed(1)}`; }
      svg += `<path d="${d}" fill="none" stroke="rgb(${RANGE_COLORS[i]})" stroke-width="2.2"/>`;
    });
    svg += '</svg>';
    const role = (pos) => (n.toAct === pos ? 'to act' : '');
    const avgs = res.sides.map((sd, i) => `<span class="eqk"><span class="dot" style="background:rgb(${RANGE_COLORS[i]})"></span><b>${esc(sd.pos)}</b> ${sd.avg === null ? '-' : pct(sd.avg)}${role(sd.pos) ? ' <span class="muted">(' + role(sd.pos) + ')</span>' : ''}</span>`).join('');
    const src = res.sides.map((sd) => `${esc(sd.pos)}: ${sd.src === 'engine' ? 'from the engine' : 'computed in the page'}`).join(', ');
    const how = n.board.length === 3 ? (res.runouts >= 1176 ? 'all 1176 turn and river runouts' : `${res.runouts} of 1176 turn and river runouts sampled`) : n.board.length === 4 ? 'all river cards' : 'exact';
    box.innerHTML = `<div class="eqhead">Average equity: ${avgs}</div>${svg}<div class="note">${src}; ${how}, ${res.ms} ms. Averages count card removal, so they add to 100%.</div>`;
  }

  // ---------- Right panel tabs: Summary, Filters, Blockers ----------
  // Group of a combo or class: preflop hand groups; on a board, the made hand class.
  const groupOf = (name, n) => (hasBoard(n) && isCombo(name) ? comboClassOn(name, n.board).made : HC.handGroup(isCombo(name) ? comboClass(name) : name));
  function renderSummaryTab() {
    const box = $('#tab-summary'), n = S.node;
    if (S.tab !== 'summary') { box.innerHTML = ''; return; }
    const order = hasBoard(n) ? HC.MADE : HC.GROUPS;
    const what = hasBoard(n) ? 'hand class' : 'hand group';
    if (!n.toAct) {
      const sides = nodeRanges(n);
      if (!sides.length) { box.innerHTML = '<div class="muted">No ranges at this node.</div>'; return; }
      const per = sides.map(([, r]) => { const m = new Map(); for (const [cb, w] of rangeCombos(r, n.board)) { const g = groupOf(cb, n); m.set(g, (m.get(g) || 0) + w); } return m; });
      let html = `<table class="stable"><thead><tr><th class="l">By ${what}</th>${sides.map(([p]) => `<th>${esc(p)} combos</th>`).join('')}</tr></thead><tbody>`;
      for (const g of order) if (per.some((m) => m.get(g))) html += `<tr><td class="l">${esc(g)}</td>${per.map((m) => `<td>${(m.get(g) || 0).toFixed(1)}</td>`).join('')}</tr>`;
      box.innerHTML = html + '</tbody></table><div class="note">No player to act: combos of each range that reaches this node.</div>';
      return;
    }
    const colors = actionColors(n.actions), rows = new Map();
    let total = 0;
    for (const [name, h] of Object.entries(n.hands)) {
      const list = n.handKind === 'combo' ? [name] : classCombos(name);
      for (const cb of list) {
        const g = groupOf(n.handKind === 'combo' ? cb : name, n);
        const r = rows.get(g) || rows.set(g, { w: 0, s: new Array(n.actions.length).fill(0) }).get(g);
        r.w += h.weight; total += h.weight;
        h.strategy.forEach((f, a) => (r.s[a] += h.weight * f));
      }
    }
    let html = `<table class="stable"><thead><tr><th class="l">By ${what}</th><th>Combos</th><th></th>${n.actions.map((a, k) => `<th><span class="dot" style="background:${colors[k]}"></span>${esc(a.label)}</th>`).join('')}</tr></thead><tbody>`;
    for (const g of order) {
      const r = rows.get(g);
      if (!r || !(r.w > 1e-6)) continue;
      const s = r.s.map((x) => x / r.w);
      html += `<tr><td class="l">${esc(g)}</td><td>${r.w.toFixed(1)}</td><td class="bcell">${stratBar(s, colors)}</td>${s.map((f) => `<td>${pct(f)}</td>`).join('')}</tr>`;
    }
    box.innerHTML = html + `</tbody></table><div class="note">${total.toFixed(1)} combos of ${esc(n.toAct)}. Frequencies are weighted by reach.</div>`;
  }

  function renderFiltersTab() {
    const box = $('#tab-filters'), n = S.node;
    if (S.tab !== 'filters') { box.innerHTML = ''; return; }
    const chip = (key, label, extra = '') => `<button class="chip${S.filters.has(key) ? ' on' : ''}${extra}" data-f="${esc(key)}">${label}</button>`;
    let html = '<div class="fsec"><div class="fh">Hand group</div>' + HC.GROUPS.map((g) => chip('group:' + g, esc(g))).join('') + '</div>';
    if (hasBoard(n)) {
      html += '<div class="fsec"><div class="fh">Hand class</div>' + HC.MADE.map((m) => chip('class:' + m, esc(m))).join('') + '</div>';
      if (n.board.length < 5) html += '<div class="fsec"><div class="fh">Draws</div>' + HC.DRAWS.map((d) => chip('class:' + d, esc(d))).join('') + '</div>';
    }
    if (n.toAct && n.actions.length) {
      const colors = actionColors(n.actions);
      html += '<div class="fsec"><div class="fh">Plays action (more than 0.5%)</div>' + n.actions.map((a, k) => chip('act:' + a.label, `<span class="dot" style="background:${colors[k]}"></span>${esc(a.label)}`)).join('') + '</div>';
    }
    // Chips that are on but have no button at this node (an action of another node, a hand class preflop).
    const shown = new Set([...html.matchAll(/data-f="([^"]*)"/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')));
    const rest = [...S.filters].filter((f) => !shown.has(f));
    if (rest.length) html += '<div class="fsec"><div class="fh">On, not used at this node</div>' + rest.map((f) => chip(f, esc(f.replace(':', ': ')), ' idle')).join('') + '</div>';
    html += `<div class="fsec"><button class="ghost" id="fclear" ${S.filters.size ? '' : 'disabled'}>Clear filters</button></div>`;
    html += '<div class="note">Chips of one kind add hands; kinds together narrow them. Hands that do not pass are dim in the grid and left out of the Table. Filters stay while you move through the tree.</div>';
    box.innerHTML = html;
    box.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => {
      const f = b.dataset.f;
      if (S.filters.has(f)) S.filters.delete(f); else S.filters.add(f);
      renderGrid(); renderFiltersTab();
    }));
    $('#fclear').onclick = () => { S.filters.clear(); renderGrid(); renderFiltersTab(); };
  }

  function renderBlockersTab() {
    const box = $('#tab-blockers'), n = S.node;
    if (S.tab !== 'blockers') { box.innerHTML = ''; return; }
    if (!hasBoard(n)) { box.innerHTML = '<div class="muted">Blockers need a board (postflop nodes).</div>'; return; }
    if (!n.toAct) { box.innerHTML = '<div class="muted">No player to act at this node.</div>'; return; }
    const colors = actionColors(n.actions), sides = nodeRanges(n);
    const opp = sides[1] ? rangeCombos(sides[1][1], n.board) : null;
    const mine = new Map(), oppW = new Map();
    let oppTot = 0;
    for (const [cb, h] of Object.entries(n.hands)) {
      for (const c of [cb.slice(0, 2), cb.slice(2, 4)]) {
        const r = mine.get(c) || mine.set(c, { w: 0, s: new Array(n.actions.length).fill(0) }).get(c);
        r.w += h.weight; h.strategy.forEach((f, a) => (r.s[a] += h.weight * f));
      }
    }
    if (opp) for (const [cb, w] of opp) { oppTot += w; for (const c of [cb.slice(0, 2), cb.slice(2, 4)]) oppW.set(c, (oppW.get(c) || 0) + w); }
    let html = `<table class="stable blk"><thead><tr><th class="l">Card</th><th>${esc(n.toAct)} combos</th><th></th>${n.actions.map((a, k) => `<th><span class="dot" style="background:${colors[k]}"></span>${esc(a.label)}</th>`).join('')}<th title="Combos of the opponent's range that hold this card">${opp ? esc(sides[1][0]) + ' removed' : 'Opp. removed'}</th></tr></thead><tbody>`;
    for (const r of RANKS) for (const s of 'shdc') {
      const c = r + s;
      if (n.board.includes(c)) continue;
      const m = mine.get(c), sw = m && m.w > 0 ? m.s.map((x) => x / m.w) : null;
      html += `<tr><td class="l">${cardHtml(c, 'inl')}</td><td>${m ? m.w.toFixed(2) : '0'}</td><td class="bcell">${sw ? stratBar(sw, colors) : ''}</td>${n.actions.map((a, k) => `<td>${sw ? pct(sw[k]) : '-'}</td>`).join('')}<td>${opp ? `${(oppW.get(c) || 0).toFixed(2)} <span class="muted">(${pct(oppTot ? (oppW.get(c) || 0) / oppTot : 0, 0)})</span>` : '-'}</td></tr>`;
    }
    box.innerHTML = html + `</tbody></table><div class="note">Per card not on the board: how ${esc(n.toAct)} plays the combos that hold it, and how many combos of the opponent's range the card removes.</div>`;
  }

  // ---------- Wiring ----------
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => {
    if (b.disabled) return;
    S.tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('#right > .tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + S.tab));
    if (S.node) { renderSummaryTab(); renderFiltersTab(); renderBlockersTab(); }
  }));
  document.querySelectorAll('#viewtabs button').forEach((b) => (b.onclick = () => {
    if (b.disabled) return;
    S.view = b.dataset.view;
    document.querySelectorAll('#viewtabs button').forEach((x) => x.classList.toggle('on', x === b));
    if (S.node) renderGrid();
  }));
  $('#setupToggle').onclick = () => { $('#setup').classList.toggle('hidden'); sizeGrid(); };
  $('#engine').onchange = () => { S.kind = $('#engine').value; renderParams(); };
  $('#solveBtn').onclick = () => startSolve(S.kind, readParams());
  $('#params').onsubmit = (e) => { e.preventDefault(); startSolve(S.kind, readParams()); };
  $('#grid').onmouseleave = () => { S.hover = null; if (!S.sel) renderHands(); };
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea,select') || !S.node) return;
    if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
      const h = S.node.history || [];
      if (h.length) go(h[h.length - 1].nodeId);
      else if (S.parents.length) { const i = S.parents.length - 1; goParent(i, S.parents[i].nodeId); }
    }
  });

  // Idle filler checkbox (Spot setup). Off by default; the server keeps the setting.
  async function initIdle() {
    try {
      const st = await api('/api/idle');
      $('#idleChk').checked = !!st.enabled;
      const min = st.idleMs / 60000;
      $('#idleLbl').textContent = `Fill calibration when idle (${min >= 1 ? Math.round(min) + ' min' : Math.round(st.idleMs / 1000) + ' s'})`;
    } catch (e) { $('#idleFld').classList.add('hidden'); }
    $('#idleChk').onchange = () => api('/api/idle', { enabled: $('#idleChk').checked }).catch((e) => showError(e.message));
  }

  async function init() {
    initIdle();
    try { S.engines = await api('/api/engines'); } catch (e) { S.engines = []; }
    const sel = $('#engine');
    for (const e of S.engines) { const o = el('option', '', esc(e.title || e.kind)); o.value = e.kind; sel.append(o); }
    if (!S.engines.length) { $('#empty').classList.remove('hidden'); $('#empty').textContent = 'No engines loaded.'; return; }
    const q = new URLSearchParams(location.hash.slice(1));
    const urlParams = new URLSearchParams(location.search);
    const last = store.get('lastSolve');
    S.kind = (S.engines.find((e) => e.kind === urlParams.get('kind')) || S.engines.find((e) => last && e.kind === last.kind) || S.engines.find((e) => e.kind === 'hu-preflop') || S.engines[0]).kind;
    sel.value = S.kind;
    renderParams();
    // Reopen the solve in the URL if the server still has it.
    if (q.get('s')) {
      try {
        const st = await api(`/api/solve/${q.get('s')}`);
        if (st.status === 'done') {
          // The server reports the solve's own kind and params (CONTRACT.md), so a link opens with the right spot line.
          if (st.kind && S.engines.some((e) => e.kind === st.kind)) { S.kind = st.kind; sel.value = S.kind; renderParams(); }
          S.frame = { solveId: q.get('s'), kind: st.kind || S.kind, params: st.params || (last && last.params) || {}, stats: st.stats, root: st.root, sample: st.sample };
          await go(q.get('n') || st.root);
          if (q.get('h')) { S.sel = q.get('h'); renderGrid(); renderHands(); }
          if (q.get('t')) { const b = document.querySelector(`#tabs button[data-tab="${CSS.escape(q.get('t'))}"]`); if (b) b.click(); }
          return;
        }
      } catch (e) { /* solve is gone, start a new one */ }
    }
    const eng = S.engines.find((e) => e.kind === S.kind);
    const params = urlParams.get('kind') ? Object.fromEntries([...urlParams].filter(([k]) => k !== 'kind')) : (last && last.kind === S.kind ? last.params : Object.fromEntries((eng.params || []).map((p) => [p.name, p.default])));
    if (S.kind === 'postflop' && !last) { $('#setup').classList.remove('hidden'); $('#empty').classList.remove('hidden'); $('#empty').textContent = 'Set up a spot and press Solve.'; return; }
    await startSolve(S.kind, params);
  }
  init();
})();
