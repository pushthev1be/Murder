// Session Desk window helper (compiled automatically by server.js with the csc.exe that ships with Windows).
// Protocol: one JSON command per line on stdin, one JSON reply per line on stdout.
//   list                      -> { windows:[{hwnd,pid,title,min,embedded}], procs:[[pid,ppid,exe]] }
//   focus  {hwnd}             -> bring a window to the keyboard
//   layout {items:[{hwnd,x,y,w,h}], park:[hwnd], hidden, marker}
//          SNAPS each window over its pane: the window stays a normal top-level window of its own
//          program (so the desk can never close it, and typing works as usual), and the helper keeps
//          it sized to the pane, moving, minimizing and rising with the desk window. If the app moves,
//          resizes, maximizes or minimizes the window itself (or you drag it), it's put back in its pane.
//   release                   -> put every snapped window back where it was
// If stdin closes or the desk window disappears, every window is put back.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PE32 { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr v);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr s, ref PE32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr s, ref PE32 e);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}

class Snapped {
  public W.RECT Orig; public bool WasMin, WasMax; public int X, Y, Wd, Ht, MinW, MinH; public string Applied = "";
  public W.RECT Got; public bool HaveGot, Moving; // where the window really ended up last time we placed it
  public int FixStart, Fixes;                     // to stop fighting an app that keeps resizing itself
}

static class Program {
  static readonly object gate = new object();
  static readonly Dictionary<long, Snapped> snapped = new Dictionary<long, Snapped>();
  static IntPtr desk = IntPtr.Zero;
  static string marker = "";
  static bool hidden = false, deskMin = false;
  static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
  static W.WinEventProc hookProc; // kept alive for the hooks
  static Timer fixTimer;          // puts windows back shortly after an app moved one of them
  const uint NOSIZE = 0x1, NOMOVE = 0x2, NOZORDER = 0x4, NOACTIVATE = 0x10, SHOWWINDOW = 0x40, NOOWNERZORDER = 0x200;

  static bool Same(W.RECT a, W.RECT b) { return a.L == b.L && a.T == b.T && a.R == b.R && a.B == b.B; }

  static string Title(IntPtr h) {
    int len = W.GetWindowTextLength(h); if (len == 0) return "";
    var t = new StringBuilder(len + 1); W.GetWindowText(h, t, len + 1); return t.ToString();
  }

  static object List() {
    var wins = new List<object>();
    W.EnumWindows((h, l) => {
      if (!W.IsWindowVisible(h) || W.GetWindow(h, 4) != IntPtr.Zero) return true;
      int cloaked; if (W.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      string t = Title(h); if (t.Length == 0) return true;
      uint pid; W.GetWindowThreadProcessId(h, out pid);
      bool emb; lock (gate) emb = snapped.ContainsKey(h.ToInt64());
      wins.Add(new Dictionary<string, object> { { "hwnd", h.ToInt64() }, { "pid", pid }, { "title", t }, { "min", W.IsIconic(h) }, { "embedded", emb } });
      return true;
    }, IntPtr.Zero);
    var procs = new List<object>();
    IntPtr snap = W.CreateToolhelp32Snapshot(2, 0);
    var e = new W.PE32(); e.dwSize = (uint)Marshal.SizeOf(typeof(W.PE32));
    if (W.Process32FirstW(snap, ref e)) do { procs.Add(new object[] { e.th32ProcessID, e.th32ParentProcessID, e.szExeFile }); } while (W.Process32NextW(snap, ref e));
    W.CloseHandle(snap);
    return new Dictionary<string, object> { { "windows", wins }, { "procs", procs } };
  }

  static IntPtr FindDesk(string m) {
    IntPtr found = IntPtr.Zero, only = IntPtr.Zero; int desks = 0;
    W.EnumWindows((h, l) => {
      if (!W.IsWindowVisible(h)) return true;
      string t = Title(h);
      if (t.Contains(m)) { found = h; return false; }
      if (t.Contains("Session Desk")) {
        var c = new StringBuilder(64); W.GetClassName(h, c, 64);
        if (c.ToString() == "Chrome_WidgetWin_1") { desks++; only = h; }
      }
      return true;
    }, IntPtr.Zero);
    // the browser can drop the invisible marker from the title: with a single desk window open, use it
    return found != IntPtr.Zero ? found : desks == 1 ? only : IntPtr.Zero;
  }

  // screen position of the web page's top-left corner inside the desk window
  static W.POINT ViewportOnScreen() {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    W.EnumChildWindows(desk, (h, l) => {
      var c = new StringBuilder(64); W.GetClassName(h, c, 64);
      if (c.ToString() == "Chrome_RenderWidgetHostHWND" && W.IsWindowVisible(h)) {
        W.RECT r; W.GetWindowRect(h, out r); long a = (long)(r.R - r.L) * (r.B - r.T);
        if (a > bestArea) { bestArea = a; best = h; }
      }
      return true;
    }, IntPtr.Zero);
    var p = new W.POINT();
    if (best != IntPtr.Zero) { W.RECT r; W.GetWindowRect(best, out r); p.X = r.L; p.Y = r.T; }
    else W.ClientToScreen(desk, ref p);
    return p;
  }

  // invisible resize borders: GetWindowRect vs. the frame you actually see
  static W.RECT Borders(IntPtr h) {
    W.RECT w, f, d = new W.RECT();
    if (W.GetWindowRect(h, out w) && W.DwmGetWindowAttribute(h, 9, out f, Marshal.SizeOf(typeof(W.RECT))) == 0) {
      d.L = f.L - w.L; d.T = f.T - w.T; d.R = w.R - f.R; d.B = w.B - f.B;
    }
    return d;
  }

  // Windows embedded by an older version of this helper are children of the desk: give them back first.
  static void Unparent(IntPtr h) {
    if (W.GetParent(h) == IntPtr.Zero) return;
    long style = W.GetWindowLongPtr(h, -16).ToInt64();
    W.SetParent(h, IntPtr.Zero);
    W.SetWindowLongPtr(h, -16, new IntPtr((style & ~0x40000000L) | 0x00CF0000L)); // drop WS_CHILD, restore a normal frame
    W.SetWindowPos(h, IntPtr.Zero, 100, 100, 1100, 750, 0x20 | SHOWWINDOW | NOZORDER);
  }

  static void Snap(long k) {
    var h = new IntPtr(k);
    Unparent(h);
    var s = new Snapped { WasMin = W.IsIconic(h), WasMax = W.IsZoomed(h) };
    if (s.WasMin || s.WasMax) W.ShowWindow(h, 4); // SW_SHOWNOACTIVATE: restores
    W.GetWindowRect(h, out s.Orig);
    snapped[k] = s;
  }

  static void Release(long k, bool minimize) {
    Snapped s; if (!snapped.TryGetValue(k, out s)) return;
    snapped.Remove(k);
    var h = new IntPtr(k);
    if (!W.IsWindow(h)) return;
    W.SetWindowPos(h, IntPtr.Zero, s.Orig.L, s.Orig.T, s.Orig.R - s.Orig.L, s.Orig.B - s.Orig.T, NOZORDER | NOACTIVATE);
    if (minimize || s.WasMin) W.ShowWindow(h, 7);      // SW_SHOWMINNOACTIVE
    else if (s.WasMax) W.ShowWindow(h, 3);
  }
  static void ReleaseAll() { lock (gate) foreach (var k in new List<long>(snapped.Keys)) Release(k, false); }

  // put every snapped window over its pane; raise=true lifts them above the desk
  static void PlaceAll(bool raise) {
    if (snapped.Count == 0 || !W.IsWindow(desk)) return;
    if (W.IsIconic(desk)) {
      if (!deskMin) { deskMin = true; foreach (var k in snapped.Keys) W.ShowWindow(new IntPtr(k), 7); }
      return;
    }
    if (deskMin) { deskMin = false; raise = true; foreach (var k in snapped.Keys) W.ShowWindow(new IntPtr(k), 4); }
    var o = ViewportOnScreen();
    foreach (var k in new List<long>(snapped.Keys)) {
      var h = new IntPtr(k);
      if (!W.IsWindow(h)) { snapped.Remove(k); continue; }
      var s = snapped[k];
      if (hidden) { // tuck it right behind the desk (still a normal window, never hidden)
        W.SetWindowPos(h, desk, 0, 0, 0, 0, NOMOVE | NOSIZE | NOACTIVATE | NOOWNERZORDER);
        s.Applied = "behind"; s.HaveGot = false; continue;
      }
      if (s.Moving) continue; // you're dragging it: put it back when you let go
      if (W.IsIconic(h) || W.IsZoomed(h)) { W.ShowWindow(h, 4); s.Applied = ""; }
      var b = Borders(h);
      int x = o.X + s.X - b.L, y = o.Y + s.Y - b.T, w = s.Wd + b.L + b.R, ht = s.Ht + b.T + b.B;
      string want = x + "," + y + "," + w + "," + ht;
      // compare with where the window really is, not only with what we last asked for: apps like
      // ChatGPT move or resize themselves, and then the window would float over the desk, outside its pane
      W.RECT now; W.GetWindowRect(h, out now);
      if (want != s.Applied || !s.HaveGot || !Same(now, s.Got)) {
        W.SetWindowPos(h, IntPtr.Zero, x, y, w, ht, NOZORDER | NOACTIVATE); s.Applied = want;
        W.RECT got; W.GetWindowRect(h, out got);
        s.Got = got; s.HaveGot = true;
        Measure(s, got, b);
      }
      if (raise) W.SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, NOMOVE | NOSIZE | NOACTIVATE | NOOWNERZORDER);
    }
  }

  // some apps (ChatGPT, Claude...) have a minimum size and stay bigger than asked: remember it
  static void Measure(Snapped s, W.RECT got, W.RECT b) {
    int gw = got.R - got.L - b.L - b.R, gh = got.B - got.T - b.T - b.B;
    if (gw > s.Wd + 2) s.MinW = Math.Max(s.MinW, gw);
    if (gh > s.Ht + 2) s.MinH = Math.Max(s.MinH, gh);
  }

  // a snapped window moved or resized on its own: put it back, unless the app keeps insisting
  // (then accept its size, so we never end up flickering against it)
  static void FixSnapped() {
    lock (gate) {
      try {
        if (snapped.Count == 0 || !W.IsWindow(desk) || hidden) return;
        int now = Environment.TickCount;
        foreach (var kv in snapped) {
          var s = kv.Value; var h = new IntPtr(kv.Key);
          if (!s.HaveGot || s.Moving || !W.IsWindow(h)) continue;
          W.RECT r; W.GetWindowRect(h, out r);
          if (Same(r, s.Got) && !W.IsIconic(h) && !W.IsZoomed(h)) continue;
          if (now - s.FixStart > 3000) { s.FixStart = now; s.Fixes = 0; }
          if (++s.Fixes > 6 && !W.IsIconic(h) && !W.IsZoomed(h)) { // it keeps changing itself: leave it be until the next layout
            s.Got = r; Measure(s, r, Borders(h));
            continue;
          }
          s.HaveGot = false;
        }
        PlaceAll(false);
      } catch { }
    }
  }

  static void Focus(long k) {
    var h = new IntPtr(k);
    if (W.IsIconic(h)) W.ShowWindow(h, 9);
    W.keybd_event(0x12, 0, 0, UIntPtr.Zero); W.keybd_event(0x12, 0, 2, UIntPtr.Zero); // lets us hand over the foreground
    W.SetForegroundWindow(h);
  }

  static long L(object o) { return Convert.ToInt64(o); }

  static object Handle(Dictionary<string, object> m) {
    switch (m["cmd"] as string) {
      case "list": return List();
      case "focus": Focus(L(m["hwnd"])); return true;
      case "release": ReleaseAll(); return true;
      case "debug": lock (gate) {
        var o = W.IsWindow(desk) ? ViewportOnScreen() : new W.POINT();
        W.RECT dr; W.GetWindowRect(desk, out dr);
        var list = new List<object>();
        foreach (var kv in snapped) { W.RECT r; W.GetWindowRect(new IntPtr(kv.Key), out r); var b = Borders(new IntPtr(kv.Key));
          list.Add(new Dictionary<string, object> { { "hwnd", kv.Key }, { "pane", new[] { kv.Value.X, kv.Value.Y, kv.Value.Wd, kv.Value.Ht } }, { "applied", kv.Value.Applied }, { "now", new[] { r.L, r.T, r.R - r.L, r.B - r.T } }, { "borders", new[] { b.L, b.T, b.R, b.B } } }); }
        return new Dictionary<string, object> { { "desk", desk.ToInt64() }, { "deskRect", new[] { dr.L, dr.T, dr.R - dr.L, dr.B - dr.T } }, { "viewport", new[] { o.X, o.Y } }, { "hidden", hidden }, { "snapped", list } };
      }
      case "layout": lock (gate) {
        string mk = m.ContainsKey("marker") ? m["marker"] as string : null;
        if (!string.IsNullOrEmpty(mk) && (mk != marker || !W.IsWindow(desk))) {
          var d = FindDesk(mk);
          if (d != IntPtr.Zero) { if (desk != IntPtr.Zero && d != desk) foreach (var s in snapped.Values) s.Applied = ""; desk = d; marker = mk; }
        }
        if (!W.IsWindow(desk)) return new Dictionary<string, object> { { "error", "desk window not found" } };
        var want = new Dictionary<long, Dictionary<string, object>>();
        foreach (var it in (System.Collections.ArrayList)m["items"]) { var d2 = (Dictionary<string, object>)it; want[L(d2["hwnd"])] = d2; }
        var park = new HashSet<long>();
        if (m.ContainsKey("park")) foreach (var p in (System.Collections.ArrayList)m["park"]) park.Add(L(p));
        foreach (var k in new List<long>(snapped.Keys)) if (!want.ContainsKey(k)) Release(k, park.Contains(k));
        bool added = false;
        foreach (var kv in want) {
          if (!W.IsWindow(new IntPtr(kv.Key))) continue;
          if (!snapped.ContainsKey(kv.Key)) { Snap(kv.Key); added = true; }
          var s = snapped[kv.Key];
          s.X = Convert.ToInt32(kv.Value["x"]); s.Y = Convert.ToInt32(kv.Value["y"]); s.Wd = Convert.ToInt32(kv.Value["w"]); s.Ht = Convert.ToInt32(kv.Value["h"]);
        }
        foreach (var p in park) if (!want.ContainsKey(p) && W.IsWindow(new IntPtr(p))) W.ShowWindow(new IntPtr(p), 7);
        bool wasHidden = hidden;
        hidden = m.ContainsKey("hidden") && m["hidden"] is bool && (bool)m["hidden"];
        PlaceAll(added || (wasHidden && !hidden) || W.GetForegroundWindow() == desk);
        var mins = new List<object>();
        foreach (var kv in snapped) if (kv.Value.MinW > 0 || kv.Value.MinH > 0) mins.Add(new long[] { kv.Key, kv.Value.MinW, kv.Value.MinH });
        return new Dictionary<string, object> { { "ok", true }, { "mins", mins } };
      }
    }
    return null;
  }

  // Windows tells us right away when the desk moves, is minimized/restored, or comes to the front.
  static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time) {
    if (obj != 0 || hwnd == IntPtr.Zero) return;
    if (hwnd != desk) { // one of the snapped windows changed by itself
      lock (gate) {
        Snapped s; if (!snapped.TryGetValue(hwnd.ToInt64(), out s)) return;
        if (ev == 0x000A) { s.Moving = true; return; }        // EVENT_SYSTEM_MOVESIZESTART: you're dragging it
        if (ev == 0x000B) s.Moving = false;                    // EVENT_SYSTEM_MOVESIZEEND
        else if (ev != 0x800B && ev != 0x0016 && ev != 0x0017) return;
        if (s.Moving) return;
      }
      fixTimer.Change(150, Timeout.Infinite); // a moment later, so a burst of changes is fixed once
      return;
    }
    lock (gate) {
      if (snapped.Count == 0) return;
      try {
        if (ev == 0x0003) PlaceAll(!hidden);              // EVENT_SYSTEM_FOREGROUND: desk clicked -> lift its windows
        else if (ev == 0x800B) PlaceAll(false);           // EVENT_OBJECT_LOCATIONCHANGE: desk moved/resized
        else if (ev == 0x0016 || ev == 0x0017) PlaceAll(ev == 0x0017); // minimize start / end
      } catch { }
    }
  }

  static void HookThread() {
    hookProc = OnWinEvent;
    W.SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, hookProc, 0, 0, 0x0002 /*OUTOFCONTEXT|SKIPOWNPROCESS*/);
    W.SetWinEventHook(0x000A, 0x000B, IntPtr.Zero, hookProc, 0, 0, 0x0002); // move/size start + end
    W.SetWinEventHook(0x0016, 0x0017, IntPtr.Zero, hookProc, 0, 0, 0x0002);
    W.SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, hookProc, 0, 0, 0x0002);
    W.MSG msg;
    while (W.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
  }

  static void Main() {
    try { W.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    var stdin = new System.IO.StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
    fixTimer = new Timer(_ => FixSnapped(), null, Timeout.Infinite, Timeout.Infinite);
    new Thread(HookThread) { IsBackground = true }.Start();
    var lines = new BlockingCollection<string>();
    new Thread(() => { string l; while ((l = stdin.ReadLine()) != null) lines.Add(l); lines.CompleteAdding(); }) { IsBackground = true }.Start();
    while (true) {
      string line;
      bool got;
      try { got = lines.TryTake(out line, 1000); } catch (InvalidOperationException) { break; }
      if (!got) {
        if (lines.IsCompleted) break;
        lock (gate) {
          try { if (snapped.Count > 0 && !W.IsWindow(desk)) foreach (var k in new List<long>(snapped.Keys)) Release(k, false); } catch { }
        }
        continue;
      }
      object id = 0, r;
      try {
        var m = json.Deserialize<Dictionary<string, object>>(line);
        if (m.ContainsKey("id")) id = m["id"];
        r = Handle(m);
      } catch (Exception ex) { r = new Dictionary<string, object> { { "error", ex.Message } }; }
      stdout.WriteLine(json.Serialize(new Dictionary<string, object> { { "id", id }, { "r", r } }));
    }
    ReleaseAll();
  }
}
