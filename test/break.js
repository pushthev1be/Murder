// Tries to break Session Desk: several desk windows at once, rapid clicks, restarts and crashes,
// bad input, floods of output, tiny windows. Each case starts its own desk on a fresh data folder.
//
//   node test/break.js            run everything
//   node test/break.js resume     only cases whose name contains "resume"
//
// Needs Playwright (npm i -D playwright, or a global install). On Linux, test/shim provides a
// stand-in for powershell.exe; on Windows the real one is used. Window snapping (winhelper) is
// not covered: the desk runs in demo mode, without discovery.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHIM = path.join(__dirname, 'shim');
let nextPort = 47900;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- a desk server ----------
class Desk {
  constructor(data) { this.data = data || fs.mkdtempSync(path.join(os.tmpdir(), 'desk-')); this.port = nextPort++; }
  async start() {
    const env = { ...process.env, DESK_DEMO: '1', DESK_DATA: this.data, DESK_PORT: String(this.port) };
    if (process.platform !== 'win32') env.PATH = SHIM + path.delimiter + env.PATH;
    this.proc = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env });
    this.log = ''; this.code = undefined;
    this.proc.stdout.on('data', d => { this.log += d; });
    this.proc.stderr.on('data', d => { this.log += d; });
    this.exited = new Promise(r => this.proc.on('exit', code => { this.code = code; r(code); }));
    for (let i = 0; i < 100 && !/running at/.test(this.log); i++) await sleep(50);
    if (!/running at/.test(this.log)) throw new Error('desk did not start:\n' + this.log);
    this.token = fs.readFileSync(path.join(this.data, 'token.txt'), 'utf8').trim();
    this.origin = `http://127.0.0.1:${this.port}`;
    this.url = `${this.origin}/?k=${this.token}`;
    return this;
  }
  async shutdown() { // like stop.cmd
    await this.req('POST', '/api/shutdown').catch(() => {});
    await Promise.race([this.exited, sleep(4000)]);
    if (this.code === undefined) this.kill();
  }
  kill() { try { this.proc.kill('SIGKILL'); } catch {} return this.exited; } // like a crash or Task Manager
  req(method, p, body, headers = {}) {
    return new Promise((res, rej) => {
      const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port: this.port, method, path: p,
        headers: { 'X-Desk-Token': this.token, 'Content-Type': 'application/json', ...headers } }, resp => {
        let b = ''; resp.on('data', d => b += d); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} res({ status: resp.statusCode, body: b, json: j }); });
      });
      r.on('error', rej);
      if (data) r.write(data);
      r.end();
    });
  }
  async state() { return (await this.req('GET', '/api/state')).json; }
  async put(state, client = 'test') { return this.req('PUT', '/api/state?client=' + client, state); }
  ws() { // a raw WebSocket client, as a desk page would open
    return new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${this.port}/ws`, { headers: { Cookie: 'desk=' + this.token, Origin: this.origin } });
      w.msgs = [];
      w.on('message', d => w.msgs.push(JSON.parse(d)));
      w.on('open', () => res(w)); w.on('error', rej);
      w.sendj = m => w.send(JSON.stringify(m));
      w.waitFor = async (pred, ms = 4000) => { for (let t = 0; t < ms; t += 50) { const m = w.msgs.find(pred); if (m) return m; await sleep(50); } return null; };
    });
  }
  async snapshot(id) {
    const w = await this.ws(); w.sendj({ t: 'attach', id });
    const m = await w.waitFor(m => m.t === 'snapshot' && m.id === id); w.close();
    return m;
  }
}

// ---------- helpers ----------
const sess = (id, extra = {}) => ({ id, title: id, provider: 'shell', projectId: 'p-general', cwd: null, command: null, url: null, createdAt: Date.now(), ...extra });
const baseState = (sessions = [], layout = null) => ({
  projects: [{ id: 'p-general', name: 'General', cwd: os.homedir(), collapsed: false }], sessions, layout, maximized: null, drafts: {},
});
const pane = sid => ({ type: 'pane', sid });
async function startShell(desk, id, extra) {
  const st = await desk.state();
  await desk.put({ ...st.state, sessions: [...st.state.sessions, sess(id, extra)] });
  if (extra && extra.provider === 'web') return null;
  const w = await desk.ws(); w.sendj({ t: 'start', id, cols: 80, rows: 24 });
  await w.waitFor(m => m.t === 'data' && m.id === id, 6000);
  return w;
}
async function waitStatus(desk, id, pred, ms = 5000) {
  let st;
  for (let t = 0; t < ms; t += 100) { st = (await desk.state()).statuses[id]; if (pred(st)) return st; await sleep(100); }
  return st;
}
const running = s => s && !['stopped', 'link', undefined].includes(s);
async function page(browser, desk, size = { width: 1440, height: 900 }) {
  const p = await browser.newPage({ viewport: size });
  p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('dialog', d => d.accept());
  await p.goto(desk.url);
  await p.waitForSelector('#sessionList');
  await sleep(500);
  return p;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------- the cases ----------
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('stale save from another window keeps every session running', async ({ desk }) => {
  await startShell(desk, 'a'); await startShell(desk, 'b');
  const r = await desk.put(baseState([]), 'stale');
  assert(r.status === 204, 'save refused: ' + r.status);
  const st = await desk.state();
  assert(st.state.sessions.length === 2, 'sessions vanished: ' + st.state.sessions.map(s => s.id));
  assert(running(st.statuses.a) && running(st.statuses.b), 'a session was stopped: ' + JSON.stringify(st.statuses));
});

test('removed session stays removed when a stale window saves it again', async ({ desk }) => {
  await startShell(desk, 'a');
  const st = await desk.state();
  await desk.put({ ...st.state, sessions: [], removed: ['a'] });
  assert(!running(await waitStatus(desk, 'a', s => !running(s))), 'removed session still running');
  await desk.put({ ...st.state }, 'stale'); // still lists "a"
  const after = await desk.state();
  assert(!after.state.sessions.some(s => s.id === 'a'), 'stale window brought a removed session back');
});

test('removed session stays removed across a desk restart', async ({ desk }) => {
  await startShell(desk, 'a');
  const st = await desk.state();
  await desk.put({ ...st.state, sessions: [], removed: ['a'] });
  await desk.shutdown(); await desk.start();
  await desk.put({ ...st.state }, 'stale');
  const after = await desk.state();
  assert(!after.state.sessions.some(s => s.id === 'a'), 'stale window brought a removed session back after a restart');
  assert(!running(after.statuses.a), 'removed session was resumed');
});

test('stray start does not restart a running session', async ({ desk }) => {
  const w = await startShell(desk, 'a');
  w.sendj({ t: 'input', id: 'a', data: 'echo MARK-$((40+2))\r' });
  await w.waitFor(m => m.t === 'data' && m.data.includes('MARK-42'));
  w.sendj({ t: 'start', id: 'a' });
  await sleep(500);
  assert((await desk.snapshot('a')).data.includes('MARK-42'), 'output was wiped: the session restarted');
});

test('explicit restart does restart', async ({ desk }) => {
  const w = await startShell(desk, 'a');
  w.sendj({ t: 'input', id: 'a', data: 'echo MARK-$((40+2))\r' });
  await w.waitFor(m => m.t === 'data' && m.data.includes('MARK-42'));
  w.sendj({ t: 'start', id: 'a', restart: true });
  await sleep(800);
  assert(!(await desk.snapshot('a')).data.includes('MARK-42'), 'restart kept the old output');
  assert(running((await desk.state()).statuses.a), 'not running after restart');
});

test('resume: running sessions come back after stop.cmd', async ({ desk }) => {
  await startShell(desk, 'a'); await startShell(desk, 'b');
  await desk.shutdown(); await desk.start();
  const st = await desk.state();
  assert(running(st.statuses.a) && running(st.statuses.b), 'not resumed: ' + JSON.stringify(st.statuses));
});

test('resume: running sessions come back after a crash', async ({ desk }) => {
  await startShell(desk, 'a');
  await desk.kill(); await desk.start();
  assert(running((await desk.state()).statuses.a), 'not resumed after crash');
});

test('resume: a session you exited does not come back', async ({ desk }) => {
  const w = await startShell(desk, 'a');
  w.sendj({ t: 'input', id: 'a', data: 'exit\r' });
  await waitStatus(desk, 'a', s => !running(s));
  await desk.shutdown(); await desk.start();
  assert(!running((await desk.state()).statuses.a), 'an exited session was started again');
});

test('resume: a session you stopped does not come back', async ({ desk }) => {
  const w = await startShell(desk, 'a');
  w.sendj({ t: 'stop', id: 'a' });
  await waitStatus(desk, 'a', s => !running(s));
  await desk.shutdown(); await desk.start();
  assert(!running((await desk.state()).statuses.a), 'a stopped session was started again');
});

test('resume: a session whose folder was deleted still starts', async ({ desk }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gone-'));
  await startShell(desk, 'a', { cwd: dir });
  await desk.shutdown(); fs.rmSync(dir, { recursive: true }); await desk.start();
  assert(running((await desk.state()).statuses.a), 'did not start without its folder');
});

test('resume: a command that fails right away does not loop', async ({ desk }) => {
  await startShell(desk, 'a', { provider: 'custom', command: 'exit 3' });
  await sleep(800);
  await desk.shutdown(); await desk.start(); await sleep(1500);
  await desk.shutdown(); await desk.start(); await sleep(500);
  const ran = JSON.parse(fs.readFileSync(path.join(desk.data, 'running.json'), 'utf8'));
  assert(!ran.includes('a'), 'a failing command stays in the restart list forever');
});

test('bad saves are refused and leave the desk intact', async ({ desk }) => {
  await startShell(desk, 'a');
  const bads = ['not json', '{}', JSON.stringify({ projects: [], sessions: [null] }), JSON.stringify({ projects: 'x', sessions: [] }),
    JSON.stringify({ projects: [], sessions: [{ title: 'no id' }] }), JSON.stringify({ projects: [], sessions: [], removed: 'a' })];
  for (const b of bads) await desk.req('PUT', '/api/state', b);
  const st = await desk.state();
  assert(st && st.state.sessions.some(s => s.id === 'a'), 'state damaged by a bad save');
  assert(running(st.statuses.a), 'session stopped by a bad save');
  assert(st.state.projects.length > 0, 'projects wiped by a bad save');
});

test('bad websocket messages do not crash the desk', async ({ desk }) => {
  const w = await startShell(desk, 'a');
  const junk = ['{', 'null', '[]', '{"t":"resize","id":"a","cols":1e9,"rows":1e9}', '{"t":"resize","id":"a","cols":-5,"rows":"x"}',
    '{"t":"input","id":"a","data":{"x":1}}', '{"t":"start","id":"nope"}', '{"t":"attach","id":"__proto__"}', '{"t":"start","id":"__proto__"}',
    '{"t":"ext-dock","items":"x"}', '{"t":"ext-close","id":"a"}', '{"t":"stop"}'];
  for (const j of junk) w.send(j);
  await sleep(800);
  assert(desk.code === undefined, 'desk crashed:\n' + desk.log.slice(-800));
  w.sendj({ t: 'input', id: 'a', data: 'echo STILL-$((1+1))\r' });
  assert(await w.waitFor(m => m.t === 'data' && m.data.includes('STILL-2')), 'session stopped answering');
});

test('pages and endpoints need the token', async ({ desk }) => {
  const r1 = await desk.req('GET', '/api/state', undefined, { 'X-Desk-Token': 'wrong' });
  const r2 = await desk.req('PUT', '/api/state', baseState(), { 'X-Desk-Token': 'wrong' });
  const r3 = await desk.req('GET', '/api/state', undefined, { Origin: 'http://evil.example' }); // token + foreign origin
  const r4 = await desk.req('GET', '/api/state', undefined, { Host: 'evil.example:' + desk.port });
  assert(r1.status === 401 && r2.status === 401 && r3.status === 401 && r4.status === 403, `got ${r1.status} ${r2.status} ${r3.status} ${r4.status}`);
  const ok = await new Promise(res => { const w = new WebSocket(`ws://127.0.0.1:${desk.port}/ws`, { headers: { Cookie: 'desk=' + desk.token, Origin: 'http://evil.example' } }); w.on('open', () => res(true)); w.on('error', () => res(false)); });
  assert(!ok, 'a foreign page could open the websocket');
});

test('flood of output stays bounded and the desk keeps answering', async ({ desk }) => {
  const w = await startShell(desk, 'a');
  w.sendj({ t: 'input', id: 'a', data: 'for i in $(seq 1 60000); do echo "line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done; echo FLOOD-$((0+1))\r' });
  assert(await w.waitFor(m => m.t === 'data' && m.data.includes('FLOOD-1'), 30000), 'flood never finished');
  const t0 = Date.now(); await desk.state();
  assert(Date.now() - t0 < 1000, 'desk slow after flood');
  const snap = await desk.snapshot('a');
  assert(snap.data.length <= 512 * 1024, 'scrollback not trimmed: ' + snap.data.length);
});

test('UI: one click starts a conversation you can type into', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await p.click('[data-quick=shell]');
  await p.waitForSelector('.xterm');
  await sleep(800);
  await p.keyboard.type('echo TYPED-$((2*21))\n');
  const st = await desk.state();
  const id = st.state.sessions[0].id;
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) { ok = (await desk.snapshot(id)).data.includes('TYPED-42'); await sleep(100); }
  assert(ok, 'typing did not reach the session');
  assert(!p.errors.length, p.errors.join('; '));
});

test('UI: ten rapid clicks give ten running conversations, none lost', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  for (let i = 0; i < 10; i++) await p.click('#btnNew', { delay: 0 }).catch(() => {});
  await sleep(3000);
  const st = await desk.state();
  const names = st.state.sessions.map(s => s.title);
  assert(st.state.sessions.length === 10, 'expected 10 sessions, got ' + names.length);
  assert(new Set(names).size === 10, 'duplicate names: ' + names);
  const notRunning = st.state.sessions.filter(s => !running(st.statuses[s.id]));
  assert(!notRunning.length, 'not running: ' + notRunning.map(s => s.title));
  assert(!p.errors.length, p.errors.join('; '));
});

test('UI: two windows adding at the same time lose nothing', async ({ desk, browser }) => {
  const a = await page(browser, desk), b = await page(browser, desk);
  await Promise.all([a.click('[data-quick=shell]'), b.click('[data-quick=shell]')]);
  await sleep(500);
  await Promise.all([a.click('#btnNew'), b.click('#btnNew')]);
  await sleep(2500);
  const st = await desk.state();
  assert(st.state.sessions.length === 4, 'expected 4 sessions, got ' + st.state.sessions.map(s => s.title));
  assert(st.state.sessions.every(s => running(st.statuses[s.id])), 'something stopped: ' + JSON.stringify(st.statuses));
  for (const p of [a, b]) {
    const shown = await p.locator('#sessionList .item').count();
    assert(shown === 4, `a window shows ${shown} conversations instead of 4`);
  }
});

test('UI: removing in one window removes it in the other, and it stays gone', async ({ desk, browser }) => {
  const a = await page(browser, desk), b = await page(browser, desk);
  await a.click('[data-quick=shell]'); await sleep(400); await a.click('#btnNew');
  await sleep(1500);
  const st = await desk.state();
  const victim = st.state.sessions[0];
  await a.click(`.item[data-sid="${victim.id}"]`, { button: 'right' });
  await a.click('#menu .mi >> text=Remove from desk');
  await sleep(1200);
  // b does something that saves (a divider double-click or a background change)
  await b.click('.swatch[data-ground=sand]'); await sleep(800);
  const after = await desk.state();
  assert(!after.state.sessions.some(s => s.id === victim.id), 'removed session came back');
  for (const p of [a, b]) assert(!(await p.locator(`.item[data-sid="${victim.id}"]`).count()), 'a window still lists the removed session');
});

test('UI: remove, then another window saves before the removal is sent', async ({ desk, browser }) => {
  const a = await page(browser, desk), b = await page(browser, desk);
  await a.click('[data-quick=shell]'); await sleep(1500);
  const id = (await desk.state()).state.sessions[0].id;
  // a removes (its save is debounced); b saves straight away with its older list
  await a.evaluate(sid => { document.querySelector(`.item[data-sid="${sid}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); }, id);
  await a.click('#menu .mi >> text=Remove from desk');
  await b.click('.swatch[data-ground=peach]');
  await sleep(1500);
  const after = await desk.state();
  assert(!after.state.sessions.some(s => s.id === id), 'removed session came back');
  assert(!running(after.statuses[id]), 'removed session still running');
  for (const p of [a, b]) assert(!(await p.locator(`.item[data-sid="${id}"]`).count()), 'a window still lists the removed session');
});

test('UI: page survives a desk restart and reattaches its terminals', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await p.click('[data-quick=shell]'); await sleep(1000);
  await p.keyboard.type('echo BEFORE-$((3*3))\n'); await sleep(500);
  await desk.shutdown(); await sleep(500); await desk.start();
  await sleep(4000); // page reconnects by itself
  await p.keyboard.type('echo AFTER-$((4*4))\n');
  const id = (await desk.state()).state.sessions[0].id;
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) { ok = (await desk.snapshot(id)).data.includes('AFTER-16'); await sleep(100); }
  assert(ok, 'could not type into the session after the desk restarted');
  assert(!(await p.locator('.overlay').count()), 'pane shows "not running" after restart');
});

test('UI: typing keeps going while another window changes things', async ({ desk, browser }) => {
  const a = await page(browser, desk), b = await page(browser, desk);
  await a.click('[data-quick=shell]'); await sleep(1200);
  const id = (await desk.state()).state.sessions[0].id;
  await a.keyboard.type('echo HALF');
  await b.click('.swatch[data-ground=sand]'); await sleep(700); // re-renders window a
  await a.keyboard.type('-WAY-$((6*7))\n');
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) { ok = (await desk.snapshot(id)).data.includes('HALF-WAY-42'); await sleep(100); }
  assert(ok, 'keystrokes were lost: the terminal lost the keyboard when the other window saved');
});

test('UI: a scrolled scratchpad keeps its place on re-render', async ({ desk, browser }) => {
  const a = await page(browser, desk), b = await page(browser, desk);
  await startShell(desk, 'w', { provider: 'web', url: 'https://example.com/c/1' });
  await a.evaluate(() => location.reload()); await a.waitForSelector('#sessionList'); await sleep(500);
  await a.click('.item[data-sid="w"]'); await sleep(500);
  await a.fill('.web-body textarea', Array.from({ length: 200 }, (_, i) => 'note ' + i).join('\n'));
  await a.$eval('.web-body textarea', t => { t.scrollTop = 1500; t.focus(); });
  await b.click('.swatch[data-ground=sand]'); await sleep(700);
  const st = await a.$eval('.web-body textarea', t => [t.scrollTop, document.activeElement === t]);
  assert(st[0] > 1000, 'scratchpad jumped to the top: ' + st[0]);
  assert(st[1], 'scratchpad lost the keyboard');
});

test('UI: parked and brought back, a terminal shows its earlier output', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await p.click('[data-quick=shell]'); await sleep(1000);
  await p.keyboard.type('echo KEEP-$((5*5))\n'); await sleep(600);
  const id = (await desk.state()).state.sessions[0].id;
  await p.click(`.pane[data-sid="${id}"] .icon-btn[title^="Park"]`); await sleep(300);
  await p.click(`.item[data-sid="${id}"]`); await sleep(1200);
  const txt = await p.evaluate(sid => document.querySelector(`.pane[data-sid="${sid}"] .xterm`)?.innerText || '', id);
  const buf = await p.evaluate(() => document.querySelector('.xterm-accessibility')?.innerText || '');
  assert(txt.includes('KEEP-25') || buf.includes('KEEP-25') || (await desk.snapshot(id)).data.includes('KEEP-25'), 'output lost after parking');
  assert(running((await desk.state()).statuses[id]), 'parking stopped the session');
});

test('UI: a tiny window never squashes panes below the minimum', async ({ desk, browser }) => {
  const p = await page(browser, desk, { width: 700, height: 500 });
  for (let i = 0; i < 5; i++) { await p.click('#btnNew'); await sleep(250); }
  await sleep(800);
  const sizes = await p.$$eval('.pane', els => els.map(e => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]));
  assert(sizes.every(([w, h]) => w >= 299 && h >= 199), 'pane too small: ' + JSON.stringify(sizes));
  const st = await desk.state();
  assert(st.state.sessions.every(s => running(st.statuses[s.id])), 'a session stopped when the screen was full');
});

test('UI: Arrange all with 25 conversations', async ({ desk, browser }) => {
  for (let i = 0; i < 25; i++) await startShell(desk, 's' + i);
  const p = await page(browser, desk);
  await p.click('#btnTile'); await sleep(1500);
  const n = await p.locator('.pane').count();
  const sizes = await p.$$eval('.pane', els => els.map(e => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]));
  assert(n > 0, 'nothing on screen');
  assert(sizes.every(([w, h]) => w >= 299 && h >= 199), 'pane too small: ' + JSON.stringify(sizes));
  assert(!p.errors.length, p.errors.join('; '));
});

test('UI: odd titles render as text, never as markup', async ({ desk, browser }) => {
  const evil = '<img src=x onerror="window.__pwned=1">Ω 🚀 ' + 'x'.repeat(300);
  await startShell(desk, 'a', { title: evil });
  const p = await page(browser, desk);
  await p.click('.item[data-sid="a"]'); await sleep(600);
  assert(!(await p.evaluate(() => window.__pwned)), 'title ran as HTML');
  const w = await p.$eval('#sessionList', e => e.scrollWidth <= e.clientWidth + 1);
  assert(w, 'a long title widens the sidebar');
});

test('UI: dragging a pane onto a too-small pane changes nothing', async ({ desk, browser }) => {
  const p = await page(browser, desk, { width: 1000, height: 700 });
  for (let i = 0; i < 3; i++) { await p.click('#btnNew'); await sleep(300); }
  await sleep(600);
  const before = (await desk.state()).state.layout;
  const src = p.locator('.pane .pane-head').first(), dst = p.locator('.pane').last();
  const r = await dst.boundingBox();
  await src.dragTo(dst, { targetPosition: { x: 5, y: r.height / 2 } });
  await sleep(600);
  const sizes = await p.$$eval('.pane', els => els.map(e => Math.round(e.getBoundingClientRect().width)));
  assert(sizes.every(w => w >= 299), 'split made a pane too small: ' + sizes);
  assert(!p.errors.length, p.errors.join('; '));
  void before;
});

// ---------- round 2 ----------
test('UI: a stale window that still shows a removed pane leaves no empty hole', async ({ desk, browser }) => {
  const a = await page(browser, desk);
  await a.click('[data-quick=shell]'); await sleep(400); await a.click('#btnNew'); await sleep(1200);
  const st = await desk.state();
  const [x, y] = st.state.sessions;
  // another window removes x but its save still carries the old layout (x on screen)
  await desk.put({ ...st.state, sessions: [y], removed: [x.id] }, 'other');
  await sleep(800);
  const panes = await a.$$eval('#layoutRoot .pane', els => els.map(e => e.dataset.sid));
  const cells = await a.$$eval('#layoutRoot .cell', els => els.filter(c => !c.querySelector('.pane')).length);
  assert(!panes.includes(x.id), 'removed pane still on screen');
  assert(cells === 0, `${cells} empty hole(s) left in the layout`);
});

test('UI: starting one while the desk is down works once it is back', async ({ desk, browser }) => {
  const a = await page(browser, desk);
  await desk.kill();
  await a.click('[data-quick=shell]'); await sleep(500);
  await desk.start(); await sleep(4000);
  const st = await desk.state();
  assert(st.state.sessions.length === 1, 'the new conversation was never saved');
  assert(running(st.statuses[st.state.sessions[0].id]), 'saved but never started');
  assert(!(await a.locator('.overlay').count()) || running(st.statuses[st.state.sessions[0].id]), 'pane stuck');
});

test('UI: two windows adding at once get different names', async ({ desk, browser }) => {
  const a = await page(browser, desk), b = await page(browser, desk);
  await Promise.all([a.click('#btnNew'), b.click('#btnNew')]);
  await sleep(1500);
  const names = (await desk.state()).state.sessions.map(s => s.title);
  assert(names.length === 2 && names[0] !== names[1], 'same name twice: ' + names);
});

test('UI: Ctrl+Alt+N from inside a terminal starts another one', async ({ desk, browser }) => {
  const a = await page(browser, desk);
  await a.click('[data-quick=shell]'); await sleep(1200);
  await a.keyboard.press('Control+Alt+n'); await sleep(1500);
  const st = await desk.state();
  assert(st.state.sessions.length === 2, 'got ' + st.state.sessions.length + ' sessions');
});

test('UI: a project whose folder is gone still starts conversations', async ({ desk, browser }) => {
  const st = await desk.state();
  await desk.put({ ...st.state, projects: [{ id: 'p-general', name: 'General', cwd: '/definitely/not/here', collapsed: false }] });
  const a = await page(browser, desk);
  await a.click('[data-quick=shell]'); await sleep(1500);
  const after = await desk.state();
  assert(running(after.statuses[after.state.sessions[0].id]), 'did not start');
});

test('server: path tricks and odd links are refused', async ({ desk }) => {
  const t1 = await desk.req('GET', '/api/transcript?sid=' + encodeURIComponent('../../../etc/passwd'));
  const t2 = await desk.req('GET', '/../server.js');
  const t3 = await desk.req('GET', '/vendor/../../server.js');
  const bad = ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'not a url', '\\\\host\\share'];
  const o = [];
  for (const u of bad) o.push((await desk.req('POST', '/api/open', { url: u })).status);
  assert(t1.status === 400, 'transcript: ' + t1.status);
  assert(t2.status === 404 && t3.status === 404, `static: ${t2.status} ${t3.status}`);
  assert(o.every(s => s === 400), 'open: ' + o);
});

test('server: a corrupted save file starts with a clean desk instead of crashing', async ({ desk }) => {
  await startShell(desk, 'a');
  await desk.shutdown();
  fs.writeFileSync(path.join(desk.data, 'state.json'), '{"projects": [tru');
  fs.writeFileSync(path.join(desk.data, 'running.json'), 'nope');
  await desk.start();
  const st = await desk.state();
  assert(st && st.state.projects.length, 'no usable state');
});

test('server: a corrupted save file is kept, not overwritten', async ({ desk }) => {
  await startShell(desk, 'a');
  await desk.shutdown();
  fs.writeFileSync(path.join(desk.data, 'state.json'), '{"projects": [tru');
  await desk.start();
  const st = await desk.state();
  await desk.put(st.state); // any save
  const files = fs.readdirSync(desk.data);
  assert(files.some(f => /^state\.json\.(bad|broken|bak)/.test(f)), 'the damaged file was overwritten, so your layout is gone for good: ' + files);
});

test('server: many windows connecting and leaving at once', async ({ desk }) => {
  await startShell(desk, 'a');
  const ws = await Promise.all(Array.from({ length: 40 }, () => desk.ws()));
  ws.forEach((w, i) => w.sendj({ t: i % 2 ? 'claim' : 'visible', on: true }));
  ws.forEach(w => w.close());
  await sleep(500);
  const st = await desk.state();
  assert(running(st.statuses.a), 'session hurt by window churn');
});

// ---------- runner ----------
(async () => {
  const only = process.argv[2];
  const list = cases.filter(c => !only || c.name.includes(only));
  const browser = await chromium.launch();
  let failed = 0;
  for (const c of list) {
    const desk = await new Desk().start();
    const t0 = Date.now();
    try {
      await Promise.race([c.fn({ desk, browser }), sleep(60000).then(() => { throw new Error('timed out'); })]);
      if (desk.code !== undefined && desk.code !== 0) throw new Error('desk exited with ' + desk.code + ':\n' + desk.log.slice(-600));
      console.log(`  ok    ${c.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${c.name}\n        ${String(e.message).split('\n').join('\n        ')}`);
    } finally {
      for (const ctx of browser.contexts()) await ctx.close().catch(() => {});
      await desk.kill();
      fs.rmSync(desk.data, { recursive: true, force: true });
    }
  }
  await browser.close();
  console.log(`\n${list.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
