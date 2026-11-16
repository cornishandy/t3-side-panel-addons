// "Auto-hide in narrow windows": under 768 px T3 swaps its docked sidebar for a pop-over. With the
// switch off, the add-ons answer T3's one narrow query with "not narrow", nudge T3's sidebar store
// so it re-reads it, and CSS shows the docked sidebar T3's Tailwind classes hide there.
// Checked against the real T3 UI on 15 Nov 2026 (nightly 0.1.10-nightly.20261115.4749).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const sandbox = { window: { __T3X_TEST__: {} } };
vm.runInNewContext(fs.readFileSync(path.join(SRC, "public/extras.js"), "utf8"), sandbox);
const C = sandbox.window.__T3X_TEST__.core;
const NARROW = "(max-width: 767px)";

test("the switch starts off (sidebar kept) and drives the <html> attribute", () => {
  const d = C.readSettings(null);
  assert.equal(d.narrowAutoHide, false);
  assert.equal(C.rootAttrs(d)["data-t3x-keep-sidebar"], "");
  const on = C.readSettings(JSON.stringify({ narrowAutoHide: true }));
  assert.equal(C.rootAttrs(on)["data-t3x-keep-sidebar"], null);
  assert.equal(C.readSettings(JSON.stringify({ narrowAutoHide: "yes" })).narrowAutoHide, false, "a non-boolean is ignored");
});

function fakeWindow() {
  const made = [];
  const win = {
    matchMedia(q) {
      const listeners = [];
      const list = { media: q, matches: true, onchange: null, listeners, addEventListener: (t, f) => listeners.push([t, f]), removeEventListener: () => {}, addListener: (f) => listeners.push(["change", f]), removeListener: () => {}, dispatchEvent: () => true };
      made.push(list);
      return list;
    },
  };
  return { win, made, native: win.matchMedia };
}

test("only T3's narrow query is answered differently, and only while kept", () => {
  const { win, made, native } = fakeWindow();
  let keep = true;
  const undo = C.wrapMatchMedia(win, () => keep);
  const narrow = win.matchMedia(NARROW);
  assert.equal(narrow.matches, false, "kept: not narrow");
  assert.equal(narrow.media, NARROW);
  const fn = () => {};
  narrow.addEventListener("change", fn);
  assert.deepEqual(made.at(-1).listeners, [["change", fn]], "listeners land on the real list, so T3 still hears width changes");
  keep = false;
  assert.equal(narrow.matches, true, "auto-hide on: the real answer, read live");
  keep = true;
  const other = win.matchMedia("(max-width: 979px)");
  assert.equal(other, made.at(-1), "every other query is the real list, untouched");
  assert.equal(other.matches, true);
  const undo2 = C.wrapMatchMedia(win, () => keep);
  assert.equal(win.matchMedia.t3xNative, native, "a second load wraps the original, not a wrapper");
  undo2();
  assert.equal(win.matchMedia, native);
  undo();
  assert.equal(win.matchMedia, native, "an older undo leaves the original in place");
});

test("the nudge reaches T3's sidebar context through the wrapper's fiber", () => {
  const calls = [];
  const ctx = (openMobile) => ({ openMobile, setOpenMobile: (v) => calls.push(v), toggleSidebar() {} });
  const els = [{ id: "closed" }, { id: "open" }, { id: "none" }];
  const fibers = {
    closed: { memoizedProps: { className: "x" }, return: { memoizedProps: { value: ctx(false) }, return: null } },
    open: { return: { memoizedProps: { value: ctx(true) } } },
    none: { memoizedProps: {}, return: { memoizedProps: { value: { theme: "dark" } } } },
  };
  const doc = { querySelectorAll: (sel) => (sel === '[data-slot="sidebar-wrapper"]' ? els : []) };
  assert.equal(C.refreshNarrowSidebar(doc, (el) => fibers[el.id]), 2);
  assert.deepEqual(calls, [true, false, false], "closed: open and close in one task; open: just close");
  assert.equal(C.refreshNarrowSidebar({ querySelectorAll: () => [] }, () => null), 0, "no sidebar, nothing to do");
});

function newestHeadlessChrome() {
  const root = path.join(os.homedir(), ".t3/tools/chrome-headless-shell/mac-arm64");
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((v) => /^\d+(\.\d+)+$/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return path.join(root, versions[0] ?? "missing", "chrome-headless-shell");
}

// T3's docked sidebar markup and the Tailwind rules that hide it under 768 px (copied from the build).
const PAGE = (keep) => `<!doctype html><html ${keep ? "data-t3x-keep-sidebar" : ""}><head><meta charset="utf-8"><style>
@layer utilities { .hidden{display:none} @media (min-width:768px){ .md\\:block{display:block} .md\\:flex{display:flex} } .flex{display:flex} }
</style><link rel="stylesheet" href="/extras.css"></head><body>
<div data-slot="sidebar-wrapper" data-sidebar-state="expanded">
  <div id="docked" class="group peer hidden md:block" data-collapsible="" data-collapsible-mode="offcanvas" data-side="left" data-slot="sidebar" data-state="expanded" data-variant="sidebar">
    <div data-slot="sidebar-gap"></div>
    <div id="container" class="fixed inset-y-0 z-10 hidden h-svh md:flex" data-slot="sidebar-container"><div data-slot="sidebar-inner">threads</div></div>
  </div>
  <div id="sheet" class="hidden" data-mobile="true" data-sidebar="sidebar" data-slot="sidebar">pop-over</div>
</div></body></html>`;

test("CSS shows the docked sidebar under 768 px only while kept, and never the pop-over", { timeout: 60_000 }, async () => {
  const chromePath = newestHeadlessChrome();
  assert.ok(fs.existsSync(chromePath), `headless Chrome missing: ${chromePath}`);
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname;
    if (name === "/extras.css") { res.writeHead(200, { "Content-Type": "text/css" }); return res.end(fs.readFileSync(path.join(SRC, "public/extras.css"))); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE(name === "/keep"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const tmp = path.join(SRC, "task-output/tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const profile = fs.mkdtempSync(path.join(tmp, "narrow-sidebar-"));
  const chrome = spawn(chromePath, ["--headless", "--disable-gpu", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  const timer = setTimeout(() => chrome.kill("SIGKILL"), 55_000);
  let ws;
  try {
    let wsUrl;
    for (let i = 0; i < 100 && !wsUrl; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const [port] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
        wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === "page")?.webSocketDebuggerUrl;
      } catch {}
    }
    assert.ok(wsUrl, "no debugger page");
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
    const look = async (route, width) => {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}${route}` });
      for (let i = 0; i < 50 && (await ev("document.readyState")) !== "complete"; i++) await new Promise((r) => setTimeout(r, 50));
      return ev(`["docked", "container", "sheet"].map((id) => getComputedStyle(document.getElementById(id)).display).join(" ")`);
    };
    await send("Page.enable");
    assert.equal(await look("/keep", 700), "block flex none", "kept, 700 px: docked sidebar shows");
    assert.equal(await look("/keep", 400), "block flex none", "kept, 400 px");
    assert.equal(await look("/", 700), "none none none", "auto-hide on: T3's own hiding");
    assert.equal(await look("/keep", 1200), "block flex none", "wide windows are T3's own rules either way");
  } finally {
    clearTimeout(timer);
    try { ws?.close(); } catch {}
    chrome.kill("SIGKILL");
    server.close();
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
});
