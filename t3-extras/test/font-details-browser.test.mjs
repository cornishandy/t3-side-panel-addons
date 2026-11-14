// "About this font" in headless Chrome against the real extras.css/extras.js (never the live app):
// S1′ the card in the Fonts window while the font menu is open, S2 the panel, S3′ the ✦ "Your fonts" card,
// S4′ the docked card, the "new" tags, and the records' missing, late, mismatched and hostile states.
// Font files: T3X_FONTS_DIR, else the installed add-on's folder (Klee One and Zen Kurenaido are used).
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
// The shipped records (all 59 families), for the tests that need Yomogi's and Barlow Condensed's warnings or a filtered font.
const SHIPPED = fs.existsSync(path.join(SRC, "font-about.json")) ? JSON.parse(fs.readFileSync(path.join(SRC, "font-about.json"), "utf8")) : null;
const HAVE_SHIPPED = HAVE_FONTS && !!SHIPPED && ["yomogi", "barlow-condensed", "kalam"].every((f) => fontFile(`${f}-latin-400.woff2`));

const THEME = `:root{--foreground:#2d2f3e;--background:#e9ebf0;--border:#c3c6d0;--popover:#f2f3f7;--popover-foreground:#2d2f3e;--muted-foreground:#6f7280;--accent:rgba(100,105,130,.14);--primary:#8a3ffc;--font-sans:Arial,sans-serif;--font-mono:Menlo,monospace}
body{margin:0;background:#e9ebf0;color:#2d2f3e;font:15px/1.5 var(--font-sans)}
ol,ul,menu{list-style:none;margin:0;padding:0}`; // T3's base styles (Tailwind preflight) strip list markers
const SETTINGS = { fontSchema: 2, fontComposer: { family: "Klee One", size: 120 }, fontMain: { family: "Zen Kurenaido", size: 130 }, fontQuestions: { family: "Dekko", size: null },
  fontSources: { composer: "own", prompts: "link:composer", main: "own", questions: "own" } };
const server = { aboutMode: "ok", aboutDelay: 0, catalogHits: 0, aboutHits: 0, body: "", records: "fixture" };
const page = () => `<!doctype html><html><head><meta charset="utf-8"><style>${THEME}</style><link rel="stylesheet" href="/extras.css"></head><body>${server.body}<button id="anchor" style="position:fixed;left:20px;bottom:20px">✦</button>
<script>window.__T3X_PICK_TEST__ = {}; window.__errors = []; addEventListener("error", (e) => __errors.push(String(e.message))); addEventListener("unhandledrejection", (e) => __errors.push(String(e.reason)));</script><script src="/extras.js"></script></body></html>`;
function aboutBody() {
  const base = fontAboutProjection(server.records === "shipped" ? SHIPPED : FIXTURE, FONTS);
  if (server.aboutMode === "mismatch") return { ...base, listVersion: FONTS.listVersion + 1 };
  if (server.aboutMode === "html") return { ...base, records: { ...base.records, "Klee One": { ...base.records["Klee One"], desc: '<img src=x onerror="window.__xss=1"> & <b>bold</b>' } } };
  return base;
}

let chrome, ws, srv, profile, nextId = 0;
const pending = new Map(), exceptions = [];
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 600));
  return m.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))");
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
const click = async (x, y) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const KEYS = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Tab: 9 };
const key = async (k) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: KEYS[k] }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: KEYS[k] }); };

before(async () => {
  srv = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname;
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
    if (name === "/extras.css" || name === "/extras.js") {
      res.writeHead(200, { "Content-Type": `${name.endsWith("css") ? "text/css" : "text/javascript"}; charset=utf-8`, "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(path.join(SRC, "public", name.slice(1)), "utf8").replace('const BASE = "http://127.0.0.1:8793/";', "const BASE = location.origin + \"/\";"));
    }
    if (name === "/font-catalog") { server.catalogHits++; return json(fontCatalogProjection(FONTS)); }
    if (name === "/font-about") {
      server.aboutHits++;
      if (server.aboutMode === "fail") { res.writeHead(500); return res.end("no"); }
      return void setTimeout(() => json(aboutBody()), server.aboutDelay);
    }
    if (name.startsWith("/fonts/")) {
      const f = fontFile(path.basename(name));
      if (!f) { res.writeHead(404); return res.end(); }
      const send = () => { res.writeHead(200, { "Content-Type": "font/woff2" }); res.end(fs.readFileSync(f)); };
      if (server.hold?.file === path.basename(name)) return void server.hold.waiting.push(send); // a cold load, released by the test
      return send();
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
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params?.exceptionDetails?.exception?.description ?? "exception"); });
  await send("Runtime.enable");
  await send("Page.enable");
});
after(async () => {
  try { ws?.close(); } catch {}
  chrome?.kill("SIGKILL");
  srv?.close();
  await sleep(200);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const url = () => `http://127.0.0.1:${srv.address().port}/`;
async function load({ width = 1512, height = 945, settings = SETTINGS, body = "", aboutMode = "ok", aboutDelay = 0, records = "fixture" } = {}) {
  Object.assign(server, { aboutMode, aboutDelay, body, records, catalogHits: 0, aboutHits: 0 });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await mouse("mouseMoved", width - 4, 4); // park the pointer away from everything
  await send("Page.navigate", { url: url() });
  await sleep(300);
  await ev(`localStorage.setItem("t3x:settings:v1", ${JSON.stringify(JSON.stringify(settings))}), 1`);
  Object.assign(server, { catalogHits: 0, aboutHits: 0 });
  await send("Page.navigate", { url: url() });
  await ev(`(async () => { for (let i = 0; i < 100; i++) { if (window.__T3X_PICK_TEST__?.openPanel) return 1; await new Promise((r) => setTimeout(r, 50)); } throw new Error("add-ons did not load"); })()`);
  await sleep(300);
}
async function openFonts(area = "Replies") {
  await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await sleep(400);
  await ev(`document.querySelector('[data-focus="open-fonts"]').click(), 1`); await sleep(500);
  await ev(`(() => { const b = [...document.querySelectorAll(".t3x-font-area")].find((e) => e.querySelector(".t3x-font-area-name").textContent === ${JSON.stringify(area)}); if (b && b.getClientRects().length) b.click(); else window.__T3X_PICK_TEST__.openFontsAt?.(null); return 1; })()`);
  await sleep(600); await frames();
}
async function openMenu() {
  await ev(`document.getElementById("t3x-font-family").scrollIntoView({ block: "center" }), 1`); await sleep(100);
  const s = await ev(`(() => { const r = document.getElementById("t3x-font-family").getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await click(s.x, s.y); await sleep(400);
  await mouse("mouseMoved", 2, 2); await sleep(350); // the pointer off the options, so the next hover is the first
  assert.equal(await ev(`document.getElementById("t3x-font-family").matches(":open")`), true, "the font menu opened");
}
const optionAt = (name) => ev(`(() => { const o = [...document.querySelectorAll("#t3x-font-family option")].find((o) => o.value === ${JSON.stringify(name)}); o.scrollIntoView({ block: "center" }); const r = o.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
// In-page clock: when the pointer last went over an option, and when the card (or its name) last changed.
const watchCard = () => ev(`(() => { window.__w = { over: 0, shown: [] }; document.getElementById("t3x-font-family").addEventListener("pointerover", () => { __w.over = performance.now(); }, true);
  new MutationObserver(() => { const n = document.querySelector(".t3x-fcard-pane .t3x-fcard-name, .t3x-fswap .t3x-fcard-name")?.textContent ?? null; if (__w.shown.at(-1)?.name !== n) __w.shown.push({ name: n, at: performance.now() }); }).observe(document.querySelector(".t3x-font-navigation"), { childList: true, subtree: true, characterData: true }); return 1; })()`);
const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const hit = (a, b) => a && b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

test("S1′: the card sits in the area list's viewport and covers nothing else, at three window sizes", { timeout: 120_000, skip: !HAVE_FONTS && "Klee One / Zen Kurenaido files not found" }, async () => {
  for (const [width, height] of [[1512, 945], [1100, 800], [820, 760]]) {
    await load({ width, height });
    await openFonts();
    await openMenu();
    const value = await ev(`document.getElementById("t3x-font-family").value`);
    const o = await optionAt("Klee One");
    await mouse("mouseMoved", o.x, o.y); await sleep(450); await frames();
    const card = await rect(".t3x-fcard-pane"), vp = await rect(".t3x-font-index");
    assert.ok(card, `${width}×${height}: a card`);
    assert.ok(Math.abs(card.left - (vp.left + 6)) < 0.6 && Math.abs(card.top - (vp.top + 6)) < 0.6, `${width}: left and top 6 px inside the viewport`);
    assert.ok(Math.abs(card.width - Math.min(300, vp.width - 12)) < 0.6, `${width}: width min(300, viewport − 12): ${card.width} vs ${vp.width}`);
    assert.ok(card.bottom <= vp.bottom - 6 + 0.5 && card.right <= vp.right, `${width}: inside the viewport, never clipped`);
    for (const sel of ["#t3x-font-search", ".t3x-font-workspace-head", "#t3x-font-source", ".t3x-font-similar", "#t3x-font-family", ".t3x-workspace-size", ".t3x-workspace-sample", ".t3x-font-editor"]) assert.equal(hit(card, await rect(sel)), false, `${width}: covers ${sel}`);
    const menu = await ev(`(() => { const rs = [...document.querySelectorAll("#t3x-font-family option")].map((o) => o.getBoundingClientRect()).filter((r) => r.height && r.bottom > 0 && r.top < innerHeight); return { left: Math.min(...rs.map((r) => r.left)), right: Math.max(...rs.map((r) => r.right)), top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)) }; })()`);
    assert.equal(hit(card, menu), false, `${width}: covers the menu`);
    const st = await ev(`(() => { const c = document.querySelector(".t3x-fcard-pane"), s = getComputedStyle(c); return { open: document.getElementById("t3x-font-family").matches(":open"), value: document.getElementById("t3x-font-family").value, pe: s.pointerEvents, tr: s.transitionDuration, an: s.animationName, pos: s.position, parent: c.parentElement.className, sibling: !!c.parentElement.querySelector(":scope > .t3x-font-index"), popover: c.hasAttribute("popover"), focus: c.contains(document.activeElement), tab: c.querySelector("[tabindex],button,a") === null, name: c.querySelector(".t3x-fcard-name").textContent }; })()`);
    assert.deepEqual(st, { open: true, value, pe: "none", tr: "0s", an: "none", pos: "absolute", parent: "t3x-font-navigation", sibling: true, popover: false, focus: false, tab: true, name: "Klee One" }, `${width}×${height}`);
  }
});

test("S1′: the card's lines and computed style match the approved card (§5)", { timeout: 60_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  await load();
  await openFonts();
  await openMenu();
  const o = await optionAt("Klee One");
  await mouse("mouseMoved", o.x, o.y); await sleep(450); await frames();
  const s = await ev(`(() => { const c = document.querySelector(".t3x-fcard-pane"), cs = (e) => getComputedStyle(c.querySelector(e) ?? c), k = getComputedStyle(c);
    return { box: [k.boxSizing, k.paddingTop, k.paddingLeft, k.borderTopWidth, k.borderTopLeftRadius, k.fontSize, k.lineHeight, k.fontWeight, k.boxShadow.includes("28px")],
      name: [cs(".t3x-fcard-name").fontSize, cs(".t3x-fcard-name").lineHeight, cs(".t3x-fcard-name").fontFamily.includes("T3X Pick Klee One")],
      strip: [cs(".t3x-fcard-strip").fontSize, cs(".t3x-fcard-strip").letterSpacing, cs(".t3x-fcard-strip").fontVariantLigatures, cs(".t3x-fcard-strip").marginTop, cs(".t3x-fcard-strip").marginBottom, cs(".t3x-fcard-strip").color === getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim() || cs(".t3x-fcard-strip").color],
      ul: [cs("ul").paddingLeft, cs("ul").marginBottom, cs("li").marginTop, cs("ul").listStyleType], line: cs(".t3x-fcard-line").marginTop,
      use: [cs(".t3x-fcard-use").marginTop, cs(".t3x-fcard-use").paddingTop, cs(".t3x-fcard-use").borderTopWidth],
      text: [...c.children].map((e) => e.tagName === "UL" ? [...e.children].map((li) => li.textContent) : e.textContent) }; })()`);
  assert.deepEqual(s.box, ["border-box", "12px", "14px", "1px", "8px", "13px", "18.85px", "400", true]);
  assert.deepEqual(s.name, ["26px", "28.6px", true]);
  assert.deepEqual(s.strip.slice(0, 5), ["20px", "1.2px", "common-ligatures", "2px", "6px"]);
  assert.deepEqual(await ev(`(() => { const st = getComputedStyle(document.querySelector(".t3x-fcard-pane .t3x-fcard-strip")); return [st.fontFeatureSettings, st.whiteSpace]; })()`), ['"liga"', "nowrap"], "ligatures kept despite the letter-spacing; the strip never splits");
  assert.deepEqual(s.ul, ["16px", "6px", "1px", "disc"], "the traits keep their bullets under T3's base styles");
  assert.equal(s.line, "6px");
  assert.deepEqual(s.use, ["6px", "6px", "1px"]);
  const r = FIXTURE.records["Klee One"], f = FONTS.families.find((x) => x.name === "Klee One");
  assert.deepEqual(s.text, ["Klee One", r.strip, r.desc, r.apart.slice(0, 2), r.madeShort,
    `Lower case ${f.xRatio}% as tall as capitals (typical here: about ${FONTS.xRatioMedian}%). Regular weight; Latin letters only in this copy.`,
    "You use it for Message composer and Your sent prompts, at 120%."]);
  // Klee One's record says the letters of fi are drawn as one shape: in the strip, with its letter-spacing, "fi" is one ligature.
  const lig = await ev(`(async () => { const c = document.querySelector(".t3x-fcard-pane .t3x-fcard-strip"); const a = document.createElement("span"), b = document.createElement("span"); a.textContent = "fi"; b.textContent = "f\\u200ci"; c.append(a, b); await document.fonts.ready; const w = [a.getBoundingClientRect().width, b.getBoundingClientRect().width]; a.remove(); b.remove(); return w; })()`);
  assert.ok(lig[0] < lig[1] - 0.5, `"fi" (${lig[0]}) narrower than f and i apart (${lig[1]})`);
});

test("S1′: first card after 250 ms of rest, then swapped at once; gone when the highlight leaves or the menu closes", { timeout: 60_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  await load();
  await openFonts();
  await openMenu();
  await watchCard();
  const k = await optionAt("Klee One");
  await mouse("mouseMoved", k.x, k.y); await sleep(120);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-pane")`), false, "not before 250 ms");
  await sleep(350);
  const first = await ev(`(() => { const s = __w.shown.find((x) => x.name === "Klee One"); return s ? s.at - __w.over : null; })()`);
  assert.ok(first >= 245 && first < 400, `first card ${first} ms after the hover`);
  const z = await optionAt("Zen Kurenaido");
  await mouse("mouseMoved", z.x, z.y); await frames();
  const swap = await ev(`(() => { const s = __w.shown.find((x) => x.name === "Zen Kurenaido"); return s ? s.at - __w.over : null; })()`);
  assert.ok(swap !== null && swap < 60, `swapped at once (${swap} ms)`);
  assert.equal(await ev(`document.getElementById("t3x-font-family").value`), "Zen Kurenaido", "nothing committed (Zen Kurenaido was already the choice)");
  const head = await rect(".t3x-font-workspace-head");
  await mouse("mouseMoved", head.left + 200, head.top + 20); await sleep(80);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-pane")`), false, "gone when the pointer leaves the options");
  assert.equal(await ev(`document.getElementById("t3x-font-family").matches(":open")`), true);
  const k2 = await optionAt("Klee One");
  await mouse("mouseMoved", k2.x, k2.y); await sleep(120);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-pane")`), false, "back on an option: 250 ms again");
  await sleep(350);
  assert.equal(await ev(`document.querySelector(".t3x-fcard-pane .t3x-fcard-name")?.textContent`), "Klee One");
  await key("Escape"); await sleep(200);
  assert.deepEqual(await ev(`[document.getElementById("t3x-font-family").matches(":open"), !!document.querySelector(".t3x-fcard-pane"), document.getElementById("t3x-font-family").value]`), [false, false, "Zen Kurenaido"]);
  assert.deepEqual(await ev("window.__errors"), []);
});

test("S1′: T3's own font's card is its name and sentence only", { timeout: 60_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  await load();
  await openFonts();
  await openMenu();
  const o = await optionAt("T3 code font");
  await mouse("mouseMoved", o.x, o.y); await sleep(450);
  assert.deepEqual(await ev(`[...document.querySelector(".t3x-fcard-pane").children].map((e) => e.textContent)`), ["T3 code font", "Follows T3's Settings → Appearance code font (now: Menlo). The size buttons don't apply."]);
  assert.equal(await ev(`getComputedStyle(document.querySelector(".t3x-fcard-pane .t3x-fcard-name")).fontFamily`), "Menlo, monospace", "the name in its own CSS");
  assert.equal(await ev(`(() => { const c = document.querySelector(".t3x-fcard-pane"), n = c.querySelector(".t3x-fcard-name").getBoundingClientRect(), d = c.querySelector(".t3x-fcard-desc").getBoundingClientRect(); return Math.round((d.top - n.bottom) * 10) / 10; })()`), 6, "12B: 6 px between the name and the sentence");
  await key("Escape");
});

test("S1′: the keyboard highlight shows the card too, and Enter still chooses", { timeout: 60_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  await load();
  await openFonts();
  await mouse("mouseMoved", 2, 2);
  await ev(`document.getElementById("t3x-font-family").scrollIntoView({ block: "center" }), document.getElementById("t3x-font-family").focus(), 1`);
  await key("ArrowDown"); await sleep(300);
  assert.equal(await ev(`document.getElementById("t3x-font-family").matches(":open")`), true, "ArrowDown opens the menu");
  const order = await ev(`[...document.querySelectorAll("#t3x-font-family option")].map((o) => o.value)`);
  for (let i = 0; i < 80 && (await ev("document.activeElement.value")) !== "Klee One"; i++) await key(order.indexOf("Klee One") > order.indexOf(await ev("document.activeElement.value")) ? "ArrowDown" : "ArrowUp");
  await sleep(450); await frames();
  assert.deepEqual(await ev(`[document.querySelector(".t3x-fcard-pane .t3x-fcard-name")?.textContent, document.getElementById("t3x-font-family").matches(":open"), document.getElementById("t3x-font-family").value]`), ["Klee One", true, "Zen Kurenaido"]);
  await key("Enter"); await sleep(400);
  assert.deepEqual(await ev(`[document.getElementById("t3x-font-family").matches(":open"), !!document.querySelector(".t3x-fcard-pane"), JSON.parse(localStorage.getItem("t3x:settings:v1")).fontMain.family]`), [false, false, "Klee One"]);
});

test("S1′: a short window swaps the list's viewport for the font (never the search box) until the menu closes; narrow: nothing", { timeout: 90_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  await load({ height: 520 });
  await openFonts();
  await ev(`document.querySelector(".t3x-font-index").scrollTop = 90, 1`);
  await openMenu();
  const o = await optionAt("Klee One");
  await mouse("mouseMoved", o.x, o.y); await sleep(450); await frames();
  const swap = await rect(".t3x-fswap"), vp = await rect(".t3x-font-index");
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-pane")`), false, "no card: it would not fit");
  assert.ok(swap && ["left", "top", "width", "height"].every((k) => Math.abs(swap[k] - vp[k]) < 0.6), "the swap fills exactly the list's viewport");
  assert.equal(hit(swap, await rect("#t3x-font-search")), false, "never over the search box");
  assert.deepEqual(await ev(`(() => { const w = document.querySelector(".t3x-fswap"); return [[...w.childNodes].filter((n) => n.nodeType !== 1).map((n) => n.textContent), /null/.test(w.textContent)]; })()`), [[], false], "no stray \"null\" line at the end of the swap");
  assert.deepEqual(await ev(`[...document.querySelector(".t3x-fswap").children].slice(0, 2).map((e) => e.textContent)`), ["Replies · About the highlighted font", "Klee One"], "10G′: one heading line");
  assert.deepEqual(await ev(`(() => { const w = document.querySelector(".t3x-fswap"), c = getComputedStyle(w); return [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft]; })()`), ["12px", "14px", "12px", "14px"], "10G′: the card's own padding");
  const z = await optionAt("Zen Kurenaido");
  await mouse("mouseMoved", z.x, z.y); await frames();
  assert.equal(await ev(`document.querySelector(".t3x-fswap .t3x-fcard-name")?.textContent`), "Zen Kurenaido", "swapped at once");
  const head = await rect(".t3x-font-workspace-head");
  await mouse("mouseMoved", head.left + 200, head.top + 20); await sleep(400);
  assert.equal(await ev(`document.querySelector(".t3x-fswap .t3x-fcard-name")?.textContent`), "Zen Kurenaido", "the swap stays, showing the last highlighted font");
  await key("Escape"); await sleep(200);
  assert.deepEqual(await ev(`[!!document.querySelector(".t3x-fswap"), document.querySelector(".t3x-font-index").scrollTop]`), [false, 90], "the list returns at its scroll position");
  await load({ width: 700, height: 900 });
  await openFonts();
  await openMenu();
  const n = await optionAt("Klee One");
  await mouse("mouseMoved", n.x, n.y); await sleep(500);
  assert.deepEqual(await ev(`[!!document.querySelector(".t3x-fcard-pane"), !!document.querySelector(".t3x-fswap"), document.getElementById("t3x-font-family").matches(":open")]`), [false, false, true], "no left pane, no card");
});

test("cold load: the panel waits for its font's face; a swapped pane never shows the last font while the next loads", { timeout: 90_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  const hold = async () => { await send("Network.clearBrowserCache"); server.hold = { file: "zen-kurenaido-latin-400.woff2", waiting: [] }; }; // extras.js fetches fonts with force-cache
  const release = () => { const w = server.hold?.waiting ?? []; server.hold = null; for (const send of w) send(); return w.length; };
  try {
    await hold();
    await load();
    await openFonts();
    const panel = `document.querySelector(".t3x-fabout:not(.t3x-fabout-docked)")`;
    await sleep(300);
    assert.equal(await ev(`${panel}.hidden`), true, "W3: nothing while its face loads");
    assert.ok(release() > 0, "the face was requested and held");
    await sleep(500); await frames();
    assert.deepEqual(await ev(`[${panel}.hidden, ${panel}.querySelector(".t3x-fabout-name")?.textContent]`), [false, "Zen Kurenaido"], "shown once its face is ready, with nothing else happening");
    await hold();
    await load({ height: 520 });
    await openFonts();
    await ev(`document.querySelector(".t3x-font-index").scrollTop = 90, 1`);
    await openMenu();
    const k = await optionAt("Klee One");
    await mouse("mouseMoved", k.x, k.y); await sleep(450); await frames();
    assert.equal(await ev(`document.querySelector(".t3x-fswap .t3x-fcard-name")?.textContent`), "Klee One", "the short window swapped");
    const z = await optionAt("Zen Kurenaido");
    await mouse("mouseMoved", z.x, z.y); await sleep(300); await frames();
    assert.deepEqual(await ev(`[!!document.querySelector(".t3x-fswap"), document.querySelector(".t3x-fswap .t3x-fcard-name")?.textContent ?? null]`), [true, null], "never the last font under \"About the highlighted font\"");
    release();
    await sleep(500); await frames();
    assert.equal(await ev(`document.querySelector(".t3x-fswap .t3x-fcard-name")?.textContent`), "Zen Kurenaido", "the highlighted font once its face is ready");
    assert.deepEqual(await ev(`window.__errors`), []);
  } finally {
    release();
  }
});

test("11C add-on on a cold load: \"drawn at 150%\" only once the capped face has loaded (Astra, 14 Nov 2026)", { timeout: 90_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  const release = () => { const w = server.hold?.waiting ?? []; server.hold = null; for (const send of w) send(); return w.length; };
  const tips = () => ev(`(() => { const n = document.querySelector('[data-focus="fs-name-main"]'); return { name: n.title, size: n.closest(".t3x-fs-row").querySelector(".t3x-fs-size-val").title, fs: n.style.fontSize }; })()`);
  try {
    await send("Network.clearBrowserCache"); server.hold = { file: "zen-kurenaido-latin-400.woff2", waiting: [] }; // extras.js fetches fonts with force-cache
    await load({ settings: { ...SETTINGS, fontMain: { family: "Zen Kurenaido", size: 200 } } });
    await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await sleep(700);
    const cold = await tips();
    assert.equal(cold.fs, "", "cold: T3's font, uncapped");
    assert.doesNotMatch(cold.size, /drawn at 150%/, "cold: the size number doesn't claim the name is drawn at 150%");
    assert.doesNotMatch(cold.name, /Shown at 150%/, "cold: nor does the name");
    assert.match(cold.size, /^Size 200%, default \d+%\. The Default control on this row sets it\.$/);
    assert.ok(release() > 0, "the face was requested and held");
    await sleep(800); await frames();
    const warm = await tips();
    assert.equal(warm.fs, "15px", "loaded: capped at 150%");
    assert.match(warm.size, /^Size 200%, default \d+%\. The Default control on this row sets it\. The font name above is drawn at 150%; the app uses 200%\.$/);
    assert.match(warm.name, /^Zen Kurenaido\. Shown at 150% here; the app uses 200%\./);
    assert.deepEqual(await ev(`window.__errors`), []);
  } finally {
    release();
  }
});

test("S2: the panel for the area's effective font, hidden on T3 default or without a record; two columns, one when narrow", { timeout: 90_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  await load();
  await openFonts();
  const panel = `document.querySelector(".t3x-fabout:not(.t3x-fabout-docked)")`;
  const s = await ev(`(() => { const p = ${panel}, c = getComputedStyle(p), q = (e) => getComputedStyle(p.querySelector(e)), note = p.previousElementSibling;
    return { hidden: p.hidden, after: note.classList.contains("t3x-font-preview-note"), box: [c.marginTop, c.paddingTop, c.paddingLeft, c.borderTopWidth, c.borderTopLeftRadius, c.fontSize, c.lineHeight],
      title: [p.querySelector(".t3x-fabout-title").textContent, q(".t3x-fabout-title").fontWeight, q(".t3x-fabout-title").fontSize, q(".t3x-fabout-title").marginBottom],
      head: [q(".t3x-fabout-head").display, q(".t3x-fabout-head").alignItems, q(".t3x-fabout-head").columnGap, q(".t3x-fabout-head").flexWrap, q(".t3x-fabout-name").fontSize, q(".t3x-fabout-name").lineHeight],
      grid: [q(".t3x-fabout-grid").gridTemplateColumns.split(" ").length, q(".t3x-fabout-grid").rowGap, q(".t3x-fabout-grid").columnGap, q(".t3x-fabout-grid").marginTop],
      sec: [q(".t3x-fabout-sec").borderTopWidth, q(".t3x-fabout-sec").paddingTop, q(".t3x-fabout-sec h4").fontSize, q(".t3x-fabout-sec h4").fontWeight, q(".t3x-fabout-sec h4").marginBottom],
      dl: [q("dl").gridTemplateColumns.split(" ").length, q("dl").rowGap, q("dl").columnGap],
      heads: [...p.querySelectorAll("h4")].map((h) => h.textContent), name: p.querySelector(".t3x-fabout-name").textContent, rows: [...p.querySelectorAll("dt")].map((d) => d.textContent) }; })()`);
  assert.deepEqual(s, { hidden: false, after: true, box: ["22px", "14px", "16px", "1px", "8px", "13px", "18.85px"], title: ["About this font", "600", "13px", "8px"],
    head: ["flex", "baseline", "16px", "wrap", "30px", "34.5px"], grid: [2, "4px", "22px", "4px"], sec: ["1px", "7px", "12px", "600", "3px"], dl: [2, "1px", "10px"],
    heads: ["What sets it apart", "Using it here", "Background", "Technical"], name: "Zen Kurenaido", rows: ["Lower case", "Width", "Weight", "Letters"] });
  const pick = async (area) => { await ev(`[...document.querySelectorAll(".t3x-font-area")].find((e) => e.querySelector(".t3x-font-area-name").textContent === ${JSON.stringify(area)}).click(), 1`); await sleep(500); };
  await pick("Your sent prompts");
  assert.deepEqual(await ev(`[${panel}.hidden, ${panel}.querySelector(".t3x-fabout-name")?.textContent, ${panel}.textContent.includes("You use it for Message composer and Your sent prompts, at 120%.")]`), [false, "Klee One", true], "a follower shows the font it follows");
  await pick("Links in replies");
  assert.equal(await ev(`${panel}.hidden`), true, "T3 default: no panel");
  await pick("Questions & saved answers");
  assert.deepEqual(await ev(`[${panel}.hidden, ${panel}.textContent, getComputedStyle(${panel}.firstElementChild).color, getComputedStyle(${panel}).borderTopWidth]`), [false, "No details for this font.", "rgb(111, 114, 128)", "0px"], "7A: no record for Dekko: one muted line saying so");
  await load({ settings: { ...SETTINGS, fontPlans: { family: "T3 interface font", size: null }, fontSources: { ...SETTINGS.fontSources, plans: "own" } } });
  await openFonts("Proposed plans");
  assert.deepEqual(await ev(`[...${panel}.children].map((e) => e.textContent)`), ["About this font", "T3 interface font", "Follows T3's Settings → Appearance interface font (now: Arial). The size buttons don't apply.", "You use it for Proposed plans."], "T3's own font: its sentence and where you use it");
  await load({ width: 700, height: 900 });
  await openFonts();
  assert.equal(await ev(`getComputedStyle(${panel}.querySelector(".t3x-fabout-grid")).gridTemplateColumns.split(" ").length`), 1);
});

test("S3′: the ✦ row's card after 600 ms, beside the panel and level with the row; pointer only; click still opens Fonts", { timeout: 90_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  // The panel dragged near the top, so a card level with the Replies row has room below it.
  const top = { ...SETTINGS, popSpots: { panel: { ax: "l", x: 20, ay: "t", y: 20 } } };
  await load({ settings: top });
  await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await sleep(700);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-float")`), false);
  const name = await rect('[data-focus="fs-name-main"]');
  await ev(`(() => { window.__w = { enter: 0, shown: 0 }; document.querySelector('[data-focus="fs-name-main"]').addEventListener("pointerenter", () => { __w.enter = performance.now(); }); new MutationObserver(() => { if (!__w.shown && document.querySelector(".t3x-fcard-float")) __w.shown = performance.now(); }).observe(document.body, { childList: true }); return 1; })()`);
  const tip = await ev(`document.querySelector('[data-focus="fs-name-main"]').title`);
  assert.match(tip, /^Replies: Zen Kurenaido · 130%\. Click to edit in Fonts/);
  await mouse("mouseMoved", name.left + 20, name.top + name.height / 2); await sleep(400);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-float")`), false, "not before 600 ms");
  assert.equal(await ev(`document.querySelector('[data-focus="fs-name-main"]').hasAttribute("title")`), false, "11C: the name's tooltip is held back from pointer-enter");
  await sleep(500);
  const t = await ev(`__w.shown - __w.enter`);
  assert.ok(t >= 595 && t < 800, `card ${t} ms after the pointer came to rest`);
  const card = await rect(".t3x-fcard-float"), panel = await rect(".t3x-pop"), row = await ev(`(() => { const r = document.querySelector('[data-focus="fs-name-main"]').closest(".t3x-fs-row").getBoundingClientRect(); return r.top; })()`);
  assert.ok(Math.abs(card.left - (panel.right + 12)) < 0.6 && Math.abs(card.top - row) < 0.6, "12 px beside the panel, level with the row");
  assert.ok(card.right <= 1512 && card.bottom <= 945 && !hit(card, panel), "whole, inside the window, off the panel");
  assert.deepEqual(await ev(`(() => { const c = document.querySelector(".t3x-fcard-float"), s = getComputedStyle(c); return [s.position, s.pointerEvents, s.width, c.querySelector(".t3x-fcard-name").textContent, c.querySelector(".t3x-fcard-use").textContent]; })()`), ["fixed", "none", "300px", "Zen Kurenaido", "You use it for Replies, at 130%."]);
  assert.equal(await ev(`document.querySelector('[data-focus="fs-name-main"]').hasAttribute("title")`), false, "11C: no tooltip while the card shows");
  await mouse("mouseMoved", 1300, 100); await sleep(80);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-float")`), false, "gone when the pointer leaves");
  assert.equal(await ev(`document.querySelector('[data-focus="fs-name-main"]').title`), tip, "11C: the tooltip is back once the pointer leaves");
  // 6B: the ✦ card names areas as the ✦ panel does ("Your prompts"; the Fonts window says "Your sent prompts").
  const comp = await rect('[data-focus="fs-name-composer"]');
  await mouse("mouseMoved", comp.left + 20, comp.top + comp.height / 2); await sleep(1000);
  assert.equal(await ev(`document.querySelector(".t3x-fcard-float .t3x-fcard-use")?.textContent`), "You use it for Message composer and Your prompts, at 120%.", "6B: the ✦ panel's names on the ✦ card");
  await mouse("mouseMoved", 1300, 100); await sleep(80);
  await ev(`document.querySelector('[data-focus="fs-name-main"]').focus(), 1`); await sleep(900);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-float")`), false, "focus shows nothing");
  await mouse("mouseMoved", name.left + 20, name.top + name.height / 2); await sleep(900);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-float")`), true);
  await click(name.left + 20, name.top + name.height / 2); await sleep(600);
  assert.deepEqual(await ev(`[!!document.querySelector(".t3x-fcard-float"), !!window.__T3X_PICK_TEST__.workspace(), document.getElementById("t3x-font-editor-title")?.textContent]`), [false, true, "Replies"], "click opens Fonts on that area");
  // No room: Replies' text fills the window beside the panel, so the card would cover it.
  await load({ settings: top, body: `<div data-message-role="assistant" style="position:fixed;left:400px;top:0;right:0;bottom:0"><div class="chat-markdown">${"<p>Reply prose that Replies styles, line after line.</p>".repeat(60)}</div></div>` });
  await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await sleep(900);
  const n2 = await rect('[data-focus="fs-name-main"]');
  await mouse("mouseMoved", n2.left + 20, n2.top + n2.height / 2); await sleep(1000);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-float")`), false, "fit or nothing");
  assert.match(await ev(`document.querySelector('[data-focus="fs-name-main"]').title`), /^Replies: Zen Kurenaido/, "11C: no card can show, so the name keeps its tooltip");
  // 1B: a row too low for a card level with it: the card slides up just enough to fit, still beside the panel.
  await load({ settings: { ...SETTINGS, popSpots: { panel: { ax: "l", x: 20, ay: "b", y: 20 } } } });
  await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await sleep(900);
  const low = await rect('[data-focus="fs-name-main"]');
  await mouse("mouseMoved", low.left + 20, low.top + low.height / 2); await sleep(1000);
  const slid = await rect(".t3x-fcard-float"), lowRow = await ev(`document.querySelector('[data-focus="fs-name-main"]').closest(".t3x-fs-row").getBoundingClientRect().top`), pop2 = await rect(".t3x-pop");
  assert.ok(slid && lowRow + slid.height > 945 - 12, "the row is too low for a card level with it");
  assert.ok(Math.abs(slid.bottom - (945 - 12)) < 0.6 && slid.top < lowRow, `slid up to 12 px above the window's foot: ${slid.top}–${slid.bottom}`);
  assert.ok(Math.abs(slid.left - (pop2.right + 12)) < 0.6 && !hit(slid, pop2), "still beside the panel, never on it");
  assert.equal(await ev(`document.querySelector('[data-focus="fs-name-main"]').hasAttribute("title")`), false, "11C: no tooltip while the card shows");
});

for (const popMove of [true, false]) {
  test(`S4′ (popMove ${popMove ? "on" : "off"}): the sentence, a closed About, the outer box kept on opening, no line under the foot`, { timeout: 90_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
    await load({ settings: { ...SETTINGS, popMove }, body: `<div data-message-role="assistant" style="position:fixed;left:40px;top:40px;width:560px"><div class="chat-markdown"><p id="reply">Reply prose that Replies styles: a paragraph to pick.</p></div></div>` });
    if (popMove) {
      await openFonts();
      await ev(`[...document.querySelectorAll(".t3x-font-workspace button")].find((x) => /Small card/.test(x.textContent)).click(), 1`);
    } else {
      await ev(`window.__T3X_PICK_TEST__.startFontPick(), 1`); await sleep(900);
      const r = await rect("#reply");
      await click(r.left + 30, r.top + r.height / 2);
    }
    await sleep(900); await frames();
    assert.equal(await ev(`document.querySelector(".t3x-font-workspace").dataset.mode`), "dock");
    const st = () => ev(`(() => { const el = document.querySelector(".t3x-font-workspace"), body = el.querySelector(".t3x-font-workspace-body"), foot = el.querySelector(".t3x-font-dockbar").getBoundingClientRect(), b = el.getBoundingClientRect();
      const texts = [...el.querySelectorAll(".t3x-font-editor *")].filter((n) => !n.closest(".t3x-font-dockbar") && n.checkVisibility() && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()));
      const lines = texts.flatMap((n) => { const rg = document.createRange(); rg.selectNodeContents(n); return [...rg.getClientRects()]; }).filter((r) => r.height > 0 && r.bottom > b.top && r.top < b.bottom);
      return { box: [b.left, b.top, b.width, b.height], foot: [foot.top, foot.bottom], under: lines.filter((r) => r.bottom > foot.top + 0.5 && r.top < foot.bottom - 0.5).length, end: body.scrollHeight - body.clientHeight - body.scrollTop, pad: body.style.scrollPaddingBottom }; })()`);
    const toEnd = () => ev(`(() => { const b = document.querySelector(".t3x-font-workspace-body"); b.scrollTop = b.scrollHeight; return 1; })()`);
    const look = await ev(`(() => { const el = document.querySelector(".t3x-font-workspace"), p = el.querySelector(".t3x-font-docksentence"), d = el.querySelector(".t3x-font-dockdetails"), s = d.querySelector("summary"), ps = getComputedStyle(p), ss = getComputedStyle(s), before = getComputedStyle(s, "::before");
      return { after: p.parentElement.previousElementSibling === el.querySelector(".t3x-font-editor > .t3x-note:not(.t3x-font-preview-note)") || p.parentElement.previousElementSibling.textContent.startsWith("Font ready"), text: p.textContent, color: ps.color, font: [ps.fontSize, ps.lineHeight], open: d.open, summary: [s.textContent, ss.fontWeight, ss.fontSize, ss.marginTop, before.content, before.color],
        panelShown: el.querySelector(".t3x-fabout:not(.t3x-fabout-docked)").checkVisibility(), noteShown: el.querySelector(".t3x-font-preview-note").checkVisibility(), muted: getComputedStyle(el.querySelector(".t3x-font-editor > .t3x-note")).color }; })()`);
    assert.equal(look.after, true, "after the status line");
    assert.equal(look.text, FIXTURE.records["Zen Kurenaido"].desc);
    assert.equal(look.color, "rgb(45, 47, 62)", "the body colour");
    assert.deepEqual(look.font, ["12.5px", "18.125px"]);
    assert.deepEqual([look.open, ...look.summary.slice(0, 5)], [false, "About this font", "600", "13px", "10px", '"▸ "']);
    assert.equal(look.summary[5], "rgb(111, 114, 128)", "a muted marker");
    assert.deepEqual([look.panelShown, look.noteShown], [false, false], "no S2 panel or Preview note in the docked card");
    await toEnd(); await sleep(100);
    const closed = await st();
    assert.equal(closed.under, 0, "closed, at the end: no line under the foot");
    const s = await rect(".t3x-font-dockdetails > summary");
    await click(s.left + 20, s.top + s.height / 2); await sleep(300);
    const opened = await st();
    assert.deepEqual(opened.box, closed.box, "opening keeps the card's outer box");
    const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.5);
    if (popMove) assert.ok(same(opened.foot, closed.foot), `the foot stays put: ${opened.foot} vs ${closed.foot}`);
    await toEnd(); await sleep(100);
    const end = await st();
    assert.equal(end.under, 0, "open, at the end: no line under the foot");
    assert.deepEqual(end.box, closed.box);
    if (popMove) { assert.ok(same(end.foot, closed.foot)); assert.match(end.pad, /^\d+px$/, "the scroll keeps the foot's height clear"); }
    assert.ok(await ev(`[...document.querySelectorAll(".t3x-fabout-docked dt")].length === 4 && getComputedStyle(document.querySelector(".t3x-fabout-docked .t3x-fabout-grid")).gridTemplateColumns.split(" ").length === 1`), "the panel's text, one column");
    assert.equal(await ev(`getComputedStyle(document.querySelector(".t3x-font-dockdetails > summary"), "::before").content`), '"▾ "', "3A: ▾ while open");
    const docked = () => ev(`(() => { const b = document.querySelector(".t3x-fabout-docked"); return { open: document.querySelector(".t3x-font-dockdetails").open, name: b.querySelector(".t3x-fabout-name")?.textContent ?? null, strip: !!b.querySelector(".t3x-fabout-strip"), desc: b.querySelector(".t3x-fabout-desc")?.textContent ?? null, sentence: document.querySelector(".t3x-font-docksentence").textContent }; })()`);
    assert.deepEqual(await docked(), { open: true, name: "Zen Kurenaido", strip: true, desc: null, sentence: FIXTURE.records["Zen Kurenaido"].desc }, "2B: name and strip, no repeated sentence");
    await ev(`document.querySelector(".t3x-font-dockdetails > summary").scrollIntoView({ block: "center" }), 1`); await sleep(100);
    const s2 = await rect(".t3x-font-dockdetails > summary");
    await click(s2.left + 20, s2.top + s2.height / 2); await sleep(300);
    assert.equal(await ev(`document.querySelector(".t3x-font-dockdetails").open`), false);
    assert.equal(await ev(`document.querySelector(".t3x-font-workspace").style.height`), "", "closing lets the card size itself again");
    // 2B: it stays open when you switch fonts.
    await ev(`document.querySelector(".t3x-font-dockdetails > summary").scrollIntoView({ block: "center" }), 1`); await sleep(100);
    const s3 = await rect(".t3x-font-dockdetails > summary");
    await click(s3.left + 20, s3.top + s3.height / 2); await sleep(300);
    assert.equal(await ev(`document.querySelector(".t3x-font-dockdetails").open`), true);
    await ev(`(() => { const sel = document.getElementById("t3x-font-family"); sel.value = "Klee One"; sel.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
    await ev(`(async () => { for (let i = 0; i < 60; i++) { if (document.querySelector(".t3x-fabout-docked .t3x-fabout-name")?.textContent === "Klee One") return 1; await new Promise((r) => setTimeout(r, 50)); } return 0; })()`); await frames();
    assert.deepEqual(await docked(), { open: true, name: "Klee One", strip: true, desc: null, sentence: FIXTURE.records["Klee One"].desc }, "2B: still open on the next font, still without the repeated sentence");
    assert.deepEqual(await ev("window.__errors"), []);
  });
}

test("the menu: \"new\" on the eight, Iansui's note, Rounded print between Handwritten and Condensed print", { timeout: 60_000 }, async () => {
  await load();
  await openFonts();
  const m = await ev(`(() => { const s = document.getElementById("t3x-font-family"); return { groups: [...s.querySelectorAll("optgroup")].map((g) => g.label), round: [...s.querySelectorAll("optgroup")].find((g) => g.label === "Rounded print") ? [...[...s.querySelectorAll("optgroup")].find((g) => g.label === "Rounded print").querySelectorAll("option")].map((o) => o.value).sort() : null, labels: Object.fromEntries([...s.querySelectorAll("option")].map((o) => [o.value, o.textContent])) }; })()`);
  assert.deepEqual(m.groups, ["T3 Code settings", "Handwritten", "Rounded print", "Condensed print"]);
  assert.deepEqual(m.round, ["Gowun Dodum", "Kiwi Maru", "Tsukimi Rounded", "Zen Maru Gothic"]);
  assert.equal(m.labels.Iansui, "Iansui · new, a darker Klee One");
  for (const n of ["Yomogi", "Yusei Magic", "LXGW Marker Gothic", "Gowun Dodum", "Kiwi Maru", "Zen Maru Gothic", "Tsukimi Rounded"]) assert.equal(m.labels[n], `${n} · new`);
  assert.equal(m.labels["Klee One"], "Klee One");
});

test("records failed, late, mismatched or hostile: no errors; nothing shown until they match; text stays text", { timeout: 120_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  const panelShown = () => ev(`!document.querySelector(".t3x-fabout:not(.t3x-fabout-docked)").hidden`);
  await load({ aboutMode: "fail" });
  await openFonts();
  assert.deepEqual([await panelShown(), await ev(`document.querySelector(".t3x-fabout:not(.t3x-fabout-docked)").textContent`)], [true, "Font details couldn't load."], "failed: one muted line");
  await openMenu();
  const o = await optionAt("Klee One");
  await mouse("mouseMoved", o.x, o.y); await sleep(500);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-pane")`), false, "failed: no card");
  await key("Escape");
  assert.deepEqual(await ev("window.__errors"), []);
  await load({ aboutDelay: 1500 });
  await openFonts();
  assert.equal(await panelShown(), false, "not yet");
  await sleep(1700);
  assert.equal(await panelShown(), true, "late: shown once the records arrive");
  await load({ aboutMode: "mismatch" });
  await openFonts();
  await sleep(500);
  assert.equal(await ev(`document.querySelector(".t3x-fabout:not(.t3x-fabout-docked)").textContent`), "Font details couldn't load.", "records for another list version: not used");
  assert.equal(server.catalogHits, 2, "the page's catalog reloads once to catch up, then stops");
  await load({ aboutMode: "html", settings: { ...SETTINGS, fontMain: { family: "Klee One", size: null } } });
  await openFonts();
  const t = await ev(`(() => { const d = document.querySelector(".t3x-fabout:not(.t3x-fabout-docked) .t3x-fabout-desc"); return [d.textContent, d.children.length, window.__xss ?? null]; })()`);
  assert.deepEqual(t, ['<img src=x onerror="window.__xss=1"> & <b>bold</b>', 0, null]);
  assert.deepEqual(await ev("window.__errors"), []);
  assert.deepEqual(exceptions, []);
});

// ---------------------------------------------------------------- design question 5 (Andy's yes, 14 Nov 2026, 12:06 AM)

const cardName = () => ev(`document.querySelector(".t3x-fcard-pane .t3x-fcard-name")?.textContent ?? null`);

test("5a C: the open menu's own border and padding keep the card (Sol, 14 Nov 2026)", { timeout: 90_000, skip: !HAVE_SHIPPED && "shipped records or font files not found" }, async () => {
  for (const [width, height] of [[1512, 945], [1100, 800], [820, 760]]) {
    await load({ width, height, records: "shipped" });
    await openFonts();
    await ev(`document.getElementById("t3x-font-family").scrollIntoView({ block: "start" }), 1`); await sleep(100);
    const btn = await rect("#t3x-font-family");
    await click(btn.left + 20, btn.top + btn.height / 2); await sleep(400); await mouse("mouseMoved", 2, 2); await sleep(300);
    const o = await optionAt("Klee One");
    await mouse("mouseMoved", o.x, o.y); await sleep(500);
    assert.equal(await ev(`document.querySelector(".t3x-fcard-pane .t3x-fcard-name")?.textContent`), "Klee One", `${width}: a card`);
    // The highest point above Klee One that still hits the open select: the menu's top border or padding.
    const p = await ev(`(() => { const s = document.getElementById("t3x-font-family"), r = [...s.options].find((o) => o.value === "Klee One").getBoundingClientRect(), x = r.left + 20; let y = r.top + r.height / 2;
      for (let i = 0; i < innerHeight; i++) { const t = document.elementFromPoint(x, y - 1); if (t !== s && !s.contains(t)) break; y--; }
      const b = s.getBoundingClientRect(); return { x, y, hit: document.elementFromPoint(x, y)?.tagName, offButton: y < b.top || y >= b.bottom || x < b.left || x >= b.right }; })()`);
    assert.deepEqual([p.hit, p.offButton], ["SELECT", true], `${width}: the point is the open menu's, off the closed button`);
    await mouse("mouseMoved", p.x, p.y); await sleep(80);
    assert.deepEqual(await ev(`[document.getElementById("t3x-font-family").matches(":open"), document.querySelector(".t3x-fcard-pane .t3x-fcard-name")?.textContent ?? null]`), [true, "Klee One"], `${width}: still in the menu, the card stays`);
    await key("Escape"); await sleep(200);
  }
});

test("5a C: a heading inside the menu keeps the card until the next option takes over; leaving the menu hides it; back waits 250 ms", { timeout: 90_000, skip: !HAVE_SHIPPED && "shipped records or font files not found" }, async () => {
  await load({ records: "shipped" });
  await openFonts();
  // The select near the top, so the menu opens under it and the closed button stays uncovered.
  const openHigh = async () => {
    await ev(`document.getElementById("t3x-font-family").scrollIntoView({ block: "start" }), 1`); await sleep(100);
    const b = await rect("#t3x-font-family");
    await click(b.left + 20, b.top + b.height / 2); await sleep(400);
    await mouse("mouseMoved", 2, 2); await sleep(350);
    assert.equal(await ev(`document.getElementById("t3x-font-family").matches(":open")`), true, "the font menu opened");
  };
  await openHigh();
  await watchCard();
  // The last option above the "Rounded print" heading, the heading itself and the first option under it.
  const at = () => ev(`(() => { const gs = [...document.querySelectorAll("#t3x-font-family optgroup")], i = gs.findIndex((g) => g.label === "Rounded print");
    const prev = [...gs[i - 1].querySelectorAll("option")].filter((o) => !o.disabled).at(-1), first = gs[i].querySelector("option");
    first.scrollIntoView({ block: "center" });
    const g = gs[i].getBoundingClientRect(), f = first.getBoundingClientRect(), p = prev.getBoundingClientRect(), head = { x: f.x + 40, y: (g.top + f.top) / 2 };
    const under = document.elementFromPoint(head.x, head.y);
    return { prev: prev.value, first: first.value, p: { x: p.x + 40, y: p.y + p.height / 2 }, head, f: { x: f.x + 40, y: f.y + f.height / 2 }, underHead: under?.closest?.("option") ? "option" : under?.tagName ?? null }; })()`);
  const m = await at();
  assert.notEqual(m.underHead, "option", "the point between them is the heading, not an option");
  assert.ok(m.underHead === "OPTGROUP" || m.underHead === "SELECT", `inside the menu: ${m.underHead}`);
  await mouse("mouseMoved", m.p.x, m.p.y); await sleep(450); await frames();
  assert.equal(await cardName(), m.prev);
  await mouse("mouseMoved", m.head.x, m.head.y); await sleep(400); await frames();
  assert.equal(await cardName(), m.prev, "over the heading: the card stays");
  // The menu's own edge (its border) reports the select itself, like the closed button: inside the menu, so it stays.
  const edgeX = m.p.x - 40 - 1;
  assert.equal(await ev(`document.elementFromPoint(${edgeX}, ${m.head.y})?.id`), "t3x-font-family", "the menu's edge reports the select");
  await mouse("mouseMoved", edgeX, m.head.y); await sleep(300); await frames();
  assert.equal(await cardName(), m.prev, "on the menu's edge: the card stays");
  await ev(`__w.over = 0, 1`);
  await mouse("mouseMoved", m.f.x, m.f.y); await frames();
  const swap = await ev(`(() => { const s = __w.shown.find((x) => x.name === ${JSON.stringify(m.first)}); return s && __w.over ? s.at - __w.over : null; })()`);
  assert.ok(swap !== null && swap < 60, `the next option takes over at once (${swap} ms)`);
  // The closed button reports the select itself as the target, as the menu's padding does: outside the menu.
  const btn = await rect("#t3x-font-family");
  await mouse("mouseMoved", btn.left + 10, btn.top + btn.height / 2); await sleep(80);
  assert.equal(await ev(`document.elementFromPoint(${btn.left + 10}, ${btn.top + btn.height / 2})?.id`), "t3x-font-family");
  assert.equal(await cardName(), null, "on the closed button, outside the menu: gone");
  assert.equal(await ev(`document.getElementById("t3x-font-family").matches(":open")`), true);
  const m2 = await at();
  await mouse("mouseMoved", m2.f.x, m2.f.y); await sleep(120);
  assert.equal(await cardName(), null, "back in the menu: 250 ms again");
  await sleep(350);
  assert.equal(await cardName(), m2.first);
  // A select mid-window: the menu, taller than the room on either side, covers the closed button. There the
  // menu's edge is still the menu.
  await key("Escape"); await sleep(200);
  await openMenu();
  const c = await ev(`(() => { const b = document.getElementById("t3x-font-family").getBoundingClientRect(), y = b.top + b.height / 2, o = document.elementFromPoint(b.left + 40, y)?.closest?.("option"); return o ? { value: o.value, x: o.getBoundingClientRect().left, y } : null; })()`);
  assert.ok(c, "an option over the closed button");
  await mouse("mouseMoved", c.x + 40, c.y); await sleep(450); await frames();
  assert.equal(await cardName(), c.value);
  assert.equal(await ev(`document.elementFromPoint(${c.x - 1}, ${c.y})?.id`), "t3x-font-family");
  await mouse("mouseMoved", c.x - 1, c.y); await sleep(300); await frames();
  assert.equal(await cardName(), c.value, "the menu's edge over the button: still inside");
  // Before any card has shown, crossing a heading doesn't count as rest on an option.
  await key("Escape"); await sleep(200);
  await openHigh();
  const m3 = await at();
  await mouse("mouseMoved", m3.p.x, m3.p.y); await sleep(100);
  await mouse("mouseMoved", m3.head.x, m3.head.y); await sleep(400);
  assert.equal(await cardName(), null, "the first card still needs 250 ms of rest on an option");
  await key("Escape");
  assert.deepEqual(await ev("window.__errors"), []);
});

test("5b A: a click-open shows the card for the option under the still pointer after 250 ms; a keyboard open, the ticked font", { timeout: 60_000, skip: !HAVE_SHIPPED && "shipped records or font files not found" }, async () => {
  await load({ records: "shipped" });
  await openFonts();
  await ev(`document.getElementById("t3x-font-family").scrollIntoView({ block: "center" }), 1`); await sleep(100);
  const s = await ev(`(() => { const r = document.getElementById("t3x-font-family").getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
  await click(s.x, s.y); await sleep(120);
  assert.equal(await ev(`document.getElementById("t3x-font-family").matches(":open")`), true);
  assert.equal(await cardName(), null, "not before 250 ms");
  await sleep(450); await frames();
  const under = await ev(`(() => { const o = document.elementFromPoint(${s.x}, ${s.y})?.closest?.("option"); return o ? o.value : null; })()`);
  assert.equal(await cardName(), under, `the option under the still pointer (${under})`);
  await key("Escape"); await sleep(200);
  await mouse("mouseMoved", 2, 2);
  await ev(`document.getElementById("t3x-font-family").focus(), 1`);
  await key("ArrowDown"); await sleep(120);
  assert.equal(await ev(`document.getElementById("t3x-font-family").matches(":open")`), true);
  await sleep(450); await frames();
  assert.equal(await cardName(), "Zen Kurenaido", "by keyboard: the ticked font");
  await key("Escape");
});

test("7A: a font with no record: one muted line in the panel and docked card; hover and ✦ cards show nothing; failures keep their line", { timeout: 90_000, skip: !HAVE_FONTS && "font files not found" }, async () => {
  const dekko = { ...SETTINGS, fontMain: { family: "Dekko", size: null }, popSpots: { panel: { ax: "l", x: 20, ay: "t", y: 20 } } };
  await load({ settings: dekko, body: `<div data-message-role="assistant" style="position:fixed;left:40px;top:600px;width:560px"><div class="chat-markdown"><p id="reply">Reply prose that Replies styles.</p></div></div>` });
  await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await sleep(700);
  const n = await rect('[data-focus="fs-name-main"]');
  await mouse("mouseMoved", n.left + 20, n.top + n.height / 2); await sleep(1100);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-float")`), false, "✦ card: nothing");
  assert.match(await ev(`document.querySelector('[data-focus="fs-name-main"]').title`), /^Replies: Dekko/, "11C: no card can show, so the tooltip is back");
  await mouse("mouseMoved", 1300, 100);
  await ev(`document.querySelector('[data-focus="open-fonts"]').click(), 1`); await sleep(500);
  await ev(`[...document.querySelectorAll(".t3x-font-area")].find((e) => e.querySelector(".t3x-font-area-name").textContent === "Replies").click(), 1`); await sleep(600);
  const panel = `document.querySelector(".t3x-fabout:not(.t3x-fabout-docked)")`;
  assert.deepEqual(await ev(`[${panel}.hidden, ${panel}.textContent, getComputedStyle(${panel}.firstElementChild).color]`), [false, "No details for this font.", "rgb(111, 114, 128)"], "the panel: one muted line");
  await openMenu();
  const o = await optionAt("Dekko");
  await mouse("mouseMoved", o.x, o.y); await sleep(500);
  assert.equal(await ev(`!!document.querySelector(".t3x-fcard-pane, .t3x-fswap")`), false, "hover card: nothing");
  await key("Escape"); await sleep(200);
  await ev(`[...document.querySelectorAll(".t3x-font-workspace button")].find((x) => /Small card/.test(x.textContent)).click(), 1`); await sleep(900);
  assert.deepEqual(await ev(`(() => { const p = document.querySelector(".t3x-font-docksentence"); return [document.querySelector(".t3x-font-workspace").dataset.mode, p.textContent, getComputedStyle(p).color, document.querySelector(".t3x-font-dockdetails").hidden]; })()`), ["dock", "No details for this font.", "rgb(111, 114, 128)", true], "the docked card: one muted line, no About");
  await load({ aboutMode: "fail", settings: dekko });
  await openFonts();
  assert.equal(await ev(`${panel}.textContent`), "Font details couldn't load.", "a real failure keeps its line");
  assert.deepEqual(await ev("window.__errors"), []);
});

test("4A: \"Hidden by…\" is the card's last line, muted", { timeout: 60_000, skip: !HAVE_SHIPPED && "shipped records or font files not found" }, async () => {
  await load({ records: "shipped", settings: { ...SETTINGS, fontMain: { family: "Kalam", size: null } } });
  await openFonts();
  await openMenu();
  const o = await optionAt("Kalam");
  await mouse("mouseMoved", o.x, o.y); await sleep(450);
  await ev(`(async () => { for (let i = 0; i < 40 && !document.querySelector(".t3x-fcard-pane"); i++) await new Promise((r) => setTimeout(r, 50)); return 1; })()`);
  assert.deepEqual(await ev(`(() => { const last = document.querySelector(".t3x-fcard-pane").lastElementChild; return [last.className, last.textContent, getComputedStyle(last).color]; })()`),
    ["t3x-fcard-hidden", "Hidden by Print only; listed because it's your current choice.", "rgb(111, 114, 128)"]);
  await key("Escape");
});

test("10G′ and 12B: a short window's swap shows whole lines by priority, keeps the warnings, lets the strip go first (6 px under the name), else no swap", { timeout: 300_000, skip: !HAVE_SHIPPED && "shipped records or font files not found" }, async () => {
  const warn = { "Yomogi": "Its long dash runs right up to the next word", "Barlow Condensed": "Two hyphens in a row are drawn as one long dash" };
  const rec = (n) => SHIPPED.records[n];
  const seen = {};
  for (const height of [600, 580, 560, 540, 520, 480, 460, 420, 400, 380, 360]) {
    await load({ height, records: "shipped" });
    await openFonts();
    await openMenu();
    for (const font of ["Klee One", "Yomogi", "Barlow Condensed"]) {
      const o = await optionAt(font);
      await mouse("mouseMoved", o.x, o.y); await sleep(450); await frames();
      await ev(`(async () => { for (let i = 0; i < 60; i++) { const w = document.querySelector(".t3x-fswap"); if (document.querySelector(".t3x-fcard-pane") || (w && (getComputedStyle(w).display === "none" || w.querySelector(".t3x-fcard-name")?.textContent === ${JSON.stringify(font)}))) return 1; await new Promise((r) => setTimeout(r, 50)); } return 0; })()`); await frames();
      const s = await ev(`(() => { const w = document.querySelector(".t3x-fswap");
        if (!w) return { swap: false, card: document.querySelector(".t3x-fcard-pane .t3x-fcard-name")?.textContent ?? null };
        const cs = getComputedStyle(w), vis = (sel) => !!w.querySelector(sel)?.checkVisibility(), box = w.getBoundingClientRect();
        if (cs.display === "none") return { swap: false, card: null };
        const n = w.querySelector(".t3x-fcard-name").getBoundingClientRect(), d = w.querySelector(".t3x-fcard-desc").getBoundingClientRect();
        return { swap: true, name: w.querySelector(".t3x-fcard-name").textContent, head: w.firstElementChild.textContent, elements: [...w.childNodes].every((x) => x.nodeType === 1),
          fits: w.scrollHeight <= w.clientHeight + 0.5, clipped: [...w.children].some((e) => e.checkVisibility() && e.getBoundingClientRect().bottom > box.bottom - parseFloat(cs.paddingBottom) + 0.5),
          strip: vis(".t3x-fcard-strip"), desc: vis(".t3x-fcard-desc"), use: vis(".t3x-fcard-use"), bg: vis(".t3x-fcard-bg"), tech: vis(".t3x-fcard-tech") ? w.querySelector(".t3x-fcard-tech").textContent : null,
          traits: [...w.querySelectorAll("li")].filter((li) => li.checkVisibility()).map((li) => li.textContent), gap: Math.round((d.top - n.bottom) * 10) / 10 }; })()`);
      seen[`${font} ${height}`] = s;
      if (!s.swap) continue;
      const card = rec(font).apart.slice(0, 2);
      assert.equal(s.name, font, `${font} ${height}`);
      assert.equal(s.head, "Replies · About the highlighted font");
      assert.ok(s.elements && s.fits && !s.clipped, `${font} ${height}: whole lines only, inside the box`);
      assert.ok(s.desc && s.use, `${font} ${height}: the sentence and usage always show`);
      if (warn[font]) assert.ok(s.traits.includes(warn[font]), `${font} ${height}: the warning stays`);
      if (warn[font]) assert.equal(s.traits.indexOf(warn[font]), s.traits.length === 2 ? card.indexOf(warn[font]) : 0, `${font} ${height}: in its place among the traits`);
      const allTraits = s.traits.length === card.length;
      if (s.bg) assert.ok(allTraits && s.tech, `${font} ${height}: Background only with the traits and a Technical form`);
      if (s.tech) assert.ok(s.tech.startsWith("Lower case "), `${font} ${height}: Technical whole or its first sentence`);
      if (!s.strip) {
        assert.ok(!s.bg && !s.tech && s.traits.every((t) => t === warn[font]), `${font} ${height}: the strip goes first, only when the must-show lines don't fit`);
        assert.equal(s.gap, 6, `${font} ${height}: 12B, 6 px between the name and the sentence`);
      }
    }
    await key("Escape"); await sleep(150);
  }
  console.log(JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, s]) => [k, s.swap ? `strip ${+s.strip} traits ${s.traits.length} tech ${s.tech ? (/weight/.test(s.tech) ? "whole" : "first") : "-"} bg ${+s.bg}` : s.card ? "card" : "no swap"]))));
  const full = Object.values(seen).find((s) => s.swap && s.name === "Klee One" && s.bg);
  assert.ok(full && full.strip && full.traits.length === 2 && /weight/.test(full.tech), "a swap with room for every line shows them all");
  assert.ok(Object.entries(seen).some(([k, s]) => k.startsWith("Yomogi") && s.swap && !s.strip), "some short window shows Yomogi with its strip yielded");
  assert.ok(Object.entries(seen).some(([, s]) => s.swap && s.tech && s.traits.length < 2), "Technical back-fills when the traits don't fit");
  assert.equal(seen["Barlow Condensed 360"].swap, false, "360 px: no room for Barlow Condensed with its warning: no swap");
  assert.equal(seen["Klee One 380"].swap, true, "380 px: Klee One still swaps");
  assert.deepEqual(await ev("window.__errors"), []);
});

test("2C: in a short window's swap the \"Hidden by…\" line comes last, only when every other line shows whole, and never costs a line or the swap", { timeout: 300_000, skip: !HAVE_SHIPPED && "shipped records or font files not found" }, async () => {
  const read = `(() => { const w = document.querySelector(".t3x-fswap");
    if (!w) return { swap: false, card: !!document.querySelector(".t3x-fcard-pane") };
    if (getComputedStyle(w).display === "none") return { swap: false, card: false };
    const vis = (sel) => !!w.querySelector(sel)?.checkVisibility(), tech = w.querySelector(".t3x-fcard-tech");
    return { swap: true, name: w.querySelector(".t3x-fcard-name").textContent, fits: w.scrollHeight <= w.clientHeight + 0.5, strip: vis(".t3x-fcard-strip"), bg: vis(".t3x-fcard-bg"),
      tech: tech.checkVisibility() ? (/weight/.test(tech.textContent) ? "whole" : "first") : "-", traits: [...w.querySelectorAll("li")].filter((li) => li.checkVisibility()).length, all: w.querySelectorAll("li").length,
      hidden: vis(".t3x-fcard-hidden"), last: [...w.children].filter((e) => e.checkVisibility()).at(-1).className }; })()`;
  const seen = {};
  for (const height of [600, 560, 520, 480, 440, 400, 380, 360]) {
    for (const printOnly of [true, false]) { // true: Kalam is listed only because it's the current font, so its card has the Hidden line
      await load({ height, records: "shipped", settings: { ...SETTINGS, printOnly, fontMain: { family: "Kalam", size: null } } });
      await openFonts();
      await openMenu();
      const o = await optionAt("Kalam");
      await mouse("mouseMoved", o.x, o.y); await sleep(450); await frames();
      await ev(`(async () => { for (let i = 0; i < 60; i++) { const w = document.querySelector(".t3x-fswap"); if (document.querySelector(".t3x-fcard-pane") || (w && (getComputedStyle(w).display === "none" || w.querySelector(".t3x-fcard-name")?.textContent === "Kalam"))) return 1; await new Promise((r) => setTimeout(r, 50)); } return 0; })()`); await frames();
      seen[`${height} ${printOnly ? "hidden" : "listed"}`] = await ev(read);
      await key("Escape"); await sleep(150);
    }
  }
  console.log(JSON.stringify(seen));
  for (const height of [600, 560, 520, 480, 440, 400, 380, 360]) {
    const a = seen[`${height} hidden`], b = seen[`${height} listed`];
    assert.equal(b.hidden ?? false, false, `${height}: no Hidden line when the filter doesn't hide the font`);
    if (b.swap) { // where the font swaps without the line, it swaps the same with it
      const { hidden, last, ...rest } = a, { hidden: _h, last: _l, ...restB } = b;
      assert.deepEqual(rest, restB, `${height}: the Hidden line costs no line and not the swap`);
    } else assert.ok(b.card && (a.card || a.swap), `${height}: a card without the line; with it (4A: the card's last line) a card, or the swap once that card is too tall`);
    if (!a.swap) continue;
    assert.ok(a.fits, `${height}: whole lines inside the box`);
    if (a.hidden) {
      assert.ok(a.strip && a.traits === a.all && a.tech === "whole" && a.bg, `${height}: the Hidden line only when every other line shows whole`);
      assert.equal(a.last, "t3x-fcard-hidden", `${height}: and last`);
    }
  }
  assert.ok(Object.entries(seen).some(([k, s]) => k.endsWith("hidden") && s.swap && !s.hidden && s.strip && s.traits === s.all && s.tech === "whole" && s.bg), "a swap one line short shows everything but the Hidden line: it is the first line left out");
  // With room: Dekko's taller card swaps the pane for this menu opening, so Kalam then shows in the swap where its own card would fit.
  const roomy = {};
  for (const height of [565, 570, 575, 580, 585, 590]) {
    await load({ height, records: "shipped", settings: { ...SETTINGS, fontMain: { family: "Kalam", size: null } } });
    await openFonts();
    await openMenu();
    for (const font of ["Dekko", "Kalam"]) {
      const o = await optionAt(font);
      await mouse("mouseMoved", o.x, o.y); await sleep(450); await frames();
      await ev(`(async () => { for (let i = 0; i < 60; i++) { const c = document.querySelector(".t3x-fcard-pane .t3x-fcard-name, .t3x-fswap .t3x-fcard-name"); if (c?.textContent === ${JSON.stringify(font)}) return 1; await new Promise((r) => setTimeout(r, 50)); } return 0; })()`); await frames();
    }
    roomy[height] = await ev(read);
    await key("Escape"); await sleep(150);
  }
  console.log(JSON.stringify(roomy));
  for (const [height, s] of Object.entries(roomy)) if (s.swap) {
    assert.ok(s.fits && s.name === "Kalam", `${height}: Kalam in the swap, whole lines`);
    if (s.hidden) assert.ok(s.strip && s.traits === s.all && s.tech === "whole" && s.bg && s.last === "t3x-fcard-hidden", `${height}: the Hidden line shows only after every other line, and last`);
  }
  assert.ok(Object.values(roomy).some((s) => s.swap && s.hidden), "with room for every line, the swap shows the Hidden line");
  assert.deepEqual(await ev("window.__errors"), []);
});
