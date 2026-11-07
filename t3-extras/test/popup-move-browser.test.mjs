// Moving popups out of the way (popMove): the clear-spot finder, then drag, keys, reset, the Fonts small card and the
// switch, in headless Chromium against the real extras.css/extras.js. Never attaches to T3.
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
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const box = (at, w, h) => ({ left: at.left, top: at.top, right: at.left + w, bottom: at.top + h });

test("clearSpot finds an exact gap, keeps picked text clear, and stays in the window", () => {
  const sandbox = { window: { __T3X_TEST__: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "public/extras.js"), "utf8"), sandbox);
  const core = sandbox.window.__T3X_TEST__.core, plain = (v) => JSON.parse(JSON.stringify(v)); // VM values have their own prototypes
  const clearSpot = (...a) => plain(core.clearSpot(...a)), readSpots = (v) => plain(core.readSpots(v)), spotFrom = (...a) => plain(core.spotFrom(...a));
  // GPT-6-Astra's case: text ends at x=13 and starts again at x=363; a 340px card fits only at x 13–23.
  const walls = [{ left: 0, top: 0, right: 13, bottom: 600 }, { left: 363, top: 0, right: 800, bottom: 600 }];
  const gap = clearSpot(340, 200, walls, { vw: 800, vh: 600, m: 12 });
  assert.ok(!walls.some((r) => overlaps(box(gap, 340, 200), r)), `the 350px gap was missed: ${JSON.stringify(gap)}`);
  // Astra's final-gate case: the same gap on half pixels (13.5 to 353.5) is found exactly, not rounded onto the text.
  const halves = [{ left: 0, top: 0, right: 13.5, bottom: 600 }, { left: 353.5, top: 0, right: 800, bottom: 600 }];
  const half = clearSpot(340, 200, halves, { vw: 800, vh: 600, m: 12 });
  assert.ok(!halves.some((r) => overlaps(box(half, 340, 200), r)), `the half-pixel gap was missed: ${JSON.stringify(half)}`);
  // Picked text inside the only text-free hole, too small to clear it: the card covers other text, not the pick.
  const hole = { left: 350, top: 50, right: 750, bottom: 330 }, keep = { left: 400, top: 100, right: 600, bottom: 140 };
  const text = [{ left: 0, top: 0, right: 800, bottom: hole.top }, { left: 0, top: hole.bottom, right: 800, bottom: 600 }, { left: 0, top: hole.top, right: hole.left, bottom: hole.bottom }, { left: hole.right, top: hole.top, right: 800, bottom: hole.bottom }];
  const picked = clearSpot(300, 200, text, { vw: 800, vh: 600, m: 12, keep });
  assert.ok(!overlaps(box(picked, 300, 200), keep), `covered the picked text: ${JSON.stringify(picked)}`);
  assert.ok(overlaps(box(clearSpot(300, 200, text, { vw: 800, vh: 600, m: 12 }), 300, 200), keep), "fixture: without keep, the hole (over the pick) wins");
  // Breathing room beats touching when both are clear; no text at all: the top right.
  const roomy = clearSpot(200, 100, [{ left: 300, top: 0, right: 800, bottom: 600 }], { vw: 800, vh: 600, m: 12 });
  assert.ok(roomy.left + 200 <= 300 - 12, `hugs the text: ${JSON.stringify(roomy)}`);
  assert.deepEqual({ ...clearSpot(200, 100, [], { vw: 800, vh: 600, m: 12 }) }, { left: 588, top: 12 });
  // Never outside the window, even when the card is wider than it.
  const wide = clearSpot(900, 100, walls, { vw: 800, vh: 600, m: 12 });
  assert.equal(wide.left, 12);
  // 120 scattered blocks: still quick.
  const many = Array.from({ length: 120 }, (_, i) => ({ left: (i * 97) % 1300, top: (i * 61) % 800, right: ((i * 97) % 1300) + 180, bottom: ((i * 61) % 800) + 40 }));
  const t0 = performance.now();
  clearSpot(340, 420, many, { vw: 1500, vh: 900, m: 12, keep: many[7] });
  assert.ok(performance.now() - t0 < 1500, "clearSpot too slow");
  // Saved spots: only valid kinds and fields survive; a spot comes from the nearer window edges.
  assert.deepEqual({ ...readSpots({ panel: { ax: "r", x: 20.4, ay: "b", y: 30 }, bogus: { ax: "l", x: 1, ay: "t", y: 1 }, fonts: { ax: "x", x: 1, ay: "t", y: 1 } }) }, { panel: { ax: "r", x: 20, ay: "b", y: 30 } });
  assert.deepEqual({ ...spotFrom({ left: 700, top: 500, right: 780, bottom: 580 }, 800, 600) }, { ax: "r", x: 20, ay: "b", y: 20 });
});

function newestHeadlessChrome() {
  const root = path.join(os.homedir(), ".t3/tools/chrome-headless-shell/mac-arm64");
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((v) => /^\d+(\.\d+)+$/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return path.join(root, versions[0] ?? "missing", "chrome-headless-shell");
}
const CHROME = newestHeadlessChrome();
const OUT_ROOT = process.env.T3X_GROUPING_OUT || path.join(SRC, "task-output");
const OUT = path.join(OUT_ROOT, "screenshots");
const PARAS = Array.from({ length: 9 }, (_, i) => `<p id="p${i}">Reply paragraph ${i + 1}: the words you are judging while you change their font, long enough to wrap onto a second line.</p>`).join("");
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>
  /* Functional harness only, not T3's theme. */
  :root { --foreground:#eee; --background:#151515; --border:#555; --popover:#222; --muted-foreground:#aaa; --accent:#2a2a2a; --primary:#7aa2ff; --font-sans:Arial,sans-serif; --font-mono:Menlo,monospace; color-scheme:dark; }
  body { margin:0; background:#151515; color:#eee; font:15px/1.5 var(--font-sans); }
  main { position:absolute; left:200px; top:0; width:420px; padding:12px 24px; }
</style>
<link rel="stylesheet" href="/extras.css"></head><body>
<main><div data-message-role="assistant"><div class="chat-markdown" id="reply">${PARAS}</div></div></main>
<button id="anchor" style="position:fixed;left:20px;bottom:20px">✦</button>
<script>window.__T3X_PICK_TEST__ = {};</script>
<script src="/extras.js"></script></body></html>`;
const CATALOG = [{ name: "Arial", source: "mac", local: ["Arial"], style: "print", group: "hand", width: 100 }];

test("popups drag by their top bar, reopen there, and the Fonts card sits clear of its text", { timeout: 120_000 }, async () => {
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
  const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 115_000);
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
    const mouse = (type, x, y, { down = false, count = 1 } = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !down ? "none" : "left", buttons: down ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : count });
    const drag = async (p, dx, dy) => {
      await mouse("mouseMoved", p.x, p.y); await mouse("mousePressed", p.x, p.y, { down: true });
      for (let i = 1; i <= 6; i++) await mouse("mouseMoved", p.x + (dx * i) / 6, p.y + (dy * i) / 6, { down: true });
      await mouse("mouseReleased", p.x + dx, p.y + dy); await frames();
    };
    const dblclick = async (p) => {
      await mouse("mouseMoved", p.x, p.y);
      for (const count of [1, 2]) { await mouse("mousePressed", p.x, p.y, { down: true, count }); await mouse("mouseReleased", p.x, p.y, { count }); }
      await frames();
    };
    const key = async (k, code, vk) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk }); await frames(); };
    const shot = async (name) => { const p = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, name), Buffer.from(p.result.data, "base64")); };
    const rect = (sel) => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return b ? { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom), width: Math.round(b.width), height: Math.round(b.height) } : null; })()`);
    const center = async (sel) => { const b = await rect(sel); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; };
    const saved = () => ev(`JSON.parse(localStorage.getItem("t3x:settings:v1") || "{}").popSpots ?? {}`);
    const viewport = async (width, height) => { await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }); await ev("new Promise((r) => setTimeout(r, 150))"); await frames(); };
    const near = (a, b, tol = 2) => Math.abs(a.left - b.left) <= tol && Math.abs(a.top - b.top) <= tol;
    // The bar's width follows its text, so it keeps the edges its spot is measured from.
    const sameEdges = (a, b, sp, tol = 2) => Math.abs((sp.ax === "r" ? a.right - b.right : a.left - b.left)) <= tol && Math.abs((sp.ay === "b" ? a.bottom - b.bottom : a.top - b.top)) <= tol;
    const T = "window.__T3X_PICK_TEST__";

    await send("Runtime.enable");
    await send("Page.enable");
    await viewport(1100, 760);
    const url = `http://127.0.0.1:${server.address().port}/`;
    await send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 500));
    await ev(`localStorage.setItem("t3x:settings:v1", JSON.stringify({ fontSchema: 2, fontMain: { family: "Arial", size: null } })), 1`);
    await send("Page.navigate", { url });
    assert.equal(await ev(`(async () => { for (let i = 0; i < 100; i++) { if (${T}?.openPanel) return "ready"; await new Promise((r) => setTimeout(r, 50)); } return "missing"; })()`), "ready");
    await new Promise((r) => setTimeout(r, 600));

    // 1. The ✦ panel: ⠿ on its top bar; dragging the bar moves it and it stays open; it reopens there.
    const toggle = () => ev(`${T}.openPanel(document.getElementById("anchor")), 1`).then(frames);
    await toggle();
    assert.equal(await ev(`!!document.querySelector(".t3x-pop .t3x-pop-head > .t3x-grip")`), true, "no ⠿ on the panel's top bar");
    const home = await rect(".t3x-pop");
    await drag(await center(".t3x-pop-head strong"), 520, -60);
    const moved = await rect(".t3x-pop");
    assert.ok(moved && Math.abs(moved.left - home.left - 520) <= 2, `panel didn't follow the drag: ${JSON.stringify({ home, moved })}`);
    assert.equal((await saved()).panel?.ax, "r", "the panel's spot is measured from the right edge it's nearer");
    await shot("popup-move-panel.png");
    await toggle(); await toggle();
    assert.ok(near(await rect(".t3x-pop"), moved), "the panel didn't reopen where it was left");
    // …and after a reload (T3 restarting), from the saved settings.
    await toggle();
    await send("Page.navigate", { url });
    assert.equal(await ev(`(async () => { for (let i = 0; i < 100; i++) { if (${T}?.openPanel) return "ready"; await new Promise((r) => setTimeout(r, 50)); } return "missing"; })()`), "ready");
    await new Promise((r) => setTimeout(r, 400));
    await toggle();
    assert.ok(near(await rect(".t3x-pop"), moved), "the panel's spot didn't survive a reload");
    // Arrow keys on ⠿ move it; Home puts it back where ✦ opens it and forgets the spot.
    await ev(`document.querySelector(".t3x-pop .t3x-grip").focus(), 1`);
    await key("ArrowLeft", "ArrowLeft", 37);
    assert.equal((await rect(".t3x-pop")).left, moved.left - 16, "ArrowLeft on ⠿ moves 16px");
    assert.equal(await ev(`document.activeElement?.matches(".t3x-grip")`), true, "focus stays on ⠿");
    await key("Home", "Home", 36);
    assert.ok(near(await rect(".t3x-pop"), home), "Home didn't put the panel back");
    assert.equal((await saved()).panel, undefined);
    // Double-click on the bar puts it back too.
    await drag(await center(".t3x-pop-head strong"), 300, 0);
    assert.ok(!near(await rect(".t3x-pop"), home));
    await dblclick(await center(".t3x-pop-head strong"));
    assert.ok(near(await rect(".t3x-pop"), home), "double-click didn't put the panel back");
    // A long panel scrolls under its top bar, which stays in reach.
    await ev(`(() => { const d = document.querySelector(".t3x-pop details.t3x-more"); if (!d.open) d.querySelector("summary").click(); })(), 1`); await frames();
    await ev(`(() => { const p = document.querySelector(".t3x-pop"); p.scrollTop = p.scrollHeight; })(), 1`); await frames();
    const head = await rect(".t3x-pop-head"), panel = await rect(".t3x-pop");
    assert.ok(await ev(`document.querySelector(".t3x-pop").scrollTop > 50`), "panel too short to test scrolling");
    assert.ok(head.top >= panel.top - 1 && head.top <= panel.top + 2, `the top bar scrolled away: ${JSON.stringify({ head, panel })}`);
    await shot("popup-move-panel-scrolled.png");
    await toggle();

    // 2. The full Fonts window: no dark wash; drags by its header; never lost off an edge; resize keeps it in reach.
    await ev(`${T}.openFontsAt("main"), 1`); await frames();
    assert.equal(await ev(`getComputedStyle(document.querySelector(".t3x-font-workspace"), "::backdrop").backgroundColor`), "rgba(0, 0, 0, 0)");
    const big0 = await rect(".t3x-font-workspace");
    await drag(await center("#t3x-fonts-title"), 2000, 30);
    const big1 = await rect(".t3x-font-workspace");
    assert.ok(big1.left <= 1100 - 160 && big1.left > big0.left, `the window went too far or nowhere: ${JSON.stringify(big1)}`);
    await drag(await center("#t3x-fonts-title"), -300, 0);
    const big2 = await rect(".t3x-font-workspace");
    assert.equal((await saved()).fonts?.ax, "r");
    await shot("popup-move-fonts.png");
    await viewport(900, 700);
    const big3 = await rect(".t3x-font-workspace");
    assert.ok(big3.left <= 900 - 160 && big3.top >= 0 && big3.top <= 700 - 48, `resized window lost the Fonts window: ${JSON.stringify(big3)}`);
    await viewport(1100, 760);
    assert.ok(near(await rect(".t3x-font-workspace"), big2), "the Fonts window didn't return to its spot after the resize");

    // 3. Small card: non-modal, named by its area, focus inside, and clear of the Replies text.
    await ev(`document.querySelector(".t3x-font-small").click(), 1`); await frames();
    const card = await ev(`(() => { const el = document.querySelector(".t3x-font-workspace"), c = el.getBoundingClientRect();
      const paras = [...document.querySelectorAll("#reply p")].map((p) => p.getBoundingClientRect());
      return { mode: el.dataset.mode, modal: el.matches(":modal"), label: el.getAttribute("aria-labelledby"), focus: el.contains(document.activeElement) && document.activeElement.getClientRects().length > 0,
        covers: paras.filter((p) => p.left < c.right && c.left < p.right && p.top < c.bottom && c.top < p.bottom).length, inView: c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight }; })()`);
    assert.deepEqual(card, { mode: "dock", modal: false, label: "t3x-font-editor-title", focus: true, covers: 0, inView: true });
    const foot = await ev(`(() => { const c = document.querySelector(".t3x-font-workspace").getBoundingClientRect(), d = [...document.querySelectorAll(".t3x-font-dockbar button")].find((b) => b.textContent === "Done").getBoundingClientRect(); return d.bottom <= c.bottom && d.top >= c.top; })()`);
    assert.equal(foot, true, "the card's Done button is scrolled out of view");
    await shot("popup-move-small-card.png");
    // Drag the card (over the text, on purpose); a resize keeps it there, inside the window.
    await drag(await center(".t3x-font-dockgrip"), -560, 40);
    const card1 = await rect(".t3x-font-workspace");
    assert.ok((await saved()).card, "the card's spot wasn't saved");
    await viewport(1000, 700);
    const card2 = await rect(".t3x-font-workspace");
    assert.ok(card2.right <= 1000 && card2.bottom <= 700 && card2.left >= 0, `resize pushed the card out: ${JSON.stringify(card2)}`);
    await viewport(1100, 760);
    assert.ok(near(await rect(".t3x-font-workspace"), card1), "the card didn't keep its spot");
    // "All fonts…" brings back the full window, modal, at its own spot.
    await ev(`[...document.querySelectorAll(".t3x-font-dockbar button")].find((b) => b.textContent.startsWith("All fonts")).click(), 1`); await frames();
    assert.equal(await ev(`document.querySelector(".t3x-font-workspace").matches(":modal")`), true);
    assert.ok(near(await rect(".t3x-font-workspace"), big2), "All fonts… didn't restore the window's spot");
    await dblclick(await center("#t3x-fonts-title"));
    assert.ok(near(await rect(".t3x-font-workspace"), big0), "double-click didn't centre the window again");
    await ev(`document.querySelector('[aria-label="Close Fonts"]').click(), 1`); await frames();

    // 4. Find fonts on screen: the bar drags (and the drag picks nothing); a pick under the card's saved spot moves the card off it.
    await ev(`${T}.startFontPick(), 1`); await frames();
    const bar0 = await rect(".t3x-pick-bar");
    await drag(await center(".t3x-pick-bar span"), 300, -500);
    const bar1 = await rect(".t3x-pick-bar");
    assert.ok(bar1.top < bar0.top - 300 && (await ev(`!!${T}.active()`)), `bar didn't move, or the drag ended picking: ${JSON.stringify(bar1)}`);
    const barSpot = (await saved()).pickbar;
    assert.ok(barSpot);
    // GPT-6.1-Sol's cases: the hint updates leave ⠿ alone, and a shrinking window keeps the moved bar in reach.
    await ev("new Promise((r) => setTimeout(r, 400))"); await frames();
    assert.equal(await ev(`document.querySelector(".t3x-pick-bar .t3x-grip").textContent`), "⠿", "the hint text overwrote ⠿");
    assert.match(await ev(`document.querySelector(".t3x-pick-bar > span").textContent`), /Click text to change its font/);
    assert.ok(sameEdges(await rect(".t3x-pick-bar"), bar1, barSpot), "the bar left its spot when its text changed");
    await viewport(400, 300);
    const small = await rect(".t3x-pick-bar");
    assert.ok(small.left >= 0 && small.right <= 400 && small.top >= 0 && small.bottom <= 300, `a shrinking window lost the bar: ${JSON.stringify(small)}`);
    await viewport(1100, 760);
    assert.ok(sameEdges(await rect(".t3x-pick-bar"), bar1, barSpot), "the bar didn't return to its spot after the resize");
    const target = await rect("#p1");
    assert.ok(overlaps(card1, target), "fixture: the saved card spot should cover paragraph 2");
    await mouse("mouseMoved", target.left + 30, target.top + 8); await frames();
    await mouse("mousePressed", target.left + 30, target.top + 8, { down: true }); await mouse("mouseReleased", target.left + 30, target.top + 8); await frames();
    const picked = await rect(".t3x-font-workspace");
    assert.equal(await ev(`document.querySelector(".t3x-font-workspace")?.dataset.mode`), "dock");
    assert.ok(!overlaps(picked, await rect("#p1")), `the card covers the text just picked: ${JSON.stringify(picked)}`);
    await ev(`[...document.querySelectorAll(".t3x-font-dockbar button")].find((b) => b.textContent === "Done").click(), 1`); await frames();
    await ev(`${T}.startFontPick(), 1`); await frames();
    const bar2 = await rect(".t3x-pick-bar");
    assert.ok(sameEdges(bar2, bar1, barSpot), `the bar didn't come back at its spot: ${JSON.stringify({ bar1, bar2, barSpot, now: (await saved()).pickbar, moved: await ev(`document.querySelector(".t3x-pick-bar").hasAttribute("data-t3x-moved")`) })}`);
    await ev(`${T}.endInspector(), 1`);

    // 5. Switch off: no ⠿, ✦ placement, the dim, no Small card, and the bar no longer drags.
    await toggle();
    await ev(`document.querySelector('[data-focus="sw-popMove"]').click(), 1`); await frames();
    assert.equal(await ev(`[...document.querySelectorAll(".t3x-grip")].some((g) => g.getClientRects().length)`), false, "⠿ still showing");
    await toggle(); await toggle();
    const off = await rect(".t3x-pop"); // Settings is open now, so the panel is taller: it still grows up from above ✦
    assert.ok(Math.abs(off.left - home.left) <= 3 && Math.abs(off.bottom - home.bottom) <= 3, `switch off: the panel isn't where ✦ opens it: ${JSON.stringify({ off, home })}`);
    const still = await rect(".t3x-pop");
    await drag(await center(".t3x-pop-head strong"), 300, 0);
    assert.ok(near(await rect(".t3x-pop"), still), "switch off: the panel still drags");
    await toggle();
    await ev(`${T}.openFontsAt("main"), 1`); await frames();
    assert.equal(await ev(`getComputedStyle(document.querySelector(".t3x-font-workspace"), "::backdrop").backgroundColor`), "rgba(0, 0, 0, 0.4)");
    assert.equal(await ev(`document.querySelector(".t3x-font-small").getClientRects().length`), 0, "Small card showing with the switch off");
    assert.ok(near(await rect(".t3x-font-workspace"), big0), "switch off: the window isn't centred");
    await ev(`document.querySelector('[aria-label="Close Fonts"]').click(), 1`); await frames();
    // Switch off, the bar doesn't drag, and a pick opens the card beside the picked text as before, not at the card's saved spot.
    await ev(`${T}.startFontPick(), 1`); await frames();
    const offBar = await rect(".t3x-pick-bar");
    await drag(await center(".t3x-pick-bar span"), -30, 0); // ends on the bar: off, a release over text would pick it, as before
    assert.ok(near(await rect(".t3x-pick-bar"), offBar) && (await ev(`!!${T}.active()`)), "switch off: the bar still drags");
    const p4 = await rect("#p4");
    await mouse("mouseMoved", p4.left + 30, p4.top + 8); await frames();
    await mouse("mousePressed", p4.left + 30, p4.top + 8, { down: true }); await mouse("mouseReleased", p4.left + 30, p4.top + 8); await frames();
    const offCard = await rect(".t3x-font-workspace");
    assert.ok(offCard && !overlaps(offCard, p4) && !near(offCard, card1), `switch off: the card isn't docked beside the text: ${JSON.stringify(offCard)}`);
    await ev(`[...document.querySelectorAll(".t3x-font-dockbar button")].find((b) => b.textContent === "Done").click(), 1`); await frames();
    // Switch on again: the saved spots come back.
    await toggle();
    await ev(`document.querySelector('[data-focus="sw-popMove"]').click(), 1`); await frames();
    await toggle();
    await ev(`${T}.startFontPick(), 1`); await frames();
    assert.ok(sameEdges(await rect(".t3x-pick-bar"), bar1, barSpot), "switch on again: the bar's spot wasn't restored");
    await ev(`${T}.endInspector(), 1`);
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
