// Thread details float and lock (Andy, 24 Nov 2026, candidate v3): the build checks, against the real
// extras.css and extras.js on a page shaped like T3's header and docked thread details card.
import { test, before, after } from "node:test";
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
const CHROME = process.env.T3X_CHROME || newestHeadlessChrome();
const OUT_ROOT = process.env.T3X_GROUPING_OUT || path.join(SRC, "task-output");
const SKIP = !fs.existsSync(CHROME) && "headless Chrome not found";

// T3 Nightly 5165's own theme tokens (read from its UI, 24 Nov 2026).
const DARK = `--background:#000;--foreground:oklch(97% 0 none);--popover:color-mix(in srgb, oklch(14.5% 0 none) 97%, #fff);--muted-foreground:oklch(70.8% 0 none);--accent:color-mix(in oklab, #fff 4%, transparent);--accent-foreground:oklch(97% 0 none);--border:color-mix(in oklab, #fff 8%, transparent);--ring:oklch(57.1% .21 264)`;
const LIGHT = `--background:oklch(99.2% 0 0);--foreground:oklch(21% .006 285.885);--popover:#fff;--muted-foreground:oklch(55.2% .016 285.938);--accent:oklch(96.7% .001 286.375);--accent-foreground:oklch(21% .006 285.885);--border:oklch(92% .004 286.32);--ring:oklch(48.8% .217 264)`;
const ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h8"/></svg>`;
const BTN = `display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;box-sizing:border-box;border:1px solid transparent;border-radius:8px;padding:0;position:relative`;
const ASIDE = () => `<aside data-workspace-area="details" aria-label="Thread details" role="region" tabindex="-1" class="absolute z-20" data-thread-details-panel="inline" style="position:absolute;right:12px;top:12px;width:280px"><div class="dropdown-glass" data-thread-details-card="true" style="background:rgba(17,17,17,.84);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid rgba(245,245,245,.1);border-radius:16px;padding:10px;display:grid;gap:6px"><button type="button" id="c1">Open in Antigravity</button><button type="button" id="menu" aria-haspopup="menu" aria-expanded="false">Choose editor</button><button type="button" id="c3">Initialize Git</button><p style="margin:0;height:90px">Thread facts</p></div></aside>`;
const page = (theme, settings) => `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${theme};--font-sans:system-ui,sans-serif}
body{margin:0;background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans)}
[data-slot="toggle"]{color:var(--foreground);background:transparent}
[data-slot="toggle"][data-pressed]{background:var(--accent);color:var(--accent-foreground)}
.z-20{z-index:20}
[data-slot="toggle"] svg{opacity:.8;pointer-events:none}
header{position:fixed;top:0;left:0;right:0;height:52px;display:flex;justify-content:flex-end;align-items:center;padding-right:12px;box-sizing:border-box;background:var(--background)}
main{position:fixed;top:52px;left:0;right:0;bottom:0}
</style><link rel="stylesheet" href="/extras.css"></head><body>
<header><div data-panel-layout-controls="true" style="display:flex;height:100%;align-items:center;gap:4px">
<span class="flex shrink-0" data-thread-panel-toggle="true" data-slot="tooltip-trigger" style="display:flex"><button id="tog" type="button" data-pressed="" aria-pressed="true" data-slot="toggle" aria-label="Toggle thread details panel" style="${BTN}">${ICON}</button></span>
<span class="flex shrink-0" data-slot="tooltip-trigger" style="display:flex"><button id="term" type="button" aria-pressed="false" data-slot="toggle" aria-label="Toggle terminal drawer" style="${BTN}">${ICON}</button></span>
<span class="flex shrink-0" data-slot="tooltip-trigger" style="display:flex"><button id="right" type="button" aria-pressed="false" data-slot="toggle" aria-label="Toggle right panel" style="${BTN}">${ICON}</button></span>
</div></header>
<main><div data-chat-canvas="true" id="canvas" style="position:relative;height:100%;--chat-timeline-gutter:0px;--chat-lane-inset-start:12px;--chat-lane-inset-end:276px">
<a id="clink" href="#clicked" style="position:absolute;left:1000px;top:1px;font-size:9px;line-height:9px">corridor link</a>
<div id="lane" style="padding:60px calc(48px + var(--chat-lane-inset-end)) 0 calc(48px + var(--chat-lane-inset-start))">Chat text that the card would otherwise push left.</div>
${ASIDE()}
</div></main>
<button id="anchor" style="position:fixed;left:8px;bottom:8px">star</button>
<script>
window.__T3X_PICK_TEST__ = {}; window.__errors = [];
addEventListener("error", (e) => __errors.push(String(e.message))); addEventListener("unhandledrejection", (e) => __errors.push(String(e.reason)));
localStorage.setItem("t3x:settings:v1", ${JSON.stringify(JSON.stringify(settings))});
// T3's own toggle: pressed closes the docked card, unpressed opens a fresh one (as React re-creates it).
window.__asideHTML = ${JSON.stringify(ASIDE())};
// Like T3, opening also puts focus on the card's first control.
document.getElementById("tog").addEventListener("click", (e) => {
  const b = e.currentTarget, canvas = document.getElementById("canvas");
  if (b.getAttribute("aria-pressed") === "true") { canvas.querySelector("[data-thread-details-panel]")?.remove(); b.setAttribute("aria-pressed", "false"); b.removeAttribute("data-pressed"); }
  else { canvas.insertAdjacentHTML("beforeend", __asideHTML); b.setAttribute("aria-pressed", "true"); b.setAttribute("data-pressed", ""); canvas.querySelector("[data-thread-details-panel] button")?.focus(); }
});
</script><script src="/extras.js"></script></body></html>`;

const server = { theme: DARK, settings: {} };
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
const move = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
const press = async (x, y) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); };
const VK = { Tab: 9, Escape: 27, ArrowDown: 40, Enter: 13, " ": 32 };
const key = async (k, modifiers = 0) => {
  const code = k === " " ? "Space" : k, text = k === "Enter" ? "\r" : k === " " ? " " : undefined;
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: VK[k] ?? 0, modifiers, ...(text ? { text } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: VK[k] ?? 0, modifiers });
};

async function load(settings = {}, theme = DARK) {
  server.settings = settings;
  server.theme = theme;
  await send("Page.navigate", { url: `http://127.0.0.1:${srv.address().port}/` });
  await sleep(500);
  await frames();
  await move(200, 600);
  await frames();
}
const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : null; })()`);
const state = () => ev(`(() => {
  const H = document.documentElement, a = document.querySelector("[data-thread-details-panel]"), lock = document.querySelector(".t3x-details-lock"), tog = document.getElementById("tog");
  const cs = a && getComputedStyle(a);
  return {
    float: H.hasAttribute("data-t3x-details-float"), mode: H.getAttribute("data-t3x-details-mode"), docked: H.hasAttribute("data-t3x-details-docked"), shown: H.hasAttribute("data-t3x-details-shown"),
    aside: Boolean(a), inert: Boolean(a?.inert), visibility: cs?.visibility, opacity: cs && Number(cs.opacity), pointer: cs?.pointerEvents, transform: cs?.transform,
    inset: getComputedStyle(document.getElementById("canvas")).getPropertyValue("--chat-lane-inset-end").trim(),
    insetStart: getComputedStyle(document.getElementById("canvas")).getPropertyValue("--chat-lane-inset-start").trim(),
    cardBf: a && getComputedStyle(a.querySelector("[data-thread-details-card]")).backdropFilter, cardZ: cs?.zIndex,
    lock: Boolean(lock), lockNext: lock?.nextElementSibling?.matches("[data-thread-panel-toggle]") ?? false, lockPressed: lock?.getAttribute("aria-pressed"), lockLabel: lock?.getAttribute("aria-label"), lockTitle: lock?.title,
    pressed: tog.getAttribute("aria-pressed"), desc: tog.getAttribute("aria-description"), active: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
    errors: window.__errors.slice(),
  };
})()`);
const saved = () => ev(`JSON.parse(localStorage.getItem("t3x:settings:v1") || "{}")`);

before(async () => {
  if (SKIP) return;
  srv = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname;
    if (name === "/extras.css" || name === "/extras.js") {
      res.writeHead(200, { "Content-Type": `${name.endsWith("css") ? "text/css" : "text/javascript"}; charset=utf-8`, "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(path.join(SRC, "public", name.slice(1)), "utf8").replace('const BASE = "http://127.0.0.1:8793/";', "const BASE = location.origin + \"/\";"));
    }
    if (name === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page(server.theme, server.settings)); }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(OUT_ROOT, "tmp"), { recursive: true });
  profile = fs.mkdtempSync(path.join(OUT_ROOT, "tmp", "chprof-"));
  chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--window-size=1280,860", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
});
after(async () => {
  try { ws?.close(); } catch {}
  chrome?.kill("SIGKILL");
  srv?.close();
  await sleep(200);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const AUTO = { detailsFloat: true, detailsMode: "auto" };

test("float on: the chat keeps its full lane while the card is docked; off: T3's own layout", { skip: SKIP }, async () => {
  await load({});
  let s = await state();
  assert.equal(s.float, true);
  assert.equal(s.mode, "locked");
  assert.equal(s.inset, "0px", "lane inset zeroed while docked");
  assert.equal(s.insetStart, "0px");
  assert.equal(s.shown, false);
  assert.equal(s.inert, false);
  assert.equal(s.visibility, "visible");
  await load({ detailsFloat: false });
  s = await state();
  assert.equal(s.float, false);
  assert.equal(s.mode, null);
  assert.equal(s.inset, "276px");
  assert.equal(s.insetStart, "12px");
  assert.equal(s.lock, false, "no padlock while float is off");
  assert.equal(s.desc, null, "no aria-description while float is off");
  assert.equal(s.docked, false);
  const glass = await ev(`getComputedStyle(document.querySelector("[data-thread-details-card]")).backdropFilter`);
  assert.match(glass, /blur/, "T3's glass kept while float is off");
  await load({ detailsFloat: false, detailsMode: "auto" });
  s = await state();
  assert.equal(s.inert, false, "Auto-hide never acts while float is off");
  assert.equal(s.visibility, "visible");
  assert.deepEqual(s.errors, []);
});

test("a floating browser preview leaves T3's layout alone", { skip: SKIP }, async () => {
  await load({});
  await ev(`document.querySelector("main").insertAdjacentHTML("beforeend", '<section data-preview-mini-player="true" aria-label="Floating browser preview" style="position:absolute;left:700px;top:400px;width:300px;height:200px"></section>'), 1`);
  await frames();
  assert.equal((await state()).inset, "276px");
  await ev(`document.querySelector("[data-preview-mini-player]").remove(), 1`);
  await frames();
  assert.equal((await state()).inset, "0px");
});

test("floating card surface: opaque popover colour, no blur, T3 border, soft shadow", { skip: SKIP }, async () => {
  await load({});
  const c = await ev(`(() => { const card = document.querySelector("[data-thread-details-card]"); const cs = getComputedStyle(card); const probe = document.createElement("i"); probe.style.color = "var(--popover)"; document.body.append(probe); const pop = getComputedStyle(probe).color; probe.remove(); return { bg: cs.backgroundColor, pop, bf: cs.backdropFilter, shadow: cs.boxShadow, bw: cs.borderTopWidth, radius: cs.borderTopLeftRadius, z: getComputedStyle(card.parentElement).zIndex }; })()`);
  assert.equal(c.bg, c.pop, "card background is the popover colour");
  assert.equal(c.bf, "none");
  assert.match(c.shadow, /0px 12px 32px/);
  assert.equal(c.bw, "1px");
  assert.equal(c.radius, "16px", "T3's own radius kept");
  assert.equal(c.z, "30");
});

test("padlock: beside the lined-paper button, 24 px fully clickable, named, pressed when Locked", { skip: SKIP }, async () => {
  await load({});
  const s = await state();
  assert.equal(s.lock, true);
  assert.equal(s.lockNext, true, "immediately left of the lined-paper button's group");
  assert.equal(s.lockLabel, "Keep thread details visible");
  assert.equal(s.lockPressed, "true");
  assert.equal(s.lockTitle, "Thread details: locked open (click to auto-hide)");
  assert.equal(s.desc, "Press Down Arrow to move into the thread details card.");
  const lock = await rect(".t3x-details-lock"), tog = await rect("#tog"), glyph = await rect(".t3x-details-lock svg");
  assert.equal(lock.w, 24);
  assert.equal(lock.h, 28);
  assert.equal(glyph.w, 14);
  assert.ok(Math.abs(lock.r - (tog.l + 4)) <= 0.5, `padlock overlaps the button by 4 px as in the prototype (${lock.r} vs ${tog.l})`);
  assert.ok(Math.abs(glyph.r - (tog.l + 1)) <= 0.5, "glyph sits where the prototype drew it");
  const hits = await ev(`(() => { const out = []; for (let x = ${Math.ceil(lock.l)}; x < ${Math.floor(lock.r)}; x++) for (const y of [${lock.t + 7}, ${lock.cy}, ${lock.b - 7}]) { const el = document.elementFromPoint(x + 0.5, y); if (!el?.closest(".t3x-details-lock")) out.push([x, y, el?.id || el?.tagName]); } return out; })()`);
  assert.deepEqual(hits, [], "every point of the 24 px target (inside its rounded corners) is the padlock");
  const togHit = await ev(`document.elementFromPoint(${tog.l + 6}, ${tog.cy})?.closest("#tog") ? 1 : 0`);
  assert.equal(togHit, 1, "the lined-paper button keeps the rest of its target");
  const colours = await ev(`(() => { const p = document.createElement("i"); document.body.append(p); const c = (v) => { p.style.color = v; return getComputedStyle(p).color; }; const r = { fg: c("var(--foreground)"), muted: c("var(--muted-foreground)"), lock: getComputedStyle(document.querySelector(".t3x-details-lock")).color }; p.remove(); return r; })()`);
  assert.equal(colours.lock, colours.fg, "closed padlock in the text colour when Locked");
  // Keyboard focus shows a ring.
  await ev(`document.activeElement?.blur(), 1`);
  await key("Tab");
  await frames();
  const ring = await ev(`(() => { const l = document.querySelector(".t3x-details-lock"); return { focused: document.activeElement === l, fv: l.matches(":focus-visible"), shadow: getComputedStyle(l).boxShadow, outline: getComputedStyle(l).outlineStyle }; })()`);
  assert.equal(ring.focused, true, "Tab reaches the padlock first");
  assert.equal(ring.fv, true);
  assert.ok(/inset/.test(ring.shadow) || ring.outline !== "none", `visible focus ring (${ring.shadow})`);
  // A click switches the global mode, the same setting as the ✦ panel.
  await move(lock.cx, lock.cy);
  await press(lock.cx, lock.cy);
  await frames();
  const after = await state();
  assert.equal(after.mode, "auto");
  assert.equal(after.lockPressed, "false");
  assert.equal(after.lockTitle, "Thread details: auto-hide (click to lock open)");
  assert.equal((await saved()).detailsMode, "auto");
  assert.equal(after.shown, true, "the pointer on the padlock keeps the card shown");
  await move(300, 600);
  await frames();
  const muted = await ev(`getComputedStyle(document.querySelector(".t3x-details-lock")).color`);
  assert.equal(muted, colours.muted, "open padlock in the muted colour when Auto");
  // Keyboard: the padlock keeps focus across mode changes.
  await ev(`document.querySelector(".t3x-details-lock").focus(), 1`);
  await key("Enter");
  await frames();
  let k = await state();
  assert.equal(k.mode, "locked");
  assert.equal(k.active, "t3x-details-lock", "focus stays on the padlock");
  await key(" ");
  await frames();
  k = await state();
  assert.equal(k.mode, "auto");
  assert.equal(k.active, "t3x-details-lock", "focus still on the padlock");
  assert.equal(k.shown, true, "keyboard focus on the padlock keeps the card shown");
});

test("Auto: tucked and inert, icon dimmed on T3's pressed fill with at least 3:1 contrast", { skip: SKIP }, async () => {
  for (const theme of [DARK, LIGHT]) {
    await load(AUTO, theme);
    await sleep(300);
    const s = await state();
    assert.equal(s.docked, true);
    assert.equal(s.shown, false);
    assert.equal(s.inert, true);
    assert.equal(s.visibility, "hidden");
    assert.equal(s.opacity, 0);
    assert.equal(s.pointer, "none");
    assert.match(s.transform, /matrix\(1, 0, 0, 1, 16, 0\)/);
    assert.equal(s.inset, "0px");
    const c = await ev(`(() => {
      const t = document.getElementById("tog"), p = document.createElement("i"); document.body.append(p);
      const rgb = (v) => { p.style.color = v; const m = getComputedStyle(p).color; const cv = document.createElement("canvas").getContext("2d"); cv.fillStyle = m; cv.fillRect(0, 0, 1, 1); return [...cv.getImageData(0, 0, 1, 1).data]; };
      const over = (top, a, bottom) => bottom.map((v, i) => i < 3 ? top[i] * a + v * (1 - a) : 255);
      const page = rgb("var(--background)"), fillC = rgb(getComputedStyle(t).backgroundColor), fill = over(fillC, fillC[3] / 255, page);
      const icon = over(rgb(getComputedStyle(t).color), 0.8, fill);
      const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const [a, b] = [L(icon), L(fill)].sort((x, y) => y - x);
      const muted = rgb("var(--muted-foreground)"), now = rgb(getComputedStyle(t).color);
      p.remove();
      return { ratio: (a + 0.05) / (b + 0.05), mutedIcon: muted.join() === now.join(), bg: getComputedStyle(t).backgroundColor, accent: (p.style.color = "var(--accent)", getComputedStyle(document.body).color) };
    })()`);
    assert.equal(c.mutedIcon, true, "only the icon dims to the muted colour");
    assert.ok(c.ratio >= 3, `tucked icon contrast ${c.ratio.toFixed(2)}:1 against the fill`);
    const fillKept = await ev(`getComputedStyle(document.getElementById("tog")).backgroundColor === (() => { const p = document.createElement("i"); p.style.backgroundColor = "var(--accent)"; document.body.append(p); const v = getComputedStyle(p).backgroundColor; p.remove(); return v; })()`);
    assert.equal(fillKept, true, "T3's pressed fill kept while tucked");
  }
});

test("Auto: hover shows after 120 ms, not before; tucks 0.5 s after leaving", { skip: SKIP }, async () => {
  await load(AUTO);
  const tog = await rect("#tog");
  await move(tog.cx, tog.cy);
  await sleep(40);
  assert.equal((await state()).shown, false, "no flash while passing over");
  await sleep(200);
  let s = await state();
  assert.equal(s.shown, true);
  assert.equal(s.inert, false);
  assert.equal(s.visibility, "visible");
  await move(300, 600);
  await sleep(250);
  assert.equal((await state()).shown, true, "still shown inside the 0.5 s grace");
  await sleep(450);
  s = await state();
  assert.equal(s.shown, false);
  assert.equal(s.inert, true);
});

test("Auto: the corridor between the buttons and the card keeps it shown; links under it still click", { skip: SKIP }, async () => {
  await load(AUTO);
  const tog = await rect("#tog"), aside = await rect("[data-thread-details-panel]");
  await move(tog.cx, tog.cy);
  await sleep(250);
  assert.equal((await state()).shown, true);
  // Slow diagonal crossing to the card's left half, 900 ms in all.
  const steps = 9;
  for (let i = 1; i <= steps; i++) {
    const x = tog.cx + (aside.l + 40 - tog.cx) * (i / steps), y = tog.b + 1 + (aside.t - 1 - tog.b - 1) * (i / steps);
    await move(x, y);
    await sleep(100);
    assert.equal((await state()).shown, true, `shown at step ${i}`);
  }
  await move(aside.l + 40, aside.t + 30);
  await sleep(700);
  assert.equal((await state()).shown, true, "pointer on the card keeps it shown");
  const link = await rect("#clink");
  await move(link.cx, link.cy);
  await sleep(700);
  assert.equal((await state()).shown, true, "the corridor keeps it shown");
  await press(link.cx, link.cy);
  await sleep(50);
  assert.equal(await ev("location.hash"), "#clicked", "the chat link under the corridor took the click");
});

test("Auto: a quick click closes at once with no delayed flash; the next click opens it shown", { skip: SKIP }, async () => {
  await load(AUTO);
  const tog = await rect("#tog");
  await move(tog.cx, tog.cy);
  await press(tog.cx, tog.cy);
  await frames();
  let s = await state();
  assert.equal(s.pressed, "false");
  assert.equal(s.aside, false);
  assert.equal(s.shown, false);
  await sleep(300);
  s = await state();
  assert.equal(s.shown, false, "the parked pointer doesn't bring anything back");
  assert.equal(s.lock, false, "no padlock while nothing is docked");
  await press(tog.cx, tog.cy);
  await frames();
  s = await state();
  assert.equal(s.aside, true);
  assert.equal(s.shown, true, "opening from closed shows the card at once");
  assert.equal(s.inert, false);
  assert.equal(s.opacity, 1);
  assert.equal(s.active, "c1", "T3 put (mouse) focus in the card");
  await move(300, 600);
  await sleep(800);
  s = await state();
  assert.equal(s.shown, false, "mouse focus in the card doesn't hold it open once the pointer leaves");
  assert.equal(s.inert, true);
});

test("Auto: keyboard focus shows at once, Down Arrow enters the card, Escape returns and tucks", { skip: SKIP }, async () => {
  await load(AUTO);
  await key("Tab"); // padlock
  await frames();
  assert.equal((await state()).shown, true, "keyboard focus on the padlock shows it at once");
  await key("Tab"); // lined-paper button
  await frames();
  let s = await state();
  assert.equal(s.active, "tog");
  assert.equal(s.shown, true);
  await key("ArrowDown");
  await frames();
  s = await state();
  assert.equal(s.active, "c1", "Down Arrow moves focus into the card");
  assert.equal(s.shown, true);
  await key("Escape");
  await frames();
  s = await state();
  assert.equal(s.active, "tog", "Escape returns focus to the lined-paper button");
  assert.equal(s.shown, false, "then the card tucks");
  await sleep(400);
  assert.equal((await state()).shown, false, "focus on the button doesn't re-show it after Escape");
  await key("ArrowDown");
  await frames();
  s = await state();
  assert.equal(s.active, "c1", "Down Arrow re-enters");
  assert.equal(s.shown, true);
  await key("Escape");
  await frames();
  await key("Tab"); // to the terminal toggle
  await frames();
  await key("Tab", 8); // Shift-Tab back
  await frames();
  s = await state();
  assert.equal(s.active, "tog");
  assert.equal(s.shown, true, "leaving and returning re-shows it");
  assert.deepEqual(s.errors, []);
});

test("Escape: a card menu handles it first; in Locked it only returns focus", { skip: SKIP }, async () => {
  await load(AUTO);
  await key("Tab");
  await key("Tab");
  await key("ArrowDown");
  await frames();
  await ev(`document.getElementById("menu").setAttribute("aria-expanded", "true"), document.getElementById("menu").focus(), 1`);
  await key("Escape");
  await frames();
  let s = await state();
  assert.equal(s.active, "menu", "focus stays while a card menu is open");
  assert.equal(s.shown, true);
  // The menu's popup is portaled outside the card and takes focus, as T3's menus do.
  await ev(`(() => { document.body.insertAdjacentHTML("beforeend", '<div id="popup" role="menu" tabindex="-1" style="position:fixed;left:700px;top:300px;width:120px;height:80px">menu</div>'); document.getElementById("popup").focus(); return 1; })()`);
  await move(300, 600);
  await sleep(800);
  s = await state();
  assert.equal(s.active, "popup");
  assert.equal(s.shown, true, "an open card menu keeps it shown with focus and pointer outside the card");
  await ev(`document.getElementById("menu").setAttribute("aria-expanded", "false"), document.getElementById("popup").remove(), document.activeElement.blur(), 1`);
  await sleep(800);
  assert.equal((await state()).shown, false, "tucks once the menu has closed");
  await load({});
  await ev(`document.getElementById("c3").focus(), 1`);
  await key("Escape");
  await frames();
  s = await state();
  assert.equal(s.active, "tog");
  assert.equal(s.visibility, "visible", "Locked: the card stays");
  assert.equal(s.inert, false);
});

test("T3 re-renders: padlock re-mounted, replaced card handled, attribute-only changes tracked", { skip: SKIP }, async () => {
  await load(AUTO);
  await ev(`(() => { const span = document.querySelector("[data-thread-panel-toggle]"); const clone = span.cloneNode(true); span.replaceWith(clone); return 1; })()`);
  await frames();
  let s = await state();
  assert.equal(s.lock, true);
  assert.equal(s.lockNext, true, "padlock back beside the new button");
  assert.equal(await ev(`document.querySelectorAll(".t3x-details-lock").length`), 1);
  // Thread switch: T3 replaces the docked card while a tuck is pending.
  const tog = await rect("[aria-label='Toggle thread details panel']");
  await move(tog.cx, tog.cy);
  await sleep(250);
  assert.equal((await state()).shown, true);
  await move(300, 600);
  await sleep(100);
  await ev(`(() => { const a = document.querySelector("[data-thread-details-panel]"); a.insertAdjacentHTML("afterend", __asideHTML); a.remove(); return 1; })()`);
  await frames();
  s = await state();
  assert.equal(s.shown, false, "a new card in Auto starts tucked");
  assert.equal(s.inert, true, "the new card is inert while tucked");
  await sleep(600);
  assert.deepEqual((await state()).errors, []);
  // aria-pressed flipping alone (no card change) cancels a pending hover reveal.
  await move(tog.cx, tog.cy);
  await sleep(30);
  await ev(`document.querySelector("[aria-label='Toggle thread details panel']").setAttribute("aria-pressed", "false"), 1`);
  await sleep(250);
  assert.equal((await state()).shown, false, "no reveal for a thread whose details are closed");
});

test("reduced motion: fade only", { skip: SKIP }, async () => {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await load(AUTO);
  await sleep(300);
  assert.equal((await state()).transform, "none");
  await send("Emulation.setEmulatedMedia", { features: [] });
});

test("✦ panel: Thread details section before Popups; Locked / Auto-hide greyed while float is off", { skip: SKIP }, async () => {
  await load({ detailsFloat: false, detailsMode: "auto" });
  await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`);
  await sleep(300);
  const p = await ev(`(() => {
    const heads = [...document.querySelectorAll('[data-t3x="pop"] section > h3')].map((x) => x.textContent);
    const sec = [...document.querySelectorAll('[data-t3x="pop"] section')].find((x) => x.querySelector(":scope > h3")?.textContent === "Thread details");
    const radios = [...sec.querySelectorAll('[role="radio"]')];
    return { heads, sw: sec.querySelector('[role="switch"]').textContent, swOn: sec.querySelector('[role="switch"]').getAttribute("aria-checked"), notes: [...sec.querySelectorAll(".t3x-note")].map((n) => n.textContent),
      radios: radios.map((r) => [r.textContent, r.getAttribute("aria-checked"), r.disabled]), label: sec.querySelector(".t3x-radios")?.previousElementSibling?.textContent,
      opacity: getComputedStyle(radios[0].closest(".t3x-set")).opacity };
  })()`);
  const i = p.heads.indexOf("Thread details");
  assert.ok(i >= 0 && p.heads[i + 1] === "Popups", `section order ${p.heads.join(" / ")}`);
  assert.equal(p.sw, "Float over the chat");
  assert.equal(p.swOn, "false");
  assert.equal(p.label, "When open");
  assert.deepEqual(p.radios, [["Locked", "false", true], ["Auto-hide", "true", true]], "kept value, greyed out");
  assert.equal(p.opacity, "0.65");
  assert.deepEqual(p.notes, [
    "The docked card sits over the chat instead of pushing the text left. Off: T3’s own layout.",
    "Locked: the card stays over the top-right of the chat. Auto-hide: it tucks away and shows while you point at the lined-paper button, the padlock or the card, or press ↓ on the lined-paper button.",
  ]);
});

test("leaving Auto-hide or float while tucked gives T3 its card back", { skip: SKIP }, async () => {
  await load(AUTO);
  await sleep(250);
  assert.equal((await state()).inert, true);
  await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`);
  await sleep(200);
  await ev(`[...document.querySelectorAll('[role="radio"]')].find((r) => r.textContent === "Locked").click(), 1`);
  await frames();
  let s = await state();
  assert.equal(s.mode, "locked");
  assert.equal(s.inert, false);
  assert.equal(s.visibility, "visible");
  assert.equal(s.desc, "Press Down Arrow to move into the thread details card.");
  await load(AUTO);
  await sleep(250);
  await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`);
  await sleep(200);
  await ev(`[...document.querySelectorAll('[role="switch"]')].find((r) => r.textContent === "Float over the chat").click(), 1`);
  await frames();
  s = await state();
  assert.equal(s.float, false);
  assert.equal(s.inert, false);
  assert.equal(s.visibility, "visible");
  assert.equal(s.desc, null);
  assert.equal(s.lock, false);
  assert.equal(s.docked, false);
  assert.equal(s.inset, "276px");
  assert.deepEqual(s.errors, []);
});

test("thread switch in Auto: the new card is tucked on its first painted frame", { skip: SKIP }, async () => {
  await load(AUTO);
  const tog = await rect("#tog");
  await move(tog.cx, tog.cy);
  await sleep(250);
  assert.equal((await state()).shown, true);
  await move(300, 600);
  const first = await ev(`new Promise((resolve) => {
    const a = document.querySelector("[data-thread-details-panel]");
    history.pushState(null, "", "/other-thread");
    a.insertAdjacentHTML("afterend", __asideHTML); a.remove();
    requestAnimationFrame(() => { const n = document.querySelector("[data-thread-details-panel]"), cs = getComputedStyle(n); resolve({ visibility: cs.visibility, opacity: cs.opacity, inert: n.inert }); });
  })`);
  assert.deepEqual(first, { visibility: "hidden", opacity: "0", inert: true });
  await sleep(700);
  assert.equal((await state()).shown, false);
});

test("two docked cards (split panes) leave the feature inactive", { skip: SKIP }, async () => {
  await load(AUTO);
  await ev(`(() => { const c = document.getElementById("canvas").cloneNode(true); c.id = "canvas2"; document.querySelector("main").append(c); return 1; })()`);
  await frames();
  const s = await state();
  assert.equal(s.docked, false);
  assert.equal(s.lock, false);
  assert.equal(s.inert, false, "nothing tucked when the card can't be told apart");
  assert.equal(s.visibility, "visible");
  assert.equal(s.inset, "276px", "T3's lane in split panes");
  assert.equal(s.insetStart, "12px");
  assert.match(s.cardBf, /blur/, "T3's glass in split panes");
  assert.equal(s.cardZ, "20");
});

test("narrow window: T3's popover card is left as it is", { skip: SKIP }, async () => {
  await load(AUTO);
  await ev(`(() => { const a = document.querySelector("[data-thread-details-panel]"); a.setAttribute("data-thread-details-panel", "popover"); document.body.append(a); return 1; })()`);
  await frames();
  const s = await ev(`(() => { const a = document.querySelector("[data-thread-details-panel]"), cs = getComputedStyle(a); return { docked: document.documentElement.hasAttribute("data-t3x-details-docked"), lock: !!document.querySelector(".t3x-details-lock"), inert: a.inert, vis: cs.visibility, bf: getComputedStyle(a.firstElementChild).backdropFilter }; })()`);
  assert.deepEqual(s, { docked: false, lock: false, inert: false, vis: "visible", bf: "blur(16px)" });
});

// Neon's code-review blockers (round 1), as regression checks.
test("after Escape, leaving the buttons over the tucked card's area and returning re-shows on hover", { skip: SKIP }, async () => {
  await load(AUTO);
  const tog = await rect("#tog");
  await move(tog.cx, tog.cy);
  await sleep(250);
  await key("Tab"); await key("Tab");
  await key("Escape");
  await frames();
  assert.equal((await state()).shown, false);
  await move(1100, 150);
  await sleep(100);
  await move(tog.cx, tog.cy);
  await sleep(250);
  assert.equal((await state()).shown, true);
});

test("a padlock we took out never pulls focus back when it returns", { skip: SKIP }, async () => {
  await load(AUTO);
  await key("Tab");
  await frames();
  assert.equal((await state()).active, "t3x-details-lock");
  await ev(`(() => { history.pushState(null, "", "/t-closed"); document.querySelector("[data-thread-details-panel]").remove(); document.getElementById("tog").setAttribute("aria-pressed", "false"); return 1; })()`);
  await frames();
  assert.equal((await state()).lock, false);
  await ev(`(() => { history.pushState(null, "", "/t-open"); document.getElementById("canvas").insertAdjacentHTML("beforeend", __asideHTML); document.getElementById("tog").setAttribute("aria-pressed", "true"); return 1; })()`);
  await frames();
  const s = await state();
  assert.notEqual(s.active, "t3x-details-lock");
  assert.equal(s.shown, false);
  assert.equal(s.inert, true);
});

test("a replaced lined-paper button, a removed padlock and a new neighbour are all picked up", { skip: SKIP }, async () => {
  await load(AUTO);
  await ev(`(() => { const old = document.getElementById("tog"); const nb = old.cloneNode(true); nb.removeAttribute("aria-description"); old.replaceWith(nb); return 1; })()`);
  await frames();
  assert.equal((await state()).desc, "Press Down Arrow to move into the thread details card.");
  await ev(`document.getElementById("tog").focus(), 1`);
  await key("ArrowDown");
  await frames();
  assert.equal((await state()).active, "c1");
  await ev(`document.querySelector(".t3x-details-lock").remove(), 1`);
  await frames();
  assert.equal((await state()).lock, true, "padlock back after being taken out");
  await ev(`(() => { const sp = document.querySelector("[data-thread-panel-toggle]"); sp.parentElement.insertBefore(document.createElement("span"), sp); return 1; })()`);
  await frames();
  assert.equal((await state()).lockNext, true, "padlock stays right beside the lined-paper button");
});

test("switching Auto -> Locked -> Auto clears Escape's suppression; Shift-Tab between the buttons keeps it", { skip: SKIP }, async () => {
  await load(AUTO);
  const tog = await rect("#tog"), lock = await rect(".t3x-details-lock");
  await move(tog.cx, tog.cy);
  await sleep(250);
  await key("Tab"); await key("Tab");
  await key("Escape");
  await frames();
  await move(lock.cx, lock.cy);
  await press(lock.cx, lock.cy);
  await frames();
  await press(lock.cx, lock.cy);
  await frames();
  await sleep(700);
  assert.equal((await state()).shown, true, "pointer on the padlock keeps it shown after switching back");
  await load(AUTO);
  await key("Tab"); await key("Tab");
  await key("Escape");
  await frames();
  await key("Tab", 8);
  await frames();
  const s = await state();
  assert.equal(s.active, "t3x-details-lock");
  assert.equal(s.shown, false, "moving from the button to the padlock after Escape doesn't re-show it");
});

test("Auto with the floating browser preview open: padlock and tuck still work, layout is T3's", { skip: SKIP }, async () => {
  await load(AUTO);
  await ev(`document.querySelector("main").insertAdjacentHTML("beforeend", '<section data-preview-mini-player="true" aria-label="Floating browser preview" style="position:absolute;left:300px;top:400px;width:300px;height:200px"></section>'), 1`);
  await frames();
  let s = await state();
  assert.equal(s.inset, "276px");
  assert.equal(s.lock, true);
  assert.equal(s.inert, true);
  const tog = await rect("#tog");
  await move(tog.cx, tog.cy);
  await sleep(250);
  s = await state();
  assert.equal(s.shown, true);
  assert.equal(s.visibility, "visible");
});
