// Session Desk — local server. Runs real terminal sessions (Claude Code, Codex, shells)
// in pseudo-terminals and serves the desk UI on 127.0.0.1 only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, exec } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');
const { Discovery, transcript, UUID } = require('./discovery');

const PORT = Number(process.env.DESK_PORT || 47821);
const ROOT = __dirname;
const DATA = process.env.DESK_DATA || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const TOKEN_FILE = path.join(DATA, 'token.txt');
const SCROLLBACK_LIMIT = 512 * 1024; // chars of raw output kept per session for re-attach
const HOME = process.env.USERPROFILE || process.env.HOME;

fs.mkdirSync(DATA, { recursive: true });

// ---------- token (keeps other local web pages from driving your terminals) ----------
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!TOKEN || TOKEN.length < 32) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN);
}
const ORIGIN = `http://127.0.0.1:${PORT}`;
const APP_URL = `${ORIGIN}/?k=${TOKEN}`;

// ---------- persisted desk state ----------
const DEFAULT_STATE = {
  projects: [{ id: 'p-general', name: 'General', cwd: HOME, collapsed: false }],
  sessions: [],
  layout: null,       // split tree of on-screen panes
  maximized: null,    // session id or null
  drafts: {},         // session id -> notes text for web sessions
};
function loadState() {
  try { return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  catch { return structuredClone(DEFAULT_STATE); }
}
let state = loadState();
function saveState() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- providers ----------
const PROVIDERS = {
  claude: { label: 'Claude Code', cmd: 'claude', resume: 'claude --continue' },
  codex:  { label: 'Codex',       cmd: 'codex',  resume: 'codex resume --last' },
  shell:  { label: 'Terminal',    cmd: '' },
  custom: { label: 'Command',     cmd: '' },
  web:    { label: 'Web chat' },
};

// ---------- live terminals ----------
const live = new Map(); // id -> { proc, buf, lastOut, lastIn, outAfterIn, bell, status }

const CLAUDE_EXE = [
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  path.join(HOME, '.local', 'bin', 'claude.exe'),
].find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });

function shellArgs(command) {
  const args = ['-NoLogo'];
  if (command) args.push('-NoExit', '-Command', command);
  return args;
}

function startSession(id, { resume = false, cols = 100, rows = 30 } = {}) {
  const s = state.sessions.find(x => x.id === id);
  if (!s || s.provider === 'web') return;
  stopSession(id);
  const p = PROVIDERS[s.provider] || PROVIDERS.custom;
  let command = s.command || p.cmd || '';
  if (resume && p.resume && !s.command) command = p.resume;
  const rid = s.ccSessionId || s.resumeId;
  if (resume && s.provider === 'claude' && !s.command && UUID.test(rid || '')) command = `claude --resume ${rid}`;
  let cwd = s.cwd || projectCwd(s.projectId) || HOME;
  if (!fs.existsSync(cwd)) cwd = HOME;
  let file = 'powershell.exe', args = shellArgs(command);
  if (s.provider === 'claude' && !s.command && CLAUDE_EXE) {
    file = CLAUDE_EXE;
    args = command === 'claude' ? [] : command.replace(/^claude\s+/, '').split(/\s+/).filter(Boolean);
  }
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color', cols, rows, cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  // scrollback kept as a list of chunks: appending is cheap, trimming happens rarely
  const entry = { proc, chunks: [], size: 0, lastOut: 0, lastIn: 0, outAfterIn: 0, bell: false, status: 'working', startedAt: Date.now() };
  live.set(id, entry);
  s.hasRun = true;
  saveState();
  proc.onData(data => {
    entry.chunks.push(data); entry.size += data.length;
    if (entry.size > SCROLLBACK_LIMIT * 1.5) { // trim to the limit in one go
      const all = entry.chunks.join('').slice(-SCROLLBACK_LIMIT);
      entry.chunks = [all]; entry.size = all.length;
    }
    const now = Date.now();
    entry.lastOut = now;
    if (now - entry.lastIn > 400 && now - (entry.lastResize || 0) > 1200) entry.outAfterIn += data.length; // ignore keystroke echo + resize redraws
    if (data.includes('\x07') && !/\x1b\][^\x07]*\x07/.test(data)) entry.bell = true;
    broadcast({ t: 'data', id, data });
  });
  proc.onExit(({ exitCode }) => {
    if (live.get(id) !== entry) return;
    live.delete(id);
    broadcast({ t: 'exit', id, exitCode });
    broadcastStatus(id, 'stopped');
  });
  broadcastStatus(id, 'working');
}

function stopSession(id) {
  const e = live.get(id);
  if (!e) return;
  live.delete(id);
  try { e.proc.kill(); } catch {}
  broadcastStatus(id, 'stopped');
}

function projectCwd(pid) {
  const p = state.projects.find(x => x.id === pid);
  return p && p.cwd;
}

// working  = producing output right now
// waiting  = it said something after your last keystroke and went quiet (likely wants you)
// idle     = quiet, nothing new since you last typed
// ---------- sessions running outside the desk ----------
// DESK_DEMO=1: no discovery of real sessions (for screenshots and demos)
const discovery = process.env.DESK_DEMO ? {
  items: [], deskSessions: new Map(), helper: { call: async () => ({}) },
  focus() {}, seen() {}, dock: async () => ({}), release: async () => ({}), setActive() {}, poll() {}, close() {},
} : new Discovery({
  ownPids: () => new Set([...live.values()].map(e => e.proc.pid)),
  onChange: items => {
    broadcast({ t: 'discovered', items });
    const map = {};
    for (const [id, e] of live) { const cc = discovery.deskSessions.get(e.proc.pid); if (cc) map[id] = cc; }
    broadcast({ t: 'ccmap', map });
  },
});

function computeStatus(e) {
  const now = Date.now();
  if (now - e.lastOut < 1500 && now - e.startedAt > 0) return 'working';
  if (e.bell || e.outAfterIn > 200) return 'waiting';
  return 'idle';
}
setInterval(() => {
  for (const [id, e] of live) {
    const st = computeStatus(e);
    if (st !== e.status) { e.status = st; broadcastStatus(id, st); }
  }
}, 700);

// ---------- websocket ----------
const clients = new Set();
// changes whenever the page files change, so open desk windows reload themselves after an update
const BUILD = ['public/app.js', 'public/style.css', 'public/index.html'].map(f => { try { return fs.statSync(path.join(ROOT, f)).mtimeMs; } catch { return 0; } }).join('-');
let dockOwner = null;
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}
function broadcastStatus(id, status) { broadcast({ t: 'status', id, status }); }
function statusMap() {
  const m = {};
  for (const s of state.sessions) {
    const e = live.get(s.id);
    m[s.id] = s.provider === 'web' ? 'link' : e ? e.status : 'stopped';
  }
  return m;
}

function handleMsg(ws, m) {
  const e = m.id && live.get(m.id);
  switch (m.t) {
    case 'attach':
      ws.send(JSON.stringify({ t: 'snapshot', id: m.id, data: e ? e.chunks.join('').slice(-SCROLLBACK_LIMIT) : '', alive: !!e }));
      break;
    case 'input':
      if (e && typeof m.data === 'string') {
        e.proc.write(m.data);
        e.lastIn = Date.now(); e.outAfterIn = 0; e.bell = false;
      }
      break;
    case 'resize':
      if (e && m.cols > 1 && m.rows > 1) { e.lastResize = Date.now(); try { e.proc.resize(Math.floor(m.cols), Math.floor(m.rows)); } catch {} }
      break;
    case 'seen': // user looked at the pane: clear "waiting"
      if (e) { e.outAfterIn = 0; e.bell = false; }
      break;
    case 'start':
      startSession(m.id, { resume: !!m.resume, cols: m.cols, rows: m.rows });
      break;
    case 'stop':
      stopSession(m.id);
      break;
    case 'visible': ws.visible = !!m.on; discovery.setActive([...clients].some(c => c.visible !== false)); break;
    case 'ext-focus': discovery.focus(m.id); break;
    case 'ext-seen': discovery.seen(m.id); break;
    case 'ext-dock': // only the desk window you used last arranges embedded windows
      ws.visible = m.visible !== false;
      // the desk window in charge: a focused one always takes over; a visible one beats a hidden/minimized one
      if (!dockOwner || dockOwner.readyState !== 1 || m.focused || (dockOwner.visible === false && ws.visible)) dockOwner = ws;
      if (ws === dockOwner) discovery.dock(m).then(r => {
        if (r && r.error) {
          // usually the desk window's title (which carries its marker) hasn't updated yet: try again shortly
          ws.dockRetries = (ws.dockRetries || 0) + 1;
          if (ws.dockRetries <= 8 && ws.readyState === 1) setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'redock' })), 600);
          else console.log('[dock]', r.error);
        } else {
          ws.dockRetries = 0;
          if (r && r.minsById && Object.keys(r.minsById).length) ws.send(JSON.stringify({ t: 'mins', mins: r.minsById }));
        }
      });
      else console.log('[dock] ignored a layout from a desk window that is not in charge');
      break;
    case 'claim': // this desk window got focus: it now owns the embedded windows
      if (dockOwner !== ws) { dockOwner = ws; ws.send(JSON.stringify({ t: 'redock' })); }
      break;
    case 'ext-close': { // "continue here": end the outside Claude Code process so the desk can resume it
      const it = discovery.items.find(i => i.id === m.id && i.kind === 'cli');
      if (it) { try { process.kill(it.pid); } catch {} setTimeout(() => discovery.poll(), 800); }
      break;
    }
  }
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const STATIC = {
  '/': 'public/index.html',
  '/app.js': 'public/app.js',
  '/style.css': 'public/style.css',
  '/icon.svg': 'public/icon.svg',
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
  '/vendor/addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
};

function authed(req) {
  if (req.headers['x-desk-token'] === TOKEN && !req.headers.origin) return true; // local scripts (stop.cmd)
  const c = /(?:^|;\s*)desk=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return c && c[1] === TOKEN;
}
function sameOrigin(req) {
  const o = req.headers.origin;
  return !o || o === ORIGIN;
}

function readBody(req, limit = 5e6) {
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > limit) { rej(new Error('too big')); req.destroy(); } });
    req.on('end', () => res(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (req.headers.host !== `127.0.0.1:${PORT}`) { res.writeHead(403); return res.end(); }

  if (url.pathname === '/' && url.searchParams.get('k') === TOKEN) {
    res.writeHead(302, { 'Set-Cookie': `desk=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
    return res.end();
  }
  if (!authed(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    return res.end('Open Session Desk with start.cmd (or the link the server printed).');
  }

  if (url.pathname === '/api/state') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ state, statuses: statusMap(), providers: PROVIDERS, home: HOME, discovered: discovery.items }));
    }
    if (req.method === 'PUT' && sameOrigin(req)) {
      try {
        const next = JSON.parse(await readBody(req));
        if (!Array.isArray(next.projects) || !Array.isArray(next.sessions)) throw new Error('bad state');
        const removed = state.sessions.filter(s => !next.sessions.some(n => n.id === s.id));
        state = { ...DEFAULT_STATE, ...next };
        removed.forEach(s => stopSession(s.id));
        saveState();
        broadcast({ t: 'state', state, from: url.searchParams.get('client') });
        res.writeHead(204); return res.end();
      } catch (err) { res.writeHead(400); return res.end(String(err.message)); }
    }
  }
  if (url.pathname === '/api/open' && req.method === 'POST' && sameOrigin(req)) {
    // open a web chat in its own app window
    try {
      const { url: target } = JSON.parse(await readBody(req));
      const u = new URL(target);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad url');
      openAppWindow(u.href, false);
      res.writeHead(204); return res.end();
    } catch { res.writeHead(400); return res.end(); }
  }
  if (url.pathname === '/api/shutdown' && req.method === 'POST' && !req.headers.origin) { // stop.cmd: hand windows back, then exit
    res.writeHead(204); res.end();
    Promise.race([discovery.release(), new Promise(r => setTimeout(r, 2000))]).then(() => process.exit(0));
    return;
  }
  if (url.pathname === '/api/release' && req.method === 'POST' && sameOrigin(req)) { // desk window closing
    discovery.release();
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/debug-dock' && req.method === 'GET') {
    const r = await discovery.helper.call('debug');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ helper: r, lastDock: discovery.lastDock || null }));
  }
  if (url.pathname === '/api/transcript' && req.method === 'GET') {
    const r = transcript(url.searchParams.get('sid') || '', url.searchParams.get('since'));
    res.writeHead(r ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r || {}));
  }
  if (url.pathname === '/api/pickdir' && req.method === 'POST' && sameOrigin(req)) {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowNewFolderButton=$true; if($f.ShowDialog() -eq 'OK'){ $f.SelectedPath }`;
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true }, (err, out) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: (out || '').trim() || null }));
    });
    return;
  }

  const file = STATIC[url.pathname];
  if (file && req.method === 'GET') {
    fs.readFile(path.join(ROOT, file), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (!authed(req) || req.headers.origin !== ORIGIN) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, ws => {
    clients.add(ws);
    ws.send(JSON.stringify({ t: 'hello', build: BUILD }));
    ws.send(JSON.stringify({ t: 'discovered', items: discovery.items }));
    discovery.setActive(true);
    ws.on('message', raw => { try { handleMsg(ws, JSON.parse(raw)); } catch {} });
    ws.on('close', () => {
      clients.delete(ws);
      if (dockOwner === ws) { dockOwner = [...clients].pop() || null; if (dockOwner) dockOwner.send(JSON.stringify({ t: 'redock' })); }
      if (!clients.size) discovery.release();
      discovery.setActive([...clients].some(c => c.visible !== false));
    });
  });
});

// ---------- app window ----------
function findBrowser() {
  const cands = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  return cands.find(p => p && fs.existsSync(p));
}
function openAppWindow(target, desk = true) {
  const b = findBrowser();
  if (b) {
    // via `start`, so the window opens visible even when the desk itself runs hidden in the background
    const args = ['/c', 'start', '""', b, `--app=${target}`];
    if (desk) args.push('--window-size=1500,920');
    execFile('cmd.exe', args, { windowsHide: true, windowsVerbatimArguments: false }, () => {});
  } else {
    exec(`start "" "${target}"`);
  }
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') { // already running: just open another window onto it
    console.log('Session Desk is already running — opening a window.');
    openAppWindow(APP_URL);
    setTimeout(() => process.exit(0), 500);
  } else throw err;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Session Desk running at ${APP_URL}`);
  console.log('Closing the window does NOT stop your sessions. Close this console to stop everything.');
  // open a window only if no desk window already open reconnects (avoids piling up windows on restart)
  if (!process.argv.includes('--no-open')) setTimeout(() => { if (!clients.size) openAppWindow(APP_URL); }, 4000);
});

process.on('exit', () => { discovery.close(); for (const e of live.values()) try { e.proc.kill(); } catch {} });
process.on('SIGINT', () => process.exit(0));
