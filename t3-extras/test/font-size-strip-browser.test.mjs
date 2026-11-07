// The ✦ panel's "Your fonts" size buttons (− n% +), in headless Chromium against the real extras.css/extras.js. Never attaches to T3.
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

const CATALOG = [
  { name: "Arial", source: "mac", local: ["Arial"], style: "print", group: "hand", width: 100 },
  { name: "Georgia", source: "mac", local: ["Georgia"], style: "print", group: "hand", width: 100, size: 110 },
];

test("Your fonts size buttons: step the source area, clamp, focus, T3 fonts have none", { timeout: 90_000 }, async () => {
  assert.ok(fs.existsSync(CHROME), `headless Chrome missing: ${CHROME}`);
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname;
    const file = { "/extras.css": "text/css", "/extras.js": "text/javascript" }[name];
    res.writeHead(200, { "Content-Type": `${file || "text/html"}; charset=utf-8`, "Cache-Control": "no-store" });
    if (name === "/font-catalog") return res.end(JSON.stringify({ families: CATALOG }));
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
    // Replies: Arial (Quotes follows it). Message composer: Georgia, whose catalog default is 110% (Headings follows it).
    // Sidebar labels: Arial at 150% (Tooltips follows it). Questions: T3's own code font. Most rows also offer "Use for similar".
    await ev(`localStorage.setItem("t3x:settings:v1", JSON.stringify({ fontSchema: 2, fontMain: { family: "Arial", size: null }, fontComposer: { family: "Georgia", size: null },
      fontQuestions: { family: "T3 code font", size: null }, fontSidebar: { family: "Arial", size: 150 },
      fontSources: { main: "own", quotes: "link:main", reasoning: "native", plans: "native", questions: "own", composer: "own", head: "link:composer", prompts: "native",
        sidebar: "own", tooltips: "link:sidebar", interface: "native", usage: "native" } })), 1`);
    await send("Page.navigate", { url });
    assert.equal(await ev(`(async () => { for (let i = 0; i < 100; i++) { if (window.__T3X_PICK_TEST__?.openPanel) return "ready"; await new Promise((r) => setTimeout(r, 50)); } return "missing"; })()`), "ready");
    await new Promise((r) => setTimeout(r, 600));
    const saved = (k) => ev(`JSON.parse(localStorage.getItem("t3x:settings:v1"))[${JSON.stringify(k)}]`);
    const row = (id) => `document.querySelector('[data-focus="fs-name-${id}"]').closest(".t3x-fs-row")`;
    const val = (id) => ev(`${row(id)}.querySelector(".t3x-fs-size-val")?.textContent ?? null`);
    const until = (expr, what) => ev(`(async () => { for (let i = 0; i < 80; i++) { if (${expr}) return true; await new Promise((r) => setTimeout(r, 50)); } return ${JSON.stringify(what)}; })()`);
    const face = (alias, pct) => `[...document.fonts].some((f) => f.family.replace(/"/g, "") === ${JSON.stringify(alias)} && f.sizeAdjust === "${pct}%" && f.status === "loaded")`;
    // Every label line: nothing spills out of the row, nothing overlaps, followers stay readable, a wrapped tail sits on the right.
    const geometry = () => ev(`[...document.querySelectorAll(".t3x-fs-area")].map((a) => {
      const A = a.getBoundingClientRect(), parts = [...a.querySelectorAll(":scope > span, :scope > button, .t3x-fs-tail > *, .t3x-fs-size > *")].filter((e) => !e.matches(".t3x-fs-tail, .t3x-fs-size"));
      const boxes = parts.map((e) => ({ cls: e.className || e.textContent, r: e.getBoundingClientRect() })).filter((b) => b.r.width > 0);
      const out = boxes.filter((b) => b.r.left < A.left - 0.5 || b.r.right > A.right + 0.5).map((b) => b.cls);
      const overlap = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const p = boxes[i].r, q = boxes[j].r;
        if (p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5) overlap.push(boxes[i].cls + " / " + boxes[j].cls); }
      const also = a.querySelector(".t3x-fs-also"), tail = a.querySelector(".t3x-fs-tail"), first = a.firstElementChild.getBoundingClientRect();
      return { label: a.firstElementChild.textContent, out, overlap, scroll: a.scrollWidth - a.clientWidth, alsoW: also ? also.getBoundingClientRect().width : null,
        wrapped: !!tail && tail.getBoundingClientRect().top > first.bottom - 1, tailRight: tail ? A.right - tail.getBoundingClientRect().right : null };
    })`);
    const checkLines = (lines, when) => {
      for (const l of lines) {
        assert.deepEqual(l.out, [], `${when}: ${l.label} spills out of its row`);
        assert.deepEqual(l.overlap, [], `${when}: ${l.label} has overlapping parts`);
        assert.ok(l.scroll <= 1, `${when}: ${l.label} scrolls sideways`);
        if (l.alsoW !== null) assert.ok(l.alsoW >= 30, `${when}: ${l.label} followers squeezed to ${l.alsoW}px`);
        if (l.tailRight !== null) assert.ok(l.tailRight <= 1, `${when}: ${l.label} size and position not on the right`);
      }
    };

    await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await frames();
    assert.equal(await until(`document.querySelector('[data-focus="plus-main"]')`, "no size buttons on Replies"), true);
    assert.equal(await val("main"), "100%");
    assert.equal(await val("composer"), "110%", "a font's catalog default size shows until changed");
    assert.equal(await val("sidebar"), "150%");
    assert.equal(await ev(`${row("questions")}.querySelector(".t3x-fs-size")`), null, "T3's own fonts take T3's size: no buttons");
    const lines = await geometry();
    assert.ok(lines.filter((l) => l.alsoW !== null).length >= 3 && (await ev(`document.querySelectorAll(".t3x-fs-area .t3x-fs-similar").length`)) >= 3, "crowded rows: followers and the similar pill");
    checkLines(lines, "as rendered");
    await shot("font-size-strip.png");
    // Stress: the widest values every row could show at once.
    await ev(`document.querySelectorAll(".t3x-fs-pos").forEach((e) => { e.textContent = "12 of 51"; }), document.querySelectorAll(".t3x-fs-size-val").forEach((e) => { e.textContent = "150%"; }), 1`); await frames();
    const stressed = await geometry();
    checkLines(stressed, "widest values");
    await shot("font-size-strip-widest.png");
    await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await frames();
    await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await frames();

    // The name keeps its face across a size change, but not across a family change.
    assert.equal(await until(`document.querySelector('[data-focus="fs-name-main"]').style.fontFamily.includes("T3X Main")`, "Replies face never loaded"), true);
    const afterSize = await ev(`(() => { const b = document.querySelector('[data-focus="plus-main"]'); b.focus(); b.click(); return document.querySelector('[data-focus="fs-name-main"]').style.fontFamily; })()`);
    assert.match(afterSize, /T3X Main/, "same family, new size: the name keeps its face while the new one loads");
    await frames();
    assert.deepEqual(await saved("fontMain"), { family: "Arial", size: 105 });
    assert.equal((await saved("fontSources")).quotes, "link:main");
    assert.equal(await val("main"), "105%");
    assert.equal(await until(face("T3X Main", 105), "Replies face not at 105%"), true);
    assert.equal(await until(face("T3X Quotes", 105), "Quotes (following Replies) not at 105%"), true);
    await frames();
    assert.equal(await ev(`document.activeElement?.dataset.focus`), "plus-main", "focus stays on + after the face loads");

    // Up to 150: + turns off and focus moves to −, also after the face loads.
    for (let i = 0; i < 12; i++) { await ev(`(() => { const b = document.querySelector('[data-focus="plus-main"]'); if (!b.disabled) b.click(); })(), 1`); await frames(); }
    assert.deepEqual(await saved("fontMain"), { family: "Arial", size: 150 });
    assert.equal(await until(face("T3X Main", 150), "Replies face not at 150%"), true); await frames();
    assert.equal(await ev(`document.querySelector('[data-focus="plus-main"]').disabled`), true);
    assert.equal(await ev(`document.activeElement?.dataset.focus`), "minus-main", "focus falls back to − at the top");
    assert.equal(await val("main"), "150%");
    // Down to 80: − turns off and focus moves to +.
    for (let i = 0; i < 16; i++) { await ev(`(() => { const b = document.querySelector('[data-focus="minus-main"]'); if (!b.disabled) b.click(); })(), 1`); await frames(); }
    assert.deepEqual(await saved("fontMain"), { family: "Arial", size: 80 });
    assert.equal(await until(face("T3X Main", 80), "Replies face not at 80%"), true); await frames();
    assert.equal(await ev(`document.querySelector('[data-focus="minus-main"]').disabled`), true);
    assert.equal(await ev(`document.activeElement?.dataset.focus`), "plus-main", "focus falls back to + at the bottom");
    // Composer steps from its 110% default; Replies is untouched; labels name the area and the size.
    await ev(`document.querySelector('[data-focus="minus-composer"]').click(), 1`); await frames();
    assert.deepEqual(await saved("fontComposer"), { family: "Georgia", size: 105 });
    assert.deepEqual(await saved("fontMain"), { family: "Arial", size: 80 });
    assert.equal(await until(face("T3X Heading", 105), "Headings (following Message composer) not at 105%"), true);
    assert.equal(await ev(`document.querySelector('[data-focus="plus-composer"]').getAttribute("aria-label")`), "Larger font for Message composer, now 105%");
    assert.equal(await ev(`document.querySelector('[data-focus="plus-composer"]').title`), "Larger (105% → 110%)");
    // A different family: the old face isn't shown under the new name while it loads.
    const afterFamily = await ev(`(() => { document.querySelector('[data-focus="fs-next-composer"]').click(); const n = document.querySelector('[data-focus="fs-name-composer"]'); return { text: n.textContent, font: n.style.fontFamily }; })()`);
    if (afterFamily.text !== "Georgia") assert.doesNotMatch(afterFamily.font, /T3X Composer/, "new family: fallback font until its face loads");
    await shot("font-size-strip-changed.png");
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
