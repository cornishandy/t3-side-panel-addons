import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

// T3 updates its headless Chrome in place (154 → 156 …); use the newest installed version.
function newestHeadlessChrome() {
  const root = path.join(os.homedir(), ".t3/tools/chrome-headless-shell/mac-arm64");
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((v) => /^\d+(\.\d+)+$/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return path.join(root, versions[0] ?? "missing", "chrome-headless-shell");
}

const root = new URL("..", import.meta.url);
const source = fs.readFileSync(new URL("../public/extras.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/extras.css", import.meta.url), "utf8");
const box = { window: { __T3X_TEST__: {} } };
vm.runInNewContext(source, box);
const C = box.window.__T3X_TEST__.core;
const plain = (v) => JSON.parse(JSON.stringify(v));
const read = (value) => C.readSettings(JSON.stringify(value));
const off = { family: "off", size: null };
const pick = (settings, role) => plain(C.effectiveFontPick(settings, role));

test("absent sources infer own or native, and an invalid map never revives a stored face", () => {
  const fresh = read({});
  for (const role of C.FONT_ROLES) assert.equal(fresh.fontSources[role.id], "native", role.id);
  const own = read({ fontHead: { family: "Caveat", size: 120 } });
  assert.equal(own.fontSources.head, "own");
  assert.equal(own.fontHead.family, "Caveat");
  assert.deepEqual(pick(own, "head"), { family: "Caveat", size: 120 });
  const wiped = read({ fontHead: { family: "Caveat", size: 120 }, fontSources: [] });
  assert.equal(wiped.fontHead.family, "Caveat");
  for (const role of C.FONT_ROLES) assert.equal(wiped.fontSources[role.id], "native", role.id);
  assert.deepEqual(pick(wiped, "head"), off);
  const entry = read({ fontHead: { family: "Caveat", size: null }, fontMain: { family: "Kalam", size: 100 }, fontSources: { head: "link:head", main: "link:body", quotes: "link:legacyBody", composer: { bad: true } } });
  assert.equal(entry.fontSources.head, "native");
  assert.equal(entry.fontSources.main, "native");
  assert.equal(entry.fontSources.quotes, "native");
  assert.equal(entry.fontSources.composer, "native");
  assert.equal(entry.fontHead.family, "Caveat");
  assert.equal(entry.fontMain.family, "Kalam");
  assert.deepEqual(pick(entry, "head"), off);
  assert.deepEqual(plain(read(wiped)), plain(wiped));
});

test("chains copy the terminal face and size, cycles native their upstream, and order does not matter", () => {
  const chained = read({
    fontSchema: 2,
    fontHead: { family: "Caveat", size: null },
    fontTables: { family: "Kalam", size: 130 },
    fontLinks: { family: "Neucha", size: 90 },
    fontSources: { head: "own", tables: "link:head", links: "link:tables" },
  });
  assert.equal(chained.fontLinks.family, "Neucha");
  assert.deepEqual(pick(chained, "links"), { family: "Caveat", size: null });
  const local = read({ ...chained, fontSources: { ...chained.fontSources, tables: "own" } });
  assert.deepEqual(pick(local, "tables"), { family: "Kalam", size: 130 });
  assert.deepEqual(pick(local, "links"), { family: "Kalam", size: 130 });
  assert.deepEqual(pick(local, "head"), { family: "Caveat", size: null });
  const back = read({ ...chained, fontSources: { ...chained.fontSources, head: "native" } });
  assert.equal(back.fontHead.family, "Caveat");
  assert.deepEqual(pick(back, "head"), off);
  assert.deepEqual(pick(back, "links"), off);
  const restored = read({ ...back, fontSources: { ...back.fontSources, head: "own", tables: "link:head", links: "link:tables" } });
  assert.deepEqual(pick(restored, "links"), { family: "Caveat", size: null });
  const first = { links: "link:paths", paths: "link:links", threadtitles: "link:links", main: "own" };
  const second = { main: "own", threadtitles: "link:links", paths: "link:links", links: "link:paths" };
  assert.deepEqual(plain(C.resolveFontGraph(first)), plain(C.resolveFontGraph(second)));
  const cycled = read({ fontSchema: 2, fontMain: { family: "Kalam", size: 100 }, fontLinks: { family: "Neucha", size: 80 }, fontSources: first });
  assert.equal(cycled.fontLinks.family, "Neucha");
  for (const id of ["links", "paths", "threadtitles"]) assert.deepEqual(pick(cycled, id), off, id);
  assert.deepEqual(pick(cycled, "main"), { family: "Kalam", size: 100 });
  assert.equal(C.fontLinkWouldCycle(first, "sidebar", "links"), true);
  assert.equal(C.fontLinkWouldCycle(first, "sidebar", "main"), false);
  assert.equal(C.fontLinkWouldCycle(first, "links", "links"), true);
  const nativeTarget = read({ fontSchema: 2, fontHead: { family: "Caveat", size: 110 }, fontSources: { head: "own", quotes: "link:composer", composer: "native" } });
  assert.deepEqual(pick(nativeTarget, "quotes"), off);
  assert.equal(nativeTarget.fontHead.family, "Caveat");
});

test("Plans preserves old Interface appearance for an absent source, including a saved Off pick; explicit native wins", () => {
  const migrated = read({ fontMain: { family: "Neucha", size: 140 }, fontTargets: { plantext: true } });
  assert.equal(migrated.fontPlans.family, "Neucha");
  assert.equal(migrated.fontSources.plans, "own");
  const linked = read({ fontSchema: 2, fontTargets: { plantext: true }, fontInterface: { family: "Kalam", size: 100 } });
  assert.deepEqual(plain(linked.fontPlans), off);
  assert.equal(linked.fontSources.plans, "link:interface");
  assert.deepEqual(pick(linked, "plans"), { family: "Kalam", size: 100 });
  const explicit = read({ fontSchema: 2, fontPlans: off, fontTargets: { plantext: true }, fontInterface: { family: "Kalam", size: 100 } });
  // The old panel persisted fontPlans:off even when Interface/plantext painted Plans.
  // Migrate actual prior appearance when only the new source entry is absent.
  assert.deepEqual(plain(explicit.fontPlans), off);
  assert.equal(explicit.fontSources.plans, "link:interface");
  assert.deepEqual(pick(explicit, "plans"), { family: "Kalam", size: 100 });
  const native = read({ ...explicit, fontSources: { ...explicit.fontSources, plans: "native" } });
  assert.equal(native.fontSources.plans, "native");
  assert.deepEqual(pick(native, "plans"), off);
  const invalid = read({ ...explicit, fontSources: { plans: "invalid" } });
  assert.equal(invalid.fontSources.plans, "native");
  assert.deepEqual(pick(invalid, "plans"), off);
  const noFace = read({ fontSchema: 2, fontTargets: { plantext: true }, fontMain: { family: "Neucha", size: 140 } });
  assert.equal(noFace.fontInterface.family, "off");
  assert.equal(noFace.fontSources.plans, "native");
  assert.deepEqual(plain(read(linked)), plain(linked));
});

test("usage hash and container reject false pages, and the marker clears on another other-route", () => {
  assert.equal(C.usagePageHash("#/usage"), true);
  assert.equal(C.usagePageHash("#/usage/"), true);
  assert.equal(C.usagePageHash("#/usage?x=1"), true);
  for (const hash of ["#/usage/extra", "#/settings", "#/settings/usage", "#/USAGE", "#/abc123/thread1", "", "#/"]) {
    assert.equal(C.usagePageHash(hash), false, hash);
  }
  const classes = "mx-auto flex w-full flex-col gap-6 px-5 pt-6 pb-12 sm:px-6";
  assert.equal(C.usageContainerMatches(classes, " Usage ", "#/usage"), true);
  assert.equal(C.usageContainerMatches(classes + " max-w-5xl", "Usage", "#/usage"), true);
  assert.equal(C.usageContainerMatches(classes.replace(" sm:px-6", ""), "Usage", "#/usage"), false);
  assert.equal(C.usageContainerMatches(classes, "Usage limits", "#/usage"), false);
  assert.equal(C.usageContainerMatches(classes, "Usage", "#/settings"), false);
  const start = source.indexOf("  function syncUsageMarker()");
  const end = source.indexOf("  function checkRoute()", start);
  const nodes = [];
  const make = (className, heading) => {
    const el = {
      className,
      attrs: {},
      querySelector(sel) { return sel === "h1" && heading != null ? { textContent: heading } : null; },
      setAttribute(key, value) { this.attrs[key] = value; },
      removeAttribute(key) { delete this.attrs[key]; },
    };
    nodes.push(el);
    return el;
  };
  const real = make(classes, "Usage");
  const decoy = make(classes.replace("gap-6", "gap-2"), "Usage");
  const other = make(classes, "Settings");
  const marked = make(classes, "Usage");
  marked.attrs["data-t3x-usage-page"] = "1";
  const ctx = {
    usagePageHash: C.usagePageHash,
    usageContainerMatches: C.usageContainerMatches,
    location: { hash: "#/usage" },
    D: {
      querySelectorAll(sel) {
        if (sel === "div.mx-auto.flex.w-full.flex-col") return nodes.filter((el) => ["mx-auto", "flex", "w-full", "flex-col"].every((name) => el.className.split(/\s+/).includes(name)));
        if (sel === "[data-t3x-usage-page]") return nodes.filter((el) => el.attrs["data-t3x-usage-page"]);
        return [];
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end) + "\nthis.sync = syncUsageMarker;", ctx);
  ctx.sync();
  assert.equal(real.attrs["data-t3x-usage-page"], "1");
  assert.equal(decoy.attrs["data-t3x-usage-page"], undefined);
  assert.equal(other.attrs["data-t3x-usage-page"], undefined);
  ctx.location.hash = "#/settings";
  ctx.sync();
  assert.equal(real.attrs["data-t3x-usage-page"], undefined);
  assert.equal(marked.attrs["data-t3x-usage-page"], undefined);
  ctx.location.hash = "#/usage/";
  ctx.sync();
  assert.equal(real.attrs["data-t3x-usage-page"], "1");
});

test("font CSS names the verified leaves and does not claim controls, toggles, or the footer block", () => {
  const leaves = css.slice(css.indexOf("/* ---------- font role leaves"), css.indexOf("/* ---------- end font role leaves"));
  const titles = leaves.slice(leaves.indexOf("/* thread titles */"), leaves.indexOf("/* tooltips */"));
  const sidebar = leaves.slice(leaves.indexOf("/* sidebar status */"));
  const sidebarPaint = sidebar.slice(0, sidebar.indexOf('font-family: "T3X Sidebar"'));
  assert.match(titles, /span\[data-testid\^="thread-title-"\]/);
  assert.match(titles, /\[data-t3x="grouping-root"\] span\.t3x-g-title/);
  assert.equal(titles.includes("[data-t3x=\"grouping-root\"] *"), false);
  assert.equal(titles.includes("[data-t3x=\"grouping-root\"] >"), false);
  assert.equal(/\.t3x-g-long|\.t3x-g-short|\.t3x-g-word/.test(titles), false);
  for (const leaf of [".t3x-g-meta", ".t3x-g-project", ".t3x-g-age", ".t3x-g-state-text", ".t3x-g-badge", ".t3x-g-badges", ".t3x-g-status", ".t3x-g-note", ".t3x-g-scope", ".t3x-g-counts", ".t3x-g-cue", ".t3x-g-method"]) {
    assert.equal(sidebarPaint.includes(leaf), true, leaf);
  }
  assert.equal(/\.t3x-g-count(?!s)/.test(sidebarPaint), false);
  assert.equal(/\.t3x-g-state(?!-text)/.test(sidebarPaint), false);
  for (const banned of [".t3x-g-long", ".t3x-g-short", ".t3x-g-word", ".t3x-g-title", ".t3x-g-attn", ".t3x-g-empty", ".t3x-g-icon", "summary"]) {
    assert.equal(sidebarPaint.includes(banned), false, banned);
  }
  assert.match(sidebar, /\.t3x-g-icon/);
  assert.match(css, /html\[data-t3x-fh\]\[data-t3x-ft-projects\] \[data-testid="sidebar-row-card"\] > div\.relative > div:first-child > span\.truncate/);
  assert.equal(css.includes(":is(blockquote, blockquote"), false);
  assert.match(css, /blockquote :is\(p, li, h1, h2, h3, h4, h5, h6\)/);
  assert.match(css, /\[data-message-role="assistant"\] \.chat-markdown :is\(h1, h2, h3, h4, h5, h6\)/);
  assert.equal(css.includes("data-t3x-ft-plantext"), false);
  assert.match(css, /\[data-t3x="pop"\]\[aria-label="Add-ons"\] \.t3x-select \{ min-height: 28px; height: auto; font-size: 12\.5px; \}/);
  assert.match(leaves, /\[data-t3x-usage-page="1"\]/);
  assert.equal(leaves.includes("!important"), false);
  assert.equal(nestedHas(leaves), false);
  const block = css.slice(css.indexOf("/* ---------- reply footer card"));
  assert.equal(crypto.createHash("sha256").update(block).digest("hex"), "cc08951882cfa8d04e113727bf598b05d5841957f4b910236760dbbba68458b9");
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const at = readme.indexOf("**Reply footer card.**");
  const paragraph = readme.slice(at, readme.indexOf("\n\n", at));
  assert.equal(crypto.createHash("sha256").update(paragraph).digest("hex"), "56d0e3c3fa807418159d6f7ebcfa88f5637a75bafcb1a6a9abb3b4ce28184c9e");
});

function nestedHas(text) {
  let i = 0;
  while ((i = text.indexOf(":has(", i)) !== -1) {
    let depth = 0;
    for (let j = i + 4; j < text.length; j++) {
      if (text.startsWith(":has(", j) && depth > 0) return true;
      if (text[j] === "(") depth++;
      else if (text[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    i += 5;
  }
  return false;
}

const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const cat = [{ name: "A", group: "hand", width: 100, style: "print", source: "google", file: "a.woff2", size: 110 }, { name: "Mac", group: "hand", width: 200, style: "print", source: "mac" }, { name: "B", group: "cond", width: 400, style: "print", source: "google", file: "b.woff2", size: 100 }];
function harness() {
  const fonts = source.slice(source.indexOf("  const DIGITLESS ="), source.indexOf("  // ---------- add-ons panel"));
  const faces = [], added = new Set(), fetches = new Map(), attrs = new Set();
  const settings = { fontHead: { family: "off", size: null }, fontBody: { family: "off", size: null }, fontMain: { family: "off", size: null } };
  const ctx = {
    disposed: false, pop: { kind: "panel" }, settings, BASE: "http://fixture/", Map,
    FontFace: class { constructor(alias, src, options) { Object.assign(this, { alias, src, options }); faces.push(this); } load() { return new Promise((resolve, reject) => { this.resolve = () => resolve(this); this.reject = reject; }); } },
    W: {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.init = init; } },
    D: {
      fonts: { add: (f) => added.add(f), delete: (f) => added.delete(f) },
      documentElement: { setAttribute: (a) => attrs.add(a), removeAttribute: (a) => attrs.delete(a) },
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return null; },
      createElement() { return { remove() {} }; },
      head: { append() {} },
      querySelectorAll() { return []; },
      dispatchEvent() {},
    },
    sizePct: (x) => x,
    fetch: (url) => { fetches.set(url, (fetches.get(url) || 0) + 1); return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }); },
    fillPopover() {},
  };
  vm.createContext(ctx);
  vm.runInContext(fonts + "\ncatalog=" + JSON.stringify(cat.filter((f) => f.source === "google")) + ";", ctx);
  return { ctx, faces, added, fetches, attrs, run: (code) => vm.runInContext(code, ctx) };
}

test("effective picks drive role loads, body stays stored, and a late face cannot revive a native link", async () => {
  const h = harness();
  h.ctx.effectiveFontPick = () => ({ family: "A", size: 100 });
  h.ctx.settings.fontBody = { family: "B", size: null };
  const body = h.run("applyRole('body')");
  await tick();
  h.faces.at(-1).resolve();
  await body;
  assert.equal([...h.added].map((f) => f.alias).join(), "T3X Body");
  assert.equal(h.fetches.has("http://fixture/fonts/b.woff2"), true);
  assert.equal(h.fetches.has("http://fixture/fonts/a.woff2"), false);
  const g = harness();
  g.ctx.effectiveFontPick = C.effectiveFontPick;
  g.ctx.settings = { fontHead: { family: "A", size: 150 }, fontViz: { family: "off", size: null }, fontSources: { head: "own", viz: "link:head" } };
  const pending = g.run("applyRole('viz')");
  await tick();
  assert.equal(g.faces[0].alias, "T3X Viz");
  assert.equal(g.faces[0].options.sizeAdjust, "150%");
  assert.equal(g.faces[0].options.unicodeRange, "U+0-2F, U+3A-10FFFF");
  g.ctx.settings = { fontHead: { family: "A", size: 150 }, fontViz: { family: "B", size: null }, fontSources: { head: "own", viz: "native" } };
  const dropped = g.run("applyRole('viz')");
  g.faces[0].resolve();
  await Promise.all([pending, dropped]);
  assert.equal(g.attrs.has("data-t3x-fv"), false);
  assert.equal(g.ctx.settings.fontViz.family, "B");
});

test("rendered families follow the leaf contract and an unpainted leaf follows the host variable", async () => {
  const chrome = newestHeadlessChrome();
  assert.equal(fs.existsSync(chrome), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-font-core-"));
  const htmlPath = path.join(dir, "fixture.html");
  const profile = path.join(dir, "profile");
  const page = `<!doctype html><meta charset="utf-8"><style>${css}
html { --font-sans: "Fixture Sans"; --font-mono: "Fixture Mono"; --font-composer: "Fixture Composer"; }
body { font-family: var(--font-sans); }
</style>
<div data-message-role="assistant"><div class="chat-markdown">
<p id="reply">Reply <a id="link"><em id="em">link</em></a> <a class="chat-markdown-file-link" id="path">file</a> <code id="code">c <a id="codelink" class="chat-markdown-file-link">p</a></code> <button id="btn">Go</button></p>
<h2 id="h2">Heading</h2>
<blockquote><p id="quote">Quote</p><h4 id="qh">QH</h4><div class="chat-markdown-table-container"><table><tr><td id="qcell">Q</td></tr></table></div></blockquote>
<div class="chat-markdown-table-container"><table><tr><td id="cell">Cell <a id="celllink">L</a></td></tr></table></div>
<hr>
<div class="chat-markdown-table-container" id="footer"><table><thead><tr><th itemprop="settle-yes">A</th><th>B</th><th id="fth">C</th></tr></thead><tbody><tr><td id="ftd">D</td><td></td><td></td></tr></tbody></table></div>
<p><sub id="sub">line</sub></p>
</div></div>
<div data-message-role="assistant"><div class="chat-markdown"><p id="ordinary-before">Before</p><hr><div class="chat-markdown-table-container"><table><tr><td>Ordinary</td></tr></table></div><p id="ordinary-after">After</p><h2 id="ordinary-head">After heading</h2></div></div>
<div data-user-message-body><div class="chat-markdown"><hr><div class="chat-markdown-table-container"><table><tr><td>User table</td></tr></table></div><p id="prompt-after">Sent prompt after table</p></div></div>
<div data-message-role="assistant"><div class="chat-markdown"><hr><div class="chat-markdown-table-container"><table><thead><tr><th itemprop="settle-no">State</th><th>Task</th><th>Who</th></tr></thead><tbody><tr><td>Done</td><td>Task</td><td>Sol</td></tr></tbody></table></div><div><div data-markdown-details><summary>Team</summary><p id="rosterprose">Team prose</p><div class="chat-markdown-table-container"><table><tr><td><span role="button" id="roster-native-control"><em id="roster-native-child">Control</em></span></td></tr></table></div></div></div><sub id="bare-footer">Footer <a id="bare-footer-link">link <code id="bare-footer-code">code</code></a></sub></div></div>
<div data-slot="tooltip-popup"><a data-slot="context-chip" id="tooltip-custom-path"><span id="tooltip-custom-span">src/file.js</span><em id="tooltip-custom-em">path</em><code id="tooltip-custom-code">code</code></a>Tooltip <span data-slot="context-chip" id="tooltip-native-path">file<code id="tooltip-path-code">code</code></span><span role="button" id="tooltip-native-control">Control</span></div>
<div data-testid="sidebar-row-card"><div class="relative"><div><span class="truncate" id="project">Project</span></div></div>
<div role="button"><span data-testid="thread-title-1" id="ntitle">Title</span><input id="rename" value="rename"></div>
<div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs" id="meta"><span class="text-muted-foreground/40" id="branch">branch</span><span class="shrink-0 font-mono" id="diff">+1</span><button id="term">term</button></div></div>
<div data-t3x="grouping-root"><a id="glink"><span class="t3x-g-title" id="gtitle">T</span><span class="t3x-g-meta" id="flatmeta">Flat</span><span class="t3x-g-meta" id="nestmeta"><span class="t3x-g-project" id="gproject">P</span><span class="t3x-g-age" id="gage">2m</span><svg class="t3x-g-icon" id="gicon"></svg></span></a>
<button><span class="t3x-g-long" id="glong">Group</span><span class="t3x-g-short" id="gshort">G</span><span class="t3x-g-count" id="gcount">3</span><span class="t3x-g-attn" id="gattn">Request</span></button>
<span class="t3x-g-word" id="gword">Sort</span><summary id="gsummary">Index details</summary>
<p class="t3x-g-status" id="gstatus">Ready</p><p class="t3x-g-note" id="gnote">Note</p>
<span class="t3x-g-badges" id="flatbadges">old</span><span class="t3x-g-badges"><span class="t3x-g-badge" id="gbadge">New</span></span>
<span class="t3x-g-state"><svg class="t3x-g-icon" id="stateicon"></svg><span class="t3x-g-state-text" id="gstate">Running</span></span>
<p class="t3x-g-scope" id="gscope">This Mac</p><p class="t3x-g-counts" id="gcounts">4 threads</p><p class="t3x-g-cue" id="gcue">Incomplete</p><p class="t3x-g-method" id="gmethod">Method</p>
<p class="t3x-g-empty" id="gempty">None</p></div>
<pre id="result"></pre>
<script>
const html = document.documentElement;
for (const name of ["data-t3x-fm","data-t3x-ft-replies","data-t3x-flinks","data-t3x-fpaths","data-t3x-ftables","data-t3x-ffooter","data-t3x-fh","data-t3x-ft-headings","data-t3x-ft-projects","data-t3x-fq","data-t3x-ft-quotes","data-t3x-fthreadtitles","data-t3x-fsidebar","data-t3x-fprompts","data-t3x-ftooltips"]) html.setAttribute(name, "");
const fam = (id) => getComputedStyle(document.getElementById(id)).fontFamily;
const ids = ["reply","link","em","path","code","codelink","btn","h2","quote","qh","qcell","cell","celllink","fth","ftd","sub","project","ntitle","rename","branch","diff","term","glink","gtitle","flatmeta","gproject","gage","gicon","glong","gshort","gcount","gattn","gword","gsummary","gstatus","gnote","flatbadges","gbadge","stateicon","gstate","gscope","gcounts","gcue","gmethod","gempty"];
const before = fam("gword");
html.style.setProperty("--font-sans", "Fixture Next");
const after = Object.fromEntries(ids.map((id) => [id, fam(id)]));
after.gwordBefore = before;
after.customTooltipPath=Object.fromEntries(["tooltip-custom-path","tooltip-custom-span","tooltip-custom-em","tooltip-custom-code"].map(id=>[id,fam(id)]));
const regressionIds=["ordinary-before","ordinary-after","ordinary-head","prompt-after","rosterprose","roster-native-control","roster-native-child","bare-footer","bare-footer-link","bare-footer-code","tooltip-native-path","tooltip-path-code","tooltip-native-control"];
html.removeAttribute("data-t3x-flinks");html.removeAttribute("data-t3x-fpaths");
after.regressions=Object.fromEntries(regressionIds.map(id=>[id,fam(id)]));
document.getElementById("result").textContent = JSON.stringify(after);
</script>`;
  fs.writeFileSync(htmlPath, page);
  const dump = await new Promise((resolve, reject) => {
    const child = spawn(chrome, ["--headless", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--virtual-time-budget=3000", "--dump-dom", htmlPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("chrome timed out")); }, 30000);
    child.stdout.on("data", (buf) => { out += buf; });
    child.stderr.on("data", (buf) => { err += buf; });
    child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(err.slice(-500) || `chrome ${code}`)); });
  });
  const raw = dump.match(/<pre id="result">([\s\S]*?)<\/pre>/);
  assert.ok(raw, "missing render result");
  const got = JSON.parse(raw[1].replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&"));
  const has = (id, name) => assert.ok(String(got[id]).includes(name), `${id} = ${got[id]}`);
  const lacks = (id, name) => assert.ok(!String(got[id]).includes(name), `${id} = ${got[id]}`);
  has("reply", "T3X Main");
  has("link", "T3X Links");
  has("em", "T3X Links");
  has("path", "T3X Paths");
  has("code", "Fixture Mono");
  has("codelink", "Fixture Mono");
  lacks("codelink", "T3X");
  lacks("btn", "T3X");
  has("h2", "T3X Heading");
  lacks("h2", "T3X Main");
  has("quote", "T3X Quotes");
  lacks("quote", "T3X Main");
  has("qh", "T3X Quotes");
  lacks("qh", "T3X Heading");
  has("cell", "T3X Tables");
  has("qcell", "T3X Tables");
  has("celllink", "T3X Links");
  has("fth", "T3X Footer");
  lacks("fth", "T3X Tables");
  has("sub", "T3X Footer");
  has("project", "T3X Heading");
  has("ntitle", "T3X Thread titles");
  lacks("rename", "T3X");
  has("branch", "T3X Sidebar");
  has("diff", "Fixture Mono");
  lacks("diff", "T3X Sidebar");
  lacks("term", "T3X Sidebar");
  lacks("glink", "T3X");
  has("gtitle", "T3X Thread titles");
  lacks("gtitle", "T3X Sidebar");
  has("flatmeta", "T3X Sidebar");
  has("gproject", "T3X Sidebar");
  lacks("gproject", "T3X Heading");
  has("gage", "T3X Sidebar");
  lacks("gicon", "T3X Sidebar");
  for (const id of ["glong", "gshort", "gcount", "gattn", "gword", "gsummary", "gempty", "stateicon"]) lacks(id, "T3X");
  has("gstatus", "T3X Sidebar");
  has("gnote", "T3X Sidebar");
  has("flatbadges", "T3X Sidebar");
  has("gbadge", "T3X Sidebar");
  has("gstate", "T3X Sidebar");
  for (const id of ["gscope", "gcounts", "gcue", "gmethod"]) has(id, "T3X Sidebar");
  assert.match(got.gwordBefore, /Fixture Sans/);
  assert.match(got.gword, /Fixture Next/);
  assert.match(got.gtitle, /T3X Thread titles/);
  for(const id of ["tooltip-custom-path","tooltip-custom-span","tooltip-custom-em"])assert.match(got.customTooltipPath[id],/T3X Paths/);
  assert.match(got.customTooltipPath["tooltip-custom-code"],/Fixture Mono/);
  const regression=got.regressions;
  for(const id of ["ordinary-before","ordinary-after"])assert.match(regression[id],/T3X Main/);
  assert.match(regression["ordinary-head"],/T3X Heading/);
  assert.match(regression["prompt-after"],/T3X Prompts/);
  for(const id of ["rosterprose","bare-footer"])assert.match(regression[id],/T3X Footer/);
  for(const id of ["roster-native-control","roster-native-child","bare-footer-link","tooltip-native-path","tooltip-native-control"])assert.doesNotMatch(regression[id],/T3X/);
  for(const id of ["bare-footer-code","tooltip-path-code"])assert.match(regression[id],/Fixture Mono/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("similar areas: the rest of the group not already on this font, never a cycle", () => {
  const groups = plain(C.FONT_SIMILAR_GROUPS).flat();
  assert.equal(new Set(groups).size, groups.length, "each area sits in one group at most");
  for (const id of groups) assert.ok(C.FONT_ROLES.some((r) => r.id === id), id);
  const sources = { main: "own", quotes: "link:main", reasoning: "native", plans: "own", questions: "link:plans", composer: "own", prompts: "link:composer" };
  assert.deepEqual(plain(C.similarFontAreas(sources, "main")), ["reasoning", "plans", "questions"]);
  // questions follows plans, so pointing plans at questions would loop
  assert.deepEqual(plain(C.similarFontAreas(sources, "questions")), ["main", "quotes", "reasoning"]);
  assert.deepEqual(plain(C.similarFontAreas(sources, "composer")), []);
  assert.deepEqual(plain(C.similarFontAreas(sources, "viz")), []);
  const linked = { ...sources };
  for (const a of C.similarFontAreas(sources, "main")) linked[a] = "link:main";
  const terminal = plain(C.resolveFontGraph(linked));
  for (const a of ["main", "quotes", "reasoning", "plans", "questions"]) assert.equal(terminal[a], "main", a);
});
