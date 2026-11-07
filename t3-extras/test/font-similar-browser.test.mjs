// "Use for similar": the optional button in the ✦ panel and in Fonts, in headless Chromium against the real extras.css/extras.js. Never attaches to T3.
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
  /* Functional harness only, not T3's theme. */
  :root { --foreground:#eee; --background:#151515; --border:#555; --popover:#222; --muted-foreground:#aaa; --accent:#2a2a2a; --primary:#7aa2ff; --font-sans:Arial,sans-serif; --font-mono:Menlo,monospace; color-scheme:dark; }
  body { margin:0; background:#151515; color:#eee; font:15px/1.5 var(--font-sans); }
</style>
<link rel="stylesheet" href="/extras.css"></head><body><button id="anchor" style="position:fixed;left:20px;bottom:20px">✦</button>
<script>window.__T3X_PICK_TEST__ = {};</script>
<script src="/extras.js"></script></body></html>`;

test("use for similar areas: optional, applies on click, undoes", { timeout: 90_000 }, async () => {
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
    await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    const url = `http://127.0.0.1:${server.address().port}/`;
    await send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 500));
    // Replies and Questions have their own fonts; Quotes follows Replies; Reasoning and Plans use T3's.
    await ev(`localStorage.setItem("t3x:settings:v1", JSON.stringify({ fontSchema: 2, fontMain: { family: "T3 system font", size: null }, fontQuestions: { family: "T3 code font", size: null },
      fontSources: { main: "own", quotes: "link:main", reasoning: "native", plans: "native", questions: "own" } })), 1`);
    await send("Page.navigate", { url });
    assert.equal(await ev(`(async () => { for (let i = 0; i < 100; i++) { if (window.__T3X_PICK_TEST__?.openPanel) return "ready"; await new Promise((r) => setTimeout(r, 50)); } return "missing"; })()`), "ready");
    await new Promise((r) => setTimeout(r, 600));
    // Only the Replies group; untouched areas gain their defaults on the first save.
    const sources = async () => { const all = await ev(`JSON.parse(localStorage.getItem("t3x:settings:v1")).fontSources`); return Object.fromEntries(["main", "quotes", "reasoning", "plans", "questions"].map((a) => [a, all[a]])); };
    const before = await sources();

    // The ✦ panel: an optional button on the Replies row; nothing changes until it's clicked.
    await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await frames();
    const row = await ev(`(() => { const b = document.querySelector('[data-focus="fs-similar-main"]'); return b && { text: b.textContent, title: b.title, w: b.getBoundingClientRect().width,
      rowW: b.closest(".t3x-fs-area").getBoundingClientRect().width, scrollW: b.closest(".t3x-fs-area").scrollWidth }; })()`);
    assert.ok(row, "Replies row offers similar areas");
    assert.equal(row.text, "Use for similar");
    assert.match(row.title, /Reasoning, Plans and Questions/);
    assert.match(row.title, /Questions loses its own pick/);
    assert.ok(row.scrollW <= row.rowW + 1, "row doesn't overflow");
    assert.deepEqual(await sources(), before, "offer alone changes nothing");
    await shot("font-similar-panel.png");
    await ev(`document.querySelector('[data-focus="fs-similar-main"]').click(), 1`); await frames();
    const applied = await sources();
    for (const a of ["quotes", "reasoning", "plans", "questions"]) assert.equal(applied[a], "link:main", a);
    assert.equal(await ev(`document.querySelector('[data-focus="fs-similar-main"]')?.textContent`), "Undo");
    assert.match(await ev(`document.querySelector(".t3x-fs-row .t3x-fs-also")?.textContent`), /Quotes.*Reasoning.*Plans.*Questions/);
    await shot("font-similar-panel-applied.png");
    await ev(`document.querySelector('[data-focus="fs-similar-main"]').click(), 1`); await frames();
    assert.deepEqual(await sources(), before, "Undo restores every area's previous source");

    // Fonts: the same offer under Font source, with Undo beside it once applied.
    await ev(`window.__T3X_PICK_TEST__.openFontsAt("main"), 1`); await frames();
    const ed = await ev(`(() => { const g = document.querySelector(".t3x-font-similar"); return { hidden: g.hidden, text: g.querySelector(".t3x-note").textContent, buttons: [...g.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent) }; })()`);
    assert.equal(ed.hidden, false);
    assert.match(ed.text, /^Also use T3 system font for Reasoning, Plans and Questions\?/);
    assert.deepEqual(ed.buttons, ["Use for similar areas"]);
    await ev(`[...document.querySelectorAll(".t3x-font-similar button")].find((b) => b.textContent === "Use for similar areas").click(), 1`); await frames();
    const ed2 = await ev(`(() => { const g = document.querySelector(".t3x-font-similar"); return { hidden: g.hidden, text: g.querySelector(".t3x-note").textContent, buttons: [...g.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent) }; })()`);
    assert.deepEqual(ed2.buttons, ["Undo"]);
    assert.match(ed2.text, /Reasoning, Plans and Questions now follow Replies/);
    await shot("font-similar-editor.png");
    await ev(`[...document.querySelectorAll(".t3x-font-similar button")].find((b) => b.textContent === "Undo").click(), 1`); await frames();
    assert.deepEqual(await sources(), before);

    // An area with nothing similar left (Message composer's group is empty here) shows no offer.
    await ev(`window.__T3X_PICK_TEST__.openFontsAt("questions"), 1`); await frames();
    assert.equal(await ev(`document.querySelector(".t3x-font-similar").hidden`), false, "Questions can offer Reasoning and Plans");
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
