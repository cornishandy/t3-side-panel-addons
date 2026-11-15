// Gate gaps Q1 to Q4 and the blocker-1 follower size, in headless Chrome against the real extras.css/extras.js (never the live app).
// Font files: T3X_FONTS_DIR, else the installed add-on's folder; the shipped records are font-about.json.
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
// The shipped records (all 71 families), for the tests that need Yomogi's and Barlow Condensed's warnings or a filtered font.
const SHIPPED = fs.existsSync(path.join(SRC, "font-about.json")) ? JSON.parse(fs.readFileSync(path.join(SRC, "font-about.json"), "utf8")) : null;
const HAVE_SHIPPED = HAVE_FONTS && !!SHIPPED && ["yomogi", "barlow-condensed", "kalam"].every((f) => fontFile(`${f}-latin-400.woff2`));
// Families whose files this harness can serve. List 3's files are not in the installed folder, so a hover on one never draws a card.
const DRAWABLE = FONTS.families.filter((f) => f.file && fontFile(f.file)).map((f) => f.name);

const THEME = `:root{--foreground:#2d2f3e;--background:#e9ebf0;--border:#c3c6d0;--popover:#f2f3f7;--popover-foreground:#2d2f3e;--muted-foreground:#6f7280;--accent:rgba(100,105,130,.14);--primary:#8a3ffc;--font-sans:Arial,sans-serif;--font-mono:Menlo,monospace}
body{margin:0;background:#e9ebf0;color:#2d2f3e;font:15px/1.5 var(--font-sans)}
ol,ul,menu{list-style:none;margin:0;padding:0}`; // T3's base styles (Tailwind preflight) strip list markers
const SETTINGS = { fontSchema: 2, fontComposer: { family: "Klee One", size: 120 }, fontMain: { family: "Zen Kurenaido", size: 130 }, fontQuestions: { family: "Dekko", size: null },
  fontSources: { composer: "own", prompts: "link:composer", main: "own", questions: "own" } };
const server = { core: false, aboutMode: "ok", aboutDelay: 0, catalogHits: 0, aboutHits: 0, body: "", records: "fixture" };
const page = () => `<!doctype html><html><head><meta charset="utf-8"><style>${THEME}</style><link rel="stylesheet" href="/extras.css"></head><body>${server.body}<button id="anchor" style="position:fixed;left:20px;bottom:20px">✦</button>
<script>${server.core ? "window.__T3X_TEST__ = {};" : "window.__T3X_PICK_TEST__ = {};"} window.__errors = []; addEventListener("error", (e) => __errors.push(String(e.message))); addEventListener("unhandledrejection", (e) => __errors.push(String(e.reason)));</script><script src="/extras.js"></script></body></html>`;
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


const SKIP = !HAVE_SHIPPED && "shipped records or font files not found";
const openPanel = async () => { await ev(`__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await sleep(400); };

// ---- Q1: a ✦ row whose font is hidden by you keeps its three lines ----
const rows = () => ev(`[...document.querySelectorAll(".t3x-fs-row")].map((row) => { const pos = row.querySelector(".t3x-fs-pos"); return { label: row.querySelector(".t3x-fs-label").textContent, h: row.offsetHeight, meta: row.querySelector(".t3x-fs-meta").offsetHeight,
  you: !!pos?.hasAttribute("data-you"), pos: pos?.textContent ?? null, title: pos?.title ?? null, aria: pos?.getAttribute("aria-label") ?? null, minWidth: pos?.style.minWidth ?? null }; })`);
test("Q1: a ✦ row hidden by you keeps the height of the same row at rest; line 3 says \"hidden by you\", or \"hidden\" where that is the only way to stay one line", { timeout: 180_000, skip: SKIP }, async () => {
  const bad = [], says = {};
  for (const width of [1512, 430, 380, 340]) {
    await load({ width, records: "shipped" }); await openPanel();
    const rest = await rows();
    await load({ width, records: "shipped", settings: { ...SETTINGS, hiddenFonts: ["Klee One", "Zen Kurenaido", "Dekko"] } }); await openPanel();
    const hid = await rows();
    const you = hid.filter((r) => r.you);
    assert.ok(you.length >= 3, `${width}: the three hidden fonts' rows are marked (${you.length})`);
    for (const r of rest) {
      const x = hid.find((y) => y.label === r.label);
      if (!x || x.h !== r.h || x.meta !== r.meta) bad.push({ width, label: r.label, rest: [r.h, r.meta], hidden: x && [x.h, x.meta] });
    }
    for (const r of you) {
      assert.equal(r.title, "hidden by you", `${width} ${r.label}: title`);
      assert.equal(r.aria, "hidden by you", `${width} ${r.label}: aria-label`);
      assert.match(r.minWidth ?? "", /^\d+(\.\d+)?ch$/, `${width} ${r.label}: the slot keeps the N-of-M width`);
      assert.equal(r.minWidth, rest.find((y) => y.label === r.label).minWidth, `${width} ${r.label}: the same slot width as at rest`);
    }
    says[width] = [...new Set(you.map((r) => r.pos))];
  }
  assert.deepEqual(bad, [], "no ✦ row or its line 3 changes height when its font is hidden");
  assert.deepEqual(says[1512], ["hidden by you"]);
  assert.deepEqual(says[430], ["hidden by you"]);
  assert.deepEqual(says[340], ["hidden"]);
});

// ---- Blocker 1: an area that follows another area ----
const about = () => ev(`(() => { const p = document.querySelector(".t3x-font-editor .t3x-fabout"); return { name: p?.querySelector(".t3x-fabout-name")?.textContent ?? null, width: [...(p?.querySelectorAll(".t3x-fabout-wline") ?? [])].map((e) => e.textContent), cond: p?.querySelector(".t3x-fabout-cond")?.textContent ?? null }; })()`);
test("follower area: Width and the score line name the size in use there, not the stored size of a font it is not using", { timeout: 60_000, skip: SKIP }, async () => {
  // "Your sent prompts" follows the composer (Klee One at 120%); its own stored pick is another font at 150%.
  await load({ records: "shipped", settings: { ...SETTINGS, fontPrompts: { family: "Zen Kurenaido", size: 150 } } });
  await openFonts("Your sent prompts");
  const a = await about();
  assert.equal(a.name, "Klee One");
  assert.equal(a.width.some((l) => /150%/.test(l)), false, "Width does not quote the stored size");
  assert.equal(/not your 150%/.test(a.cond ?? ""), false, "the score line does not either");
  assert.ok(a.width.some((l) => /at your 120% \(/.test(l)), "Width names the 120% in use here");
});
test("follower area: with no stored size of its own it still names the 120% in use", { timeout: 60_000, skip: SKIP }, async () => {
  await load({ records: "shipped", settings: { ...SETTINGS, fontPrompts: { family: "off", size: null } } });
  await openFonts("Your sent prompts");
  const a = await about();
  assert.equal(a.name, "Klee One");
  assert.ok(a.width.some((l) => /at your 120% \(/.test(l)), "Width names the 120% in use here");
  assert.match(a.cond ?? "", /not your 120%/);
});

// ---- Q2: the closed font menu's face carries the hidden mark ----
const FACE = {
  filter: { settings: { ...SETTINGS, printOnly: true, showPartly: false, fontMain: { family: "Kalam", size: null } }, ends: "· hidden by the filter" },
  you: { settings: { ...SETTINGS, fontMain: { family: "Kalam", size: null }, hiddenFonts: ["Kalam"], printOnly: false, showPartly: true }, ends: "· hidden by you" },
  both: { settings: { ...SETTINGS, printOnly: true, showPartly: false, fontMain: { family: "Kalam", size: null }, hiddenFonts: ["Kalam"] }, ends: "· hidden by the filter and by you" },
  none: { settings: { ...SETTINGS, fontMain: { family: "Kalam", size: null }, printOnly: false, showPartly: true }, ends: null },
};
test("Q2: the closed menu's face ends with the hidden mark, as the open row does, and has none for a font that is not hidden", { timeout: 120_000, skip: SKIP }, async () => {
  for (const [state, { settings, ends }] of Object.entries(FACE)) {
    await load({ records: "shipped", settings });
    await openFonts();
    const face = (await ev(`document.querySelector("#t3x-font-family selectedcontent")?.innerText ?? null`))?.replace(/\s+/g, " ").trim();
    assert.ok(face?.startsWith("Kalam"), `${state}: the face names the font (${face})`);
    if (ends) {
      assert.ok(face.endsWith(ends), `${state}: face "${face}" ends with "${ends}"`);
      assert.equal(await ev(`[...document.querySelectorAll("#t3x-font-family selectedcontent .mkt")].every((m) => getComputedStyle(m).display !== "none") && !!document.querySelector("#t3x-font-family selectedcontent .mkt")`), true, `${state}: the mark is drawn`);
    } else assert.doesNotMatch(face, /hidden/, `${state}: no hidden mark (${face})`);
  }
});

// ---- Q3: the short pane's swap, over every shipped font ----
test("Q3: over every shipped font, pane widths 220/300/420 and heights 100 to 520, the swap never keeps Background after a dropped trait, or the score without every trait and Technical", { timeout: 300_000, skip: SKIP }, async () => {
  // extras.js with __T3X_TEST__ set only exposes its pure core and does not start the app, so this page is its own load.
  Object.assign(server, { core: true, records: "shipped", aboutMode: "ok", body: "" });
  await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 945, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: url() });
  await ev(`(async () => { for (let i = 0; i < 100; i++) { if (window.__T3X_TEST__?.core) return 1; await new Promise((r) => setTimeout(r, 50)); } throw new Error("core did not load"); })()`);
  server.core = false;
  const res = await ev(`(async () => {
    const C = window.__T3X_TEST__.core;
    const cat = C.normalizeCatalog(await (await fetch("/font-catalog")).json());
    const about = await (await fetch("/font-about")).json();
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const swap = el("div", "t3x-fswap"); swap.style.position = "absolute"; swap.style.left = "0"; swap.style.top = "40px"; document.body.append(swap);
    const res = { fonts: 0, combos: 0, bgAfterDroppedTrait: [], scoreWithoutGate: [], bgWithoutTech: 0, bgWithoutTechOrdinary: 0, scoreShown: 0, bgWithoutTechNotOrdinary: [] };
    for (const f of cat) {
      const rec = about.records[f.name];
      let m; try { m = C.fontAbout(f, rec, { median: cat.xRatioMedian, usage: [{ label: "Replies", size: 110 }], uiWidth: cat.uiWidth }); } catch { continue; }
      if (!m || m.kind !== "font") continue;
      res.fonts++;
      for (const w of [220, 300, 420]) {
        swap.replaceChildren(el("div", "t3x-fswap-area", "Replies"), el("div", "t3x-fcard-name", m.name), el("div", "t3x-fcard-strip", m.strip), el("p", "t3x-fcard-desc", m.desc));
        const ul = m.card.length ? el("ul") : null; if (ul) { for (const x of m.card) ul.append(el("li", "", x)); swap.append(ul); }
        const bg = el("p", "t3x-fcard-line t3x-fcard-bg", m.background), tech = el("p", "t3x-fcard-line t3x-fcard-tech", m.technical);
        const score = m.screen ? el("p", "t3x-fcard-line t3x-fcard-score", m.screen.cardLine) : null;
        swap.append(bg, tech); if (score) swap.append(score); swap.append(el("p", "t3x-fcard-use", m.usage));
        const lis = ul ? [...ul.children] : [], warn = new Set(lis.filter((_, i) => m.cardWarn && m.cardWarn.includes(i)));
        const apply = (st) => { swap.children[2].hidden = !st.strip; if (ul) { ul.hidden = st.traits !== "all" && !warn.size; for (const li of lis) li.hidden = st.traits !== "all" && !warn.has(li); }
          tech.hidden = st.tech === "off"; tech.textContent = st.tech === "first" ? m.technicalFirst : m.technical; bg.hidden = !st.bg; if (score) score.hidden = !st.score; };
        swap.style.width = w + "px";
        const ordinary = (m.card?.length ?? 0) > (m.cardWarn?.length ?? 0);
        for (let hgt = 100; hgt <= 520; hgt += 12) {
          swap.style.height = hgt + "px";
          const k = C.fitSwapKeep({ traits: !!ul, score: !!score, hidden: false, ordinary }, (st) => { apply(st); return swap.scrollHeight <= swap.clientHeight + 0.5; });
          res.combos++;
          if (!k) continue;
          const at = [m.name, w, hgt, JSON.stringify(k)];
          if (k.score) res.scoreShown++;
          if (k.bg && k.traits !== "all") res.bgAfterDroppedTrait.push(at);
          if (k.score && (k.traits !== "all" || k.tech === "off")) res.scoreWithoutGate.push(at);
          if (k.bg && k.tech === "off") { res.bgWithoutTech++; if (ordinary) res.bgWithoutTechOrdinary++; else res.bgWithoutTechNotOrdinary.push(at); }
        }
      }
    }
    swap.remove();
    return res;
  })()`);
  assert.ok(res.fonts >= 60, `fonts swept: ${res.fonts}`);
  assert.equal(res.combos, res.fonts * 3 * 36);
  assert.ok(res.bgWithoutTechOrdinary > 0 && res.scoreShown > 0, `the sweep reaches Background without Technical (${res.bgWithoutTechOrdinary}) and the score (${res.scoreShown})`);
  assert.deepEqual(res.bgAfterDroppedTrait, [], "Background is never back-filled after a trait was dropped");
  assert.deepEqual(res.bgWithoutTechNotOrdinary, [], "Background without Technical only when an ordinary trait is on screen");
  assert.deepEqual(res.scoreWithoutGate.slice(0, 5), [], `the score never shows with traits dropped or Technical off (${res.scoreWithoutGate.length} combos)`);
  console.log("Q3 sweep:", JSON.stringify({ fonts: res.fonts, combos: res.combos, bgWithoutTech: res.bgWithoutTech }));
});

// ---- Q4: the docked card when details fail ----
test("Q4: docked, a failed details sentence is followed at once by the Hide this font foot; a T3 font has none", { timeout: 180_000, skip: SKIP }, async () => {
  const body = `<div data-message-role="assistant" style="position:fixed;left:40px;top:40px;width:560px"><div class="chat-markdown"><p id="reply">Reply prose that Replies styles: a paragraph to pick.</p></div></div>`;
  const dock = async (aboutMode, family) => {
    await load({ records: "shipped", aboutMode, body, settings: { ...SETTINGS, popMove: true, fontMain: { family, size: null } } });
    await openFonts();
    await ev(`[...document.querySelectorAll(".t3x-font-workspace button")].find((x) => /Small card/.test(x.textContent)).click(), 1`); await sleep(900); await frames();
    assert.equal(await ev(`document.querySelector(".t3x-font-workspace").dataset.mode`), "dock");
    await sleep(500); await frames();
    return ev(`(() => { const d = document.querySelector(".t3x-font-docksentence"), a = document.querySelector(".t3x-font-dockabout"), box = a.querySelector(".t3x-font-dockfoot"), foot = box.querySelector(".t3x-fabout-foot");
      return { shown: !!a.getClientRects().length, sentence: d.textContent, failed: d.classList.contains("t3x-font-docksentence-failed"), feet: box.querySelectorAll(".t3x-fabout-foot").length,
        directlyAfter: !!foot && d.nextElementSibling === box, footVisible: !!foot?.getClientRects().length, button: foot?.querySelector("button")?.textContent ?? null }; })()`);
  };
  const ok = await dock("ok", "Klee One");
  assert.equal(ok.failed, false, "details loaded: no failed sentence");
  assert.equal(ok.feet, 0, "details loaded: nothing under the sentence");
  const failed = await dock("fail", "Klee One");
  assert.deepEqual(failed, { shown: true, sentence: "Font details couldn't load.", failed: true, feet: 1, directlyAfter: true, footVisible: true, button: "Hide this font" });
  const t3 = await dock("fail", "T3 interface font");
  assert.equal(t3.feet, 0, "a T3 font has no foot");
  assert.equal(t3.failed, false);
});

// ---- Q4 late arrival: the failed block shows after the card has already been placed ----
const COMPOSER_AT = (top) => `<div data-testid="composer-editor" contenteditable="true" style="position:fixed;left:12px;top:${top}px;width:596px;margin:0"><p id="cp" style="margin:0">Typed text in the composer, long enough to run the full width of this narrow window and wrap on to a second line of text here.</p></div>`;
const dockCover = () => ev(`(() => { const el = document.querySelector(".t3x-font-workspace"); if (!el) return null; const c = el.getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(document.getElementById("cp")); const t = r.getBoundingClientRect();
  return { mode: el.dataset.mode, coveredRows: Math.max(0, Math.round(Math.min(c.bottom, t.bottom) - Math.max(c.top, t.top))) * (c.left < t.right && t.left < c.right ? 1 : 0) }; })()`);
async function pickComposerText() {
  await ev(`window.__T3X_PICK_TEST__.startFontPick(), 1`); await sleep(900);
  const p = await ev(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById("cp")); const t = r.getClientRects()[0]; return { x: t.left + 30, y: t.top + t.height / 2 }; })()`);
  await mouse("mouseMoved", p.x, p.y); await sleep(300);
  await mouse("mousePressed", p.x, p.y); await mouse("mouseReleased", p.x, p.y);
  await sleep(2500); await frames();
}
test("Q4 late: a pick places the card, then the failed sentence and foot arrive, and the card stays clear of that text", { timeout: 120_000, skip: SKIP }, async () => {
  await load({ width: 620, height: 1100, records: "shipped", aboutMode: "fail", body: COMPOSER_AT(600), settings: { ...SETTINGS, popMove: true, fontPicker: true } });
  await pickComposerText();
  const end = await dockCover();
  assert.equal(end?.mode, "dock");
  assert.equal(end.coveredRows, 0, `the card covers ${end.coveredRows} px of the height of the composer text just picked`);
});
test("Q4 late: a pinned failed card stays inside the window when the window gets shorter", { timeout: 120_000, skip: SKIP }, async () => {
  await load({ width: 620, height: 1100, records: "shipped", aboutMode: "fail", body: COMPOSER_AT(600), settings: { ...SETTINGS, popMove: true, fontPicker: true } });
  await pickComposerText();
  assert.equal((await dockCover())?.mode, "dock");
  await send("Emulation.setDeviceMetricsOverride", { width: 620, height: 500, deviceScaleFactor: 1, mobile: false }); await sleep(1200); await frames();
  const r = await ev(`(() => { const el = document.querySelector('.t3x-font-workspace[data-mode="dock"]'); const bar = el?.querySelector('.t3x-font-dockbar'); return el ? { bottom: el.getBoundingClientRect().bottom, bar: bar ? bar.getBoundingClientRect().bottom : 0, vh: innerHeight } : null; })()`);
  assert.ok(r, "the card is still docked");
  assert.ok(r.bottom <= r.vh && r.bar <= r.vh, `card bottom ${r.bottom} / foot bar ${r.bar} past the ${r.vh} px window`);
});
test("Q4 late: details failed more than a minute ago, so a later pick places the card before the retry answers, and it stays clear", { timeout: 200_000, skip: SKIP }, async () => {
  await load({ width: 620, height: 1100, records: "shipped", aboutMode: "fail", body: COMPOSER_AT(600), settings: { ...SETTINGS, popMove: true, fontPicker: true } });
  await openFonts("Message composer");
  await ev(`document.querySelector('[aria-label="Close Fonts"]').click(), 1`); await sleep(500);
  await sleep(61_000);
  await pickComposerText();
  const end = await dockCover();
  assert.equal(end?.mode, "dock");
  assert.equal(end.coveredRows, 0, `the card covers ${end.coveredRows} px of the height of the composer text just picked`);
});
