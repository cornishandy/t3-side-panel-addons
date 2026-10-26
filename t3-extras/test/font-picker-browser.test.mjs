// Find fonts on screen, in headless Chromium against the real extras.css/extras.js. Never attaches to T3.
// Covers Astra's pre-OK cases: an area is named only if switching that one area on changes the text,
// digits stay T3's, picking never reaches the page, and the probe leaves <html> exactly as it was.
// Astra's final-gate cases too: visualization frames can't swallow a pick, and the docked card stays on screen.
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
<script>window.__T3X_PICK_TEST__ = {};</script>
<script src="/extras.js"></script></body></html>`;

test("find fonts on screen in a headless browser", { timeout: 90_000 }, async () => {
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
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
    assert.equal(await ev(`(async () => { for (let i = 0; i < 100; i++) { if (window.__T3X_PICK_TEST__?.areaOwners) return "ready"; await new Promise((r) => setTimeout(r, 50)); } return "missing"; })()`), "ready");
    // Boot settles (absent fonts clear their attributes); then Replies, Reasoning and Composer show a face.
    await new Promise((r) => setTimeout(r, 1200));
    await ev(`(() => { const r = document.documentElement; for (const a of ["data-t3x-fm", "data-t3x-fr", "data-t3x-fc"]) r.setAttribute(a, ""); return 1; })()`);

    // 1. Ownership: named only when that one area (with its boxes) changes the text; probes restore <html>.
    const owners = await ev(`(() => {
      const T = window.__T3X_PICK_TEST__, root = document.documentElement, ids = ["head", "prose", "link", "quote", "code", "rq", "rp", "cp", "clink", "native"];
      const snap = () => [...root.attributes].map((a) => a.name + "=" + a.value).sort().join("|");
      const before = snap(), els = ids.map((i) => document.getElementById(i)), got = T.areaOwners(els), after = snap();
      const fam = (el) => T.roleOfFamily(getComputedStyle(el).fontFamily);
      const roles = ["head","composer","prompts","main","quotes","footer","reasoning","plans","questions","viz","interface","tables","links","paths","threadtitles","tooltips","usage","sidebar"];
      const withRole = (id, fn) => { const added = T.roleAttrs(id).filter((a) => !root.hasAttribute(a)); added.forEach((a) => root.setAttribute(a, "")); try { return fn(); } finally { added.forEach((a) => root.removeAttribute(a)); } };
      const checks = ids.map((name, i) => {
        const o = got[i], el = els[i];
        if (o?.active) return fam(el) === o.role;
        if (o) return withRole(o.role, () => fam(el) === o.role);
        return roles.every((r) => withRole(r, () => fam(el) !== r));
      });
      return { owners: Object.fromEntries(ids.map((n, i) => [n, got[i] ? got[i].role + (got[i].active ? "*" : "") : null])), checks, same: before === after };
    })()`);
    assert.equal(owners.same, true, "probe restored every <html> attribute");
    assert.deepEqual(owners.checks, owners.checks.map(() => true), JSON.stringify(owners.owners));
    assert.equal(owners.owners.prose, "main*");
    assert.equal(owners.owners.link, "links", "a reply link keeps T3's font until Links has one, so Links (not Replies) controls it");
    assert.equal(owners.owners.quote, "quotes");
    assert.equal(owners.owners.rq, "reasoning*", "Reasoning on, Quotes off: never named Quotes");
    assert.notEqual(owners.owners.clink, "composer", "Composer alone does not change a composer link while Links is off");
    assert.equal(owners.owners.code, null);
    assert.equal(owners.owners.native, null);

    // 2. Hover: the tag names the area; digits say they keep T3's font.
    await ev("window.__T3X_PICK_TEST__.startFontPick(), 1");
    assert.equal(await ev(`(async () => { for (let i = 0; i < 200; i++) { if (document.querySelector(".t3x-pick-bar span")?.textContent.startsWith("Click")) return "read"; await new Promise((r) => setTimeout(r, 10)); } return "slow"; })()`), "read");
    const digits = await at("#prose", "4242");
    await mouse("mouseMoved", digits.x, digits.y); await frames();
    const tagDigits = await ev(`document.querySelector(".t3x-pick-tag")?.textContent`);
    assert.match(tagDigits, /^Replies/);
    assert.match(tagDigits, /digits 0–9 keep T3's font/);
    const code = await at("#code", "let");
    await mouse("mouseMoved", code.x, code.y); await frames();
    assert.match(await ev(`document.querySelector(".t3x-pick-tag")?.textContent`), /^Not one of the Fonts areas/);
    const quote = await at("#quote", "quoted");
    await mouse("mouseMoved", quote.x, quote.y); await frames();
    assert.match(await ev(`document.querySelector(".t3x-pick-tag")?.textContent`), /^Quotes in replies.*T3 default/);
    await shot("picker-hover.png");

    // 3. Shift labels every area; letting go removes them.
    await key("keyDown", "Shift", "ShiftLeft", 16); await frames();
    const labels = await ev(`[...document.querySelectorAll(".t3x-pick-label")].map((n) => n.textContent)`);
    for (const want of ["Replies", "Quotes in replies", "Expanded reasoning", "Message composer"]) assert.ok(labels.includes(want), `${want} in ${labels}`);
    await shot("picker-labels.png");
    await key("keyUp", "Shift", "ShiftLeft", 16); await frames();
    assert.equal(await ev(`document.querySelectorAll(".t3x-pick-label").length`), 0);

    // 4. Click a link: the page never sees it; Fonts docks beside the paragraph, non-modal.
    const link = await at("#link");
    await click(link.x, link.y);
    const dock = await ev(`(() => { const ui = window.__T3X_PICK_TEST__.workspace(), p = document.getElementById("prose").getBoundingClientRect(), d = ui?.el.getBoundingClientRect();
      return ui && { hash: location.hash, mode: ui.el.dataset.mode, modal: ui.el.matches(":modal"), title: ui.title.textContent, picking: !!window.__T3X_PICK_TEST__.active(),
        overlaps: !(d.right <= p.left || d.left >= p.right || d.bottom <= p.top || d.top >= p.bottom), inView: d.left >= 0 && d.top >= 0 && d.right <= innerWidth && d.bottom <= innerHeight }; })()`);
    assert.deepEqual(dock, { hash: "", mode: "dock", modal: false, title: "Links in replies", picking: false, overlaps: false, inView: true });
    await shot("picker-dock.png");

    // 5. All fonts… expands to the full window; Show on screen steps aside and comes back on Esc.
    await ev(`[...document.querySelectorAll(".t3x-font-dockbar button")].find((b) => b.textContent === "All fonts…").click(), 1`);
    assert.equal(await ev(`window.__T3X_PICK_TEST__.workspace().el.matches(":modal")`), true);
    await ev(`window.__T3X_PICK_TEST__.workspace().showBtn.click(), 1`); await frames();
    const shown = await ev(`({ open: window.__T3X_PICK_TEST__.workspace().el.open, boxes: document.querySelectorAll(".t3x-pick-shown").length, bar: document.querySelector(".t3x-pick-bar")?.textContent })`);
    assert.equal(shown.open, false);
    assert.ok(shown.boxes >= 1, JSON.stringify(shown));
    await shot("picker-show.png");
    await key("keyDown", "Escape", "Escape", 27); await key("keyUp", "Escape", "Escape", 27); await frames();
    assert.equal(await ev(`window.__T3X_PICK_TEST__.workspace().el.matches(":modal")`), true);
    assert.equal(await ev(`document.querySelectorAll('[data-t3x="pick"]').length`), 0);
    // Independent final-gate checks. The BASE URL is redirected to this fixture server only.
    const observations = {};
    await ev(`document.querySelector('[aria-label="Close Fonts"]').click(), 1`);
    const readyPick = async () => {
      await ev("window.__T3X_PICK_TEST__.startFontPick(), 1");
      assert.equal(await ev(`(async () => { for (let i=0;i<200;i++) { if(document.querySelector(".t3x-pick-bar span")?.textContent.startsWith("Click")) return true; await new Promise(r=>setTimeout(r,10)); } return false; })()`), true);
    };
    // A real font choice through the dock must change the target text and persist the chosen source.
    await readyPick();
    const prosePt = await at("#prose", "Reply");
    await click(prosePt.x, prosePt.y);
    observations.familyOptions = await ev(`[...document.querySelector('#t3x-font-family').options].map(o=>o.value)`);
    await ev(`(() => { const f=document.querySelector('#t3x-font-family'); f.value='T3 code font'; f.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
    await frames();
    observations.fontChange = await ev(`({family:getComputedStyle(document.getElementById('prose')).fontFamily, stored:JSON.parse(localStorage.getItem('t3x:settings:v1')).fontMain, source:document.querySelector('#t3x-font-source').value})`);
    await ev(`document.querySelector('.t3x-font-done').click(), 1`);
    assert.equal(observations.fontChange.stored.family, 'T3 code font');
    assert.equal(observations.fontChange.source, 'own');
    assert.match(observations.fontChange.family, /Menlo/);
    // Resizing after opening the dock should keep all controls reachable.
    await readyPick();
    await click(prosePt.x, prosePt.y);
    await send('Emulation.setDeviceMetricsOverride',{width:640,height:480,deviceScaleFactor:1,mobile:false});
    await frames();
    observations.resizeDock = await ev(`(() => {const b=window.__T3X_PICK_TEST__.workspace().el.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:innerWidth,height:innerHeight};})()`);
    await shot('picker-resize-offscreen.png');
    await send('Emulation.setDeviceMetricsOverride',{width:1100,height:760,deviceScaleFactor:1,mobile:false});
    await frames();
    await ev(`document.querySelector('.t3x-font-done').click(), 1`);
    // Sandboxed native visualization: pointer and keyboard events stay in the child browsing context.
    const frameHTML = '<html><body style="margin:0;color:white;background:#333"><button style="width:300px;height:150px">Visualization text</button><script>document.body.onclick=()=>parent.postMessage("fixture-click","*"); addEventListener("keydown",()=>parent.postMessage("fixture-key","*"))</script></body></html>';
    await ev(`(() => { window.frameClicks=0; window.frameKeys=0; window.addEventListener('message',e=>{if(e.data==='fixture-click') frameClicks++; if(e.data==='fixture-key') frameKeys++;}); const f=document.createElement('iframe'); f.id='vizfixture'; f.setAttribute('data-t3x-native-html','1'); f.setAttribute('sandbox','allow-scripts allow-forms'); f.style='position:fixed;left:700px;top:40px;width:300px;height:150px;border:2px solid white'; f.srcdoc=${JSON.stringify(frameHTML)}; document.body.append(f); return 1; })()`);
    await new Promise(r=>setTimeout(r,100));
    await readyPick();
    await mouse('mouseMoved',800,100); await frames();
    observations.frameHover = await ev(`({tag:document.querySelector('.t3x-pick-tag')?.textContent, visible:!document.querySelector('.t3x-pick-tag')?.hidden})`);
    await click(800,100);
    await key('keyDown','Escape','Escape',27); await key('keyUp','Escape','Escape',27); await frames();
    observations.frameClick = await ev(`({clicks:frameClicks,keys:frameKeys,active:!!window.__T3X_PICK_TEST__.active(),workspace:!!window.__T3X_PICK_TEST__.workspace()})`);
    await ev(`window.__T3X_PICK_TEST__.endInspector(); document.getElementById('vizfixture').remove(); 1`);
    // Show on screen also needs to find the visible visualization frame.
    await ev(`(() => {const f=document.createElement('iframe'); f.id='vizfixture'; f.setAttribute('data-t3x-native-html','1'); f.setAttribute('sandbox','allow-scripts allow-forms'); f.style='position:fixed;left:700px;top:40px;width:300px;height:150px'; document.body.append(f); window.__T3X_PICK_TEST__.showAreaOnScreen('viz'); return 1;})()`);
    observations.frameShow = await ev(`({boxes:document.querySelectorAll('.t3x-pick-shown').length,bar:document.querySelector('.t3x-pick-bar')?.textContent})`);
    await ev(`window.__T3X_PICK_TEST__.endInspector(); document.getElementById('vizfixture').remove(); 1`);
    // Cleanup returns all page events; no inspection attributes or overlays remain.
    observations.cleanup = await ev(`({probing:document.documentElement.hasAttribute('data-t3x-probing'),picking:document.documentElement.hasAttribute('data-t3x-picking'),overlays:document.querySelectorAll('[data-t3x="pick"]').length})`);
    console.log('FINAL GATE OBSERVATIONS', JSON.stringify(observations));
    // 6. Cost on a long thread (2,000 extra paragraphs): reading the screen once when picking starts,
    // then a lookup for text that wasn't read yet. Hovering read text costs nothing.
    await ev(`window.__T3X_PICK_TEST__.workspace() && document.querySelector(".t3x-font-workspace").close(), 1`);
    await ev(`(() => { const md = document.querySelector('[data-message-role="assistant"] .chat-markdown');
      for (let i = 0; i < 2000; i++) { const p = document.createElement("p"); p.textContent = "Filler paragraph " + i + " with some words in it"; md.append(p); } return 1; })()`);
    const cost = await ev(`(async () => {
      const T = window.__T3X_PICK_TEST__, hint = () => document.querySelector(".t3x-pick-bar span")?.textContent || "";
      const t0 = performance.now(); T.startFontPick();
      while (!hint().startsWith("Click")) await new Promise((r) => setTimeout(r, 5));
      const start = performance.now() - t0;
      const p = document.createElement("p"); p.textContent = "Streamed after the read"; document.getElementById("prose").after(p);
      const chain = []; for (let n = p; n && n !== document.body && chain.length < 8; n = n.parentElement) chain.push(n);
      const t1 = performance.now(); const o = T.areaOwners(chain); const fresh = performance.now() - t1;
      T.endInspector();
      return { start, fresh, owner: o[0]?.role };
    })()`);
    console.log("picker cost (ms)", JSON.stringify(cost));
    assert.equal(cost.owner, "main");
    assert.ok(cost.start < 1500 && cost.fresh < 400, JSON.stringify(cost));
    assert.deepEqual(exceptions, []);
    assert.deepEqual(observations.cleanup,{probing:false,picking:false,overlays:0});
    const defects=[];
    if(observations.frameClick.clicks!==0) defects.push('Picking a native visualization activates its content');
    if(observations.frameClick.active) defects.push('Escape after clicking a native visualization leaves the picker active');
    if(!observations.frameShow.boxes) defects.push('Show on screen omits a visible native visualization');
    const d=observations.resizeDock;
    if(d.left>=d.width || d.right<=0 || d.top>=d.height || d.bottom<=0) defects.push('Resizing the window leaves the dock entirely offscreen');
    assert.deepEqual(defects, [], 'final-gate regressions');
  } finally {
    clearTimeout(killTimer);
    try { ws?.close(); } catch { /* closed */ }
    chrome.kill("SIGKILL");
    await new Promise((resolve) => { if (chrome.exitCode != null || chrome.signalCode != null) resolve(); else { chrome.once("exit", resolve); setTimeout(resolve, 3000); } });
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
