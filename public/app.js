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
  };

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
    $('#grid').style.setProperty('--size', Math.max(260, Math.min(h, w)) + 'px');
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
    renderActionBar();
    sizeGrid();
    renderGrid();
    renderRight();
  }

  function streetCards(node, street) {
    const b = node.board || [];
    return street === 'flop' ? b.slice(0, 3) : street === 'turn' ? b.slice(3, 4) : street === 'river' ? b.slice(4, 5) : [];
  }
  function boardCol(node, street) {
    const c = el('div', 'col board');
    c.innerHTML = `<div class="hd"><span>${esc(street[0].toUpperCase() + street.slice(1))}</span><span class="st">${node.pot !== undefined ? esc(+node.pot.toFixed(2)) + ' bb' : ''}</span></div><div class="cards">${streetCards(node, street).map((x) => cardHtml(x)).join('')}</div>`;
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
    const addCols = (frameSolveId, history, parentIdx) => {
      for (const h of history) {
        const key = frameSolveId + '|' + h.nodeId;
        const node = S.nodeVals.get(key);
        if (!node) continue;
        if (node.street !== 'preflop' && node.street !== prevStreet) bar.append(boardCol(node, node.street));
        prevStreet = node.street;
        const onClick = parentIdx === undefined ? () => go(h.nodeId) : () => goParent(parentIdx, h.nodeId);
        const col = decisionCol(node, h.pos, h.label, onClick, false);
        if (parentIdx !== undefined) col.classList.add('parent');
        bar.append(col);
      }
    };
    S.parents.forEach((p, i) => addCols(p.frame.solveId, p.node.history || [], i));
    addCols(S.frame.solveId, S.node.history || []);
    const n = S.node;
    if (n.street !== 'preflop' && n.street !== prevStreet) bar.append(boardCol(n, n.street));
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
    const picker = $('#picker');
    picker.classList.toggle('hidden', !deal.length);
    grid.classList.toggle('hidden', !!deal.length);
    if (deal.length) { renderDealPicker(deal); return; }

    if (n.terminal) {
      const ranges = termRanges(n), sides = Object.keys(ranges);
      head.innerHTML = sides.length ? `Range <span class="seg">${sides.map((s) => `<button data-side="${esc(s)}" class="${s === S.rangeSide ? 'on' : ''}">${esc(s)}</button>`).join('')}</span>` : '<span>No ranges for this node</span>';
      head.querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => { S.rangeSide = b.dataset.side; renderGrid(); renderRight(); }));
      const cells = rangeCells(ranges[S.rangeSide] || {});
      for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
        const name = cellName(r, c), d = cells[name], frac = d ? d.w / d.n : 0;
        const cell = el('div', 'cell' + (frac <= 0 ? ' zero' : ''));
        cell.innerHTML = `<div class="bars" style="height:${(100 * frac).toFixed(1)}%"><div style="width:100%;background:#4c7a5a"></div></div><span class="nm">${name}</span>${frac > 0 ? `<span class="ev">${frac < 0.005 ? '&lt;1' : Math.round(100 * frac)}%</span>` : ''}`;
        grid.append(cell);
      }
      return;
    }

    const cells = aggregate(n), colors = actionColors(n.actions);
    S.cells = cells;
    head.innerHTML = `<b>${esc(n.toAct || '')}</b> to act`;
    let maxAbs = 0;
    if (S.view === 'ev') for (const c of Object.values(cells)) if (c.handEv !== null) maxAbs = Math.max(maxAbs, Math.abs(c.handEv));
    for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
      const name = cellName(r, c), d = cells[name];
      const frac = d ? Math.min(1, d.w / d.n) : 0;
      const cell = el('div', 'cell' + (frac <= 1e-6 ? ' zero' : '') + (S.sel === name ? ' sel' : ''));
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

  // ---------- Wiring ----------
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => {
    if (b.disabled) return;
    S.tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('#tab-hands').classList.toggle('hidden', S.tab !== 'hands');
    $('#tab-stats').classList.toggle('hidden', S.tab !== 'stats');
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
