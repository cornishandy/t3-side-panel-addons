// The ✦ panel's "Your fonts" rows: three fixed lines, the size buttons (− n% +) and the two-way Default, in headless Chromium against the real extras.css/extras.js. Never attaches to T3.
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

test("Your fonts rows: fixed places, size steps to 200%, Default both ways, T3 fonts have none", { timeout: 90_000 }, async () => {
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
    // Sidebar labels: Arial at 150% (Tooltips follows it). Questions: T3's own code font. Plans: Georgia at 120%. Most rows also offer "Use for similar".
    await ev(`localStorage.setItem("t3x:settings:v1", JSON.stringify({ fontSchema: 2, fontMain: { family: "Arial", size: null }, fontComposer: { family: "Georgia", size: null },
      fontQuestions: { family: "T3 code font", size: null }, fontSidebar: { family: "Arial", size: 150 }, fontPlans: { family: "Georgia", size: 120 },
      fontSources: { main: "own", quotes: "link:main", reasoning: "native", plans: "own", questions: "own", composer: "own", head: "link:composer", prompts: "native",
        sidebar: "own", tooltips: "link:sidebar", interface: "native", usage: "native" } })), 1`);
    await send("Page.navigate", { url });
    assert.equal(await ev(`(async () => { for (let i = 0; i < 100; i++) { if (window.__T3X_PICK_TEST__?.openPanel) return "ready"; await new Promise((r) => setTimeout(r, 50)); } return "missing"; })()`), "ready");
    await new Promise((r) => setTimeout(r, 600));
    const saved = (k) => ev(`JSON.parse(localStorage.getItem("t3x:settings:v1"))[${JSON.stringify(k)}]`);
    const row = (id) => `document.querySelector('[data-focus="fs-name-${id}"]').closest(".t3x-fs-row")`;
    const val = (id) => ev(`${row(id)}.querySelector(".t3x-fs-size-val")?.textContent ?? null`);
    const until = (expr, what) => ev(`(async () => { for (let i = 0; i < 80; i++) { if (${expr}) return true; await new Promise((r) => setTimeout(r, 50)); } return ${JSON.stringify(what)}; })()`);
    const face = (alias, pct) => `[...document.fonts].some((f) => f.family.replace(/"/g, "") === ${JSON.stringify(alias)} && f.sizeAdjust === "${pct}%" && f.status === "loaded")`;
    // Every row: nothing spills out or overlaps; "Use for similar" is pinned top right whatever the label's length;
    // the position sits on the right, on the same line in every row that has a size.
    const geometry = () => ev(`[...document.querySelectorAll(".t3x-fs-row")].map((row) => {
      const R = row.getBoundingClientRect(), box = (e) => e.getBoundingClientRect();
      const parts = [...row.querySelectorAll(".t3x-fs-lead, .t3x-fs-similar, .t3x-fs-step, .t3x-fs-name, .t3x-fs-sz, .t3x-fs-size-val, .t3x-fs-defslot > :not(.t3x-fs-def-sizer), .t3x-fs-pos")];
      const boxes = parts.map((e) => ({ cls: e.className || e.textContent, r: box(e) })).filter((b) => b.r.width > 0);
      const out = boxes.filter((b) => b.r.left < R.left - 0.5 || b.r.right > R.right + 0.5).map((b) => b.cls);
      const overlap = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const p = boxes[i].r, q = boxes[j].r;
        if (p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5) overlap.push(boxes[i].cls + " / " + boxes[j].cls); }
      const similar = row.querySelector(".t3x-fs-similar"), head = box(row.querySelector(".t3x-fs-head")), pos = row.querySelector(".t3x-fs-pos"), meta = row.querySelector(".t3x-fs-meta");
      return { label: row.querySelector(".t3x-fs-label").textContent, out, overlap, scroll: row.scrollWidth - row.clientWidth, h: R.height, sized: !!row.querySelector(".t3x-fs-size[role]"),
        together: Math.abs(box(row.querySelector(".t3x-fs-size")).top + box(row.querySelector(".t3x-fs-size")).height / 2 - box(row.querySelector(".t3x-fs-defslot")).top - box(row.querySelector(".t3x-fs-defslot")).height / 2) < 4,
        lineW: Math.round(box(row.querySelector(".t3x-fs-sizeline")).width * 10),
        order: [...row.children].map((c) => c.className),
        similarRight: similar ? R.right - box(similar).right : null, similarTop: similar ? box(similar).top - head.top : null,
        posRight: pos ? R.right - box(pos).right : null, posDy: pos && meta ? box(pos).top - box(meta).top : null };
    })`);
    const checkLines = (lines, when) => {
      for (const l of lines) {
        assert.deepEqual(l.out, [], `${when}: ${l.label} spills out of its row`);
        assert.deepEqual(l.overlap, [], `${when}: ${l.label} has overlapping parts`);
        assert.ok(l.scroll <= 1, `${when}: ${l.label} scrolls sideways`);
        assert.deepEqual(l.order.slice(0, 2), ["t3x-fs-head", "t3x-fs-pick"], `${when}: ${l.label} is area line, then the font`);
        if (l.similarRight !== null) assert.ok(Math.abs(l.similarRight) <= 1 && l.similarTop >= 0 && l.similarTop <= 3, `${when}: ${l.label}: "Use for similar" not pinned top right (${l.similarRight}, ${l.similarTop})`);
        if (l.posRight !== null) assert.ok(Math.abs(l.posRight) <= 1, `${when}: ${l.label} position not on the right`);
      }
      // Every row, T3's own fonts included, reserves the same width and puts the position on the same line.
      const dys = lines.map((l) => Math.round(l.posDy)), widths = lines.map((l) => l.lineW);
      assert.ok(dys.length >= 4 && dys.every((d) => d === dys[0]), `${when}: the position isn't on the same line in every row: ${dys}`);
      assert.ok(widths.every((w) => w === widths[0]), `${when}: rows reserve different widths for size and Default: ${widths}`);
      return { dy: dys[0], together: lines.every((l) => l.together) };
    };

    await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await frames();
    assert.equal(await until(`document.querySelector('[data-focus="plus-main"]')`, "no size buttons on Replies"), true);
    assert.equal(await val("main"), "100%");
    assert.equal(await val("composer"), "110%", "a font's catalog default size shows until changed");
    assert.equal(await val("sidebar"), "150%");
    assert.equal(await ev(`${row("questions")}.querySelector("button.t3x-fs-sz, .t3x-fs-size[role]")`), null, "T3's own fonts take T3's size: no buttons");
    assert.equal(await ev(`getComputedStyle(${row("questions")}.querySelector(".t3x-fs-sizeline")).visibility`), "hidden", "…but the row keeps the same room on line 3, unseen");
    const lines = await geometry();
    assert.ok((await ev(`document.querySelectorAll(".t3x-fs-also").length`)) >= 3 && (await ev(`document.querySelectorAll(".t3x-fs-head > .t3x-fs-similar").length`)) >= 3, "crowded rows: followers and the similar pill");
    const wide = checkLines(lines, "as rendered");
    assert.ok(wide.dy < 8 && wide.together, "a panel this wide keeps size, Default and the position on one line");
    await shot("font-size-strip.png");
    // Stress: the widest values every row could show at once.
    await ev(`document.querySelectorAll(".t3x-fs-pos").forEach((e) => { e.textContent = "12 of 51"; }), document.querySelectorAll(".t3x-fs-size-val").forEach((e) => { e.textContent = "200%"; }), 1`); await frames();
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

    // At 150% the name is still drawn at its real size.
    for (let i = 0; i < 9; i++) { await ev(`document.querySelector('[data-focus="plus-main"]').click(), 1`); await frames(); }
    assert.deepEqual(await saved("fontMain"), { family: "Arial", size: 150 });
    assert.equal(await until(face("T3X Main", 150), "Replies face not at 150%"), true); await frames();
    assert.equal(await ev(`document.querySelector('[data-focus="fs-name-main"]').style.fontSize`), "", "150%: the name isn't scaled down");
    // Up to 200: + turns off and focus moves to −, also after the face loads.
    for (let i = 0; i < 12; i++) { await ev(`(() => { const b = document.querySelector('[data-focus="plus-main"]'); if (!b.disabled) b.click(); })(), 1`); await frames(); }
    assert.deepEqual(await saved("fontMain"), { family: "Arial", size: 200 });
    assert.equal(await until(face("T3X Main", 200), "Replies face not at 200%"), true); await frames();
    assert.equal(await ev(`document.querySelector('[data-focus="plus-main"]').disabled`), true);
    assert.equal(await ev(`document.activeElement?.dataset.focus`), "minus-main", "focus falls back to − at the top");
    assert.equal(await val("main"), "200%");
    // Past 150% the name stops growing: 20px × 150/200, so its 30px line (and the buttons under it) stay put.
    const capped = await ev(`(() => { const n = document.querySelector('[data-focus="fs-name-main"]'); return { fs: n.style.fontSize, h: n.getBoundingClientRect().height, title: n.title }; })()`);
    assert.equal(capped.fs, "15px"); assert.equal(capped.h, 30);
    assert.match(capped.title, /^Arial\. Shown at 150% here; the app uses 200%\./);
    // Down to 80: − turns off and focus moves to +.
    for (let i = 0; i < 26; i++) { await ev(`(() => { const b = document.querySelector('[data-focus="minus-main"]'); if (!b.disabled) b.click(); })(), 1`); await frames(); }
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

    // Default, both ways. Replies is at 80% (Arial's default is 100%): a ring and "Default 100%".
    const def = (id) => ev(`(() => { const c = ${row("ID")}.querySelector(".t3x-fs-defslot > :not(.t3x-fs-def-sizer)"); return c && { tag: c.tagName, text: c.textContent, on: c.classList.contains("t3x-fs-def-on"), title: c.title }; })()`.replace("ID", id));
    const heights = async () => (await geometry()).map((l) => Math.round(l.h * 10));
    assert.deepEqual(await def("main"), { tag: "BUTTON", text: "Default 100%", on: false, title: "Use the default size, 100%" });
    const h0 = await heights();
    await ev(`(() => { const b = document.querySelector('[data-focus="fs-def-main"]'); b.focus(); b.click(); })(), 1`); await frames();
    assert.deepEqual(await saved("fontMain"), { family: "Arial", size: null }, "Default stores \"follow this font's default\"");
    assert.equal(await val("main"), "100%");
    assert.deepEqual(await def("main"), { tag: "BUTTON", text: "Default · back to 80%", on: true, title: "Back to 80%" });
    assert.equal(await ev(`document.activeElement?.dataset.focus`), "fs-def-main", "focus stays on Default");
    assert.deepEqual(await heights(), h0, "a click on Default moves nothing");
    checkLines(await geometry(), "after Default");
    // The memory outlives closing the panel.
    await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await frames();
    await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await frames();
    assert.equal((await def("main")).text, "Default · back to 80%");
    await ev(`document.querySelector('[data-focus="fs-def-main"]').click(), 1`); await frames();
    assert.deepEqual(await saved("fontMain"), { family: "Arial", size: 80 }, "and back");
    assert.equal((await def("main")).text, "Default 100%");
    // − or + drops the remembered size: at the default again there is nothing to go back to, and no button.
    await ev(`document.querySelector('[data-focus="fs-def-main"]').click(), 1`); await frames();
    await ev(`document.querySelector('[data-focus="plus-main"]').click(), 1`); await frames();
    await ev(`document.querySelector('[data-focus="minus-main"]').click(), 1`); await frames();
    assert.deepEqual(await saved("fontMain"), { family: "Arial", size: 100 });
    assert.deepEqual(await def("main"), { tag: "SPAN", text: "Default", on: true, title: "100% is this font's default size" });
    assert.equal(await ev(`${row("questions")}.querySelector(".t3x-fs-defslot > :not(.t3x-fs-def-sizer)")`), null, "T3's own fonts have no Default");

    // "Use for similar" gives the followers this font, so a follower's remembered size is gone; Undo doesn't bring it back.
    await ev(`document.querySelector('[data-focus="fs-def-plans"]').click(), 1`); await frames();
    assert.equal((await def("plans")).text, "Default · back to 120%");
    await ev(`document.querySelector('[data-focus="fs-similar-main"]').click(), 1`); await frames();
    assert.equal(await ev(`document.querySelector('[data-focus="fs-name-plans"]')`), null, "Plans now follows Replies");
    await ev(`document.querySelector('[data-focus="fs-similar-main"]').click(), 1`); await frames();
    assert.deepEqual(await def("plans"), { tag: "SPAN", text: "Default", on: true, title: "110% is this font's default size" });

    // Mixed digits (80%, 105%, 200%) reserve the same widths at every width in between.
    for (let i = 0; i < 20; i++) { await ev(`(() => { const b = document.querySelector('[data-focus="plus-plans"]'); if (!b.disabled) b.click(); })(), 1`); await frames(); }
    for (let i = 0; i < 4; i++) { await ev(`document.querySelector('[data-focus="minus-main"]').click(), 1`); await frames(); }
    assert.deepEqual([await val("main"), await val("plans")], ["80%", "200%"]);
    // Another T3 window pressing + then − leaves an explicit size at the default: that ends the remembered size here too.
    await ev(`document.querySelector('[data-focus="fs-def-composer"]').click(), 1`); await frames();
    assert.equal((await def("composer")).text, "Default · back to 105%");
    const fromOtherWindow = async (size) => { await ev(`(() => { const next = { ...JSON.parse(localStorage.getItem("t3x:settings:v1")), fontComposer: { family: "Georgia", size: ${size} } };
      localStorage.setItem("t3x:settings:v1", JSON.stringify(next)); window.dispatchEvent(new StorageEvent("storage", { key: "t3x:settings:v1", newValue: JSON.stringify(next) })); })(), 1`); await frames(); };
    await fromOtherWindow(110);
    assert.deepEqual(await def("composer"), { tag: "SPAN", text: "Default", on: true, title: "110% is this font's default size" });
    await fromOtherWindow(105);
    assert.equal((await def("composer")).text, "Default 110%");
    // A narrow panel: the position alone wraps under the size line, in every row at once (size and Default stay together),
    // and Default still moves nothing.
    let dropAt = null;
    for (let w = 340; w >= 250; w -= 6) {
      await ev(`document.querySelector(".t3x-pop").style.width = "${w}px", 1`); await frames();
      const g = checkLines(await geometry(), `panel ${w}px`);
      if (g.dy > 10 && g.together && dropAt === null) dropAt = w;
    }
    assert.ok(dropAt !== null, "some width drops only the position, with size and Default still side by side");
    await ev(`document.querySelector(".t3x-pop").style.width = "${dropAt}px", 1`); await frames();
    const narrow = checkLines(await geometry(), "narrow panel");
    const h1 = await heights();
    await ev(`document.querySelector('[data-focus="fs-def-composer"]').click(), 1`); await frames();
    assert.equal((await def("composer")).text, "Default · back to 105%");
    assert.deepEqual(await heights(), h1, "narrow panel: a click on Default moves nothing");
    assert.deepEqual(checkLines(await geometry(), "narrow panel after Default"), narrow);
    await shot("font-size-strip-narrow.png");
    // Narrower than size and Default together: they part, still alike in every row.
    await ev(`document.querySelector(".t3x-pop").style.width = "216px", 1`); await frames();
    assert.equal(checkLines(await geometry(), "very narrow panel").together, false);
    await ev(`document.querySelector(".t3x-pop").style.width = "340px", 1`); await frames();

    // The Fonts editor's Default button goes both ways too, on the same memory.
    await ev(`window.__T3X_PICK_TEST__.openFontsAt("composer"), 1`); await frames();
    const reset = () => ev(`(() => { const b = window.__T3X_PICK_TEST__.workspace().reset; return { text: b.textContent, disabled: b.disabled }; })()`);
    assert.deepEqual(await reset(), { text: "Back to 105%", disabled: false }, "the row's Default left 105% behind: the editor offers the way back");
    await ev(`window.__T3X_PICK_TEST__.workspace().reset.click(), 1`); await frames();
    assert.deepEqual(await saved("fontComposer"), { family: "Georgia", size: 105 });
    assert.deepEqual(await reset(), { text: "Default 110%", disabled: false });
    await ev(`window.__T3X_PICK_TEST__.workspace().reset.click(), 1`); await frames();
    assert.deepEqual(await saved("fontComposer"), { family: "Georgia", size: null });
    assert.deepEqual(await reset(), { text: "Back to 105%", disabled: false });
    await ev(`window.__T3X_PICK_TEST__.workspace().reset.click(), 1`); await frames();
    assert.deepEqual(await saved("fontComposer"), { family: "Georgia", size: 105 });
    assert.deepEqual(await reset(), { text: "Default 110%", disabled: false });
    await ev(`window.__T3X_PICK_TEST__.workspace().plus.click(), 1`); await frames();
    assert.deepEqual(await reset(), { text: "Default 110%", disabled: true }, "at the default with nothing to go back to: greyed out");
    for (let i = 0; i < 20; i++) { await ev(`(() => { const b = window.__T3X_PICK_TEST__.workspace().plus; if (!b.disabled) b.click(); })(), 1`); await frames(); }
    assert.deepEqual(await saved("fontComposer"), { family: "Georgia", size: 200 }, "the editor steps to 200% too");
    assert.equal(await ev(`window.__T3X_PICK_TEST__.workspace().plus.disabled`), true);
    // Following another area, even for a moment, shows another font: the remembered size is gone for good.
    await ev(`window.__T3X_PICK_TEST__.workspace().reset.click(), 1`); await frames();
    assert.deepEqual(await reset(), { text: "Back to 200%", disabled: false });
    const source = async (v) => { await ev(`(() => { const s = document.getElementById("t3x-font-source"); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("change", { bubbles: true })); })(), 1`); await frames(); };
    await source("link:main");
    assert.equal((await saved("fontSources")).composer, "link:main");
    await source("own");
    assert.equal((await saved("fontSources")).composer, "own");
    assert.deepEqual(await reset(), { text: "Default 110%", disabled: true }, "own → follows Replies → own: nothing to go back to");
    await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await frames();
    if (!(await ev(`!!document.querySelector('[data-focus="fs-next-composer"]')`))) { await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`); await frames(); }
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
