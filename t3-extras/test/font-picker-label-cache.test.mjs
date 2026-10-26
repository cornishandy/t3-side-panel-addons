// Sol's review case: a font that finishes loading mid-pick must change what the picker names.
// Find fonts on screen, in headless Chromium against the real extras.css/extras.js. Never attaches to T3.
// Covers Astra's pre-OK cases: an area is named only if switching that one area on changes the text,
// digits stay T3's, picking never reaches the page, and the probe leaves <html> exactly as it was.
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
const SRC = fileURLToPath(new URL('..', import.meta.url));
const CHROME = newestHeadlessChrome();
const OUT_ROOT = process.env.T3X_GROUPING_OUT || path.join(SRC, "task-output");
const OUT = path.join(OUT_ROOT, "screenshots");

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>
  /* Functional harness only, not T3's theme. */
  :root { --foreground:#eee; --background:#151515; --border:#555; --popover:#222; --muted-foreground:#aaa; --accent:#2a2a2a; --primary:#7aa2ff; --font-sans:Arial,sans-serif; --font-mono:Menlo,monospace; color-scheme:dark; }
  body { margin:0; background:#151515; color:#eee; font:15px/1.5 var(--font-sans); }
  main { width:620px; padding:24px; }
  [data-testid="composer-editor"] { border:1px solid #555; padding:8px; }
</style>
<link rel="stylesheet" href="/extras.css"></head><body><main>
<div data-message-role="assistant"><div class="chat-markdown">
  <h2 id="head">A reply heading</h2>
  <p id="prose">Reply prose with digits 4242 and <a id="link" href="#moved">a link</a> in it.</p>
  <blockquote><p id="quote">A quoted passage</p></blockquote>
  <pre><code id="code">let x = 1</code></pre>
</div></div>
<div data-t3x-slot="reasoning"><div class="chat-markdown"><blockquote><h3 id="rq">Reasoning quote heading</h3></blockquote><p id="rp">Reasoning prose</p></div></div>
<div data-testid="composer-editor" contenteditable="true"><p id="cp">Typed text with <a id="clink" href="#moved2">a composer link</a></p></div>
<button id="native">A T3 button</button>
</main>
<script>
window.__T3X_PICK_TEST__ = {};
localStorage.setItem('t3x:settings:v1',JSON.stringify({fontSchema:2,fontReasoning:{family:'T3 code font',size:null},fontSources:{reasoning:'own'}}));
const realFetch=window.fetch.bind(window);
window.fetch=(url,opts)=>String(url).includes('127.0.0.1:8793/')?Promise.resolve(new Response(JSON.stringify(String(url).endsWith('font-catalog')?{families:[{name:'Arial',source:'mac',local:['Arial'],style:'print',group:'hand',width:100}]}:{}),{status:String(url).endsWith('font-catalog')?200:503})):realFetch(url,opts);
const realLoad=FontFace.prototype.load;
FontFace.prototype.load=function(){if(this.family.replaceAll('"','')==='T3X Quotes')return new Promise((resolve,reject)=>{window.releaseQuote=()=>realLoad.call(this).then(f=>{resolve(f);return f;},reject);});return realLoad.call(this);};
</script>
<script src="/extras.js"></script></body></html>`;

test("pending font completion invalidates Shift label selection", { timeout: 90_000 }, async () => {
  assert.ok(fs.existsSync(CHROME), `headless Chrome missing: ${CHROME}`);
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname;
    const file = { "/extras.css": "text/css", "/extras.js": "text/javascript" }[name];
    res.writeHead(200, { "Content-Type": `${file || "text/html"}; charset=utf-8`, "Cache-Control": "no-store" });
    res.end(file ? fs.readFileSync(path.join(SRC, "public", name.slice(1))) : PAGE);
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
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
    assert.equal(await ev(`(async () => { for (let i = 0; i < 100; i++) { if (window.__T3X_PICK_TEST__?.areaOwners) return "ready"; await new Promise((r) => setTimeout(r, 50)); } return "missing"; })()`), "ready");
    // Boot settles (absent fonts clear their attributes); then Replies, Reasoning and Composer show a face.
    await new Promise((r) => setTimeout(r, 1200));




    await ev(`window.__T3X_PICK_TEST__.openFontsAt('quotes'),1`);
    await frames();
    await ev(`(() => { const ui=window.__T3X_PICK_TEST__.workspace();ui.source.value='own';ui.source.dispatchEvent(new Event('change'));ui.family.value='Arial';ui.family.dispatchEvent(new Event('change'));return 1;})()`);
    await frames();
    assert.equal(await ev(`typeof window.releaseQuote`),'function','Quote font load is paused');
    await ev(`window.__T3X_PICK_TEST__.startFontPick(),1`);
    await ev(`new Promise(r=>setTimeout(r,100))`);
    const rq = await at('#rq','Reasoning');
    await mouse('mouseMoved',rq.x,rq.y);await frames();
    const before = await ev(`document.querySelector('.t3x-pick-tag').textContent`);
    await key('keyDown','Shift','ShiftLeft',16); await frames();
    const labelBefore=await ev(`([...document.querySelectorAll('.t3x-pick-label')].find(b=>b.textContent==='Expanded reasoning')).outerHTML`);
    await ev(`window.releaseQuote().then(()=>new Promise(r=>setTimeout(r,10)))`);
    await mouse('mouseMoved',rq.x+1,rq.y);await frames();
    const after = await ev(`({tag:document.querySelector('.t3x-pick-tag').textContent,live:window.__T3X_PICK_TEST__.areaOwners([document.getElementById('rq')])[0].role, family:getComputedStyle(document.getElementById('rq')).fontFamily})`);
    const labelPt=await ev(`(() => {const b=[...document.querySelectorAll('.t3x-pick-label')].find(b=>b.textContent==='Expanded reasoning').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()`);
    await click(labelPt.x,labelPt.y);
    const chosen=await ev(`window.__T3X_PICK_TEST__.workspace().role`);
    console.log({before,after,labelBefore,chosen});
    assert.equal(chosen,after.live,'The opened area must still control the picked text after a pending font finishes');
  } finally {
    clearTimeout(killTimer);
    try { ws?.close(); } catch { /* closed */ }
    chrome.kill("SIGKILL");
    await new Promise((resolve) => { if (chrome.exitCode != null || chrome.signalCode != null) resolve(); else { chrome.once("exit", resolve); setTimeout(resolve, 3000); } });
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
