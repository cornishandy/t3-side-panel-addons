// Questions and Reasoning reach T3's own markup (build 3707+) without the native bridge's
// data-t3x-slot marks, which a T3 update removes. Headless Chromium against the real extras.css;
// the markup copies T3's _chat / useTimelineFollow structure. Never attaches to T3.
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>:root { --font-sans: Arial, sans-serif; --font-mono: Menlo, monospace; } body { font-family: var(--font-sans); }</style>
<link rel="stylesheet" href="/extras.css"></head><body>
<!-- open question card (GM in _chat): collapsible, trigger button, panel with ChatMarkdown and option buttons -->
<div data-slot="collapsible">
  <button type="button" data-slot="collapsible-trigger" data-pending-user-input-toggle="expanded"><span id="qhead">6. Hosting</span></button>
  <div data-slot="collapsible-panel"><div><div class="min-w-0 ps-8 ps-6 pe-4 pb-1">
    <div class="chat-markdown pt-2"><p id="qprose">Where should the page live?</p><p>See <a id="qlink" href="#x">the page</a> and <code id="qcode">x</code></p></div>
    <div class="-ms-2 mt-1.5"><button type="button" aria-pressed="false"><span id="qradio" class="pointer-events-none flex h-5 shrink-0 items-center"><span aria-hidden="true"></span></span><div class="min-w-0 flex-1 flex flex-col gap-0.5"><span id="qopt" class="text-sm font-medium">Tailnet (Recommended)</span><span id="qdesc" class="text-secondary-label text-2xs">Private</span></div><span id="qkey" class="flex h-5 w-7 shrink-0"><kbd id="qkbd">1</kbd></span></button></div>
  </div></div></div>
</div>
<!-- a collapsible that is not a question -->
<div data-slot="collapsible"><button data-slot="collapsible-trigger">Other</button><div data-slot="collapsible-panel"><div class="chat-markdown"><p id="otherprose">Not a question</p></div></div></div>
<!-- saved answer (Gh in useTimelineFollow) -->
<div data-timeline-row-kind="work"><div class="ms-7 mt-2 space-y-2"><div class="space-y-1">
  <p id="squestion" class="whitespace-pre-wrap text-sm text-muted-foreground">Where should it live?</p>
  <p id="sanswer" class="ms-3 whitespace-pre-wrap text-sm text-muted-foreground">Tailnet</p>
  <div class="flex flex-wrap gap-2"><a id="sattach" class="text-sm underline" href="#a">shot.png</a></div>
</div></div>
<!-- expanded reasoning (Hh inside qf kind "text") and a collapsed Thinking row -->
<div class="cursor-auto ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text"><div class="chat-markdown text-foreground"><h3 id="rhead">Plan</h3><p id="rprose">First, consider</p><pre><code id="rcode">x</code></pre></div></div>
<button aria-expanded="false" id="thinking">Thinking <span class="line-clamp-4" id="preview">First</span></button>
</div></body></html>`;

test("Questions and Reasoning reach T3's own markup without the native bridge", { timeout: 60_000 }, async () => {
  assert.ok(fs.existsSync(CHROME), `headless Chrome missing: ${CHROME}`);
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname;
    res.writeHead(200, { "Content-Type": `${name === "/extras.css" ? "text/css" : "text/html"}; charset=utf-8` });
    res.end(name === "/extras.css" ? fs.readFileSync(path.join(SRC, "public/extras.css"), "utf8") : PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(path.join(OUT_ROOT, "tmp"), { recursive: true });
  const profile = fs.mkdtempSync(path.join(OUT_ROOT, "tmp", "chprof-"));
  const chrome = spawn(CHROME, ["--headless", "--disable-gpu", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 55_000);
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
    const pending = new Map();
    ws.addEventListener("message", (event) => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await send("Page.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
    assert.equal(await ev(`(async () => { for (let i = 0; i < 100; i++) { if (document.styleSheets.length >= 2 && document.getElementById("preview")) return "ready"; await new Promise((r) => setTimeout(r, 50)); } return "slow"; })()`), "ready");
    const families = (attrs) => ev(`(() => { const r = document.documentElement; for (const a of [...r.attributes]) if (a.name.startsWith("data-t3x")) r.removeAttribute(a.name);
      for (const a of ${JSON.stringify(attrs)}) r.setAttribute(a, "");
      return Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id, getComputedStyle(el).fontFamily.split(",")[0].replace(/"/g, "").trim()])); })()`);

    const off = await families([]);
    for (const [k, v] of Object.entries(off)) assert.ok(!v.startsWith("T3X"), `${k} is native with every area off`);

    const on = await families(["data-t3x-fquestions", "data-t3x-fr"]);
    assert.equal(on.qprose, "T3X Questions", "open question prose");
    assert.equal(on.squestion, "T3X Questions", "saved question");
    assert.equal(on.sanswer, "T3X Questions", "saved answer");
    assert.equal(on.qopt, "T3X Questions", "option label");
    assert.equal(on.qdesc, "T3X Questions", "option description");
    for (const k of ["qhead", "qradio", "qkey", "qkbd", "qlink", "qcode", "sattach", "otherprose"]) assert.ok(!on[k].startsWith("T3X"), `${k} stays native (${on[k]})`);
    assert.equal(on.rprose, "T3X Reasoning", "expanded reasoning prose");
    assert.equal(on.rhead, "T3X Reasoning", "expanded reasoning heading");
    for (const k of ["rcode", "thinking", "preview"]) assert.ok(!on[k].startsWith("T3X"), `${k} stays native (${on[k]})`);
  } finally {
    clearTimeout(killTimer);
    try { ws?.close(); } catch {}
    chrome.kill("SIGKILL");
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
