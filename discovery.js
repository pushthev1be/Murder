// Finds agent sessions running OUTSIDE the desk: Claude Code CLI sessions (via ~/.claude/sessions)
// and desktop / browser chat windows (ChatGPT, Claude, Codex, Gemini...). Also drives window docking.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME;
const CC_SESSIONS = path.join(HOME, '.claude', 'sessions');
const CC_PROJECTS = path.join(HOME, '.claude', 'projects');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- window helper process ----------
// winhelper.cs is compiled with the C# compiler that ships with Windows (.NET Framework 4)
function ensureHelperBuilt() {
  const src = path.join(__dirname, 'winhelper.cs');
  const exe = path.join(__dirname, 'bin', 'winhelper.exe');
  const fresh = fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(src).mtimeMs;
  if (!fresh) {
    const fw = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    require('child_process').execFileSync(path.join(fw, 'csc.exe'),
      ['-nologo', '-optimize', '-platform:x64', '-target:exe', '-out:' + exe, '-r:System.Web.Extensions.dll', src], { stdio: 'pipe' });
  }
  return exe;
}
class Helper {
  constructor() { this.n = 0; this.pending = new Map(); this.start(); }
  start() {
    this.proc = spawn(ensureHelperBuilt(), [], { windowsHide: true });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { const m = JSON.parse(line); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m.r); } } catch {}
      }
    });
    this.proc.stderr.on('data', d => { const s = String(d).trim(); if (s) console.error('[winhelper]', s.slice(0, 300)); });
    this.proc.on('exit', () => {
      for (const p of this.pending.values()) p(null);
      this.pending.clear();
      if (!this.closing) setTimeout(() => this.start(), 1000);
    });
  }
  call(cmd, args = {}, timeout = 8000) {
    return new Promise(res => {
      const id = ++this.n;
      const t = setTimeout(() => { this.pending.delete(id); res(null); }, timeout);
      this.pending.set(id, r => { clearTimeout(t); res(r); });
      try { this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n'); } catch { res(null); }
    });
  }
  close() { this.closing = true; try { this.proc.stdin.end(); } catch {} }
}

// ---------- known chat apps ----------
const APPS = [
  { exe: /^chatgpt\.exe$/i, label: 'ChatGPT app', provider: 'chatgpt' },
  { exe: /^codex\.exe$/i, label: 'Codex app', provider: 'codex' },
  { exe: /^claude\.exe$/i, label: 'Claude app', provider: 'claude' },
];
const BROWSERS = /^(chrome|msedge|firefox|brave|opera|vivaldi|arc)\.exe$/i;
const BROWSER_NAMES = { 'chrome.exe': 'Chrome', 'msedge.exe': 'Edge', 'firefox.exe': 'Firefox', 'brave.exe': 'Brave', 'opera.exe': 'Opera', 'vivaldi.exe': 'Vivaldi', 'arc.exe': 'Arc' };
const CHAT_SITES = [
  { re: /chatgpt/i, label: 'ChatGPT', provider: 'chatgpt' },
  { re: /\bclaude\b/i, label: 'Claude', provider: 'claude' },
  { re: /gemini/i, label: 'Gemini', provider: 'web' },
  { re: /copilot/i, label: 'Copilot', provider: 'web' },
  { re: /perplexity/i, label: 'Perplexity', provider: 'web' },
  { re: /\bcodex\b/i, label: 'Codex', provider: 'codex' },
];
const TERMINAL_HOSTS = new Set(['windowsterminal.exe', 'conhost.exe', 'openconsole.exe', 'mintty.exe', 'wezterm-gui.exe', 'alacritty.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe']);
const HOSTS = { 'windowsterminal.exe': 'Windows Terminal', 'code.exe': 'VS Code', 'cursor.exe': 'Cursor', 'powershell.exe': 'PowerShell', 'pwsh.exe': 'PowerShell', 'cmd.exe': 'Command Prompt', 'conhost.exe': 'Console', 'openconsole.exe': 'Console', 'idea64.exe': 'IntelliJ', 'studio64.exe': 'Android Studio', 'mintty.exe': 'Git Bash', 'wezterm-gui.exe': 'WezTerm', 'alacritty.exe': 'Alacritty' };

// ---------- transcripts ----------
const transcriptPathCache = new Map();
function findTranscript(sessionId) {
  const c = transcriptPathCache.get(sessionId);
  if (c && fs.existsSync(c)) return c;
  try {
    for (const dir of fs.readdirSync(CC_PROJECTS)) {
      const f = path.join(CC_PROJECTS, dir, sessionId + '.jsonl');
      if (fs.existsSync(f)) { transcriptPathCache.set(sessionId, f); return f; }
    }
  } catch {}
  return null;
}
function readTail(file, bytes) {
  const st = fs.statSync(file);
  const len = Math.min(bytes, st.size);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  let s = buf.toString('utf8');
  if (len < st.size) s = s.slice(s.indexOf('\n') + 1);
  return { text: s, mtime: st.mtimeMs, size: st.size };
}
const titleCache = new Map(); // file -> { mtime, title }
function transcriptTitle(file) {
  try {
    const st = fs.statSync(file);
    const c = titleCache.get(file);
    if (c && c.mtime === st.mtimeMs) return c.title;
    let title = null, custom = null;
    const { text } = readTail(file, 400 * 1024);
    for (const line of text.split('\n')) {
      if (!line.includes('-title"')) continue;
      try { const o = JSON.parse(line); if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle; else if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle; } catch {}
    }
    title = custom || title;
    if (!title) { // fall back to the first real prompt
      const head = fs.readFileSync(file, 'utf8').slice(0, 200 * 1024);
      for (const line of head.split('\n')) {
        if (!line.startsWith('{"') || !line.includes('"type":"user"')) continue;
        try {
          const o = JSON.parse(line); const t = msgText(o.message?.content);
          if (t && !t.startsWith('<')) { title = t.slice(0, 60); break; }
        } catch {}
      }
    }
    titleCache.set(file, { mtime: st.mtimeMs, title });
    return title;
  } catch { return null; }
}
function msgText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  return '';
}
function briefInput(name, input = {}) {
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.prompt || '';
  return String(v).split('\n')[0].slice(0, 120);
}
const txCache = new Map(); // file -> { offset, items, partial, mtime }
function readRange(file, from, to) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(to - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  return buf.toString('utf8');
}
function transcript(sessionId, sinceMtime) {
  if (!UUID.test(sessionId)) return null;
  const file = findTranscript(sessionId);
  if (!file) return { items: [], mtime: 0 };
  const st = fs.statSync(file);
  if (sinceMtime && st.mtimeMs === Number(sinceMtime)) return { unchanged: true, mtime: st.mtimeMs };
  let c = txCache.get(file);
  if (!c || st.size < c.offset) { // first look (or the file was rewritten): start from the last 1.5 MB
    const start = Math.max(0, st.size - 1.5 * 1024 * 1024);
    let text = readRange(file, start, st.size);
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    c = { offset: st.size, items: [], partial: '' };
    c.partial = parseInto(c.items, text);
  } else if (st.size > c.offset) { // only the new bytes
    c.partial = parseInto(c.items, c.partial + readRange(file, c.offset, st.size));
    c.offset = st.size;
  }
  if (c.items.length > 300) c.items = c.items.slice(-200);
  c.mtime = st.mtimeMs;
  txCache.set(file, c);
  if (txCache.size > 30) txCache.delete(txCache.keys().next().value);
  return { items: c.items.slice(-120), mtime: st.mtimeMs };
}
// parses complete lines into items; returns the trailing partial line
function parseInto(items, text) {
  const lines = text.split('\n');
  const partial = lines.pop();
  for (const line of lines) {
    if (!line.startsWith('{"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type === 'user') {
      const c = o.message?.content;
      if (Array.isArray(c) && c.every(x => x.type === 'tool_result')) continue;
      const t = msgText(c);
      if (!t || o.isMeta || o.isCompactSummary || /^This session is being continued/.test(t)) continue;
      const clean = t.replace(/<(system-reminder|command-[\w-]+|local-command-[\w-]+|task-notification)>[\s\S]*?<\/\1>/g, '').trim();
      if (!clean || clean.startsWith('<')) continue;
      items.push({ role: 'user', text: clean.slice(0, 4000) });
    } else if (o.type === 'assistant') {
      for (const c of o.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) items.push({ role: 'assistant', text: c.text.trim().slice(0, 6000) });
        else if (c.type === 'tool_use') {
          const last = items[items.length - 1];
          const entry = `${c.name}${briefInput(c.name, c.input) ? ' · ' + briefInput(c.name, c.input) : ''}`;
          if (last && last.role === 'tool') { last.tools.push(entry); if (last.tools.length > 20) last.tools.splice(0, last.tools.length - 20); }
          else items.push({ role: 'tool', tools: [entry] });
        }
      }
    }
  }
  return partial;
}

// ---------- discovery loop ----------
class Discovery {
  constructor({ ownPids, onChange }) {
    this.ownPids = ownPids;      // () => Set of pids of the desk's own ptys
    this.onChange = onChange;
    this.helper = new Helper();
    this.items = [];
    this.hwndById = new Map();
    this.seenAt = new Map();     // id -> statusUpdatedAt the user has seen
    this.deskSessions = new Map(); // desk pty pid -> claude sessionId running inside it
    this.interval = 3000;
    this.timer = setInterval(() => this.poll(), this.interval);
    setTimeout(() => this.poll(), 300);
  }
  async poll() {
    if (this.busy) return; this.busy = true;
    try {
      const r = await this.helper.call('list', {}, 20000);
      if (!r || !r.windows) return;
      const procs = new Map(r.procs.map(([pid, ppid, exe]) => [pid, { ppid, exe: exe.toLowerCase() }]));
      const winByPid = new Map();
      for (const w of r.windows) if (!winByPid.has(w.pid)) winByPid.set(w.pid, w);
      const own = this.ownPids();
      const ancestors = pid => { const out = []; let p = procs.get(pid)?.ppid, n = 0; while (p && n++ < 20) { out.push(p); p = procs.get(p)?.ppid; } return out; };
      const items = [];
      const deskSessions = new Map();

      // Claude Code CLI sessions
      let files = [];
      try { files = fs.readdirSync(CC_SESSIONS).filter(f => /^\d+\.json$/.test(f)); } catch {}
      for (const f of files) {
        let reg; try { reg = JSON.parse(fs.readFileSync(path.join(CC_SESSIONS, f), 'utf8')); } catch { continue; }
        const pr = procs.get(reg.pid);
        if (!pr || !/claude|node/.test(pr.exe) || !UUID.test(reg.sessionId || '')) continue;
        const anc = ancestors(reg.pid);
        const ownPty = anc.find(p => own.has(p));
        if (ownPty) { deskSessions.set(ownPty, reg.sessionId); continue; } // already inside the desk
        let host = null;
        for (const a of anc) { const ex = procs.get(a)?.exe; if (ex === 'explorer.exe' || ex === 'services.exe') break; const w = winByPid.get(a); if (w) { host = { ...w, exe: ex }; break; } }
        const id = 'x-cc-' + reg.sessionId;
        const tfile = findTranscript(reg.sessionId);
        const title = (tfile && transcriptTitle(tfile)) || path.basename(reg.cwd || '') || 'Claude Code';
        let status = reg.status === 'busy' ? 'working' : 'idle';
        if (!this.seenAt.has(id)) this.seenAt.set(id, reg.statusUpdatedAt || 0);
        if (status === 'idle' && (reg.statusUpdatedAt || 0) > this.seenAt.get(id)) status = 'waiting';
        if (reg.status === 'waiting' || reg.status === 'needs_input' || reg.status === 'blocked') status = 'waiting';
        items.push({
          id, kind: 'cli', provider: 'claude', title, cwd: reg.cwd, sessionId: reg.sessionId, pid: reg.pid,
          status, hwnd: host?.hwnd || null, hostTerminal: !!(host && TERMINAL_HOSTS.has(host.exe)),
          where: host ? (HOSTS[host.exe] || host.exe.replace(/\.exe$/, '')) : (reg.entrypoint && reg.entrypoint !== 'cli' ? reg.entrypoint : 'a terminal'),
          statusAt: reg.statusUpdatedAt || 0,
        });
      }

      // chat app + browser windows
      for (const w of r.windows) {
        const exe = procs.get(w.pid)?.exe || '';
        if (/session desk$/i.test(w.title)) continue;
        const app = APPS.find(a => a.exe.test(exe));
        if (app) {
          items.push({ id: `x-win-${w.hwnd}`, kind: 'app', provider: app.provider, title: w.title || app.label, where: app.label, hwnd: w.hwnd, pid: w.pid, status: 'appwin', min: w.min });
          continue;
        }
        if (BROWSERS.test(exe)) {
          const tabTitle = w.title.replace(/\s+[-–—]\s+(Google Chrome|Microsoft\W*Edge|Mozilla Firefox|Brave|Opera|Vivaldi).*$/i, '').trim();
          const site = CHAT_SITES.find(s => new RegExp('(^|\\s[-–—|]\\s)' + s.label + '$', 'i').test(tabTitle));
          if (site) {
            items.push({ id: `x-win-${w.hwnd}`, kind: 'app', provider: site.provider, title: tabTitle, where: `${site.label} · ${BROWSER_NAMES[exe] || 'browser'}`, hwnd: w.hwnd, pid: w.pid, status: 'appwin', min: w.min, browser: true });
          }
        }
      }
      this.hwndById = new Map(items.filter(i => i.hwnd).map(i => [i.id, i.hwnd]));
      this.deskSessions = deskSessions;
      const sig = JSON.stringify(items.map(i => [i.id, i.title, i.status, i.where, i.hwnd]));
      this.items = items;
      if (sig !== this.sig) { this.sig = sig; this.onChange(items); }
    } catch (e) { console.error('[discovery]', e.message); }
    finally { this.busy = false; }
  }
  // 3 s while a desk window is visible, 15 s otherwise
  setActive(on) {
    const want = on ? 3000 : 15000;
    if (want === this.interval) return;
    this.interval = want;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), want);
    if (on) this.poll();
  }
  seen(id) {
    const it = this.items.find(i => i.id === id);
    if (it && it.kind === 'cli') { this.seenAt.set(id, Math.max(Date.now(), it.statusAt)); if (it.status === 'waiting') { it.status = 'idle'; this.sig = null; this.onChange(this.items); } }
  }
  focus(id) { const h = this.hwndById.get(id); if (h) this.helper.call('focus', { hwnd: h }); }
  dock({ items = [], park = [], dpr = 1, hidden = false, marker = '' }) {
    const out = [];
    for (const it of items) {
      const h = this.hwndById.get(it.id);
      if (!h || out.some(o => o.hwnd === h)) continue; // one window can only be docked once
      out.push({ hwnd: h, x: Math.round(it.x * dpr), y: Math.round(it.y * dpr), w: Math.round(it.w * dpr), h: Math.round(it.h * dpr) });
    }
    const parkH = park.map(id => this.hwndById.get(id)).filter(Boolean).filter(h => !out.some(o => o.hwnd === h));
    this.lastDock = { items, dpr, out };
    return this.helper.call('layout', { items: out, park: parkH, hidden: !!hidden, marker: String(marker).slice(0, 40) }).then(r => {
      if (r && Array.isArray(r.mins)) { // [hwnd, minW, minH] in screen pixels -> { id: [w, h] } in page pixels
        const byHwnd = new Map([...this.hwndById].map(([id, h]) => [h, id]));
        r.minsById = {};
        for (const [h, w, ht] of r.mins) { const id = byHwnd.get(h); if (id) r.minsById[id] = [Math.ceil(w / dpr), Math.ceil(ht / dpr)]; }
      }
      return r;
    });
  }
  release() { return this.helper.call('release'); }
  close() { clearInterval(this.timer); this.helper.close(); }
}

module.exports = { Discovery, transcript, UUID };
