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
  constructor(opts = {}) {
    this.data = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-')); this.port = nextPort++;
    this.fake = !!opts.fake; // fake windows instead of demo mode: discovery + docking run for real
    this.fakeFile = path.join(this.data, 'fake-windows.json');
    this.home = path.join(this.data, 'home');
  }
  setWindows(w) { fs.writeFileSync(this.fakeFile, JSON.stringify(w)); }
  helperLog() { try { return fs.readFileSync(this.fakeFile + '.log', 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }
  layouts() { return this.helperLog().filter(c => c.cmd === 'layout'); }
  async start() {
    const env = { ...process.env, DESK_DATA: this.data, DESK_PORT: String(this.port) };
    if (this.fake) { env.DESK_FAKE_WINDOWS = this.fakeFile; env.USERPROFILE = this.home; fs.mkdirSync(this.home, { recursive: true }); if (!fs.existsSync(this.fakeFile)) this.setWindows({}); }
    else env.DESK_DEMO = '1';
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

test('UI: four windows each adding three at once lose nothing', async ({ desk, browser }) => {
  const ps = [];
  for (let i = 0; i < 4; i++) ps.push(await page(browser, desk, { width: 1600, height: 1000 }));
  await Promise.all(ps.map(async p => { for (let k = 0; k < 3; k++) { await p.click('#btnNew'); await sleep(30); } }));
  await sleep(3500);
  const st = await desk.state();
  const names = st.state.sessions.map(s => s.title);
  assert(st.state.sessions.length === 12, `expected 12, got ${names.length}: ${names}`);
  assert(new Set(names).size === 12, 'duplicate names: ' + names);
  const stopped = st.state.sessions.filter(s => !running(st.statuses[s.id]));
  assert(!stopped.length, 'never started: ' + stopped.map(s => s.title));
  for (const p of ps) { const n = await p.locator('#sessionList .item').count(); assert(n === 12, `a window lists ${n} of 12`); }
});

// ---------- round 3: outside windows and snapping (fake windows, real discovery + docking) ----------
const fakeTest = (name, fn) => cases.push({ name, fn, fake: true });
const CHATGPT = { windows: [{ hwnd: 1001, pid: 501, title: 'ChatGPT', min: false }], procs: [[501, 1, 'ChatGPT.exe']] };
const lastLayout = desk => desk.layouts().slice(-1)[0];
const docked = (l, hwnd) => l && l.items.find(i => i.hwnd === hwnd);
async function waitLayout(desk, pred, ms = 6000) {
  for (let t = 0; t < ms; t += 100) { const l = lastLayout(desk); if (l && pred(l)) return l; await sleep(100); }
  return lastLayout(desk);
}
async function bodyRect(p, sid) {
  return p.$eval(`.pane[data-sid="${sid}"] .pane-body`, e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, dpr: devicePixelRatio }; });
}
// a fake Claude Code CLI session: a real (sleeping) process, its registry entry and a transcript
function fakeCli(desk, { host = 'WindowsTerminal.exe', hostHwnd = 2002 } = {}) {
  const proc = spawn('sleep', ['600']);
  const sid = '11111111-2222-3333-4444-555555555555', hostPid = 777;
  fs.mkdirSync(path.join(desk.home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(desk.home, '.claude', 'sessions', proc.pid + '.json'), JSON.stringify({ pid: proc.pid, sessionId: sid, cwd: desk.home, status: 'idle', statusUpdatedAt: 1 }));
  fs.mkdirSync(path.join(desk.home, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(desk.home, '.claude', 'projects', 'p', sid + '.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'fix the login bug' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at auth.js now.' }] } }) + '\n');
  desk.setWindows({ windows: [{ hwnd: hostHwnd, pid: hostPid, title: 'Terminal', min: false }], procs: [[proc.pid, hostPid, 'claude.exe'], [hostPid, 1, host]] });
  return { proc, id: 'x-cc-' + sid, alive: () => { try { process.kill(proc.pid, 0); return true; } catch { return false; } } };
}

fakeTest('snap: a ChatGPT window lands exactly on its pane', async ({ desk, browser }) => {
  desk.setWindows(CHATGPT);
  const p = await page(browser, desk); await sleep(3500);
  await p.click('.item[data-sid="x-win-1001"]');
  const l = await waitLayout(desk, l => docked(l, 1001));
  const it = docked(l, 1001), r = await bodyRect(p, 'x-win-1001');
  assert(it, 'never snapped');
  const off = Math.max(Math.abs(it.x - r.x * r.dpr), Math.abs(it.y - r.y * r.dpr), Math.abs(it.w - r.w * r.dpr), Math.abs(it.h - r.h * r.dpr));
  assert(off <= 1, `window off its pane by ${off}px: ${JSON.stringify(it)} vs ${JSON.stringify(r)}`);
  assert(l.hidden === false, 'snapped window left hidden');
});

fakeTest('snap: parking the pane minimizes the window, it is not left floating', async ({ desk, browser }) => {
  desk.setWindows(CHATGPT);
  const p = await page(browser, desk); await sleep(3500);
  await p.click('.item[data-sid="x-win-1001"]'); await waitLayout(desk, l => docked(l, 1001));
  await p.click('.pane[data-sid="x-win-1001"] .icon-btn[title^="Park"]');
  const l = await waitLayout(desk, l => !docked(l, 1001));
  assert(!docked(l, 1001) && (l.park || []).includes(1001), 'parked window not minimized: ' + JSON.stringify(l));
});

fakeTest('snap: expanding another pane tucks the window away, restoring brings it back', async ({ desk, browser }) => {
  desk.setWindows(CHATGPT);
  const p = await page(browser, desk); await sleep(3500);
  await p.click('.item[data-sid="x-win-1001"]'); await waitLayout(desk, l => docked(l, 1001));
  await p.click('#btnNew'); await sleep(1200);
  const other = (await desk.state()).state.sessions[0].id;
  await p.dblclick(`.pane[data-sid="${other}"] .pane-title`);
  let l = await waitLayout(desk, l => !docked(l, 1001));
  assert(!docked(l, 1001), 'window still over the stage while another pane is expanded');
  await p.dblclick(`.pane[data-sid="${other}"] .pane-title`);
  l = await waitLayout(desk, l => docked(l, 1001));
  assert(docked(l, 1001), 'window did not come back after restoring the layout');
});

fakeTest('snap: an open dialog or a drag tucks windows behind the desk', async ({ desk, browser }) => {
  desk.setWindows(CHATGPT);
  const p = await page(browser, desk); await sleep(3500);
  await p.click('.item[data-sid="x-win-1001"]'); await waitLayout(desk, l => docked(l, 1001));
  await p.click('#btnNewMore'); await p.click('#menu .mi >> text=Other');
  let l = await waitLayout(desk, l => l.hidden);
  assert(l.hidden, 'window stays over the dialog');
  await p.keyboard.press('Escape');
  l = await waitLayout(desk, l => !l.hidden);
  assert(!l.hidden && docked(l, 1001), 'window did not come back after the dialog');
});

fakeTest('snap: a second desk window in the background cannot move the windows', async ({ desk, browser }) => {
  desk.setWindows(CHATGPT);
  const a = await page(browser, desk); await sleep(3500);
  await a.click('.item[data-sid="x-win-1001"]'); await waitLayout(desk, l => docked(l, 1001));
  const want = await bodyRect(a, 'x-win-1001');
  const b = await page(browser, desk, { width: 900, height: 600 }); // a different size: its panes are elsewhere
  await b.evaluate(() => window.dispatchEvent(new Event('resize')));
  await a.click('.swatch[data-ground=sand]'); // makes b re-render
  await a.bringToFront(); await a.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(1500);
  const it = docked(lastLayout(desk), 1001);
  assert(it && Math.abs(it.w - want.w * want.dpr) <= 1, `window was moved to the other desk window's pane: ${JSON.stringify(it)} vs ${JSON.stringify(want)}`);
});

fakeTest('snap: the helper not finding the desk keeps being retried', async ({ desk, browser }) => {
  desk.setWindows({ ...CHATGPT, layoutReply: { error: 'desk window not found' } });
  const p = await page(browser, desk); await sleep(3500);
  await p.click('.item[data-sid="x-win-1001"]');
  await sleep(9000);
  const n = desk.layouts().length;
  desk.setWindows(CHATGPT); // the desk window turns up
  await sleep(4000);
  assert(desk.layouts().length > n, 'gave up retrying: a window would stay loose until you touched the layout');
});

fakeTest('snap: a window that needs more room grows its pane', async ({ desk, browser }) => {
  desk.setWindows({ ...CHATGPT, mins: [[1001, 700, 500]] });
  const p = await page(browser, desk); await sleep(3500);
  await p.click('#btnNew'); await sleep(400); await p.click('#btnNew'); await sleep(400);
  await p.click('.item[data-sid="x-win-1001"]'); await sleep(2500);
  const r = await bodyRect(p, 'x-win-1001');
  assert(r.w >= 699 && r.h >= 499, `pane is ${Math.round(r.w)}x${Math.round(r.h)}, the app needs 700x500, so it spills over its neighbours`);
});

fakeTest('snap: a ChatGPT title change does not take the keyboard from a terminal', async ({ desk, browser }) => {
  desk.setWindows(CHATGPT);
  const p = await page(browser, desk); await sleep(3500);
  await p.click('.item[data-sid="x-win-1001"]'); await sleep(500);
  await p.click('#btnNew'); await sleep(1500);
  const id = (await desk.state()).state.sessions[0].id;
  await p.click(`.pane[data-sid="${id}"] .pane-body`);
  await p.keyboard.type('echo TITLE');
  desk.setWindows({ ...CHATGPT, windows: [{ ...CHATGPT.windows[0], title: 'Fixing a login bug - ChatGPT' }] });
  await sleep(3800); // next discovery pass
  await p.keyboard.type('-SAFE-$((9*9))\n');
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) { ok = (await desk.snapshot(id)).data.includes('TITLE-SAFE-81'); await sleep(100); }
  assert(ok, 'keystrokes lost when the ChatGPT window changed its title');
});

fakeTest('snap: ChatGPT closed and reopened goes back into its pane', async ({ desk, browser }) => {
  desk.setWindows(CHATGPT);
  const p = await page(browser, desk); await sleep(3500);
  await p.click('.item[data-sid="x-win-1001"]'); await waitLayout(desk, l => docked(l, 1001));
  desk.setWindows({}); await sleep(3500); // closed
  desk.setWindows({ windows: [{ hwnd: 1077, pid: 502, title: 'ChatGPT', min: false }], procs: [[502, 1, 'ChatGPT.exe']] }); // reopened: new window
  const l = await waitLayout(desk, l => docked(l, 1077), 8000);
  assert(docked(l, 1077), 'the reopened ChatGPT window is not in the pane: you have to set it up again');
});

fakeTest('cli: putting an outside Claude Code session on screen never stops it', async ({ desk, browser }) => {
  const cli = fakeCli(desk);
  try {
    const p = await page(browser, desk); await sleep(3500);
    await p.click(`.item[data-sid="${cli.id}"]`); await sleep(1500);
    await p.click('#btnTile'); await sleep(1000);
    await p.click(`.pane[data-sid="${cli.id}"] .icon-btn[title^="Park"]`); await sleep(500);
    assert(cli.alive(), 'the outside Claude Code process was stopped');
  } finally { cli.proc.kill(); }
});

fakeTest('cli: in an IDE it shows the conversation, and Reply here snaps without stopping it', async ({ desk, browser }) => {
  const cli = fakeCli(desk, { host: 'Code.exe', hostHwnd: 3003 });
  try {
    const p = await page(browser, desk); await sleep(3500);
    await p.click(`.item[data-sid="${cli.id}"]`); await sleep(2500);
    const tx = await p.$eval(`.pane[data-sid="${cli.id}"] .tx`, e => e.innerText).catch(() => '');
    assert(tx.includes('fix the login bug') && tx.includes('auth.js'), 'transcript not shown: ' + tx.slice(0, 200));
    await p.click(`.pane[data-sid="${cli.id}"] >> text=Reply here`);
    const l = await waitLayout(desk, l => docked(l, 3003));
    assert(docked(l, 3003), 'Reply here did not snap the window');
    assert(cli.alive(), 'Reply here stopped the original');
  } finally { cli.proc.kill(); }
});

fakeTest('cli: Move into desk ends the original and continues the same conversation', async ({ desk, browser }) => {
  const cli = fakeCli(desk, { host: 'Code.exe', hostHwnd: 3003 });
  try {
    const p = await page(browser, desk); await sleep(3500);
    await p.click(`.item[data-sid="${cli.id}"]`); await sleep(1000);
    await p.click(`.pane[data-sid="${cli.id}"] >> text=Move into desk`); await sleep(3000);
    assert(!cli.alive(), 'original still running');
    const s = (await desk.state()).state.sessions[0];
    assert(s && s.provider === 'claude' && s.resumeId === '11111111-2222-3333-4444-555555555555', 'not resumed in the desk: ' + JSON.stringify(s));
  } finally { cli.proc.kill(); }
});

// ---------- round 4: everyday use ----------
async function addShell(p) { await p.click('#btnNewMore'); await p.click('#menu .mi >> text=Terminal'); await sleep(900); }
const sessionIds = async desk => (await desk.state()).state.sessions.map(s => s.id);
async function sees(desk, id, text) {
  for (let i = 0; i < 40; i++) { if ((await desk.snapshot(id)).data.includes(text)) return true; await sleep(100); }
  return false;
}

test('keys: Ctrl+Alt+Enter inside a terminal expands, and again restores', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await addShell(p); await addShell(p);
  await p.keyboard.press('Control+Alt+Enter'); await sleep(400);
  assert(await p.locator('#layoutRoot .pane').count() === 1, 'did not expand');
  await p.keyboard.press('Control+Alt+Enter'); await sleep(400);
  assert(await p.locator('#layoutRoot .pane').count() === 2, 'did not restore');
});

test('keys: Ctrl+Alt+arrows move between panes and typing follows', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await addShell(p); await addShell(p);
  const [a, b] = await sessionIds(desk);
  await p.keyboard.press('Control+Alt+ArrowLeft'); await sleep(300);
  await p.keyboard.type('echo LEFT-$((1+1))\n');
  await p.keyboard.press('Control+Alt+ArrowRight'); await sleep(300);
  await p.keyboard.type('echo RIGHT-$((2+2))\n');
  assert(await sees(desk, a, 'LEFT-2'), 'left pane did not get its text');
  assert(await sees(desk, b, 'RIGHT-4'), 'right pane did not get its text');
  assert(!(await desk.snapshot(a)).data.includes('RIGHT-4'), 'text went to the wrong pane');
});

test('reload: layout, sizes, background and output all come back', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await addShell(p); await addShell(p);
  const [a] = await sessionIds(desk);
  await p.click(`.pane[data-sid="${a}"] .pane-body`); await p.keyboard.type('echo RELOAD-$((7*6))\n'); await sleep(400);
  const div = await p.locator('.divider').first().boundingBox();
  await p.mouse.move(div.x + div.width / 2, div.y + 50); await p.mouse.down(); await p.mouse.move(div.x - 250, div.y + 50, { steps: 8 }); await p.mouse.up();
  await p.click('.swatch[data-ground=ember]'); await sleep(600);
  const w1 = (await bodyRect(p, a)).w;
  await p.reload(); await p.waitForSelector('#sessionList'); await sleep(1500);
  const w2 = (await bodyRect(p, a)).w;
  assert(Math.abs(w1 - w2) < 3, `pane width changed after reload: ${w1} -> ${w2}`);
  assert(await p.evaluate(() => document.documentElement.dataset.ground) === 'ember', 'background not kept');
  const txt = await p.evaluate(sid => { const t = document.querySelector(`.pane[data-sid="${sid}"] .xterm-rows`); return t ? t.innerText : null; }, a);
  assert(txt === null || txt.includes('RELOAD-42'), 'output missing after reload');
  assert(!(await p.locator('.overlay').count()), 'a pane says it is not running after reload');
});

test('layout: a divider can not squash a pane below the minimum', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await addShell(p); await addShell(p);
  const div = await p.locator('.divider').first().boundingBox();
  await p.mouse.move(div.x + div.width / 2, div.y + 50); await p.mouse.down(); await p.mouse.move(5, div.y + 50, { steps: 10 }); await p.mouse.up();
  await sleep(300);
  const ws = await p.$$eval('.pane', els => els.map(e => Math.round(e.getBoundingClientRect().width)));
  assert(ws.every(w => w >= 299), 'pane squashed: ' + ws);
});

async function selectAndSend(p, desk, from, to, rows) {
  const box = await p.locator(`.pane[data-sid="${from}"] .xterm-screen`).boundingBox();
  const lh = await p.$eval(`.pane[data-sid="${from}"] .xterm-screen`, e => e.getBoundingClientRect().height) / 24;
  await p.mouse.move(box.x + 1, box.y + lh * rows[0] + lh / 2); await p.mouse.down();
  await p.mouse.move(box.x + box.width - 3, box.y + lh * rows[1] + lh / 2, { steps: 5 }); await p.mouse.up();
  await sleep(300);
  const btn = p.locator(`.pane[data-sid="${from}"] .send-btn:not(.hidden)`);
  if (!(await btn.count())) return false;
  await btn.click();
  await p.click(`#menu .mi >> text=${(await desk.state()).state.sessions.find(s => s.id === to).title}`);
  await sleep(1000);
  return true;
}
for (const multi of [false, true]) test(`send selection: ${multi ? 'several lines' : 'one line'} land as a draft and nothing runs`, async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await addShell(p); await addShell(p);
  const [a, b] = await sessionIds(desk);
  await p.click(`.pane[data-sid="${a}"] .pane-body`);
  // pane a shows two command-looking lines (as agent output often does)
  await p.keyboard.type("clear; printf 'echo RAN-$((5*5))\\necho RAN-$((6*6))\\n'\n"); await sleep(700);
  assert(await selectAndSend(p, desk, a, b, multi ? [0, 1] : [0, 0]), 'no "Send selection" button after selecting text');
  const plain = (await desk.snapshot(b)).data.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');
  assert(plain.includes('RAN-$((5'), 'selection never arrived: ' + JSON.stringify(plain.slice(-200)));
  assert(!/RAN-25|RAN-36/.test(plain), 'the shell RAN the sent text: it was supposed to wait for Enter');
});

for (const how of ['parked', 'no-bracketed-paste']) test(`send selection: into a ${how} shell nothing runs`, async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await addShell(p); await addShell(p);
  const [a, b] = await sessionIds(desk);
  await p.click(`.pane[data-sid="${b}"] .pane-body`);
  // like PowerShell or cmd: a shell that doesn't mark pasted text, so a newline in it means Enter
  if (how === 'no-bracketed-paste') { await p.keyboard.type("bind 'set enable-bracketed-paste off'\n"); await sleep(400); }
  await p.click(`.pane[data-sid="${a}"] .pane-body`);
  await p.keyboard.type("clear; printf 'echo RAN-$((5*5))\\necho RAN-$((6*6))\\n'\n"); await sleep(700);
  if (how === 'parked') { await p.click(`.pane[data-sid="${b}"] .icon-btn[title^="Park"]`); await sleep(300); }
  assert(await selectAndSend(p, desk, a, b, [0, 1]), 'no "Send selection" button');
  await sleep(500);
  const plain = (await desk.snapshot(b)).data.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');
  assert(plain.includes('RAN-$((5'), 'selection never arrived');
  assert(!/RAN-25|RAN-36/.test(plain), 'the shell RAN the sent text instead of waiting for Enter');
});

test('park all, then Arrange all brings everything back', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await addShell(p); await addShell(p); await addShell(p);
  await p.click('#btnParkAll'); await sleep(400);
  assert(!(await p.locator('#layoutRoot .pane').count()), 'Park all left panes');
  const st = await desk.state();
  assert(st.state.sessions.every(s => running(st.statuses[s.id])), 'Park all stopped something');
  await p.click('#btnTile'); await sleep(800);
  assert(await p.locator('#layoutRoot .pane').count() === 3, 'Arrange all did not bring all three back');
});

test('a session that exits offers to start again, and starting works', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await addShell(p);
  const [a] = await sessionIds(desk);
  await p.keyboard.type('exit\n'); await sleep(1000);
  const btn = p.locator(`.pane[data-sid="${a}"] .overlay button`).last();
  assert(await btn.count(), 'no way to start it again');
  await btn.click(); await sleep(1000);
  assert(running((await desk.state()).statuses[a]), 'did not start again');
  await p.keyboard.type('echo AGAIN-$((8+8))\n');
  assert(await sees(desk, a, 'AGAIN-16'), 'cannot type after starting again');
});

test('removing the pane you are typing in does not send keys anywhere else', async ({ desk, browser }) => {
  const p = await page(browser, desk);
  await addShell(p); await addShell(p);
  const [a, b] = await sessionIds(desk);
  await p.click(`.pane[data-sid="${b}"] .pane-body`);
  await p.click(`.pane[data-sid="${b}"] .icon-btn[title="More"]`); await p.click('#menu .mi >> text=Remove from desk'); await sleep(600);
  await p.keyboard.type('echo STRAY-$((3+4))\n'); await sleep(600);
  assert(!(await desk.snapshot(a)).data.includes('STRAY-7'), 'keys meant for the removed pane went into another session');
  assert(!p.errors.length, p.errors.join('; '));
});

test('projects: deleting one that has conversations is refused; moving works', async ({ desk, browser }) => {
  const st0 = await desk.state();
  await desk.put({ ...st0.state, projects: [...st0.state.projects, { id: 'p2', name: 'Website', cwd: os.homedir(), collapsed: false }] });
  const p = await page(browser, desk);
  await addShell(p);
  const [a] = await sessionIds(desk);
  await p.click(`.item[data-sid="${a}"]`, { button: 'right' }); await p.click('#menu .mi >> text=Website'); await sleep(500);
  assert((await desk.state()).state.sessions[0].projectId === 'p2', 'move to project did not stick');
  const head = p.locator('.project-head', { hasText: 'Website' });
  await head.locator('.icon-btn[title="Project options"]').click(); await p.click('#menu .mi >> text=Delete project'); await sleep(400);
  assert((await desk.state()).state.projects.some(x => x.id === 'p2'), 'a project with conversations was deleted');
});

fakeTest('snap: closing the desk window puts snapped windows back', async ({ desk, browser }) => {
  desk.setWindows(CHATGPT);
  const p = await page(browser, desk); await sleep(3500);
  await p.click('.item[data-sid="x-win-1001"]'); await waitLayout(desk, l => docked(l, 1001));
  const n = desk.helperLog().length;
  await p.close(); await sleep(1500);
  const after = desk.helperLog().slice(n);
  assert(after.some(c => c.cmd === 'release' || (c.cmd === 'layout' && !c.items.length)), 'windows left where the closed desk was: ' + after.map(c => c.cmd));
});

fakeTest('snap: on a zoomed screen (150%) the window still matches its pane', async ({ desk, browser }) => {
  desk.setWindows(CHATGPT);
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
  p.on('dialog', d => d.accept());
  await p.goto(desk.url); await p.waitForSelector('#sessionList'); await sleep(3500);
  await p.click('.item[data-sid="x-win-1001"]');
  const l = await waitLayout(desk, l => docked(l, 1001));
  const it = docked(l, 1001), r = await bodyRect(p, 'x-win-1001');
  assert(r.dpr === 1.5, 'zoom not applied');
  assert(Math.abs(it.w - r.w * 1.5) <= 1 && Math.abs(it.x - r.x * 1.5) <= 1, `scaled wrong: ${JSON.stringify(it)} vs ${JSON.stringify(r)}`);
});

// ---------- runner ----------
(async () => {
  const only = process.argv[2];
  const list = cases.filter(c => !only || c.name.includes(only));
  const browser = await chromium.launch();
  let failed = 0;
  for (const c of list) {
    const desk = await new Desk({ fake: c.fake }).start();
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
