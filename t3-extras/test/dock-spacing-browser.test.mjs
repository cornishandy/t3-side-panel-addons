// Dock spacing S5 (Andy, 15 Nov 2026): one browser test per build check, against the real extras.css and extras.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fontCatalogProjection, fontAboutProjection } from "../lib.mjs";

function newestHeadlessChrome() {
  const root = path.join(os.homedir(), ".t3/tools/chrome-headless-shell/mac-arm64");
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((v) => /^\d+(\.\d+)+$/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return path.join(root, versions[0] ?? "missing", "chrome-headless-shell");
}
const SRC = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.T3X_CHROME || newestHeadlessChrome();
const OUT_ROOT = process.env.T3X_GROUPING_OUT || path.join(SRC, "task-output");
const FONT_DIRS = [process.env.T3X_FONTS_DIR, path.join(os.homedir(), ".local/share/t3-extras/fonts")].filter(Boolean);
const fontFile = (f) => FONT_DIRS.map((d) => path.join(d, f)).find((p) => fs.existsSync(p));
const FONTS = JSON.parse(fs.readFileSync(path.join(SRC, "fonts.json"), "utf8"));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(SRC, "test/fixtures/font-about.fixture.json"), "utf8"));
const HAVE_FONTS = !!fontFile("klee-one-latin-400.woff2") && !!fontFile("zen-kurenaido-latin-400.woff2");
const SKIP = !HAVE_FONTS && "font files not found";

// Check 13: T3's own UI font is the system font. Scroll bars are forced on below, because this Chrome hides them.
const THEME = `:root{--foreground:#2d2f3e;--background:#e9ebf0;--border:#c3c6d0;--popover:#f2f3f7;--popover-foreground:#2d2f3e;--muted-foreground:#6f7280;--accent:rgba(100,105,130,.14);--primary:#8a3ffc;--font-sans:system-ui,sans-serif;--font-mono:ui-monospace,monospace}
body{margin:0;background:#e9ebf0;color:#2d2f3e;font:15px/1.5 var(--font-sans)}
.t3x-font-workspace[data-mode="dock"] .t3x-font-workspace-body{scrollbar-gutter:stable}
.t3x-font-workspace[data-mode="dock"] .t3x-font-workspace-body::-webkit-scrollbar{width:14px}`;
const SETTINGS = {
  fontSchema: 2, fontPicker: true, fontPickDock: true, popMove: true,
  fontComposer: { family: "Klee One", size: 120 }, fontMain: { family: "Zen Kurenaido", size: 130 }, fontQuestions: { family: "Dekko", size: null },
  fontSources: { composer: "own", prompts: "link:composer", main: "own", questions: "own" },
};
const server = { aboutMode: "ok", aboutDelay: 0, body: "", records: "fixture", holdAll: false, holdExcept: "", held: [], heldNames: [] };
const page = () => `<!doctype html><html><head><meta charset="utf-8"><style>${THEME}</style><link rel="stylesheet" href="/extras.css"></head><body>${server.body}<button id="anchor" style="position:fixed;left:8px;bottom:8px">star</button>
<script>window.__T3X_PICK_TEST__ = {}; window.__errors = []; addEventListener("error", (e) => __errors.push(String(e.message))); addEventListener("unhandledrejection", (e) => __errors.push(String(e.reason)));</script><script src="/extras.js"></script></body></html>`;
const replyAt = (top, left = 40, width = 420) => `<div data-message-role="assistant" style="position:fixed;left:${left}px;top:${top}px;width:${width}px"><div class="chat-markdown"><p id="reply" style="margin:0">Reply prose that Replies styles, long enough to pick.</p></div></div>`;
const composerAt = (top, left = 12, width = 596) => `<div data-testid="composer-editor" contenteditable="true" style="position:fixed;left:${left}px;top:${top}px;width:${width}px;margin:0"><p id="cp" style="margin:0">Typed text in the composer, long enough to run the width of this window.</p></div>`;

let chrome, ws, srv, profile, nextId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 700));
  return m.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))");
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
const clickAt = async (x, y) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const key = async (k, code = k) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: code === "Tab" ? 9 : 0 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: code === "Tab" ? 9 : 0 }); };

before(async () => {
  srv = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname;
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
    if (name === "/extras.css" || name === "/extras.js") {
      res.writeHead(200, { "Content-Type": `${name.endsWith("css") ? "text/css" : "text/javascript"}; charset=utf-8`, "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(path.join(SRC, "public", name.slice(1)), "utf8").replace('const BASE = "http://127.0.0.1:8793/";', "const BASE = location.origin + \"/\";"));
    }
    if (name === "/font-catalog") return json(fontCatalogProjection(FONTS));
    if (name === "/font-about") {
      const send = () => {
        if (server.aboutMode === "fail") { res.writeHead(500); return res.end("no"); }
        json(fontAboutProjection(FIXTURE, FONTS));
      };
      // A fail used to answer at once, so the sentence could arrive before the touch in check 6.
      if (server.aboutDelay) return void setTimeout(send, server.aboutDelay);
      return send();
    }
    if (name.startsWith("/fonts/")) {
      const base = path.basename(name);
      const f = fontFile(base);
      const sendFile = () => { if (!f) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": "font/woff2", "Cache-Control": "no-store" }); res.end(fs.readFileSync(f)); };
      if (server.holdAll && base !== server.holdExcept) { server.held.push(sendFile); server.heldNames.push(base); return; }
      return sendFile();
    }
    if (name === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page()); }
    json({});
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(OUT_ROOT, "tmp"), { recursive: true });
  profile = fs.mkdtempSync(path.join(OUT_ROOT, "tmp", "chprof-"));
  chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--window-size=1512,945", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let wsUrl = "";
  for (let i = 0; i < 150 && !wsUrl; i++) {
    await sleep(100);
    try { const [port] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n"); wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? ""; } catch {}
  }
  ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
});
after(async () => {
  try { ws?.close(); } catch {}
  chrome?.kill("SIGKILL");
  srv?.close();
  await sleep(200);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const url = () => `http://127.0.0.1:${srv.address().port}/`;
async function load({ width = 1100, height = 800, settings = SETTINGS, body = "", aboutMode = "ok", aboutDelay = 0 } = {}) {
  Object.assign(server, { aboutMode, aboutDelay, body, holdAll: false, holdExcept: "", held: [], heldNames: [] });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await mouse("mouseMoved", 2, 2);
  await send("Page.navigate", { url: url() });
  await sleep(250);
  await ev(`localStorage.setItem("t3x:settings:v1", ${JSON.stringify(JSON.stringify(settings))}), 1`);
  await send("Page.navigate", { url: url() });
  await ev(`(async () => { for (let i = 0; i < 100; i++) { if (window.__T3X_PICK_TEST__?.startFontPick) return 1; await new Promise((r) => setTimeout(r, 50)); } throw new Error("add-ons did not load"); })()`);
  await sleep(200);
}
async function pick(id = "reply") {
  await ev(`window.__T3X_PICK_TEST__.startFontPick(), 1`);
  await sleep(600);
  const p = await ev(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById(${JSON.stringify(id)})); const t = r.getClientRects()[0]; return { x: t.left + 24, y: t.top + t.height / 2 }; })()`);
  await clickAt(p.x, p.y);
  await ev(`(async () => { for (let i = 0; i < 80; i++) { if (document.querySelector(".t3x-font-workspace")?.dataset.mode === "dock") return 1; await new Promise((r) => setTimeout(r, 25)); } throw new Error("dock did not open"); })()`);
  return p;
}
const settle = async () => { await sleep(700); await frames(); };
async function openAbout() {
  await ev(`document.querySelector(".t3x-font-dockdetails > summary").scrollIntoView({ block: "center" }), 1`);
  await frames();
  const s = await ev(`(() => { const r = document.querySelector(".t3x-font-dockdetails > summary").getBoundingClientRect(); return { x: r.left + 16, y: r.top + r.height / 2 }; })()`);
  await clickAt(s.x, s.y);
  await sleep(200);
  await frames();
}
const metrics = () => ev(`(() => {
  const el = document.querySelector(".t3x-font-workspace"), body = el.querySelector(".t3x-font-workspace-body"), bar = el.querySelector(".t3x-font-dockbar");
  const cue = el.querySelector(".t3x-dock-cue"), tab = el.querySelector(".t3x-dock-cue-tab"), foot = el.querySelector(".t3x-font-dockfoot");
  const box = (n) => { if (!n || !n.getClientRects().length) return null; const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const textEl = document.getElementById("reply") || document.getElementById("cp");
  const rg = document.createRange(); rg.selectNodeContents(textEl); const t = rg.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  const sepX = Math.max(0, t.left - b.right, b.left - t.right), sepY = Math.max(0, t.top - b.bottom, b.top - t.bottom);
  const gap = sepX === 0 && sepY === 0 ? 0 : sepX === 0 ? sepY : sepY === 0 ? sepX : Math.hypot(sepX, sepY);
  const buttons = [...bar.querySelectorAll(":scope > .t3x-btn")].map((n) => ({ text: n.textContent, ...box(n) }));
  return { gap, card: box(el), bar: box(bar), cue: box(cue), tab: box(tab), foot: box(foot), buttons, sentence: el.querySelector(".t3x-font-docksentence").textContent,
    scroll: body.scrollHeight - body.scrollTop - body.clientHeight, scrollTop: body.scrollTop, padTop: getComputedStyle(bar).paddingTop, height: el.style.height,
    cueHidden: cue.hidden, tabH: tab ? getComputedStyle(tab).height : null, font: getComputedStyle(el).fontFamily, sans: getComputedStyle(el).getPropertyValue("--font-sans").trim(),
    spots: JSON.parse(localStorage.getItem("t3x:settings:v1")).popSpots, errors: window.__errors };
})()`);
const noErrors = async (where) => assert.deepEqual(await ev("window.__errors"), [], where);
const dockFlags = () => ev(`(() => { const w = window.__T3X_PICK_TEST__.workspace(); return { touched: !!w?.dockTouched, once: !!w?.dockScrolledOnce }; })()`);
// Rewind the failed-card scroll without it counting as a touch. The product treats a trusted scroll as a touch, so this marks the write as the card's own and swallows that one event.
const rewindScroll = () => ev(`new Promise((resolve) => {
  const body = document.querySelector(".t3x-font-workspace-body");
  const w = window.__T3X_PICK_TEST__.workspace();
  const finish = () => resolve(body.scrollTop);
  if (body.scrollTop === 0) return finish();
  w.dockOwnScroll = (w.dockOwnScroll || 0) + 1;
  const onScroll = (e) => { e.stopImmediatePropagation(); body.removeEventListener("scroll", onScroll, true); finish(); };
  body.addEventListener("scroll", onScroll, true);
  body.scrollTop = 0;
})`);
const press = (label) => ev(`document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}).dispatchEvent(new MouseEvent("click", { bubbles: true })), 1`);

test("1. the tab's hit area is the whole gap between All fonts and Done", { timeout: 90_000, skip: SKIP }, async () => {
  await load({ body: replyAt(40), width: 1200, height: 640 });
  await pick();
  await settle();
  await openAbout();
  const m = await metrics();
  assert.equal(m.cueHidden, false, "content remains below, so the tab is up");
  const before = m.buttons.find((b) => b.text.startsWith("All fonts"));
  const done = m.buttons.find((b) => b.text === "Done");
  assert.ok(before && done && done.left - before.right > 20, "the two buttons share a row with a clear gap");
  const ys = [m.bar.top + 4, (m.bar.top + m.bar.bottom) / 2, m.bar.bottom - 4];
  const xs = [before.right + 3, (before.right + done.left) / 2, done.left - 3];
  const hits = await ev(`(() => {
    const cue = document.querySelector(".t3x-dock-cue");
    const on = (x, y) => { const n = document.elementFromPoint(x, y); return !!(n && (n === cue || cue.contains(n))); };
    const btn = (text, x, y) => { const n = document.elementFromPoint(x, y); return n?.closest?.("button")?.textContent === text; };
    return { gap: ${JSON.stringify(xs)}.flatMap((x) => ${JSON.stringify(ys)}.map((y) => on(x, y))),
      all: btn("All fonts…", ${(before.left + before.right) / 2}, ${(before.top + before.bottom) / 2}),
      done: btn("Done", ${(done.left + done.right) / 2}, ${(done.top + done.bottom) / 2}) };
  })()`);
  assert.deepEqual(hits.gap, [true, true, true, true, true, true, true, true, true], "every point in the gap is the tab, not a neighbour");
  assert.equal(hits.all, true, "All fonts still receives its own click");
  assert.equal(hits.done, true, "Done still receives its own click");
  await noErrors("check 1");
});

test("2. the tab is 9 px and the bar's top padding is 12, with popMove on and off", { timeout: 120_000, skip: SKIP }, async () => {
  for (const popMove of [true, false]) {
    await load({ body: replyAt(40), width: 1200, height: 640, settings: { ...SETTINGS, popMove } });
    await pick();
    await settle();
    await openAbout();
    const m = await metrics();
    assert.equal(m.padTop, "12px", `popMove ${popMove}: bar top padding`);
    assert.equal(m.tabH, "9px", `popMove ${popMove}: tab height`);
    assert.ok(9 + 3 <= 12, "tab height plus 3 fits in the padding");
    assert.ok(m.tab && m.tab.height <= 12 && m.tab.top >= m.bar.top - 1.5, `popMove ${popMove}: the tab hangs in the padding`);
  }
  await noErrors("check 2");
});

test("3. a wrapped bar never puts the tab on a button", { timeout: 90_000, skip: SKIP }, async () => {
  await load({ body: replyAt(40, 40, 200), width: 900, height: 640 });
  await pick();
  await settle();
  await openAbout();
  await ev(`document.querySelector(".t3x-font-workspace").style.width = "200px", 1`);
  await ev(`window.dispatchEvent(new Event("resize")), 1`);
  await sleep(200);
  await frames();
  const m = await metrics();
  assert.equal(m.cueHidden, false, "the tab is still up on the narrow card");
  assert.ok(m.buttons.some((b, i) => m.buttons.slice(i + 1).some((c) => Math.abs((b.top + b.bottom) / 2 - (c.top + c.bottom) / 2) > 10)), "the bar wrapped");
  const onButton = m.buttons.some((b) => m.tab && m.tab.left < b.right - 0.5 && b.left < m.tab.right - 0.5 && m.tab.top < b.bottom - 0.5 && b.top < m.tab.bottom - 0.5);
  assert.equal(onButton, false, "the 28 px tab misses every button");
  assert.ok(Math.abs(m.tab.width - 28) < 0.6 && Math.abs(m.tab.height - 9) < 0.6, "the tab stays 28 by 9");
  await noErrors("check 3");
});

test("4. one click on the tab reveals the rest and the tab goes away", { timeout: 90_000, skip: SKIP }, async () => {
  await load({ body: replyAt(40), width: 1200, height: 640 });
  await pick();
  await settle();
  await openAbout();
  const before = await metrics();
  assert.ok(before.scroll > 1 && before.cueHidden === false, "there is something below");
  const beforeBtn = before.buttons.find((b) => b.text.startsWith("All fonts"));
  await clickAt(beforeBtn.right + 6, before.bar.top + 6);
  await sleep(150);
  await frames();
  const after = await metrics();
  assert.ok(after.scroll <= 1, `content remains below (${after.scroll})`);
  assert.equal(after.cueHidden, true, "the tab hides at the end");
  await noErrors("check 4");
});

test("5. tabbing to Hide scrolls it into view above the bar", { timeout: 90_000, skip: SKIP }, async () => {
  await load({ width: 700, height: 460, aboutMode: "fail", body: composerAt(200, 16, 660), settings: { ...SETTINGS, popMove: true } });
  await pick("cp");
  await settle();
  await ev(`document.querySelector(".t3x-font-workspace-body").scrollTop = 0, 1`);
  await frames();
  const hid = await ev(`(() => { const foot = document.querySelector(".t3x-font-dockfoot button"); const bar = document.querySelector(".t3x-font-dockbar").getBoundingClientRect(); const r = foot.getBoundingClientRect(); return { below: r.top >= bar.bottom - 1, label: foot.textContent }; })()`);
  assert.equal(hid.label, "Hide this font");
  assert.equal(hid.below, true, "Hide starts below the fold");
  await ev(`document.querySelector(".t3x-font-workspace button").focus({ preventScroll: true }), 1`);
  for (let i = 0; i < 25; i++) {
    const onHide = await ev(`document.activeElement?.getAttribute("data-focus") === "about-hide"`);
    if (onHide) break;
    await key("Tab", "Tab");
    await frames();
  }
  const end = await ev(`(() => { const foot = document.querySelector(".t3x-font-dockfoot button"); const bar = document.querySelector(".t3x-font-dockbar").getBoundingClientRect(); const r = foot.getBoundingClientRect(); return { focused: document.activeElement === foot, top: r.top, bottom: r.bottom, barTop: bar.top, bodyTop: document.querySelector(".t3x-font-workspace-body").getBoundingClientRect().top }; })()`);
  assert.equal(end.focused, true, "Tab landed on Hide");
  assert.ok(end.top >= end.bodyTop - 1 && end.bottom <= end.barTop + 1, `Hide sits in view above the bar (${end.top}–${end.bottom}, bar ${end.barTop})`);
  await noErrors("check 5");
});

test("6. a pointer, key, press or wheel before the details arrive blocks the one scroll", { timeout: 180_000, skip: SKIP }, async () => {
  const openDuringWait = async (touch) => {
    await load({ width: 700, height: 460, aboutMode: "fail", aboutDelay: 800, body: composerAt(200, 16, 660) });
    await pick("cp");
    const early = await ev(`document.querySelector(".t3x-font-docksentence")?.textContent || ""`);
    if (early) throw new Error(`details arrived before the touch (${early})`);
    await touch();
    const sentence = await ev(`(async () => { for (let i = 0; i < 40; i++) { const t = document.querySelector(".t3x-font-docksentence")?.textContent; if (t) return t; await new Promise((r) => setTimeout(r, 100)); } return ""; })()`);
    await frames();
    const m = await metrics();
    return { sentence, scrollTop: m.scrollTop, footBelow: m.foot && m.bar && m.foot.top >= m.bar.bottom - 1 };
  };
  const cardPoint = () => ev(`(() => { const r = document.querySelector(".t3x-font-workspace").getBoundingClientRect(); return { x: r.left + 30, y: r.top + 40 }; })()`);
  const pointer = await openDuringWait(async () => { const p = await cardPoint(); await mouse("mouseMoved", p.x, p.y); });
  assert.equal(pointer.sentence, "Font details couldn't load.");
  assert.equal(pointer.footBelow, true, "pointer entry: the foot stays below the bar");
  assert.equal(pointer.scrollTop, 0, "pointer entry: the one scroll did not run");
  // A press dispatched on the card. A bare mouse press at a new point does not move the pointer onto the card first.
  const press = await openDuringWait(async () => { await ev(`document.querySelector(".t3x-font-workspace").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true })), 1`); });
  assert.equal(press.footBelow, true, "press: the foot stays below the bar");
  assert.equal(press.scrollTop, 0, "press: the one scroll did not run");
  // A drag starts at pointerdown. The card does not listen for a separate drag event.
  const drag = await openDuringWait(async () => { await ev(`(() => { const el = document.querySelector(".t3x-font-workspace"); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, isPrimary: true })); el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 1 })); return 1; })()`); });
  assert.equal(drag.footBelow, true, "drag: the foot stays below the bar");
  const keyed = await openDuringWait(async () => { await ev(`document.querySelector(".t3x-font-workspace").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })), 1`); });
  assert.equal(keyed.footBelow, true, "key: the foot stays below the bar");
  const wheeled = await openDuringWait(async () => { await ev(`document.querySelector(".t3x-font-workspace").dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 })), 1`); });
  assert.equal(wheeled.footBelow, true, "wheel: the foot stays below the bar");
  // Setting scrollTop fires a trusted scroll in this browser, so it counts as a scroll in the card.
  const scrolled = await openDuringWait(async () => { await ev(`document.querySelector(".t3x-font-workspace-body").scrollTop = 1, 1`); });
  assert.equal(scrolled.footBelow, true, "scroll: the foot stays below the bar");
  assert.equal(scrolled.scrollTop, 1, "scroll: the one scroll did not run");
  await noErrors("check 6");
});

test("7. both failure sentences get the one scroll", { timeout: 120_000, skip: SKIP }, async () => {
  const run = async (aboutMode, family, expect) => {
    await load({ width: 700, height: 460, aboutMode, body: composerAt(200, 16, 660), settings: { ...SETTINGS, fontComposer: { family, size: 120 } } });
    await pick("cp");
    await settle();
    const m = await metrics();
    assert.equal(m.sentence, expect);
    assert.ok(m.scrollTop > 0, `${expect}: it scrolled`);
    assert.ok(m.foot && m.bar && m.foot.bottom <= m.bar.top + 2, `${expect}: the Hide foot sits just above the bar (${m.foot?.bottom} vs ${m.bar?.top})`);
  };
  await run("fail", "Klee One", "Font details couldn't load.");
  await run("ok", "Dekko", "No details for this font.");
  await noErrors("check 7");
});

test("8. Next and Previous never re-arm the one scroll", { timeout: 90_000, skip: SKIP }, async () => {
  await load({ width: 700, height: 460, aboutMode: "fail", body: composerAt(200, 16, 660) });
  await pick("cp");
  await settle();
  const first = await metrics();
  assert.ok(first.scrollTop > 0, "the first arrival scrolled");
  const armed = await dockFlags();
  assert.equal(armed.touched, false, "the card's own scroll is not a touch");
  assert.equal(armed.once, true, "the one scroll is used");
  assert.equal(await rewindScroll(), 0, "the body is back at the top");
  const quiet = await dockFlags();
  assert.equal(quiet.touched, false, "rewinding the scroll did not count as a touch");
  const back = await metrics();
  assert.ok(back.foot && back.foot.top >= back.bar.bottom - 1, "the foot is below the bar again");
  await press("Next font");
  await sleep(400);
  await frames();
  const next = await metrics();
  assert.equal(next.scrollTop, 0, "Next did not scroll again");
  assert.ok(next.foot && next.foot.top >= next.bar.bottom - 1, "the foot stays below the bar after Next");
  await press("Previous font");
  await sleep(400);
  await frames();
  const prev = await metrics();
  assert.equal(prev.scrollTop, 0, "Previous did not scroll again");
  assert.ok(prev.foot && prev.foot.top >= prev.bar.bottom - 1, "the foot stays below the bar after Previous");
  await noErrors("check 8");
});

test("9. the tab shows and hides on scroll, resize and content change", { timeout: 90_000, skip: SKIP }, async () => {
  await load({ body: replyAt(40), width: 1200, height: 640 });
  await pick();
  await settle();
  await openAbout();
  assert.equal((await metrics()).cueHidden, false, "opening About, with more below, shows the tab");
  await ev(`(() => { const b = document.querySelector(".t3x-font-workspace-body"); b.scrollTop = b.scrollHeight; return 1; })()`);
  await frames();
  assert.equal((await metrics()).cueHidden, true, "scrolled to the end: the tab hides");
  await ev(`document.querySelector(".t3x-font-workspace-body").scrollTop = 0, 1`);
  await frames();
  assert.equal((await metrics()).cueHidden, false, "scrolled back up: the tab returns");
  await ev(`document.querySelector(".t3x-font-workspace").style.width = "300px"; window.dispatchEvent(new Event("resize")); 1`);
  await sleep(150);
  await frames();
  assert.equal((await metrics()).cueHidden, false, "after a resize, with more below, the tab stays");
  await openAbout();
  await frames();
  const closed = await metrics();
  assert.equal(await ev(`document.querySelector(".t3x-font-dockdetails").open`), false);
  assert.equal(closed.cueHidden, true, "closing About, once nothing remains below, hides the tab");
  await noErrors("check 9");
});

test("10. a pin keeps his saved left, and a spot that misses the text stays inside 12 px", { timeout: 120_000, skip: SKIP }, async () => {
  const spot = { ax: "l", x: 20, ay: "t", y: 20 };
  const settings = { ...SETTINGS, popMove: true, popSpots: { card: spot } };
  await load({ width: 900, height: 800, body: replyAt(40, 368, 280), settings });
  await pick();
  await settle();
  const stay = await metrics();
  assert.ok(stay.gap > 0 && stay.gap < 12, `his spot stays ${stay.gap} px from the text`);
  assert.ok(Math.abs(stay.card.left - 20) < 1.5, `left stays ${stay.card.left}`);
  assert.deepEqual(stay.spots.card, spot, "a spot that misses the text is not rewritten");
  await load({ width: 720, height: 800, body: composerAt(340, 0, 700), settings });
  const before = JSON.stringify((await ev(`JSON.parse(localStorage.getItem("t3x:settings:v1")).popSpots`)));
  await pick("cp");
  await settle();
  const pin = await metrics();
  assert.ok(Math.abs(pin.card.left - 20) < 1.5, `the pin keeps his left (${pin.card.left})`);
  assert.ok(pin.gap >= 11.5, `the cap leaves ${pin.gap} px`);
  assert.notEqual(pin.height, "", "the card is capped");
  assert.equal(JSON.stringify(pin.spots), before, "popSpots is not written");
  await noErrors("check 10");
});

test("11. a short-window pin clears when the room comes back, and About's box is kept", { timeout: 120_000, skip: SKIP }, async () => {
  await load({ width: 620, height: 460, body: composerAt(180, 12, 590), settings: { ...SETTINGS, popMove: false } });
  await pick("cp");
  await settle();
  const pinned = await metrics();
  assert.notEqual(pinned.height, "", "the short window pins a height");
  assert.ok(pinned.gap >= 11.5, `pinned gap ${pinned.gap}`);
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await frames();
  const back = await metrics();
  assert.equal(back.height, "", "the pin clears when the window is roomy again");
  assert.ok(back.gap >= 11.5, `after the pin clears, gap ${back.gap}`);
  await openAbout();
  const frozen = (await metrics()).card.height;
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 320, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await frames();
  const short = await metrics();
  assert.ok(short.card.height < frozen - 5, `the window forces the frozen box shorter (${short.card.height} vs ${frozen})`);
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await frames();
  const restored = await metrics();
  assert.ok(Math.abs(restored.card.height - frozen) < 1.5, `About's box comes back (${restored.card.height} vs ${frozen})`);
  await noErrors("check 11");
});

test("12. Next does not shrink the card and grow it back while the next font loads", { timeout: 90_000, skip: SKIP }, async () => {
  // Shadows Into Light is the menu neighbour before Zen Kurenaido, which is the next font that has a details record. Neither face is the page's preloaded font, so the hold is a real miss.
  const settings = { ...SETTINGS, fontComposer: { family: "Shadows Into Light", size: 100 }, fontMain: { family: "Dekko", size: 100 }, fontQuestions: { family: "Handlee", size: null } };
  await load({ body: composerAt(80, 16, 640), width: 1100, height: 800, settings });
  await pick("cp");
  await settle();
  const opened = await metrics();
  assert.equal(await ev(`document.querySelector("#t3x-font-family").value`), "Shadows Into Light");
  assert.equal(opened.sentence, "No details for this font.");
  const start = opened.card.bottom;
  await ev(`(() => { window.__bottoms = []; const el = document.querySelector(".t3x-font-workspace"); new ResizeObserver(() => __bottoms.push(el.getBoundingClientRect().bottom)).observe(el); return 1; })()`);
  server.holdAll = true;
  server.holdExcept = "";
  server.held = [];
  server.heldNames = [];
  await press("Next font");
  let state = null;
  for (let i = 0; i < 40; i++) {
    state = await ev(`(() => { const about = document.querySelector(".t3x-font-dockabout"); return { family: document.querySelector("#t3x-font-family").value, hidden: !!about?.hidden, sentence: document.querySelector(".t3x-font-docksentence").textContent }; })()`);
    if (state.family === "Zen Kurenaido" && state.hidden && state.sentence === "" && server.heldNames.includes("zen-kurenaido-latin-400.woff2")) break;
    await sleep(50);
  }
  assert.equal(state.family, "Zen Kurenaido", "Next lands on the font that has a record");
  assert.equal(state.hidden, true, "the details block hides while the face loads");
  assert.equal(state.sentence, "", "the sentence is empty while the face loads");
  assert.ok(server.heldNames.includes("zen-kurenaido-latin-400.woff2"), `the face is still loading (${server.heldNames.join(", ")})`);
  await sleep(300);
  const during = await ev(`window.__bottoms.slice()`);
  const now = (await metrics()).card.bottom;
  for (const b of [...during, now]) assert.ok(b >= start - 2, `the bottom shrank from ${start} to ${b}`);
  server.held.splice(0).forEach((fn) => fn());
  server.holdAll = false;
  let after = "";
  for (let i = 0; i < 40; i++) {
    after = (await metrics()).sentence;
    if (after) break;
    await sleep(50);
  }
  assert.ok(after && after !== "No details for this font." && after !== "Font details couldn't load.", `the details arrived (${after})`);
  const end = (await metrics()).card.bottom;
  assert.ok(end >= start - 2, `after the details, the bottom is ${end}, from ${start}`);
  await noErrors("check 12");
});

test("13. system font and a narrower card, as a stand-in for always-on scroll bars", { timeout: 90_000, skip: SKIP }, async () => {
  await load({ body: replyAt(48, 24, 360), width: 1100, height: 700 });
  await pick();
  await settle();
  await ev(`document.querySelector(".t3x-font-workspace").style.width = "220px"; window.dispatchEvent(new Event("resize")); 1`);
  await sleep(200);
  await frames();
  const m = await metrics();
  assert.match(m.sans, /system-ui/, "the card is set in the system font");
  assert.ok(m.font && !/Arial/.test(m.font), `computed font is the system font (${m.font})`);
  assert.ok(m.gap >= 11.5, `the narrower card stays ${m.gap} px clear`);
  assert.equal(m.padTop, "12px");
  if (!m.cueHidden && m.tab) {
    const onButton = m.buttons.some((b) => m.tab.left < b.right - 0.5 && b.left < m.tab.right - 0.5 && m.tab.top < b.bottom - 0.5 && b.top < m.tab.bottom - 0.5);
    assert.equal(onButton, false, "the tab stays off the buttons on the narrow card");
  }
  await noErrors("check 13");
});

test("14. the bar keeps its height when the tab hides", { timeout: 90_000, skip: SKIP }, async () => {
  await load({ body: replyAt(40), width: 1200, height: 640 });
  await pick();
  await settle();
  await openAbout();
  const shown = await metrics();
  assert.equal(shown.cueHidden, false);
  const h1 = shown.bar.height;
  await ev(`(() => { const b = document.querySelector(".t3x-font-workspace-body"); b.scrollTop = b.scrollHeight; return 1; })()`);
  await frames();
  const hidden = await metrics();
  assert.equal(hidden.cueHidden, true);
  assert.ok(Math.abs(hidden.bar.height - h1) < 0.6, `bar height ${h1} vs ${hidden.bar.height}`);
  assert.equal(hidden.padTop, "12px");
  await noErrors("check 14");
});

test("15. 12 px holds while details arrive, load, fail, and the card is used", { timeout: 180_000, skip: SKIP }, async () => {
  const gapAt = async (label) => {
    const m = await metrics();
    assert.ok(m.gap >= 11.5, `${label}: gap ${m.gap}`);
    const vh = await ev("innerHeight");
    assert.ok(m.card.top >= 11 && m.card.bottom <= vh - 11, `${label}: card ${m.card.top}–${m.card.bottom} in a ${vh} px window`);
    return m;
  };
  await load({ width: 1100, height: 760, aboutDelay: 900, body: replyAt(80, 24, 280), settings: { ...SETTINGS, popMove: false } });
  await pick();
  const loading = await metrics();
  assert.equal(loading.sentence, "", "details have not arrived yet");
  assert.ok(loading.gap >= 11.5, `while loading: gap ${loading.gap}`);
  await settle();
  await gapAt("details arrived");
  await ev(`document.querySelector('[aria-label="Next font"]').click(), 1`);
  await sleep(200);
  await gapAt("Next, while the next face loads");
  await settle();
  await gapAt("Next, once it has settled");
  await ev(`document.querySelector('[aria-label="Previous font"]').click(), 1`);
  await settle();
  await gapAt("Previous");
  await ev(`document.querySelector('[aria-label="Larger font"]').click(), 1`);
  await settle();
  await gapAt("Size plus");
  await ev(`document.querySelector('[aria-label="Smaller font"]').click(), 1`);
  await settle();
  await gapAt("Size minus");
  await openAbout();
  await gapAt("About open");
  await openAbout();
  await gapAt("About closed");
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 420, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await frames();
  await gapAt("shorter window");
  await load({ width: 700, height: 640, aboutMode: "fail", body: composerAt(300, 16, 660), settings: { ...SETTINGS, popMove: false } });
  await pick("cp");
  await settle();
  const failed = await gapAt("details failed");
  assert.equal(failed.sentence, "Font details couldn't load.");
  await noErrors("check 15");
});

test("16. a frozen About box stays 12 px clear when the window shrinks or the text wraps", { timeout: 180_000, skip: SKIP }, async () => {
  const clear = async (label, height) => {
    const m = await metrics();
    assert.ok(m.gap >= 11.5, `${label}: gap ${m.gap}`);
    assert.ok(m.card.top >= 11 && m.card.bottom <= height - 11, `${label}: card ${m.card.top}–${m.card.bottom} in a ${height} px window`);
    return m;
  };
  await load({ body: composerAt(300, 16, 660), width: 700, height: 800 });
  await pick("cp");
  await settle();
  await openAbout();
  const spots = JSON.stringify((await metrics()).spots);
  await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 360, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await frames();
  await clear("shorter window", 360);
  await load({ width: 1200, height: 800, body: composerAt(300, 16, 660).replace("width:660px", "width:calc(100vw - 32px)") });
  await pick("cp");
  await settle();
  await openAbout();
  await send("Emulation.setDeviceMetricsOverride", { width: 450, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await frames();
  await clear("text wraps in a narrower window", 800);
  await load({ body: replyAt(40), width: 1200, height: 800 });
  await pick();
  await settle();
  await openAbout();
  await send("Emulation.setDeviceMetricsOverride", { width: 620, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await frames();
  const narrow = await clear("narrower window", 800);
  assert.equal(JSON.stringify(narrow.spots), spots, "popSpots is not written");
  await noErrors("check 16");
});
