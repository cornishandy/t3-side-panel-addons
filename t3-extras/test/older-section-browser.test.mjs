// The Older section: active threads past the age picked in the ✦ panel (default 2 days) fold under one header, in headless Chromium against the real extras.css/extras.js and a T3-shaped sidebar list. Never attaches to T3.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function newestHeadlessChrome() {
  const root = path.join(os.homedir(), ".t3/tools/chrome-headless-shell/mac-arm64");
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((v) => /^\d+(\.\d+)+$/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return path.join(root, versions[0] ?? "missing", "chrome-headless-shell");
}
const SRC = fileURLToPath(new URL("..", import.meta.url));
const CHROME = newestHeadlessChrome();
const OUT_ROOT = process.env.T3X_GROUPING_OUT || path.join(SRC, "task-output");
const OUT = path.join(OUT_ROOT, "screenshots");

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>
  /* Functional harness only, close to T3's dark sidebar, not its theme. */
  :root { --foreground:#eee; --background:#151515; --border:#555; --popover:#222; --muted-foreground:#a1a1aa; --sidebar-foreground:#e4e4e7; --sidebar-muted-foreground:#a1a1aa; --accent:#2a2a2a; --primary:#7aa2ff; --font-sans:Arial,sans-serif; --font-mono:Menlo,monospace; color-scheme:dark; }
  body { margin:0; background:#151515; color:#eee; font:15px/1.5 var(--font-sans); }
  #side { width:280px; background:#18181b; color:var(--sidebar-foreground); font-size:13px; }
  #side ul { margin:0; padding:4px 0; }
  #side li { list-style:none; }
</style>
<link rel="stylesheet" href="/extras.css"></head><body>
<div id="side" data-slot="sidebar-content"><ul>
<li data-testid="sidebar-pinned-header" class="list-none"></li><li data-testid="sidebar-pinned-divider" class="list-none"></li>
<li data-testid="sidebar-active-placeholder" class="list-none"></li>
<li data-thread-item="env-1:t1" class="list-none"><div data-testid="sidebar-row-card" style="display:flex;gap:8px;height:28px;align-items:center;padding:0 8px"><span aria-hidden="true" class="min-w-0 flex-1">Fix the footer card</span><span class="group/sidebar-status-slot"><span>now</span></span></div></li><li data-thread-item="env-1:t2" class="list-none"><div data-testid="sidebar-row-card" style="display:flex;gap:8px;height:28px;align-items:center;padding:0 8px"><span aria-hidden="true" class="min-w-0 flex-1">Movie podcast draft</span><span class="group/sidebar-status-slot"><span>5h</span></span></div></li><li data-thread-item="env-1:t3" class="list-none"><div data-testid="sidebar-row-card" style="display:flex;gap:8px;height:28px;align-items:center;padding:0 8px"><span aria-hidden="true" class="min-w-0 flex-1">Usage meter check</span><span class="group/sidebar-status-slot"><span>23h</span></span></div></li><li data-thread-item="env-1:t4" class="list-none"><div data-testid="sidebar-row-card" style="display:flex;gap:8px;height:28px;align-items:center;padding:0 8px"><span aria-hidden="true" class="min-w-0 flex-1">Fonts not applying</span><span class="group/sidebar-status-slot"><span>1d</span></span></div></li><li data-thread-item="env-1:t5" class="list-none"><div data-testid="sidebar-row-card" style="display:flex;gap:8px;height:28px;align-items:center;padding:0 8px"><span aria-hidden="true" class="min-w-0 flex-1">Sidebar sections and titles</span><span class="group/sidebar-status-slot"><span>2d</span></span></div></li><li data-thread-item="env-1:t6" class="list-none"><div data-testid="sidebar-row-card" style="display:flex;gap:8px;height:28px;align-items:center;padding:0 8px"><span aria-hidden="true" class="min-w-0 flex-1">Public install recheck</span><span class="group/sidebar-status-slot"><span>4d</span></span></div></li><li data-thread-item="env-1:t7" class="list-none"><div data-testid="sidebar-row-card" style="display:flex;gap:8px;height:28px;align-items:center;padding:0 8px"><span aria-hidden="true" class="min-w-0 flex-1">Thread health watch (48)</span><span class="group/sidebar-status-slot"><span>9d</span></span></div></li>
<li data-testid="sidebar-settled-header" class="list-none" style="height:32px;padding:0 8px;color:#a1a1aa;font-size:12px;display:flex;align-items:center">Settled</li>
</ul></div>
<button id="anchor" style="position:fixed;left:320px;bottom:20px">✦</button>
<script>window.__T3X_PICK_TEST__ = {};</script>
<script src="/extras.js"></script></body></html>`;

test("older section: threads past the picked age fold under one header (default 2 days)", { timeout: 90_000 }, async () => {
  assert.ok(fs.existsSync(CHROME), `headless Chrome missing: ${CHROME}`);
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname;
    const file = { "/extras.css": "text/css", "/extras.js": "text/javascript" }[name];
    res.writeHead(200, { "Content-Type": `${file || "text/html"}; charset=utf-8`, "Cache-Control": "no-store" });
    if (name === "/font-catalog") return res.end(JSON.stringify({families:[]}));
    if (name !== "/" && !file) return res.end("{}");
    res.end(file ? fs.readFileSync(path.join(SRC, "public", name.slice(1)), "utf8").replace('const BASE = "http://127.0.0.1:8793/";', 'const BASE = location.origin + "/";') : PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(path.join(OUT_ROOT, "tmp"), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(OUT_ROOT, "tmp", "chprof-"));
  const chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--window-size=1100,760", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 85_000);
  let ws;
  try {
    let wsUrl = "";
    for (let i = 0; i < 100 && !wsUrl; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const [port] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
        wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch { /* not ready */ }
    }
    assert.ok(wsUrl, "no debugger page");
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    let id = 0;
    const pending = new Map(), exceptions = [];
    ws.addEventListener("message", (event) => {
      const m = JSON.parse(event.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params?.exceptionDetails?.exception?.description ?? "exception");
    });
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (expression) => {
      const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 900));
      return m.result?.result?.value;
    };
    const frames = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))");
    const mouse = async (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    const click = async (x, y) => { await mouse("mouseMoved", x, y); await frames(); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); await frames(); };
    const key = (type, k, code, vk) => send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: type === "keyDown" && k === "Shift" ? 8 : 0 });
    const shot = async (name) => { const p = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, name), Buffer.from(p.result.data, "base64")); };
    // Center of a substring of an element's first text run (or of the element).
    const at = (sel, sub) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); let b = el.getBoundingClientRect();
      ${sub ? `const t = [...el.childNodes].find((n) => n.nodeType === 3 && n.data.includes(${JSON.stringify(sub)})); const r = document.createRange(); const i = t.data.indexOf(${JSON.stringify(sub)}); r.setStart(t, i); r.setEnd(t, i + ${sub.length}); b = r.getBoundingClientRect();` : ""}
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 760, height: 520, deviceScaleFactor: 2, mobile: false });
    const url = `http://127.0.0.1:${server.address().port}/`;
    await send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 500));
    await ev(`localStorage.removeItem("t3x:settings:v1"), 1`);
    await send("Page.navigate", { url });
    assert.equal(await ev(`(async () => { for (let i = 0; i < 100; i++) { if (window.__T3X_PICK_TEST__?.openPanel && document.querySelector(".t3x-older:not([hidden])")) return "ready"; await new Promise((r) => setTimeout(r, 50)); } return "missing"; })()`), "ready");
    const view = () => ev(`(() => { const ul = document.querySelector("#side ul"); const btn = document.querySelector(".t3x-older-btn");
      return { order: [...ul.children].map((li) => li.classList.contains("t3x-older") ? "HEADER" : li.dataset.threadItem?.slice(6) ?? null).filter(Boolean),
        shown: [...ul.querySelectorAll("li[data-thread-item]")].filter((li) => li.checkVisibility()).map((li) => li.dataset.threadItem.slice(6)),
        label: btn.querySelector(".t3x-older-label").textContent, count: btn.querySelector(".t3x-older-count").textContent,
        expanded: btn.getAttribute("aria-expanded"), aria: btn.getAttribute("aria-label"), hidden: btn.parentElement.hidden }; })()`);
    // Default: 2 days. "2d" and "9d" are older; "1d" (24-47 h) stays.
    let v = await view();
    assert.deepEqual(v.order, ["t1", "t2", "t3", "t4", "HEADER", "t5", "t6", "t7"]);
    assert.deepEqual(v.shown, ["t1", "t2", "t3", "t4"]);
    assert.equal(v.label, "Older than 2 days");
    assert.equal(v.count, "3");
    assert.equal(v.expanded, "false");
    assert.equal(v.aria, "Older than 2 days: 3 threads, idle 2d to 9d");
    await shot("older-section-folded.png");
    // Click: the older threads open below the header, which stays put.
    const y0 = await ev(`document.querySelector(".t3x-older-btn").getBoundingClientRect().top`);
    await click(...Object.values(await at(".t3x-older-btn")));
    v = await view();
    assert.deepEqual(v.shown, ["t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
    assert.equal(v.expanded, "true");
    assert.equal(v.label, "Older than 2 days", "the header keeps its name when open");
    assert.equal(await ev(`document.querySelector(".t3x-older-btn").getBoundingClientRect().top`), y0);
    await mouse("mouseMoved", 700, 500); await new Promise((r) => setTimeout(r, 300)); // off the header, chevron turned
    await shot("older-section-open.png");
    await click(...Object.values(await at(".t3x-older-btn")));
    assert.deepEqual((await view()).shown, ["t1", "t2", "t3", "t4"]);

    // The ✦ panel: the age is a choice under the switch, and picking one moves the cut at once.
    await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await frames();
    await ev(`(() => { const d = document.querySelector(".t3x-more"); if (!d.open) d.querySelector("summary").click(); return 1; })()`); await frames();
    const panel = await ev(`(() => { const g = document.querySelector('[role="radiogroup"][aria-label="Older than"]');
      const sw = document.querySelector('[data-focus="sw-foldOlder"]');
      return g && { radios: [...g.querySelectorAll('[role="radio"]')].map((r) => r.textContent + (r.getAttribute("aria-checked") === "true" ? "*" : "")),
        sw: sw.textContent, note: sw.parentElement.querySelector(".t3x-note")?.textContent }; })()`);
    assert.ok(panel, "the Older than choice is in Settings");
    assert.deepEqual(panel.radios, ["12 hours", "1 day", "2 days*", "3 days", "1 week", "Auto"]);
    assert.equal(panel.sw, "Older threads section");
    assert.match(panel.note, /more than 2 days ago fold under one “Older than 2 days” header/);
    await ev(`document.querySelector('[role="radiogroup"][aria-label="Older than"]').scrollIntoView({ block: "center" }), 1`); await frames();
    await shot("older-section-panel.png");
    await ev(`document.querySelector('[data-focus="r-olderAfter-1d"]').click(), 1`); await frames(); await frames();
    v = await view();
    assert.deepEqual(v.order, ["t1", "t2", "t3", "HEADER", "t4", "t5", "t6", "t7"]);
    assert.equal(v.label, "Older than 1 day");
    assert.equal(v.count, "4");
    assert.equal(await ev(`JSON.parse(localStorage.getItem("t3x:settings:v1")).olderAfter`), "1d");
    await ev(`document.querySelector('[data-focus="r-olderAfter-1w"]').click(), 1`); await frames(); await frames();
    v = await view();
    assert.deepEqual(v.order, ["t1", "t2", "t3", "t4", "t5", "t6", "HEADER", "t7"]);
    assert.equal(v.label, "Older than a week");
    assert.equal(v.aria, "Older than a week: 1 thread, idle 9d");
    // Switched off: every thread shows and the header goes.
    await ev(`document.querySelector('[data-focus="sw-foldOlder"]').click(), 1`); await frames(); await frames();
    assert.equal(await ev(`document.querySelector('[role="radiogroup"][aria-label="Older than"]')`), null, "the choice hides with the switch off");
    assert.equal(await ev(`[...document.querySelectorAll("#side li[data-thread-item]")].filter((li) => li.checkVisibility()).length`), 7);
    assert.equal(await ev(`Boolean(document.querySelector(".t3x-older")?.checkVisibility())`), false);
    assert.deepEqual(exceptions, []);
  } finally {
    clearTimeout(killTimer);
    try { ws?.close(); } catch { /* closed */ }
    chrome.kill("SIGKILL");
    await new Promise((resolve) => { if (chrome.exitCode != null || chrome.signalCode != null) resolve(); else { chrome.once("exit", resolve); setTimeout(resolve, 3000); } });
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
