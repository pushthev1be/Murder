/* Session Desk — client */
(() => {
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
const uid = p => p + '-' + Math.random().toString(36).slice(2, 9);
const CLIENT = uid('c');
const MARKER = '\u2063' + [...CLIENT.slice(2, 8)].map(c => c.charCodeAt(0).toString(2).padStart(7, '0')).join('').replace(/0/g, '\u200B').replace(/1/g, '\u200C');

const ICONS = {
  claude: '<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/></svg>',
  codex: '<svg viewBox="0 0 24 24"><path d="m5 7 5 5-5 5M12 18h7"/></svg>',
  shell: '<svg viewBox="0 0 24 24"><path d="m5 7 5 5-5 5M12 18h7"/></svg>',
  custom: '<svg viewBox="0 0 24 24"><path d="m5 7 5 5-5 5M12 18h7"/></svg>',
  web: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
  restore: '<svg viewBox="0 0 24 24"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/></svg>',
  park: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  parkSide: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16M8 10l2 2-2 2"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
};
ICONS.chatgpt = '<svg viewBox="0 0 24 24"><path d="M12 3.5a4 4 0 0 1 4 4v3l-4 2.3-4-2.3v-3a4 4 0 0 1 4-4z"/><path d="M8 10.5 4.6 12.4a4 4 0 0 0 4 6.9L12 17.3M16 10.5l3.4 1.9a4 4 0 0 1-4 6.9L12 17.3"/></svg>';
ICONS.front = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
ICONS.dock = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 8v7M8.5 11.5 12 15l3.5-3.5"/></svg>';
const LABEL = { claude: 'Claude Code', codex: 'Codex', shell: 'Terminal', custom: 'Command', web: 'Web chat', chatgpt: 'ChatGPT' };
const STATUS_TEXT = { working: 'working', waiting: 'needs you', idle: 'idle', stopped: 'not running', link: 'opens in its own window', appwin: 'desktop window', gone: 'closed' };
const EXT_GROUP = '__ext';

// ---------- state ----------
let state = null;
let statuses = {};
let home = '';
let focusedId = null;
const unread = new Set();
let discovered = [];         // sessions running outside the desk (from the server)
const lastExt = new Map();   // ext id -> last known item (so a closed one can still show its pane)
const isExt = sid => typeof sid === 'string' && sid.startsWith('x-');
const ext = sid => discovered.find(d => d.id === sid);
const terms = new Map();     // sid -> { term, fit, host, cols, rows, alive }
const paneEls = new Map();   // sid -> pane element (kept across re-renders)

// ---------- server sync ----------
let saveTimer = null;
const removedQueue = new Set(); // conversations you removed: the server stops them on the next save
let unsaved = false;           // a save failed (desk unreachable): retried on reconnect
const serverKnown = new Set(); // conversations the desk server has confirmed
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const removed = [...removedQueue], ids = state.sessions.map(s => s.id);
  return fetch('/api/state?client=' + CLIENT, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...state, removed }) })
    .then(r => { if (!r.ok) throw new Error(r.status); removed.forEach(id => removedQueue.delete(id)); ids.forEach(id => serverKnown.add(id)); unsaved = false; })
    .catch(() => { unsaved = true; });
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}
function commit() { save(); render(); }

let ws = null, wsBackoff = 500;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    wsBackoff = 500;
    // anything done while the desk was unreachable (a new conversation, a removal) goes through now
    if (unsaved || pendingStarts.length) saveNow().then(() => pendingStarts.splice(0).forEach(m => send(m)));
    for (const sid of terms.keys()) attach(sid);
    if (document.hasFocus()) send({ t: 'claim' });
    lastDockPayload = ''; syncDock();
  };
  ws.onmessage = ev => onMsg(JSON.parse(ev.data));
  ws.onclose = () => { setTimeout(connect, wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 2500); };
}
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
const pendingStarts = []; // starts asked for while the desk was unreachable
function sendStart(msg) {
  if (ws && ws.readyState === 1 && !unsaved) send(msg);
  else { pendingStarts.push(msg); toast('The desk is reconnecting. This starts as soon as it is back.'); }
}

function onMsg(m) {
  switch (m.t) {
    case 'data': {
      const t = terms.get(m.id);
      if (t) t.term.write(m.data);
      else unread.add(m.id);
      break;
    }
    case 'snapshot': {
      const t = terms.get(m.id);
      if (!t) break;
      t.term.reset();
      if (m.data) t.term.write(m.data);
      t.alive = m.alive;
      updateOverlay(m.id);
      if (m.alive) { t.cols = t.rows = 0; fitTerm(m.id); }
      break;
    }
    case 'status':
      statuses[m.id] = m.status;
      if (m.status === 'waiting' && m.id === focusedId && document.hasFocus()) { send({ t: 'seen', id: m.id }); }
      const t = terms.get(m.id);
      if (t) { t.alive = m.status !== 'stopped'; updateOverlay(m.id); }
      renderStatusBits(m.id);
      break;
    case 'exit':
      statuses[m.id] = 'stopped';
      if (terms.get(m.id)) { terms.get(m.id).alive = false; updateOverlay(m.id); }
      renderStatusBits(m.id);
      break;
    case 'state':
      if (m.from !== CLIENT) {
        // keep what this window did that the desk hasn't heard yet: removals, and conversations
        // added here a moment ago (another window's update must not wipe them before they're saved)
        const mine = state.sessions.filter(s => !serverKnown.has(s.id) && !m.state.sessions.some(o => o.id === s.id));
        const mineOn = mine.filter(s => isOn(s.id)).map(s => s.id);
        state = m.state;
        state.sessions.forEach(s => serverKnown.add(s.id));
        state.sessions = state.sessions.filter(s => !removedQueue.has(s.id)).concat(mine);
        ensureStateShape(); applyGround(state.ground);
        mineOn.forEach(addToScreen);
        if (mine.length) save();
        render();
      }
      break;
    case 'hello':
      if (window.__build && window.__build !== m.build) location.reload(); // the desk was updated
      window.__build = m.build;
      break;
    case 'mins': {
      let changed = false;
      for (const [id, v] of Object.entries(m.mins)) {
        const old = appMins[id];
        if (!old || old[0] !== v[0] || old[1] !== v[1]) { appMins[id] = v; changed = true; }
      }
      if (changed) { lastDockPayload = ''; render(); } // panes grow to fit, then windows re-snap
      break;
    }
    case 'redock':
      lastDockPayload = ''; lastDocked.clear(); syncDock();
      break;
    case 'discovered':
      if (setDiscovered(m.items)) save();
      render();
      break;
    case 'ccmap': {
      let changed = false;
      for (const [sid, cc] of Object.entries(m.map)) { const s = session(sid); if (s && s.ccSessionId !== cc) { s.ccSessionId = cc; changed = true; } }
      if (changed) save();
      break;
    }
  }
}

// ---------- layout tree ----------
// node: { type:'pane', sid } | { type:'split', dir:'row'|'col', children:[], sizes:[] }
function onScreen(node = state.layout, out = []) {
  if (!node) return out;
  if (node.type === 'pane') out.push(node.sid);
  else node.children.forEach(c => onScreen(c, out));
  return out;
}
const isOn = sid => onScreen().includes(sid);
const equal = n => Array(n).fill(1 / n);

function normalize(node) {
  if (!node || node.type === 'pane') return node;
  node.children = node.children.map(normalize).filter(Boolean);
  // flatten same-direction nesting
  const kids = [], sizes = [];
  node.children.forEach((c, i) => {
    const sz = node.sizes[i] ?? 1 / node.children.length;
    if (c.type === 'split' && c.dir === node.dir) c.children.forEach((g, j) => { kids.push(g); sizes.push(sz * c.sizes[j]); });
    else { kids.push(c); sizes.push(sz); }
  });
  node.children = kids;
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  node.sizes = sizes.map(s => s / total);
  if (node.children.length === 0) return null;
  if (node.children.length === 1) return node.children[0];
  return node;
}

function removeFromTree(sid) {
  const rm = node => {
    if (!node) return null;
    if (node.type === 'pane') return node.sid === sid ? null : node;
    const keep = [], sizes = [];
    node.children.forEach((c, i) => { const r = rm(c); if (r) { keep.push(r); sizes.push(node.sizes[i]); } });
    return { ...node, children: keep, sizes };
  };
  state.layout = normalize(rm(state.layout));
  if (state.maximized === sid) state.maximized = null;
}

// ---------- layout rules ----------
// A pane never gets smaller than MIN_W x MIN_H. Splits, divider drags and new panes all respect it;
// if the window itself gets too small, the stage scrolls instead of squashing panes.
const MIN_W = 300, MIN_H = 200, GAP = 12;
const appMins = {}; // pane id -> [w, h]: the smallest the app in it will go
const PANE_CHROME_W = 2, PANE_CHROME_H = 48; // pane border + header around the body
function minSize(node) {
  if (!node) return { w: 0, h: 0 };
  if (node.type === 'pane') {
    const m = appMins[node.sid];
    return m ? { w: Math.max(MIN_W, m[0] + PANE_CHROME_W), h: Math.max(MIN_H, m[1] + PANE_CHROME_H) } : { w: MIN_W, h: MIN_H };
  }
  const ms = node.children.map(minSize), gaps = GAP * (node.children.length - 1);
  return node.dir === 'row'
    ? { w: ms.reduce((a, m) => a + m.w, 0) + gaps, h: Math.max(...ms.map(m => m.h)) }
    : { w: Math.max(...ms.map(m => m.w)), h: ms.reduce((a, m) => a + m.h, 0) + gaps };
}
function stageBox() { const r = $('#layoutRoot').getBoundingClientRect(); return { w: r.width || innerWidth - 300, h: r.height || innerHeight - 140 }; }
const fits = layout => { const m = minSize(layout), b = stageBox(); return m.w <= b.w + 1 && m.h <= b.h + 1; };
const lastFocusAt = new Map();

function addToScreen(sid) {
  if (isOn(sid)) return;
  const pane = { type: 'pane', sid };
  state.maximized = null;
  if (!state.layout) { state.layout = pane; return; }
  const clone = x => JSON.parse(JSON.stringify(x));
  // 1) another column in the top row
  let next = state.layout.type === 'split' && state.layout.dir === 'row'
    ? { ...clone(state.layout), children: [...clone(state.layout.children), pane], sizes: equal(state.layout.children.length + 1) }
    : { type: 'split', dir: 'row', children: [clone(state.layout), pane], sizes: [.5, .5] };
  if (fits(next)) { state.layout = normalize(next); return; }
  // 2) split the biggest pane that still has room, along its longer side
  const rects = onScreen().map(id => ({ id, r: paneEls.get(id)?.getBoundingClientRect() })).filter(x => x.r && x.r.width)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  for (const { id, r } of rects) {
    const edge = r.width / MIN_W >= r.height / MIN_H ? 'right' : 'bottom';
    const room = edge === 'right' ? r.width >= 2 * MIN_W + GAP : r.height >= 2 * MIN_H + GAP;
    if (!room) continue;
    const saved = clone(state.layout);
    placeAt(id, edge, sid);
    if (fits(state.layout)) return;
    state.layout = saved;
  }
  // 3) screen is full: swap out the pane you used least recently (it keeps running, parked)
  const victim = onScreen().sort((a, b) => (lastFocusAt.get(a) || 0) - (lastFocusAt.get(b) || 0))[0];
  if (victim) {
    const walk = n => { if (n.type === 'pane') { if (n.sid === victim) n.sid = sid; } else n.children.forEach(walk); };
    walk(state.layout);
    disposeTerm(victim); paneEls.delete(victim);
    toast(`Screen is full, so "${info(victim)?.title || 'a pane'}" was parked. It keeps running in the sidebar.`);
  }
}

function placeAt(targetSid, edge, sid) {
  if (targetSid === sid) return;
  if (edge === 'center') { // swap places
    if (!isOn(sid)) { replacePane(targetSid, sid); return; }
    const swap = node => { if (node.type === 'pane') node.sid = node.sid === sid ? targetSid : node.sid === targetSid ? sid : node.sid; else node.children.forEach(swap); };
    swap(state.layout); return;
  }
  removeFromTree(sid);
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const before = edge === 'left' || edge === 'top';
  const walk = node => {
    if (node.type === 'pane') {
      if (node.sid !== targetSid) return node;
      const np = { type: 'pane', sid };
      return { type: 'split', dir, children: before ? [np, node] : [node, np], sizes: [.5, .5] };
    }
    node.children = node.children.map(walk);
    return node;
  };
  state.layout = normalize(walk(state.layout));
  state.maximized = null;
}
function replacePane(targetSid, sid) {
  const walk = node => { if (node.type === 'pane') { if (node.sid === targetSid) node.sid = sid; } else node.children.forEach(walk); };
  walk(state.layout);
  disposeTerm(targetSid);
}

function ensureStateShape() {
  state.drafts ||= {}; state.extAssign ||= {}; state.extDock ||= {}; state.extCollapsed ??= false;
}
function setDiscovered(items) {
  discovered = items;
  let moved = false;
  // an app window you had on screen was closed and opened again (that's a new window): it goes
  // straight back into the same pane, snapped the same way, instead of you setting it up again
  if (state && state.layout) for (const sid of onScreen()) {
    const old = lastExt.get(sid);
    if (!isExt(sid) || items.some(d => d.id === sid) || !old || old.kind !== 'app') continue;
    const repl = items.find(d => d.kind === 'app' && d.where === old.where && !isOn(d.id) && !lastExt.has(d.id));
    if (!repl) continue;
    const walk = n => { if (n.type === 'pane') { if (n.sid === sid) n.sid = repl.id; } else n.children.forEach(walk); };
    walk(state.layout);
    if (state.maximized === sid) state.maximized = repl.id;
    if (sid in state.extDock) state.extDock[repl.id] = state.extDock[sid];
    if (state.extAssign[sid]) state.extAssign[repl.id] = state.extAssign[sid];
    delete state.extDock[sid]; delete state.extAssign[sid];
    lastExt.delete(sid); paneEls.delete(sid); lastDocked.delete(sid);
    if (focusedId === sid) focusedId = repl.id;
    moved = true;
  }
  for (const d of items) { lastExt.set(d.id, d); statuses[d.id] = d.status; }
  for (const id of lastExt.keys()) if (!items.some(d => d.id === id)) statuses[id] = 'gone';
  return moved;
}

// ---------- actions ----------
function session(sid) { return state.sessions.find(s => s.id === sid); }
// display info for any pane id: desk session or outside session
function info(sid) {
  if (!isExt(sid)) return session(sid);
  const d = ext(sid) || lastExt.get(sid);
  return d ? { ...d, gone: !ext(sid) } : null;
}
// app windows dock into their pane by default; Claude Code CLI sessions show a live transcript unless docked
const docksWindow = sid => { const d = ext(sid); return !!(d && d.hwnd && (state.extDock[sid] ?? (d.kind === 'app' || d.hostTerminal))); };
function project(pid) { return state.projects.find(p => p.id === pid); }

function showSession(sid) {
  if (isOn(sid)) { if (state.maximized && state.maximized !== sid) state.maximized = sid; commit(); focusPane(sid, true); return; }
  addToScreen(sid); commit(); focusPane(sid, true);
}
function park(sid) {
  removeFromTree(sid);
  disposeTerm(sid);
  paneEls.delete(sid);
  if (focusedId === sid) focusedId = null;
  commit();
}
function toggleMax(sid) {
  state.maximized = state.maximized === sid ? null : sid;
  commit(); focusPane(sid);
}
function startSess(sid, resume = false, restart = false) {
  const ss = session(sid); if (ss) ss.hasRun = true;
  const t = terms.get(sid);
  const dims = t ? t.fit.proposeDimensions() : null;
  // make sure the server knows about this session before asking it to start
  saveNow().then(() => sendStart({ t: 'start', id: sid, resume, restart, cols: dims?.cols || 100, rows: dims?.rows || 30 }));
  if (t) { t.term.reset(); t.alive = true; t.cols = t.rows = 0; updateOverlay(sid); setTimeout(() => { fitTerm(sid); t.term.focus(); }, 50); }
}
function removeSession(sid) {
  if (isExt(sid)) { removeFromTree(sid); paneEls.delete(sid); lastExt.delete(sid); delete state.extAssign[sid]; commit(); return; }
  const s = session(sid);
  if (!s) return;
  const running = statuses[sid] && !['stopped', 'link'].includes(statuses[sid]);
  if (running && !confirm(`"${s.title}" is still running. Stop it and remove it from the desk?`)) return;
  removeFromTree(sid); disposeTerm(sid);
  state.sessions = state.sessions.filter(x => x.id !== sid);
  removedQueue.add(sid);
  commit();
}
// ---------- outside sessions ----------
function bringToFront(sid) { send({ t: 'ext-focus', id: sid }); }
function setDock(sid, on) { state.extDock[sid] = on; paneEls.delete(sid); commit(); }
function extProject(d) { return state.extAssign[d.id] && project(state.extAssign[d.id]) ? state.extAssign[d.id] : null; }
// take a Claude Code session that's running elsewhere and reopen the same conversation inside the desk
function continueHere(sid, closeOriginal) {
  const d = info(sid);
  if (!d || d.kind !== 'cli') return;
  if (closeOriginal && !confirm(`Move "${d.title}" into the desk?\n\nThis closes it in ${d.where} and reopens the same conversation here (claude --resume). If it's in the middle of something, that step gets interrupted.`)) return;
  if (closeOriginal) send({ t: 'ext-close', id: sid });
  const s = {
    id: uid('s'), title: d.title, provider: 'claude', projectId: extProject(d) || state.projects[0].id,
    cwd: d.cwd || null, command: null, url: null, resumeId: d.sessionId, hasRun: true, createdAt: Date.now(),
  };
  state.sessions.push(s);
  if (isOn(sid)) replacePane(sid, s.id); else addToScreen(s.id);
  delete state.extAssign[sid];
  lastExt.delete(sid);
  commit();
  focusPane(s.id, true);
  setTimeout(() => startSess(s.id, true), closeOriginal ? 1500 : 100);
}

let dockRaf = 0, dockHidden = false;
let lastDocked = new Set();
let lastDockPayload = '';
function syncDock() {
  cancelAnimationFrame(dockRaf);
  dockRaf = requestAnimationFrame(() => {
    if (!state) return;
    const items = [];
    for (const [sid, pane] of paneEls) {
      if (!isExt(sid) || !pane.isConnected || !docksWindow(sid)) continue;
      const r = $('.pane-body', pane).getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      items.push({ id: sid, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    const now = new Set(items.map(i => i.id));
    // windows that left the screen (parked, or hidden by an expanded pane) get minimized;
    // windows you undocked go back where they were
    const park = [...lastDocked].filter(id => !now.has(id) && !(isOn(id) && !docksWindow(id) && !state.maximized));
    lastDocked = now;
    // only tell the helper when something actually changed (re-renders send the same layout again)
    const payload = JSON.stringify({ items: items.map(i => [i.id, Math.round(i.x), Math.round(i.y), Math.round(i.w), Math.round(i.h)]), park, dpr: devicePixelRatio, hidden: dockHidden });
    if (payload === lastDockPayload && !park.length) return;
    lastDockPayload = payload;
    send({ t: 'ext-dock', items, park, dpr: devicePixelRatio, hidden: dockHidden, marker: MARKER, visible: !document.hidden, focused: document.hasFocus() });
  });
}
function hideDocked(on) { if (dockHidden !== on) { dockHidden = on; syncDock(); } }
addEventListener('resize', syncDock);
addEventListener('focus', () => { send({ t: 'claim' }); lastDockPayload = ''; syncDock(); });
document.addEventListener('visibilitychange', () => { send({ t: 'visible', on: !document.hidden }); if (!document.hidden) { lastDockPayload = ''; syncDock(); } });
// give embedded windows back before this window goes away (otherwise Windows would close them with it)
addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/release', '1'); } catch {} send({ t: 'ext-dock', items: [], park: [], dpr: 1, marker: MARKER }); });

// live transcript for outside Claude Code sessions
const txState = new Map(); // sid -> mtime
setInterval(pollTranscripts, 2000);
function pollTranscripts() {
  if (document.hidden) return;
  for (const [sid, pane] of paneEls) {
    const d = info(sid);
    if (!d || d.kind !== 'cli' || docksWindow(sid) || !pane.isConnected) continue;
    loadTranscript(sid, d.sessionId, pane);
  }
}
function mdLite(text) {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map(part =>
    /^\*\*.+\*\*$/.test(part) ? h('strong', {}, part.slice(2, -2)) : /^`.+`$/.test(part) ? h('code', {}, part.slice(1, -1)) : part);
}
function loadTranscript(sid, ccId, pane) {
  const since = txState.get(sid);
  fetch(`/api/transcript?sid=${encodeURIComponent(ccId)}${since ? '&since=' + since : ''}`).then(r => r.json()).then(r => {
    if (!r || r.unchanged) return;
    txState.set(sid, r.mtime);
    const box = $('.tx', pane);
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = '';
    if (!r.items?.length) box.append(h('div', { class: 'muted tx-empty' }, 'No messages yet.'));
    for (const it of r.items || []) {
      if (it.role === 'tool') box.append(h('div', { class: 'tx-tool' }, it.tools.slice(-4).map(t => h('div', {}, '↳ ' + t)), it.tools.length > 4 ? h('div', {}, `… ${it.tools.length - 4} more steps`) : null));
      else box.append(h('div', { class: 'tx-msg ' + it.role }, h('div', { class: 'who' }, it.role === 'user' ? 'You' : 'Claude Code'), h('div', { class: 'txt' }, mdLite(it.text))));
    }
    if (atBottom || !since) box.scrollTop = box.scrollHeight;
  }).catch(() => {});
}

function focusPane(sid, flash = false) {
  focusedId = sid;
  lastFocusAt.set(sid, Date.now());
  unread.delete(sid);
  if (statuses[sid] === 'waiting') send({ t: isExt(sid) ? 'ext-seen' : 'seen', id: sid });
  document.querySelectorAll('.pane.focused').forEach(p => p.classList.remove('focused'));
  const el = paneEls.get(sid);
  if (el) {
    el.classList.add('focused');
    if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }
  const t = terms.get(sid);
  if (t) t.term.focus();
  else if (isExt(sid) && docksWindow(sid)) setTimeout(() => bringToFront(sid), 120);
  else el?.querySelector('textarea')?.focus();
  renderSidebar();
}

// ---------- terminals ----------
const TERM_DARK = {
  background: '#211b18', foreground: '#f4ebe3', cursor: '#d97757', cursorAccent: '#211b18', selectionBackground: '#5a3a2c',
  black: '#2a231f', red: '#f08a74', green: '#9fcf86', yellow: '#e9c26d', blue: '#8fb3f0', magenta: '#d4a3e6', cyan: '#7fd0cf', white: '#d8cec5',
  brightBlack: '#8a7d72', brightRed: '#f5a08c', brightGreen: '#b3dc9c', brightYellow: '#f2d08a', brightBlue: '#a8c4f5', brightMagenta: '#e0b8ee', brightCyan: '#9adcdb', brightWhite: '#f4ebe3',
};
const GROUNDS = ['milk', 'sand', 'peach', 'ember'];
const groundBg = () => getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim() || '#fffdf9';
function termTheme() {
  if (state && state.ground === 'ember') return TERM_DARK;
  const bg = groundBg();
  return { ...TERM_THEME, background: bg, cursorAccent: bg };
}
function applyGround(g) {
  if (!GROUNDS.includes(g)) g = 'milk';
  document.documentElement.dataset.ground = g;
  document.querySelectorAll('.swatch').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ground === g)));
  const th = termTheme();
  for (const t of terms.values()) t.term.options.theme = th;
}
document.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => { state.ground = b.dataset.ground; applyGround(state.ground); save(); }));
const TERM_THEME = {
  background: '#fffdf9', foreground: '#2b2420', cursor: '#d97757', cursorAccent: '#fffdf9',
  selectionBackground: '#e2e0d8',
  black: '#1d2420', red: '#b4402e', green: '#2f7a3f', yellow: '#946200', blue: '#2b5fb8', magenta: '#8a3f9c', cyan: '#1f7a80', white: '#8a918c',
  brightBlack: '#5f6862', brightRed: '#c9563f', brightGreen: '#3b8c4c', brightYellow: '#a87200', brightBlue: '#3a6fd0', brightMagenta: '#9d50b0', brightCyan: '#278a90', brightWhite: '#5a625d',
};

function ensureTerm(sid, host) {
  let t = terms.get(sid);
  if (t) { if (t.host !== host) { host.append(t.el); t.host = host; } return t; }
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace', fontSize: 13, lineHeight: 1.15,
    theme: termTheme(), minimumContrastRatio: 4.5, scrollback: 8000, cursorBlink: true, allowProposedApi: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
  const el = h('div', { class: 'term-el', style: 'width:100%;height:100%' });
  host.append(el);
  term.open(el);
  if (window.WebglAddon) {
    try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); } catch {}
  }
  term.onData(d => send({ t: 'input', id: sid, data: d }));
  term.onSelectionChange(() => renderSendBtn(sid));
  term.textarea?.addEventListener('focus', () => { if (focusedId !== sid) focusPane(sid); });
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c') && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); return false; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) { navigator.clipboard.readText().then(x => term.paste(x)); return false; }
    if (e.ctrlKey && e.key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    if (globalShortcut(e)) { e.preventDefault(); e.stopPropagation(); return false; } // handled once, not again by the page
    return true;
  });
  t = { term, fit, el, host, cols: 0, rows: 0, alive: statuses[sid] && statuses[sid] !== 'stopped' };
  terms.set(sid, t);
  const ro = new ResizeObserver(() => { clearTimeout(t.rt); t.rt = setTimeout(() => fitTerm(sid), 40); });
  ro.observe(host);
  t.ro = ro;
  attach(sid);
  return t;
}
function attach(sid) { send({ t: 'attach', id: sid }); }
function fitTerm(sid) {
  const t = terms.get(sid);
  if (!t || !t.host.isConnected || t.host.clientWidth < 20) return;
  try { t.fit.fit(); } catch { return; }
  if (t.term.cols !== t.cols || t.term.rows !== t.rows) {
    t.cols = t.term.cols; t.rows = t.term.rows;
    send({ t: 'resize', id: sid, cols: t.cols, rows: t.rows });
  }
}
function disposeTerm(sid) {
  const t = terms.get(sid);
  if (!t) return;
  t.ro.disconnect();
  t.term.dispose();
  terms.delete(sid);
  paneEls.delete(sid);
}

function updateOverlay(sid) {
  const pane = paneEls.get(sid);
  const s = session(sid);
  if (!pane || !s || s.provider === 'web') return;
  const body = $('.pane-body', pane);
  let ov = $('.overlay', body);
  const t = terms.get(sid);
  const alive = t ? t.alive : statuses[sid] !== 'stopped';
  if (alive) { ov?.remove(); return; }
  if (ov) return;
  const canResume = (s.provider === 'claude' || s.provider === 'codex') && !s.command && s.hasRun;
  ov = h('div', { class: 'overlay' }, h('div', { class: 'box' },
    h('p', {}, s.hasRun ? `${s.title} isn't running.` : `Ready to start ${LABEL[s.provider]} in ${shortPath(s.cwd || project(s.projectId)?.cwd)}`),
    h('div', { class: 'btns' },
      canResume ? h('button', { class: 'btn primary', onclick: () => startSess(sid, true) }, 'Resume last conversation') : null,
      h('button', { class: canResume ? 'btn' : 'btn primary', onclick: () => startSess(sid, false) }, s.hasRun ? 'Start fresh' : 'Start'))));
  body.append(ov);
}

// ---------- send selection between panes ----------
function renderSendBtn(sid) {
  const pane = paneEls.get(sid);
  if (!pane) return;
  const t = terms.get(sid);
  const btn = $('.send-btn', pane);
  const has = t && t.term.hasSelection() && t.term.getSelection().trim();
  btn.classList.toggle('hidden', !has);
}
function openSendMenu(sid, anchor) {
  const t = terms.get(sid);
  const text = t?.term.getSelection();
  if (!text) return;
  const targets = [...state.sessions, ...discovered.map(d => ({ ...d, provider: d.kind === 'cli' ? 'claude' : d.provider, ext: true }))].filter(s => s.id !== sid);
  const items = [{ hdr: 'Send selection to…' }];
  const on = onScreen();
  targets.sort((a, b) => on.includes(b.id) - on.includes(a.id)).forEach(s => items.push({
    label: `${s.title} · ${s.ext ? s.where : LABEL[s.provider]}${on.includes(s.id) ? '' : s.ext ? ' (outside)' : ' (parked)'}`,
    act: () => sendTextTo(s.id, text),
  }));
  items.push({ sep: true }, { label: 'Copy', act: () => { navigator.clipboard.writeText(text); toast('Copied'); } });
  showMenu(anchor, items);
}
function sendTextTo(sid, text) {
  text = text.replace(/[ \t]+$/gm, '').trim();
  if (isExt(sid)) {
    const d = info(sid);
    navigator.clipboard.writeText(text).catch(() => {});
    if (d.hwnd) bringToFront(sid);
    toast(`Copied. Press Ctrl+V in ${d.title} to paste it`);
    return;
  }
  const s = session(sid);
  if (s.provider === 'web') {
    state.drafts[sid] = ((state.drafts[sid] || '') + (state.drafts[sid] ? '\n\n' : '') + text);
    navigator.clipboard.writeText(text).catch(() => {});
    showSession(sid);
    toast(`Added to ${s.title} notes and copied — paste it into the chat window`);
    return;
  }
  if (statuses[sid] === 'stopped' || !statuses[sid]) { toast(`${s.title} isn't running — start it first`); showSession(sid); return; }
  showSession(sid);
  const t = terms.get(sid);
  if (t) t.term.paste(text);  // lands as a draft — nothing is sent until you press Enter
  else send({ t: 'input', id: sid, data: text });
  toast(`Pasted into ${s.title} as a draft — add your note and press Enter`);
}

// ---------- rendering ----------
function render() {
  renderSidebar();
  renderStage();
}

function shortPath(p) { if (!p) return '~'; return home && p.toLowerCase().startsWith(home.toLowerCase()) ? '~' + p.slice(home.length) : p; }

function itemRow(sid, on) {
  const d = info(sid);
  const st = statuses[sid] || (d.provider === 'web' ? 'link' : 'stopped');
  const isOnScreen = on.includes(sid);
  const sub = isExt(sid) ? `${d.kind === 'cli' ? 'Claude Code · ' : ''}${d.where}` : LABEL[d.provider];
  const item = h('div', {
    class: 'item' + (isOnScreen ? ' on' : '') + (st === 'gone' ? ' gone' : ''), draggable: 'true', 'data-sid': sid,
    title: `${d.title}\n${sub} · ${STATUS_TEXT[st] || st}\nClick to ${isOnScreen ? 'focus' : 'open'} · drag onto a pane edge to split · right-click for more`,
    onclick: e => { if (e.target.closest('.icon-btn')) return; showSession(sid); },
    oncontextmenu: e => { e.preventDefault(); sessionMenu(sid, e); },
  },
    h('span', { class: 'dot ' + st, 'data-dot': sid }),
    h('div', { class: 'meta' },
      h('div', { class: 'title' }, d.title),
      h('div', { class: 'sub' }, h('span', { class: 'subtxt' }, sub),
        st === 'waiting' ? h('span', { class: 'badge' }, '· needs you') : (!isOnScreen && unread.has(sid) && st !== 'working' ? h('span', { class: 'badge', style: 'color:var(--muted)' }, '· new output') : null))),
    isOnScreen
      ? h('button', { class: 'icon-btn', title: 'Park (hide pane, keep it running)', html: ICONS.parkSide, onclick: () => park(sid) })
      : h('button', { class: 'icon-btn', title: 'Put on screen', html: ICONS.plus, onclick: () => showSession(sid) }));
  item.addEventListener('dragstart', e => startDrag(e, sid, item));
  item.addEventListener('dragend', endDrag);
  return item;
}

function moveToProject(sid, pid) {
  if (isExt(sid)) { if (pid === EXT_GROUP) delete state.extAssign[sid]; else state.extAssign[sid] = pid; }
  else if (pid !== EXT_GROUP) session(sid).projectId = pid;
}

function groupEl({ id, name, collapsed, title, onToggle, tools, ids, empty, icon }) {
  const on = onScreen();
  const proj = h('div', { class: 'project' + (collapsed ? ' collapsed' : '') + (id === EXT_GROUP ? ' ext-group' : '') });
  const head = h('div', { class: 'project-head', title: title || '', onclick: e => { if (e.target.closest('.icon-btn')) return; onToggle(); } },
    h('span', { html: ICONS.chev, style: 'display:contents' }),
    h('span', { html: icon, style: 'display:contents' }),
    h('span', { class: 'name' }, name), ...tools);
  head.addEventListener('dragover', e => { if (dragSid && (id !== EXT_GROUP || isExt(dragSid))) { e.preventDefault(); head.classList.add('drop-into'); } });
  head.addEventListener('dragleave', () => head.classList.remove('drop-into'));
  head.addEventListener('drop', e => { head.classList.remove('drop-into'); if (dragSid) { e.preventDefault(); moveToProject(dragSid, id); endDrag(); commit(); } });
  proj.append(head);
  const items = h('div', { class: 'items' });
  ids.forEach(sid => items.append(itemRow(sid, on)));
  if (!ids.length) items.append(h('div', { class: 'muted', style: 'font-size:12.5px;padding:4px 12px 6px 30px' }, empty));
  proj.append(items);
  return proj;
}

function renderSidebar() {
  const list = $('#sessionList');
  const scroll = list.scrollTop;
  list.innerHTML = '';
  const on = onScreen();
  // outside sessions that are still around, plus closed ones still pinned on screen or to a project
  const extIds = [...new Set([...discovered.map(d => d.id), ...[...lastExt.keys()].filter(id => on.includes(id))])];
  const unassigned = extIds.filter(id => !extProject(info(id)));
  list.append(groupEl({
    id: EXT_GROUP, name: 'Running elsewhere', collapsed: state.extCollapsed, icon: ICONS.front,
    title: 'Found automatically: Claude Code sessions in other terminals, and ChatGPT / Claude / Codex windows',
    onToggle: () => { state.extCollapsed = !state.extCollapsed; commit(); },
    tools: unassigned.some(id => ext(id) && !on.includes(id))
      ? [h('button', { class: 'icon-btn', title: 'Put all of these on screen', html: ICONS.plus, onclick: () => { unassigned.filter(id => ext(id)).forEach(addToScreen); commit(); } })]
      : [],
    ids: unassigned, empty: 'Nothing else running',
  }));
  for (const p of state.projects) {
    const ids = [...state.sessions.filter(s => s.projectId === p.id).map(s => s.id), ...extIds.filter(id => extProject(info(id)) === p.id)];
    list.append(groupEl({
      id: p.id, name: p.name, collapsed: p.collapsed, title: p.cwd, icon: ICONS.folder,
      onToggle: () => { p.collapsed = !p.collapsed; commit(); },
      tools: [
        h('button', { class: 'icon-btn', title: `New conversation in ${p.name}`, html: ICONS.plus, onclick: e => newMenu(e.currentTarget, p.id) }),
        h('button', { class: 'icon-btn', title: 'Project options', html: ICONS.more, onclick: e => projectMenu(p, e.currentTarget) }),
      ],
      ids, empty: 'No conversations yet — drag one here',
    }));
  }
  list.scrollTop = scroll;
  const total = new Set([...state.sessions.map(s => s.id), ...discovered.map(d => d.id), ...on]).size;
  $('#stageCount').textContent = `${on.length} of ${total} conversation${total === 1 ? '' : 's'}`;
  const waiting = [...state.sessions.map(s => s.id), ...discovered.map(d => d.id)].filter(id => statuses[id] === 'waiting').length;
  document.title = (waiting ? `(${waiting}) Session Desk` : 'Session Desk') + MARKER;
}

function renderStatusBits(sid) {
  // cheap update: sidebar re-render + pane subtitle
  renderSidebar();
  const pane = paneEls.get(sid);
  if (pane) {
    const st = statuses[sid] || 'stopped';
    const dot = $('.pane-title .dot', pane), txt = $('.pane-title .st', pane);
    if (dot) dot.className = 'dot ' + st;
    if (txt) txt.textContent = STATUS_TEXT[st];
  }
}

function renderStage() {
  const root = $('#layoutRoot');
  // drop panes for outside windows we no longer know anything about (e.g. closed before a restart)
  // (only once discovery has reported, so a just-started desk doesn't drop them all)
  if (discovered.length) for (const sid of onScreen()) if (isExt(sid) && !info(sid)) removeFromTree(sid);
  // and panes for conversations that were removed (e.g. in another desk window): no empty holes
  for (const sid of onScreen()) if (!isExt(sid) && !session(sid)) removeFromTree(sid);
  const on = onScreen();
  // dispose terminals whose panes left the screen (e.g. changed in another window)
  for (const sid of [...terms.keys()]) if (!on.includes(sid) || !session(sid)) disposeTerm(sid);
  for (const sid of [...paneEls.keys()]) if (!on.includes(sid)) paneEls.delete(sid);

  // Panes are re-attached, not rebuilt, but taking them out of the page for a moment drops the
  // keyboard and scroll positions. Re-renders happen whenever another desk window saves or an app
  // window changes its title, so without this you'd lose keystrokes mid-sentence.
  const active = document.activeElement;
  const scrolls = [...root.querySelectorAll('.tx, textarea, .xterm-viewport')].map(el => [el, el.scrollTop]);
  root.innerHTML = '';
  $('#emptyState').classList.toggle('hidden', on.length > 0);
  $('#stageTitle').textContent = state.maximized ? 'Focused' : 'On screen';
  if (!state.layout) { syncDock(); return; } // still tell the helper: snapped windows must leave the empty stage
  if (state.maximized && on.includes(state.maximized)) {
    root.append(cellFor({ type: 'pane', sid: state.maximized }));
  } else {
    state.maximized = null;
    root.append(cellFor(state.layout));
  }
  for (const [el, top] of scrolls) if (el.isConnected && el.scrollTop !== top) el.scrollTop = top;
  if (active && active !== document.body && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  requestAnimationFrame(() => { for (const sid of terms.keys()) fitTerm(sid); });
  syncDock();
}

function cellFor(node) {
  if (node.type === 'pane') return buildPane(node.sid);
  const wrap = h('div', { class: `split ${node.dir}` });
  node.children.forEach((c, i) => {
    if (i > 0) wrap.append(makeDivider(node, i, wrap));
    const cell = h('div', { class: 'cell' });
    cell.style.flex = `${node.sizes[i]} 1 0`;
    const m = minSize(c);
    cell.style.minWidth = m.w + 'px'; cell.style.minHeight = m.h + 'px';
    cell.append(cellFor(c));
    wrap.append(cell);
  });
  return wrap;
}

function makeDivider(node, i, wrap) {
  const d = h('div', { class: 'divider', title: 'Drag to resize · double-click to even out' });
  d.addEventListener('dblclick', () => { node.sizes = equal(node.children.length); commit(); });
  d.addEventListener('pointerdown', e => {
    e.preventDefault();
    d.setPointerCapture(e.pointerId);
    d.classList.add('active');
    document.body.classList.add('resizing', node.dir + '-resize');
    const cells = [...wrap.children].filter(c => c.classList.contains('cell'));
    const rect = wrap.getBoundingClientRect();
    const total = node.dir === 'row' ? rect.width : rect.height;
    const start = node.dir === 'row' ? e.clientX : e.clientY;
    const a = node.sizes[i - 1], b = node.sizes[i];
    const avail = total - GAP * (node.children.length - 1); // flex space, without dividers
    const key = node.dir === 'row' ? 'w' : 'h';
    const minA = minSize(node.children[i - 1])[key] / avail, minB = minSize(node.children[i])[key] / avail;
    let lastSync = 0;
    const move = ev => {
      const delta = ((node.dir === 'row' ? ev.clientX : ev.clientY) - start) / avail;
      if (minA + minB > a + b) return; // no room to move at all
      let na = Math.max(minA, Math.min(a + b - minB, a + delta));
      node.sizes[i - 1] = na; node.sizes[i] = a + b - na;
      cells[i - 1].style.flex = `${node.sizes[i - 1]} 1 0`;
      cells[i].style.flex = `${node.sizes[i]} 1 0`;
      const now = performance.now();
      if (now - lastSync > 50) { lastSync = now; syncDock(); } // embedded windows follow at ~20 fps
    };
    const up = () => {
      d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up);
      d.classList.remove('active');
      document.body.classList.remove('resizing', 'row-resize', 'col-resize');
      save();
      syncDock();
      for (const sid of terms.keys()) fitTerm(sid);
    };
    d.addEventListener('pointermove', move); d.addEventListener('pointerup', up);
  });
  return d;
}

function extMode(sid) { const d = info(sid); return !d || d.gone ? 'gone' : docksWindow(sid) ? 'dock' : d.kind === 'cli' ? 'tx' : 'app'; }

function buildPane(sid) {
  if (isExt(sid)) return buildExtPane(sid);
  const s = session(sid);
  if (!s) return h('div');
  let pane = paneEls.get(sid);
  if (pane) { refreshPaneHead(pane, s); return pane; }
  const st = statuses[sid] || (s.provider === 'web' ? 'link' : 'stopped');
  const max = state.maximized === sid;
  pane = h('div', { class: 'pane' + (focusedId === sid ? ' focused' : ''), 'data-sid': sid });
  const head = h('div', { class: 'pane-head', draggable: 'true', ondblclick: e => { if (!e.target.closest('button')) toggleMax(sid); } },
    h('span', { class: 'prov ' + s.provider, html: ICONS[s.provider] }),
    h('div', { class: 'pane-title' },
      h('span', { class: 'p' }, s.title),
      h('span', { class: 's' }, h('span', { class: 'dot ' + st }), h('span', { class: 'prov-name' }, LABEL[s.provider]), '·', h('span', { class: 'st' }, STATUS_TEXT[st]))),
    h('div', { class: 'pane-tools' },
      h('button', { class: 'send-btn hidden', title: 'Send the selected text into another conversation as a draft', onclick: e => openSendMenu(sid, e.currentTarget) }, 'Send selection →'),
      h('button', { class: 'icon-btn max-btn', title: max ? 'Restore layout (double-click header)' : 'Expand (double-click header)', html: max ? ICONS.restore : ICONS.expand, onclick: () => toggleMax(sid) }),
      h('button', { class: 'icon-btn', title: 'Park — hide this pane, keep it running', html: ICONS.park, onclick: () => park(sid) }),
      h('button', { class: 'icon-btn', title: 'More', html: ICONS.more, onclick: e => sessionMenu(sid, e.currentTarget) })));
  head.addEventListener('dragstart', e => startDrag(e, sid, pane));
  head.addEventListener('dragend', endDrag);
  const body = h('div', { class: 'pane-body' });
  pane.append(head, body);
  pane.addEventListener('mousedown', () => { if (focusedId !== sid) focusPane(sid); });
  pane.addEventListener('dragover', e => paneDragOver(e, sid, pane));
  pane.addEventListener('drop', e => paneDrop(e, sid, pane));
  paneEls.set(sid, pane);

  if (s.provider === 'web') body.append(buildWebBody(s));
  else {
    const host = h('div', { class: 'term-host' });
    body.append(host);
    // terminal must be opened once the host is in the DOM
    requestAnimationFrame(() => { ensureTerm(sid, host); updateOverlay(sid); });
  }
  return pane;
}
function paneShell(sid, d, provName, extraTools) {
  const st = statuses[sid] || 'stopped';
  const max = state.maximized === sid;
  const pane = h('div', { class: 'pane' + (focusedId === sid ? ' focused' : ''), 'data-sid': sid });
  const head = h('div', { class: 'pane-head', draggable: 'true', ondblclick: e => { if (!e.target.closest('button')) toggleMax(sid); } },
    h('span', { class: 'prov ' + d.provider, html: ICONS[d.provider] || ICONS.web }),
    h('div', { class: 'pane-title' },
      h('span', { class: 'p' }, d.title),
      h('span', { class: 's' }, h('span', { class: 'dot ' + st }), h('span', { class: 'prov-name' }, provName), '·', h('span', { class: 'st' }, STATUS_TEXT[st] || st))),
    h('div', { class: 'pane-tools' }, ...extraTools,
      h('button', { class: 'icon-btn max-btn', title: max ? 'Restore layout (double-click header)' : 'Expand (double-click header)', html: max ? ICONS.restore : ICONS.expand, onclick: () => toggleMax(sid) }),
      h('button', { class: 'icon-btn', title: 'Park - hide this pane, keep it running', html: ICONS.park, onclick: () => park(sid) }),
      h('button', { class: 'icon-btn', title: 'More', html: ICONS.more, onclick: e => sessionMenu(sid, e.currentTarget) })));
  head.addEventListener('dragstart', e => startDrag(e, sid, pane));
  head.addEventListener('dragend', endDrag);
  const body = h('div', { class: 'pane-body' });
  pane.append(head, body);
  pane.addEventListener('mousedown', () => { if (focusedId !== sid) focusPane(sid); });
  pane.addEventListener('dragover', e => paneDragOver(e, sid, pane));
  pane.addEventListener('drop', e => paneDrop(e, sid, pane));
  return { pane, body };
}

function buildExtPane(sid) {
  const d = info(sid);
  if (!d) return h('div');
  const mode = extMode(sid);
  let pane = paneEls.get(sid);
  if (pane && pane.dataset.mode === mode) { refreshPaneHead(pane, d); return pane; }
  const provName = `${d.kind === 'cli' ? 'Claude Code' : LABEL[d.provider] || 'App'} · ${d.kind === 'cli' ? 'in ' : ''}${d.where}`;
  const tools = [];
  if (mode !== 'gone' && d.hwnd) {
    tools.push(h('button', { class: 'icon-btn front-btn', title: 'Bring its window to the front', html: ICONS.front, onclick: () => bringToFront(sid) }));
    tools.push(h('button', { class: 'chip-btn', title: mode === 'dock' ? 'Take the window out of the desk and put it back where it was' : 'Put its real window inside this pane so you can type in it', onclick: () => setDock(sid, mode !== 'dock') }, mode === 'dock' ? 'Unsnap' : 'Snap here'));
  }
  const built = paneShell(sid, d, provName, tools);
  pane = built.pane; pane.dataset.mode = mode;
  const body = built.body;
  if (mode === 'gone') {
    body.append(h('div', { class: 'ext-card' },
      h('h4', {}, d.kind === 'cli' ? 'This Claude Code session has closed' : 'This window has closed'),
      h('p', {}, d.kind === 'cli' ? 'You can reopen the same conversation right here in the desk.' : 'Open it again and it will show up under "Running elsewhere".'),
      h('div', { class: 'btns' },
        d.kind === 'cli' ? h('button', { class: 'btn primary', onclick: () => continueHere(sid, false) }, 'Resume it here') : null,
        h('button', { class: 'btn', onclick: () => removeSession(sid) }, 'Remove pane'))));
  } else if (mode === 'dock') {
    body.append(h('div', { class: 'ext-card docked' },
      h('p', { class: 'muted' }, `Opening ${d.title}…`),
      h('p', { class: 'muted' }, 'If it doesn\'t appear, click Re-dock. Pop out puts the window back where it was.'),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { lastDocked.clear(); lastDockPayload = ''; syncDock(); bringToFront(sid); } }, 'Re-dock'))));
  } else if (mode === 'tx') {
    body.append(h('div', { class: 'tx-wrap' },
      h('div', { class: 'tx' }, h('div', { class: 'muted tx-empty' }, 'Loading conversation…')),
      h('div', { class: 'tx-foot' },
        h('span', { class: 'muted' }, `Live view of the session in ${d.where}${d.cwd ? ' · ' + shortPath(d.cwd) : ''}. To reply:`),
        d.hwnd ? h('button', { class: 'btn primary', title: 'Put its real window in this pane. It keeps running where it is.', onclick: () => setDock(sid, true) }, 'Reply here (snap its window)') : null,
        h('button', { class: d.hwnd ? 'btn ghost' : 'btn primary', title: `Ends it in ${d.where} and reopens the same conversation inside the desk`, onclick: () => continueHere(sid, true) }, 'Move into desk (closes it there)'))));
    txState.delete(sid);
    requestAnimationFrame(() => loadTranscript(sid, d.sessionId, pane));
  } else {
    body.append(h('div', { class: 'ext-card' }, h('p', {}, `${d.title} is open in its own window.`),
      h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: () => setDock(sid, true) }, 'Snap it here'), h('button', { class: 'btn', onclick: () => bringToFront(sid) }, 'Bring to front'))));
  }
  paneEls.set(sid, pane);
  return pane;
}

function refreshPaneHead(pane, s) {
  if (isExt(s.id)) {
    const st = statuses[s.id] || 'gone';
    $('.pane-title .p', pane).textContent = s.title;
    $('.pane-title .dot', pane).className = 'dot ' + st;
    $('.pane-title .st', pane).textContent = STATUS_TEXT[st] || st;
  }
  $('.pane-title .p', pane).textContent = s.title;
  const max = state.maximized === s.id;
  const mb = $('.max-btn', pane);
  mb.innerHTML = max ? ICONS.restore : ICONS.expand;
  mb.title = max ? 'Restore layout (double-click header)' : 'Expand (double-click header)';
  pane.classList.toggle('focused', focusedId === s.id);
  if (isExt(s.id)) return;
  if (s.provider === 'web') { const a = $('.web-body .link', pane); if (a) a.textContent = s.url || ''; }
}

function buildWebBody(s) {
  const ta = h('textarea', { placeholder: 'Scratchpad for this chat — drafts, things to paste in, notes on what it said. Saved with the desk.' });
  ta.value = state.drafts[s.id] || '';
  ta.addEventListener('input', () => { state.drafts[s.id] = ta.value; save(); });
  return h('div', { class: 'web-body' },
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => openWeb(s) }, `Open ${hostName(s.url)} window`),
      h('button', { class: 'btn ghost', onclick: () => { navigator.clipboard.writeText(ta.value); toast('Scratchpad copied'); } }, 'Copy scratchpad')),
    h('div', { class: 'link' }, s.url || ''),
    ta);
}
function hostName(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'chat'; } }
function openWeb(s) {
  if (!s.url) return toast('No link saved for this chat');
  fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: s.url }) });
}

// ---------- drag & drop ----------
let dragSid = null;
function startDrag(e, sid, el) {
  dragSid = sid;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', info(sid)?.title || '');
  hideDocked(true);
  el.classList.add('dragging');
  closeMenu();
}
function endDrag() {
  document.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging'));
  $('#dropHint').classList.add('hidden');
  dragSid = null;
  hideDocked(false);
}
function edgeFor(e, pane) {
  const r = pane.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  const d = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  const [edge, dist] = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
  return dist < .3 ? edge : 'center';
}
function paneDragOver(e, sid, pane) {
  if (!dragSid) return;
  e.preventDefault();
  if (dragSid === sid) { $('#dropHint').classList.add('hidden'); return; }
  const edge = edgeFor(e, pane), r = pane.getBoundingClientRect(), hint = $('#dropHint');
  const ok = canSplit(r, edge);
  hint.classList.toggle('no', !ok);
  e.dataTransfer.dropEffect = ok ? 'move' : 'none';
  let { left, top, width, height } = r;
  if (edge === 'left') width /= 2;
  if (edge === 'right') { left += width / 2; width /= 2; }
  if (edge === 'top') height /= 2;
  if (edge === 'bottom') { top += height / 2; height /= 2; }
  Object.assign(hint.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
  hint.textContent = ok ? (edge === 'center' ? 'Swap places' : '') : 'Too small to split here. Drop in the middle to swap';
  hint.classList.remove('hidden');
}
function canSplit(r, edge) {
  if (edge === 'center') return true;
  return edge === 'left' || edge === 'right' ? r.width >= 2 * MIN_W + GAP : r.height >= 2 * MIN_H + GAP;
}
function paneDrop(e, sid, pane) {
  if (!dragSid) return;
  e.preventDefault();
  const moving = dragSid, edge = edgeFor(e, pane);
  endDrag();
  if (moving === sid) return;
  if (!canSplit(pane.getBoundingClientRect(), edge)) { toast('Not enough room to split that pane. Drop in its middle to swap, or park something first.'); return; }
  const before = JSON.stringify(state.layout);
  placeAt(sid, edge, moving);
  if (!fits(state.layout)) { state.layout = JSON.parse(before); toast('That would make panes too small, so nothing changed.'); render(); return; }
  commit();
  focusPane(moving);
}
// drop onto the empty stage
$('#layoutRoot').parentElement.addEventListener('dragover', e => { if (dragSid && !state.layout) e.preventDefault(); });
$('#layoutRoot').parentElement.addEventListener('drop', e => { if (dragSid && !state.layout) { e.preventDefault(); const s = dragSid; endDrag(); showSession(s); } });
document.addEventListener('dragover', e => { if (dragSid && !e.target.closest?.('.pane')) $('#dropHint').classList.add('hidden'); });

// ---------- menus ----------
function showMenu(anchor, items) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it.sep) m.append(h('div', { class: 'sep' }));
    else if (it.hdr) m.append(h('div', { class: 'hdr' }, it.hdr));
    else m.append(h('div', { class: 'mi' + (it.danger ? ' danger' : ''), onclick: () => { closeMenu(); it.act(); } }, it.label));
  }
  m.classList.remove('hidden');
  let x, y;
  if (anchor instanceof Event) { x = anchor.clientX; y = anchor.clientY; }
  else { const r = anchor.getBoundingClientRect(); x = r.right - m.offsetWidth; y = r.bottom + 4; }
  x = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8));
  y = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8));
  m.style.left = x + 'px'; m.style.top = y + 'px';
}
function closeMenu() { $('#menu').classList.add('hidden'); }
document.addEventListener('mousedown', e => { if (!e.target.closest('#menu')) closeMenu(); });

function extMenu(sid, anchor) {
  const d = info(sid);
  const on = isOn(sid);
  const items = [];
  items.push(on ? { label: 'Park (minimizes an embedded window)', act: () => park(sid) } : { label: 'Put on screen', act: () => showSession(sid) });
  if (on) items.push({ label: state.maximized === sid ? 'Restore layout' : 'Expand', act: () => toggleMax(sid) });
  if (!d.gone && d.hwnd) {
    items.push({ label: 'Bring window to front', act: () => bringToFront(sid) });
    items.push(docksWindow(sid) ? { label: 'Unsnap (put the window back)', act: () => setDock(sid, false) } : { label: 'Snap window into pane', act: () => { addToScreen(sid); setDock(sid, true); } });
    if (d.kind === 'cli' && docksWindow(sid)) items.push({ label: 'Show live transcript instead', act: () => setDock(sid, false) });
  }
  if (d.kind === 'cli') items.push(d.gone ? { label: 'Resume it here', act: () => continueHere(sid, false) } : { label: `Move into desk (closes it in ${d.where})`, act: () => continueHere(sid, true) });
  items.push({ sep: true }, { hdr: 'File under project' });
  state.projects.forEach(p => items.push({ label: (state.extAssign[sid] === p.id ? '✓ ' : '') + p.name, act: () => { moveToProject(sid, p.id); commit(); } }));
  if (state.extAssign[sid]) items.push({ label: 'Back to "Running elsewhere"', act: () => { moveToProject(sid, EXT_GROUP); commit(); } });
  if (on) items.push({ sep: true }, { label: 'Remove pane', act: () => removeSession(sid) });
  showMenu(anchor, items);
}

function sessionMenu(sid, anchor) {
  if (isExt(sid)) return extMenu(sid, anchor);
  const s = session(sid);
  const on = isOn(sid);
  const st = statuses[sid];
  const items = [];
  items.push(on ? { label: 'Park (keep running)', act: () => park(sid) } : { label: 'Put on screen', act: () => showSession(sid) });
  if (on) items.push({ label: state.maximized === sid ? 'Restore layout' : 'Expand', act: () => toggleMax(sid) });
  items.push({ label: 'Rename…', act: () => { const t = prompt('Name', s.title); if (t && t.trim()) { s.title = t.trim(); commit(); } } });
  if (s.provider === 'web') {
    items.push({ label: 'Open chat window', act: () => openWeb(s) });
    items.push({ label: 'Change link…', act: () => { const u = prompt('Chat link', s.url || ''); if (u) { s.url = u.trim(); commit(); } } });
  } else {
    if (st && st !== 'stopped') items.push({ label: 'Stop', act: () => send({ t: 'stop', id: sid }) });
    if ((s.provider === 'claude' || s.provider === 'codex') && !s.command) items.push({ label: 'Restart & resume last conversation', act: () => { showSession(sid); setTimeout(() => startSess(sid, true, true), 80); } });
    items.push({ label: st && st !== 'stopped' ? 'Restart fresh' : 'Start', act: () => { showSession(sid); setTimeout(() => startSess(sid, false, true), 80); } });
  }
  const others = state.projects.filter(p => p.id !== s.projectId);
  if (others.length) { items.push({ sep: true }, { hdr: 'Move to project' }); others.forEach(p => items.push({ label: p.name, act: () => { s.projectId = p.id; commit(); } })); }
  items.push({ sep: true }, { label: 'Remove from desk', danger: true, act: () => removeSession(sid) });
  showMenu(anchor, items);
}
function inProject(id, pid) { return isExt(id) ? state.extAssign[id] === pid : session(id)?.projectId === pid; }
function projectMenu(p, anchor) {
  const sess = [...state.sessions.filter(s => s.projectId === p.id), ...discovered.filter(d => state.extAssign[d.id] === p.id)];
  const items = [
    { label: 'Show all on screen', act: () => { sess.forEach(s => addToScreen(s.id)); commit(); } },
    { label: 'Show only this project', act: () => {
      onScreen().filter(id => !inProject(id, p.id)).forEach(id => { removeFromTree(id); disposeTerm(id); paneEls.delete(id); });
      sess.forEach(s => addToScreen(s.id)); commit(); } },
    { label: 'Park all', act: () => { sess.forEach(s => { removeFromTree(s.id); disposeTerm(s.id); }); commit(); } },
    { sep: true },
    { label: 'Edit project…', act: () => openProjectDialog(p) },
  ];
  if (state.projects.length > 1) items.push({ label: 'Delete project', danger: true, act: () => {
    if (sess.length) return toast('Move or remove its conversations first');
    state.projects = state.projects.filter(x => x.id !== p.id); commit(); } });
  showMenu(anchor, items);
}

// ---------- new conversations ----------
// One click: Claude Code, Codex or a terminal starts right away in the project's folder, with a name
// picked for you. The dialog is only for the rest (custom command, web chat, another folder).
const QUICK = ['claude', 'codex', 'shell'];
function autoTitle(provider) {
  const base = LABEL[provider], taken = new Set(state.sessions.map(s => s.title));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}
function currentProject() {
  const pid = focusedId && (session(focusedId)?.projectId || state.extAssign[focusedId]);
  return project(pid) ? pid : state.projects[0].id;
}
function createSession({ provider, projectId, title, cwd, command, url }) {
  const s = {
    id: uid('s'), title: title || autoTitle(provider), autoTitle: !title, provider, projectId,
    cwd: provider === 'web' ? null : (cwd || null), command: provider === 'custom' ? command : null,
    url: provider === 'web' ? url : null, createdAt: Date.now(),
  };
  state.sessions.push(s);
  if (project(projectId)) project(projectId).collapsed = false;
  addToScreen(s.id);
  commit();
  focusPane(s.id, true);
  if (provider !== 'web') setTimeout(() => startSess(s.id), 150);
  else openWeb(s);
}
function quickAdd(provider, pid) { createSession({ provider, projectId: pid || currentProject() }); }
function newMenu(anchor, pid) {
  const p = project(pid || currentProject());
  showMenu(anchor, [
    { hdr: `Start now in ${p.name} · ${shortPath(p.cwd)}` },
    ...QUICK.map(k => ({ label: LABEL[k], act: () => quickAdd(k, p.id) })),
    { sep: true },
    { label: 'Other: command, web chat or another folder…', act: () => openNewSession(p.id) },
  ]);
}

// ---------- dialogs ----------
const dlgS = $('#dlgSession'), formS = $('#formSession');
function syncKindFields() {
  const k = formS.provider.value;
  formS.querySelectorAll('.for-custom').forEach(x => x.classList.toggle('hidden', k !== 'custom'));
  formS.querySelectorAll('.for-web').forEach(x => x.classList.toggle('hidden', k !== 'web'));
  formS.querySelectorAll('.for-term').forEach(x => x.classList.toggle('hidden', k === 'web'));
  formS.url.required = k === 'web';
  formS.command.required = k === 'custom';
}
$('#kinds').addEventListener('change', syncKindFields);
formS.projectId.addEventListener('change', () => { formS.cwd.value = project(formS.projectId.value)?.cwd || home; });
function openNewSession(pid) {
  formS.reset();
  const sel = formS.projectId;
  sel.innerHTML = '';
  state.projects.forEach(p => sel.append(h('option', { value: p.id }, p.name)));
  sel.value = pid || (focusedId && session(focusedId)?.projectId) || state.projects[0].id;
  formS.cwd.value = project(sel.value)?.cwd || home;
  syncKindFields();
  hideDocked(true);
  dlgS.showModal();
  formS.title.focus();
}
formS.addEventListener('submit', e => {
  if (e.submitter?.value !== 'ok') return;
  const f = formS;
  const cwd = f.cwd.value.trim();
  createSession({
    provider: f.provider.value, projectId: f.projectId.value, title: f.title.value.trim(),
    // the project's own folder stays "follow the project" rather than a fixed copy
    cwd: cwd && cwd !== project(f.projectId.value)?.cwd ? cwd : null,
    command: f.command.value.trim(), url: f.url.value.trim(),
  });
});
async function pickDir(input) {
  const r = await fetch('/api/pickdir', { method: 'POST' }).then(r => r.json()).catch(() => ({}));
  if (r.path) input.value = r.path;
}
$('#btnPickCwd').onclick = () => pickDir($('#inCwd'));
$('#btnPickProjCwd').onclick = () => pickDir($('#inProjCwd'));

const dlgP = $('#dlgProject'), formP = $('#formProject');
let editingProject = null;
function openProjectDialog(p) {
  editingProject = p || null;
  formP.reset();
  $('#dlgProjectTitle').textContent = p ? 'Edit project' : 'New project';
  formP.name.value = p?.name || '';
  formP.cwd.value = p?.cwd || home;
  hideDocked(true);
  dlgP.showModal();
  formP.name.focus();
}
formP.addEventListener('submit', e => {
  if (e.submitter?.value !== 'ok') return;
  const name = formP.name.value.trim(), cwd = formP.cwd.value.trim() || home;
  if (editingProject) { editingProject.name = name; editingProject.cwd = cwd; }
  else state.projects.push({ id: uid('p'), name, cwd, collapsed: false });
  commit();
});

// ---------- top bar ----------
$('#btnNew').onclick = () => quickAdd('claude');
$('#btnNewMore').onclick = e => newMenu(e.currentTarget);
document.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', () => b.dataset.quick === 'other' ? openNewSession() : quickAdd(b.dataset.quick)));
$('#btnNewProject').onclick = () => openProjectDialog();
$('#btnParkAll').onclick = () => { onScreen().forEach(id => disposeTerm(id)); state.layout = null; state.maximized = null; focusedId = null; commit(); };
// one click: everything running, in the desk or found elsewhere, tiled on screen
$('#btnTile').onclick = () => {
  const running = [
    ...state.sessions.filter(s => ['working', 'waiting', 'idle'].includes(statuses[s.id])).map(s => s.id),
    ...discovered.map(d => d.id),
  ];
  if (!running.length && !onScreen().length) return toast('Nothing is running');
  const b = stageBox();
  const cols = Math.max(1, Math.floor((b.w + GAP) / (MIN_W + GAP))), rowsMax = Math.max(1, Math.floor((b.h + GAP) / (MIN_H + GAP)));
  const ids = [...new Set([...onScreen(), ...running])];
  const shown = ids.slice(0, cols * rowsMax), left = ids.length - shown.length;
  const perRow = Math.min(cols, Math.ceil(Math.sqrt(shown.length * (b.w / b.h) * (MIN_H / MIN_W))) || 1);
  const rows = [];
  for (let i = 0; i < shown.length; i += perRow) rows.push(shown.slice(i, i + perRow));
  ids.slice(shown.length).forEach(id => { disposeTerm(id); paneEls.delete(id); });
  state.layout = normalize({ type: 'split', dir: 'col', sizes: equal(rows.length), children: rows.map(r => ({ type: 'split', dir: 'row', sizes: equal(r.length), children: r.map(sid => ({ type: 'pane', sid })) })) });
  if (left > 0) toast(`${left} more ${left === 1 ? "doesn't" : "don't"} fit on screen and stay parked in the sidebar.`);
  state.maximized = null;
  commit();
};

// ---------- keyboard ----------
// Ctrl+Alt+Enter expand/restore · Ctrl+Alt+- park · Ctrl+Alt+←/→/↑/↓ move focus · Ctrl+Alt+N new
function globalShortcut(e) {
  if (!(e.ctrlKey && e.altKey)) return false;
  const on = onScreen();
  if (e.key === 'Enter' && focusedId && on.includes(focusedId)) { toggleMax(focusedId); return true; }
  if ((e.key === '-' || e.key === '_') && focusedId && on.includes(focusedId)) { park(focusedId); return true; }
  if (e.key === 'n' || e.key === 'N') { quickAdd('claude'); return true; }
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (dirs[e.key] && on.length) {
    const cur = paneEls.get(focusedId);
    if (!cur) { focusPane(on[0]); return true; }
    const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const [dx, dy] = dirs[e.key];
    let best = null, bestD = Infinity;
    for (const sid of on) {
      if (sid === focusedId || !paneEls.get(sid)?.isConnected) continue;
      const q = paneEls.get(sid).getBoundingClientRect(), qx = q.left + q.width / 2, qy = q.top + q.height / 2;
      const along = (qx - cx) * dx + (qy - cy) * dy;
      if (along <= 10) continue;
      const d = along + Math.abs((qx - cx) * dy + (qy - cy) * dx) * 2;
      if (d < bestD) { bestD = d; best = sid; }
    }
    if (best) focusPane(best);
    return true;
  }
  return false;
}
document.addEventListener('keydown', e => { if (globalShortcut(e)) e.preventDefault(); if (e.key === 'Escape') closeMenu(); });
window.addEventListener('focus', () => { if (focusedId && statuses[focusedId] === 'waiting') send({ t: 'seen', id: focusedId }); });

// ---------- misc ----------
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 3200);
}

dlgS.addEventListener('close', () => hideDocked(false));
dlgP.addEventListener('close', () => hideDocked(false));

// ---------- boot ----------
fetch('/api/state').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(d => {
  state = d.state; statuses = d.statuses; home = d.home;
  state.sessions.forEach(s => serverKnown.add(s.id));
  ensureStateShape();
  applyGround(state.ground);
  setDiscovered(d.discovered || []);
  render();
  connect();
  const first = onScreen()[0];
  if (first) setTimeout(() => focusPane(first), 300);
}).catch(() => {
  document.body.innerHTML = '<p style="padding:40px;font:15px Segoe UI">Session Desk isn\'t authorised in this window. Launch it with <b>start.cmd</b>.</p>';
});
})();
