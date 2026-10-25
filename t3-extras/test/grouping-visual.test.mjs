// Visual checks for the sidebar candidate. Isolated headless Chrome only.
// Default data is synthetic. A real recording is optional: set T3X_VISUAL_RECORDING
// to a metadata JSON path. The plain before/after files live in test/fixtures.
// This file does not read a parent cache or task-output baseline.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// T3 updates its headless Chrome in place (154 → 156 …); use the newest installed version.
function newestHeadlessChrome() {
  const root = path.join(os.homedir(), ".t3/tools/chrome-headless-shell/mac-arm64");
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((v) => /^\d+(\.\d+)+$/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return path.join(root, versions[0] ?? "missing", "chrome-headless-shell");
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = fileURLToPath(new URL("..", import.meta.url));
const CHROME = newestHeadlessChrome();
const PLAIN = fileURLToPath(new URL("./fixtures/plain-baseline/", import.meta.url));
const RECORDING = process.env.T3X_VISUAL_RECORDING || "";
const CLASSES = ["t3x-g-title", "t3x-g-meta", "t3x-g-project", "t3x-g-age", "t3x-g-state-text", "t3x-g-badges", "t3x-g-badge", "t3x-g-status", "t3x-g-note", "t3x-g-scope", "t3x-g-counts", "t3x-g-cue", "t3x-g-method"];

// Default app-sidebar tokens from main-CQXOblKU.css. Not a captured user theme or font.
const HOST = `
html[data-t3x-fixture="default-app-sidebar-light"] {
  color-scheme: light;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --background: oklch(99.2% 0 0);
  --foreground: oklch(27.4% .006 286.033);
  --card: #fff;
  --accent: oklch(96.7% .001 286.375);
  --accent-foreground: oklch(21% .006 285.885);
  --muted-foreground: oklch(55.2% .016 285.938);
  --border: oklch(92% .004 286.32);
  --sidebar: oklch(98.5% 0 none);
  --sidebar-foreground: oklch(27.4% .006 286.033);
  --sidebar-muted-foreground: oklch(55.2% .016 285.938);
  --sidebar-border: oklch(92% .004 286.32);
  --sidebar-row-hover: oklch(99.2% 0 0);
  --sidebar-row-selected: #fff;
  --primary: oklch(48.8% .217 264);
}
html[data-t3x-fixture="default-app-sidebar-dark"] {
  color-scheme: dark;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --background: #000;
  --foreground: #f1f3f7;
  --card: #000;
  --accent: #191a1d;
  --accent-foreground: #f7f9ff;
  --muted-foreground: #a3a3a3;
  --border: #ffffff14;
  --sidebar: #000;
  --sidebar-foreground: #f1f3f7;
  --sidebar-muted-foreground: #a3a3a3;
  --sidebar-border: #ffffff14;
  --sidebar-row-hover: color-mix(in srgb, #f1f3f7 8%, transparent);
  --sidebar-row-selected: color-mix(in srgb, #f1f3f7 7%, transparent);
  --primary: oklch(57.1% .21 264);
}
body { margin: 0; background: transparent; color: var(--sidebar-foreground, CanvasText); font-family: var(--font-sans, sans-serif); }
#column { width: 280px; }
.cap { margin: 0; padding: 4px 8px 2px; font: 11px/1.3 var(--font-sans, sans-serif); }
[data-slot="sidebar-inner"] { width: 100%; height: 520px; display: flex; flex-direction: column; background: var(--sidebar, transparent); }
[data-slot="sidebar-content"] { overflow: auto; height: 460px; }
ul { margin: 0; padding: 0; list-style: none; }
`;

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}

function synthetic() {
  const asOf = Date.now();
  const row = (extra) => ({
    projectId: "proj-alpha", projectLabel: "Alpha", createdAt: asOf - 86400000,
    activityAt: asOf - 3600000, activitySource: "run", recentBucket: "today",
    activity: "unknown", activityLabel: "State unavailable", badges: [], shelf: "main",
    detail: "Synthetic fixture. State unavailable. A value was missing, conflicting or not one this index knows.",
    ...extra,
  });
  const threads = [
    row({ id: "pinned-1", title: "Pinned question", shelf: "pinned", recentBucket: "m15", activityAt: asOf - 60000, activity: "questions", activityLabel: "Questions & approvals", badges: ["Recorded question", "Run recorded"], detail: "Recorded request in this database snapshot. A snapshot is not a live callback." }),
    row({ id: "mix-both", title: "Unknown with a recorded approval", activity: "unknown", activityLabel: "State unavailable", activitySource: "unavailable", activityAt: null, recentBucket: "unread", badges: ["Recorded approval request", "Child work recorded"] }),
    row({ id: "mix-run", title: "Run recorded, not live", badges: ["Run recorded"], recentBucket: "m60", activityAt: asOf - 1800000 }),
    row({ id: "mix-long", title: "SupercalifragilisticexpialidociousToken and a wrapping title that stays whole at a narrow width", projectLabel: "A very long project name that also has to wrap in full" }),
    row({ id: "ask", title: "Settled but a request remains", shelf: "settled", activity: "questions", activityLabel: "Questions & approvals", badges: ["Recorded approval request"], recentBucket: "yesterday", activityAt: asOf - 86400000 }),
    row({ id: "quiet", title: "Quiet settled note", shelf: "settled", recentBucket: "week", activityAt: asOf - 3 * 86400000 }),
  ];
  for (let i = 0; i < 16; i += 1) {
    threads.push(row({ id: `old-${i}`, title: `Older synthetic ${i}`, recentBucket: "older", activityAt: asOf - (20 + i) * 86400000 }));
  }
  return {
    ok: true, unavailable: false, reason: null, asOf, localEnvironmentId: "localenv01", source: "v2",
    coverage: { eligible: threads.length, returned: threads.length, truncated: false, cap: 1000, omittedUnsafeIds: 0, childLinksTruncated: false, factsIncomplete: true, questionsUnread: false },
    threads,
  };
}

function pinOf(meta) {
  const pinned = meta.threads.find((thread) => thread.shelf === "pinned");
  if (!pinned) throw new Error("fixture has no pinned thread");
  return pinned.id;
}

function liveCopy(raw) {
  const body = structuredClone(raw);
  const delta = Date.now() - body.asOf;
  body.asOf = Date.now();
  for (const thread of body.threads) {
    if (Number.isFinite(thread.activityAt)) thread.activityAt += delta;
    if (Number.isFinite(thread.createdAt)) thread.createdAt += delta;
  }
  return body;
}

function page({ caption, base, mode, env, pin }) {
  return `<!doctype html>
<html data-t3x-fixture="default-app-sidebar-dark">
<head><meta charset="utf-8"><style>${HOST}</style>
<link rel="stylesheet" href="${base}grouping.css"></head>
<body>
<div id="column">
  <p class="cap">${caption}</p>
  <div data-slot="sidebar-inner">
    <input aria-label="Search threads" role="combobox" value="">
    <button type="button" aria-label="Filter threads by project">Projects</button>
    <div data-slot="sidebar-content"><ul><li data-thread-item="${env}:anchor-thread">Native anchor</li></ul></div>
  </div>
</div>
<script>
localStorage.setItem("t3x:grouping:v1", JSON.stringify({ v: 1, mode: ${JSON.stringify(mode)}, sort: "recent", collapsed: {} }));
window.t3xGroupingExpose = true;
window.t3xGroupingBase = ${JSON.stringify(base)};
location.hash = ${JSON.stringify(`#/${env}/${pin}`)};
window.__ready = async () => {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (document.querySelector('[data-t3x="grouping-root"][data-ready="1"]')) return "ready";
    await new Promise((r) => setTimeout(r, 40));
  }
  return document.querySelector(".t3x-g-status")?.textContent || "no-status";
};
window.__measure = () => {
  const scroller = document.querySelector('[data-slot="sidebar-content"]');
  const first = document.querySelector(".t3x-g-groups section");
  const row = document.querySelector(".t3x-g-groups a");
  const view = scroller.getBoundingClientRect();
  return {
    top: first ? first.getBoundingClientRect().top - view.top : null,
    rowH: row ? row.getBoundingClientRect().height : null,
    scroll: scroller.scrollTop,
    selected: document.querySelector('[aria-current="page"]')?.getAttribute("data-thread-id") || "",
  };
};
window.__contrast = (el) => {
  if (!el) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const paint = (value) => { ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); };
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const chain = [];
  let node = el;
  while (node) { chain.push(getComputedStyle(node).backgroundColor); node = node.parentElement; }
  ctx.clearRect(0, 0, 1, 1);
  for (const color of chain.reverse()) paint(color);
  const bg = ctx.getImageData(0, 0, 1, 1).data;
  ctx.clearRect(0, 0, 1, 1);
  paint(getComputedStyle(el).color);
  const fg = ctx.getImageData(0, 0, 1, 1).data;
  if (bg[3] === 0 || fg[3] === 0) return null;
  const hi = Math.max(L(fg), L(bg));
  const lo = Math.min(L(fg), L(bg));
  return (hi + 0.05) / (lo + 0.05);
};
window.__fit = (select) => {
  const option = select.selectedOptions[0];
  const probe = document.createElement("span");
  probe.textContent = option.textContent;
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font:" + getComputedStyle(select).font;
  document.body.append(probe);
  const text = probe.getBoundingClientRect().width;
  probe.remove();
  const box = select.getBoundingClientRect().width;
  return { visible: option.textContent, accessible: option.getAttribute("aria-label"), text, box, fits: text + 18 <= box };
};
window.__sweep = () => {
  const mode = document.querySelector("#t3x-g-mode");
  const sort = document.querySelector("#t3x-g-sort");
  const rows = [];
  for (const width of [280, 200, 140]) {
    document.querySelector("#column").style.width = width + "px";
    for (const option of [...mode.options]) {
      mode.value = option.value;
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      rows.push({ control: "group", width, ...window.__fit(mode) });
    }
    for (const option of [...sort.options]) {
      sort.value = option.value;
      sort.dispatchEvent(new Event("change", { bubbles: true }));
      rows.push({ control: "sort", width, ...window.__fit(sort) });
    }
  }
  document.querySelector("#column").style.width = "280px";
  mode.value = "recent";
  mode.dispatchEvent(new Event("change", { bubbles: true }));
  sort.value = "recent";
  sort.dispatchEvent(new Event("change", { bubbles: true }));
  return rows;
};
window.__canon = () => {
  const details = document.querySelector(".t3x-g-details");
  if (details) details.open = false;
  const scroller = document.querySelector('[data-slot="sidebar-content"]');
  scroller.scrollTop = 0;
  const clip = (sel) => [...document.querySelectorAll(sel)].filter((node) => node.scrollWidth > node.clientWidth + 1).length;
  const column = document.querySelector("#column");
  return {
    open: details ? details.open : false,
    hasDetails: Boolean(details),
    scroll: scroller.scrollTop,
    titleClip: clip(".t3x-g-title"),
    projectClip: clip(".t3x-g-project"),
    overflow: column.scrollWidth - column.clientWidth,
  };
};
</script>
<script src="${base}grouping.js"></script>
</body></html>`;
}

function embed(value) {
  return JSON.stringify(value).replace(/<\/(script)/gi, "<\\/$1");
}

function buildPreview({ meta, beforeJs, afterJs, beforeCss, afterCss, caption }) {
  const pack = embed({ beforeJs, afterJs, beforeCss, afterCss, data: meta, env: meta.localEnvironmentId, pin: pinOf(meta) });
  const boot = `
const PACK = ${pack};
function copyVars(frame) {
  const doc = frame.contentDocument;
  const root = doc && doc.documentElement;
  if (!root) return;
  stampRoot(root, getComputedStyle(document.documentElement));
}
function lumOf(color) {
  if (!color) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const px = ctx.getImageData(0, 0, 1, 1).data;
  if (!px || px[3] === 0) return null;
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(px[0]) + 0.7152 * lin(px[1]) + 0.0722 * lin(px[2]);
}
function hostScheme(cs) {
  const raw = String(cs.getPropertyValue("color-scheme") || "").trim().toLowerCase();
  const named = raw.match(/dark|light/g) || [];
  if (named.length === 1) return named[0];
  const bg = cs.getPropertyValue("--sidebar").trim() || cs.getPropertyValue("--background").trim();
  const bgLum = lumOf(bg);
  if (bgLum != null) return bgLum < 0.45 ? "dark" : "light";
  const fg = cs.getPropertyValue("--sidebar-foreground").trim() || cs.getPropertyValue("--foreground").trim();
  const fgLum = lumOf(fg);
  if (fgLum != null) return fgLum > 0.55 ? "dark" : "light";
  return "";
}
function stampRoot(root, cs) {
  const names = ["--font-sans","--font-mono","--background","--foreground","--card","--accent","--accent-foreground","--muted-foreground","--border","--sidebar","--sidebar-foreground","--sidebar-muted-foreground","--sidebar-border","--sidebar-row-hover","--sidebar-row-selected","--primary"];
  for (const name of names) {
    const value = cs.getPropertyValue(name).trim();
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  const scheme = hostScheme(cs);
  if (scheme) root.style.setProperty("color-scheme", scheme);
  else root.style.removeProperty("color-scheme");
}
function rootAttr() {
  const probe = document.createElement("span");
  stampRoot(probe, getComputedStyle(document.documentElement));
  return (probe.getAttribute("style") || "").replace(/"/g, "'").replace(/</g, "");
}
function contrastOf(el) {
  if (!el) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const paint = (value) => { ctx.fillStyle = value || "rgba(0,0,0,0)"; ctx.fillRect(0, 0, 1, 1); };
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const chain = [];
  let node = el;
  while (node && node.nodeType === 1) {
    chain.push(getComputedStyle(node).backgroundColor);
    node = node.parentElement;
  }
  ctx.clearRect(0, 0, 1, 1);
  for (const color of chain.reverse()) paint(color);
  const bg = ctx.getImageData(0, 0, 1, 1).data;
  ctx.clearRect(0, 0, 1, 1);
  paint(getComputedStyle(el).color);
  const fg = ctx.getImageData(0, 0, 1, 1).data;
  if (bg[3] === 0 || fg[3] === 0) return null;
  const hi = Math.max(L(fg), L(bg));
  const lo = Math.min(L(fg), L(bg));
  return (hi + 0.05) / (lo + 0.05);
}
function paneReport(frame) {
  const doc = frame.contentDocument;
  const cs = getComputedStyle(doc.documentElement);
  const row = doc.querySelector('[aria-current="page"]') || doc.querySelector(".t3x-g-groups a");
  const title = row && row.querySelector(".t3x-g-title");
  const controls = [
    ["search", 'input[aria-label="Search threads"]'],
    ["projects", 'button[aria-label="Filter threads by project"]'],
    ["group", "#t3x-g-mode"],
    ["sort", "#t3x-g-sort"],
  ].map(([name, sel]) => {
    const el = doc.querySelector(sel);
    return { name, found: Boolean(el), contrast: contrastOf(el) };
  });
  const scroller = doc.querySelector('[data-slot="sidebar-content"]');
  const bits = row ? [".t3x-g-project", ".t3x-g-state-text"].map((sel) => row.querySelector(sel)?.textContent || "") : [];
  return {
    rows: doc.querySelectorAll("[data-thread-id]").length,
    rowChars: (row && row.textContent || "").trim().length,
    scheme: String(cs.colorScheme || cs.getPropertyValue("color-scheme") || "").trim(),
    sidebar: cs.getPropertyValue("--sidebar").trim(),
    sidebarFg: cs.getPropertyValue("--sidebar-foreground").trim(),
    backgroundVar: cs.getPropertyValue("--background").trim(),
    foregroundVar: cs.getPropertyValue("--foreground").trim(),
    htmlBackground: cs.backgroundColor,
    htmlLum: lumOf(cs.backgroundColor),
    title: contrastOf(title),
    controls,
    selected: doc.querySelector('[aria-current="page"]')?.getAttribute("data-thread-id") || "",
    scroll: scroller ? scroller.scrollTop : -1,
    meta: bits.join("|"),
  };
}
window.__hostReport = () => {
  const parent = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const frame = document.querySelector("#after");
  const frameBg = frame ? getComputedStyle(frame).backgroundColor : "";
  const htmlBg = parent.backgroundColor;
  const clear = (value) => {
    const text = String(value || "").replace(/\\s+/g, "").toLowerCase();
    return text === "transparent" || text === "rgba(0,0,0,0)";
  };
  return {
    outerTransparent: clear(body.backgroundColor) && clear(frameBg) && clear(htmlBg),
    outerHtmlBackground: htmlBg,
    outerBackground: body.backgroundColor,
    frameBackground: frameBg,
    parentSidebar: parent.getPropertyValue("--sidebar").trim(),
    parentSidebarFg: parent.getPropertyValue("--sidebar-foreground").trim(),
    parentBackground: parent.getPropertyValue("--background").trim(),
    parentForeground: parent.getPropertyValue("--foreground").trim(),
    parentFont: parent.getPropertyValue("--font-sans").trim(),
    parentScheme: parent.getPropertyValue("color-scheme").trim(),
    before: paneReport(document.querySelector("#before")),
    after: paneReport(document.querySelector("#after")),
    errors: window.__errors.slice(),
  };
};
function inner(which) {
  const js = (which === "before" ? PACK.beforeJs : PACK.afterJs).replace(/<\\/script/gi, "<\\\\/script");
  const css = which === "before" ? PACK.beforeCss : PACK.afterCss;
  const label = which === "before" ? "Before" : "After";
  return "<!doctype html><html style=\\"" + rootAttr() + "\\"><head><meta charset=utf-8><style>"
    + "html,body{margin:0;background:var(--sidebar,var(--background,Canvas));color:var(--sidebar-foreground,var(--foreground,CanvasText));font-family:var(--font-sans,sans-serif)}"
    + "#column{width:280px}.cap{margin:0;padding:4px 8px;font:11px/1.3 var(--font-sans,sans-serif)}"
    + "[data-slot=sidebar-inner]{width:280px;height:460px;display:flex;flex-direction:column;color:var(--sidebar-foreground,var(--foreground,CanvasText));background:var(--sidebar,var(--background,Canvas))}"
    + "[data-slot=sidebar-content]{overflow:auto;height:400px}ul{margin:0;padding:0;list-style:none}"
    + css
    + "</style></head><body><p class=cap>" + label + "</p><div id=column><div data-slot=sidebar-inner>"
    + "<input aria-label=\\"Search threads\\" role=combobox value=\\"\\">"
    + "<button type=button aria-label=\\"Filter threads by project\\">Projects</button>"
    + "<div data-slot=sidebar-content><ul><li data-thread-item=\\"" + PACK.env + ":anchor-thread\\">Native anchor</li></ul></div>"
    + "</div></div><script>const RAW = " + JSON.stringify(PACK.data) + ";"
    + "function payload(){const body=JSON.parse(JSON.stringify(RAW));const delta=Date.now()-body.asOf;body.asOf=Date.now();for (const thread of body.threads){if(Number.isFinite(thread.activityAt))thread.activityAt+=delta;if(Number.isFinite(thread.createdAt))thread.createdAt+=delta;}return body;}"
    + "window.addEventListener('error',(event)=>{parent.__errors.push(String(event.message||'error'));});"
    + "window.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve(payload())});"
    + "localStorage.setItem('t3x:grouping:v1', JSON.stringify({v:1,mode:'recent',sort:'recent',collapsed:{}}));window.t3xGroupingExpose=true;"
    + "window.t3xGroupingBase='preview://';location.hash='#/" + PACK.env + "/" + PACK.pin + "';"
    + "<\\/script><script>" + js + "<\\/script></body></html>";
}
window.__errors = [];
window.addEventListener("error", (event) => { window.__errors.push(String(event.message || "error")); });
const oldError = console.error.bind(console);
console.error = (...args) => { window.__errors.push(args.map(String).join(" ")); oldError(...args); };
async function ready(frame) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const doc = frame.contentDocument;
    if (doc && doc.querySelector('[data-t3x="grouping-root"][data-ready="1"]')) {
      copyVars(frame);
      const scroller = doc.querySelector('[data-slot="sidebar-content"]');
      if (scroller) scroller.scrollTop = 0;
      const details = doc.querySelector("details");
      if (details) details.open = false;
      return;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  const doc = frame.contentDocument;
  window.__errors.push("not ready " + (doc?.querySelector(".t3x-g-status")?.textContent || doc?.body?.innerText || "empty").slice(0, 180));
}
(async () => {
  const before = document.querySelector("#before");
  const after = document.querySelector("#after");
  before.srcdoc = inner("before");
  after.srcdoc = inner("after");
  await ready(before);
  await ready(after);
  const readPane = (frame) => {
    const doc = frame.contentDocument;
    const scroller = doc.querySelector('[data-slot="sidebar-content"]');
    return {
      rows: doc.querySelectorAll("[data-thread-id]").length,
      selected: doc.querySelector('[aria-current="page"]')?.getAttribute("data-thread-id") || "",
      scroll: scroller ? scroller.scrollTop : -1,
      detailsOpen: doc.querySelector("details") ? doc.querySelector("details").open : false,
      hasDetails: Boolean(doc.querySelector("details")),
    };
  };
  window.__previewState = { before: readPane(before), after: readPane(after), errors: window.__errors.slice() };
})();
`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Design candidate</title>
<style>
body { margin: 0; background: transparent; color: inherit; font: 12px/1.35 var(--font-sans, sans-serif); }
.caption { margin: 0 0 8px; max-width: 40rem; }
.pair { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.pane { width: 280px; }
.pane p { margin: 0 0 4px; }
iframe { width: 280px; height: 520px; border: 0; background: transparent; }
</style>
</head>
<body>
<div id="stage">
  <p class="caption">${caption}</p>
  <div class="pair">
    <div class="pane"><p>Before</p><iframe id="before" title="Before, same threads, viewport, selection and scroll"></iframe></div>
    <div class="pane"><p>After</p><iframe id="after" title="After, same threads, viewport, selection and scroll"></iframe></div>
  </div>
</div>
<script>${boot}</script>
</body>
</html>`;
}

function validatePreview(html, beforeJs, afterJs) {
  assert.equal(/\d(?:vh|svh|dvh)/.test(html), false);
  assert.equal(/height\s*:\s*100%/.test(html), false);
  assert.equal(html.includes("https://"), false);
  assert.equal(html.includes("\\u003c"), false);
  assert.match(html, /<=/);
  assert.match(html, /var\(--font-sans/);
  assert.doesNotMatch(html, /data-theme=/);
  assert.doesNotMatch(html, /background:\s*#000/);
  assert.doesNotMatch(html, /background:\s*#1b1b1b/);
  assert.doesNotMatch(html, /class="banner"|class="card"/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0][1]);
  const source = scripts[0][1];
  const start = source.indexOf("const PACK = ") + "const PACK = ".length;
  const end = source.indexOf(";\nfunction copyVars");
  const pack = JSON.parse(source.slice(start, end));
  new vm.Script(pack.beforeJs);
  new vm.Script(pack.afterJs);
  assert.equal(pack.beforeJs, beforeJs);
  assert.equal(pack.afterJs, afterJs);
  assert.equal(pack.beforeJs.includes("\\u003c="), false);
  assert.equal(pack.afterJs.includes("\\u003c="), false);
}

test("provenance, preserved classes, and a hermetic visual test", () => {
  const js = read("public/grouping.js");
  const css = read("public/grouping.css");
  const joined = js + "\n" + css;
  for (const name of CLASSES) assert.equal(joined.includes(name), true, name);
  assert.match(js, /Recent runs/);
  assert.match(js, /Recent run activity/);
  assert.match(css, /var\(--font-sans/);
  assert.doesNotMatch(js, /<h[1-6]/);
  assert.match(js, /class: "t3x-g-project"/);
  const provenance = JSON.parse(fs.readFileSync(new URL("./host-provenance.json", import.meta.url), "utf8"));
  assert.equal(provenance.defaultsSource.sha256, "3e20e22b8cfa0d0314341d5239681750026b12a6cdda99c88785f806f2a92155");
  assert.match(provenance.outstanding, /not established/);
  assert.equal(provenance.classesPreserved.length, CLASSES.length);
  const self = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.equal(self.includes(["visual-live", "metadata.json"].join("-")), false);
  assert.equal(self.includes(["task-output", "before-source"].join("/")), false);
  const baseline = fs.readFileSync(path.join(PLAIN, "grouping.js"), "utf8");
  assert.match(baseline, /Recent run activity/);
  assert.equal(baseline.includes("Find macOS"), false);
  new vm.Script(js);
  new vm.Script(baseline);
});

test("sidebar visual candidate in isolated Chrome", { timeout: 240_000 }, async () => {
  assert.equal(fs.existsSync(CHROME), true, `missing ${CHROME}`);
  const beforeJs = fs.readFileSync(path.join(PLAIN, "grouping.js"), "utf8");
  const beforeCss = fs.readFileSync(path.join(PLAIN, "grouping.css"), "utf8");
  const afterJs = read("public/grouping.js");
  const afterCss = read("public/grouping.css");
  const synth = synthetic();
  const recorded = RECORDING ? JSON.parse(fs.readFileSync(RECORDING, "utf8")) : null;
  let previewBody = "";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (type, body) => {
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    if (url.pathname === "/current/grouping.js") return send("text/javascript; charset=utf-8", afterJs);
    if (url.pathname === "/current/grouping.css") return send("text/css; charset=utf-8", afterCss);
    if (url.pathname === "/plain/grouping.js") return send("text/javascript; charset=utf-8", beforeJs);
    if (url.pathname === "/plain/grouping.css") return send("text/css; charset=utf-8", beforeCss);
    if (url.pathname === "/recorded/grouping.js") return send("text/javascript; charset=utf-8", afterJs);
    if (url.pathname === "/recorded/grouping.css") return send("text/css; charset=utf-8", afterCss);
    if (url.pathname === "/recorded-plain/grouping.js") return send("text/javascript; charset=utf-8", beforeJs);
    if (url.pathname === "/recorded-plain/grouping.css") return send("text/css; charset=utf-8", beforeCss);
    if (url.pathname === "/current/grouping" || url.pathname === "/plain/grouping") return send("application/json", JSON.stringify(liveCopy(synth)));
    if (url.pathname === "/recorded/grouping" || url.pathname === "/recorded-plain/grouping") {
      return send("application/json", JSON.stringify(liveCopy(recorded)));
    }
    if (url.pathname === "/preview.html" || url.pathname === "/preview-host.html") {
      const hostStyle = "<style>html{--background:#0a0a0a;--foreground:#f5f5f5;--font-sans:'Liberation Sans',Arimo,Arial,Helvetica,sans-serif}</style>";
      const body = url.pathname === "/preview-host.html" ? previewBody.replace("<head>", "<head>" + hostStyle) : previewBody;
      return send("text/html; charset=utf-8", body);
    }
    const routes = {
      "/syn.html": page({ caption: "Synthetic fixture. Default app-sidebar dark tokens from main-CQXOblKU.css. Not the current user theme.", base: "/current/", mode: "recent", env: synth.localEnvironmentId, pin: pinOf(synth) }),
      "/syn-before.html": page({ caption: "Before. Synthetic fixture. Same viewport, selection and scroll.", base: "/plain/", mode: "recent", env: synth.localEnvironmentId, pin: pinOf(synth) }),
      "/mix.html": page({ caption: "Mixed-state fixture, not a recorded snapshot.", base: "/current/", mode: "activity", env: synth.localEnvironmentId, pin: pinOf(synth) }),
    };
    if (recorded && url.pathname === "/rec.html") {
      return send("text/html; charset=utf-8", page({ caption: "Recorded metadata. Default app-sidebar dark tokens, not the current user theme.", base: "/recorded/", mode: "recent", env: recorded.localEnvironmentId, pin: pinOf(recorded) }));
    }
    if (recorded && url.pathname === "/rec-before.html") {
      return send("text/html; charset=utf-8", page({ caption: "Before. Recorded metadata. Same viewport, selection and scroll.", base: "/recorded-plain/", mode: "recent", env: recorded.localEnvironmentId, pin: pinOf(recorded) }));
    }
    if (routes[url.pathname]) return send("text/html; charset=utf-8", routes[url.pathname]);
    res.writeHead(404); res.end("missing");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-visual-"));
  const chrome = spawn(CHROME, [
    "--headless", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`,
    "--remote-debugging-port=0", "--window-size=1280,900", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (chunk) => { stderr += chunk; });
  const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 230_000);
  let ws;
  const shots = [];
  try {
    let wsUrl = "";
    for (let i = 0; i < 100 && !wsUrl; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const [debugPort] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        wsUrl = list.find((tab) => tab.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch { /* debugger port not ready */ }
    }
    if (!wsUrl) throw new Error(`no debugger page: ${stderr.slice(0, 400)}`);
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("debugger socket failed")), { once: true });
    });
    let id = 0;
    const pending = new Map();
    const runtimeErrors = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(JSON.stringify(message.params?.exceptionDetails?.exception || message.params).slice(0, 300));
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const next = ++id;
      pending.set(next, resolve);
      ws.send(JSON.stringify({ id: next, method, params }));
    });
    const ev = async (expression) => {
      const message = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (message.result?.exceptionDetails) throw new Error(JSON.stringify(message.result.exceptionDetails).slice(0, 900));
      return message.result?.result?.value;
    };
    const shot = async (dir, name) => {
      if (!dir) return "";
      const clip = await ev(`(() => { const node = document.querySelector("#stage") || document.querySelector("#column"); const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: Math.max(1, b.width), height: Math.max(1, Math.min(b.height, 860)), scale: 1 }; })()`);
      const picture = await send("Page.captureScreenshot", { format: "png", clip });
      const dest = path.join(dir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, Buffer.from(picture.result.data, "base64"));
      shots.push(dest);
      return dest;
    };
    const open = async (pathname) => {
      runtimeErrors.length = 0;
      await send("Page.navigate", { url: `http://127.0.0.1:${port}${pathname}` });
      const ready = await ev(`(async () => {
        const start = Date.now();
        while (Date.now() - start < 8000) {
          if (typeof window.__ready === "function") return await window.__ready();
          if (window.__previewState) return "preview";
          await new Promise((r) => setTimeout(r, 40));
        }
        return "timeout";
      })()`);
      assert.equal(ready === "ready" || ready === "preview", true, pathname + " " + ready);
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    const assertCanon = async () => {
      const state = await ev(`window.__canon()`);
      assert.equal(state.open, false, JSON.stringify(state));
      assert.equal(state.scroll, 0, JSON.stringify(state));
      assert.equal(state.titleClip, 0, JSON.stringify(state));
      assert.equal(state.projectClip, 0, JSON.stringify(state));
      assert.ok(state.overflow <= 1, JSON.stringify(state));
      return state;
    };
    const assertFits = async () => {
      const rows = await ev(`window.__sweep()`);
      assert.equal(rows.length, 21, JSON.stringify(rows.length));
      for (const row of rows) {
        assert.equal(row.fits, true, JSON.stringify(row));
        assert.equal(row.accessible, row.visible === "Recent runs" ? "Recent run activity" : row.visible, JSON.stringify(row));
      }
      return rows;
    };
    const assertContrast = async (label) => {
      const values = await ev(`(() => {
        const sample = document.querySelector('[aria-current="page"]') || document.querySelector(".t3x-g-groups a");
        return {
          title: window.__contrast(sample.querySelector(".t3x-g-title")),
          project: window.__contrast(sample.querySelector(".t3x-g-project")),
          state: window.__contrast(sample.querySelector(".t3x-g-state-text")),
          cue: window.__contrast(document.querySelector(".t3x-g-cue")),
        };
      })()`);
      for (const [name, value] of Object.entries(values)) assert.ok(value >= 4.5, `${label} ${name} ${value}`);
      return values;
    };
    const colorText = (value) => String(value || "").replace(/\s+/g, "").toLowerCase();
    const isHex = (value, hex) => {
      const text = colorText(value);
      if (text === hex) return true;
      const bits = /^#([0-9a-f]{6})$/.exec(hex);
      if (!bits) return false;
      const n = parseInt(bits[1], 16);
      return text === `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
    };
    const hostSlim = (report) => ({
      outerTransparent: report.outerTransparent,
      outerBackground: report.outerBackground,
      frameBackground: report.frameBackground,
      parentBackground: report.parentBackground,
      parentForeground: report.parentForeground,
      parentSidebar: report.parentSidebar,
      parentSidebarFg: report.parentSidebarFg,
      parentScheme: report.parentScheme,
      parentFont: report.parentFont,
      sameSelection: report.before.selected === report.after.selected && report.before.scroll === report.after.scroll,
      errors: report.errors,
      before: { ...report.before, meta: report.before.meta ? "set" : "" },
      after: { ...report.after, meta: report.after.meta ? "set" : "" },
    });
    // T3 html_preview injects host variables and does not set sidebar variables.
    // This is a separate case from the default app-sidebar fixture above.
    const assertHostInjection = async (pin) => {
      runtimeErrors.length = 0;
      await send("Page.navigate", { url: `http://127.0.0.1:${port}/preview-host.html` });
      let report = null;
      let detail = "";
      const start = Date.now();
      while (Date.now() - start < 12000) {
        try {
          const value = await ev(`(() => {
            if (location.pathname !== "/preview-host.html" || !window.__previewState || typeof window.__hostReport !== "function") return null;
            return window.__hostReport();
          })()`);
          if (value && value.after) { report = value; break; }
        } catch (error) {
          detail = String(error).slice(0, 180);
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.ok(report, detail || "host preview did not load");
      const slim = hostSlim(report);
      assert.equal(report.outerTransparent, true, JSON.stringify(slim));
      assert.equal(report.parentSidebar, "", JSON.stringify(slim));
      assert.equal(report.parentSidebarFg, "", JSON.stringify(slim));
      assert.equal(isHex(report.parentBackground, "#0a0a0a"), true, JSON.stringify(slim));
      assert.equal(isHex(report.parentForeground, "#f5f5f5"), true, JSON.stringify(slim));
      assert.match(report.parentFont, /Liberation Sans/);
      assert.equal(report.parentScheme, "normal", JSON.stringify(slim));
      assert.equal(report.before.selected, report.after.selected, JSON.stringify(slim));
      assert.equal(report.before.scroll, report.after.scroll, JSON.stringify(slim));
      assert.ok((report.after.meta.split("|")[1] || "").length > 0, JSON.stringify(slim));
      for (const pane of [report.before, report.after]) {
        assert.equal(pane.sidebar, "", JSON.stringify(slim));
        assert.equal(pane.sidebarFg, "", JSON.stringify(slim));
        assert.equal(pane.scheme, "dark", JSON.stringify(slim));
        assert.equal(isHex(pane.backgroundVar, "#0a0a0a"), true, JSON.stringify(slim));
        assert.equal(isHex(pane.foregroundVar, "#f5f5f5"), true, JSON.stringify(slim));
        assert.ok(pane.htmlLum != null && pane.htmlLum < 0.2, JSON.stringify(slim));
        assert.ok(pane.title >= 4.5, JSON.stringify(slim));
        assert.ok(pane.rows > 1, JSON.stringify(slim));
        assert.ok(pane.rowChars > 10, JSON.stringify(slim));
        assert.equal(pane.scroll, 0, JSON.stringify(slim));
        assert.equal(pane.selected, pin, JSON.stringify(slim));
        assert.equal(pane.controls.length, 4, JSON.stringify(slim));
        for (const control of pane.controls) {
          assert.equal(control.found, true, JSON.stringify(control));
          assert.ok(control.contrast >= 4.5, JSON.stringify(control));
        }
      }
      assert.deepEqual(report.errors, []);
      assert.deepEqual(runtimeErrors, []);
      return report;
    };

    await open("/syn-before.html");
    const before = await ev(`window.__measure()`);
    assert.equal(before.scroll, 0);
    assert.equal(before.selected, pinOf(synth));
    await open("/syn.html");
    const started = await ev(`(() => ({ open: document.querySelector(".t3x-g-details").open, scroll: document.querySelector('[data-slot="sidebar-content"]').scrollTop }))()`);
    assert.equal(started.open, false, JSON.stringify(started));
    assert.equal(started.scroll, 0, JSON.stringify(started));
    const after = await ev(`window.__measure()`);
    assert.equal(after.selected, pinOf(synth));
    assert.equal(after.scroll, 0);
    const recovered = before.top - after.top;
    assert.ok(recovered >= after.rowH, JSON.stringify({ before, after, recovered }));
    const fits = await assertFits();
    await assertCanon();
    const dark = await assertContrast("default-app-sidebar-dark");
    const held = await ev(`(async () => {
      const summary = document.querySelector(".t3x-g-details summary");
      if (!document.querySelector(".t3x-g-details").open) summary.click();
      summary.focus();
      const scroller = document.querySelector('[data-slot="sidebar-content"]');
      scroller.scrollTop = 40;
      const beforeScroll = scroller.scrollTop;
      const beforeStamp = document.querySelector('[data-t3x="grouping-root"]').dataset.asof;
      window.t3xGrouping.requestRefresh();
      const start = Date.now();
      while (Date.now() - start < 4000 && document.querySelector('[data-t3x="grouping-root"]').dataset.asof === beforeStamp) await new Promise((r) => setTimeout(r, 30));
      return { open: document.querySelector(".t3x-g-details").open, focus: document.activeElement === summary, moved: Math.abs(scroller.scrollTop - beforeScroll) > 1 };
    })()`);
    assert.equal(held.open, true, JSON.stringify(held));
    assert.equal(held.focus, true, JSON.stringify(held));
    assert.equal(held.moved, false, JSON.stringify(held));
    await ev(`document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0`);
    const detailsOpen = await ev(`(() => ({ open: document.querySelector(".t3x-g-details").open, scroll: document.querySelector('[data-slot="sidebar-content"]').scrollTop }))()`);
    assert.equal(detailsOpen.open, true);
    assert.equal(detailsOpen.scroll, 0);
    for (const width of [280, 200, 140]) {
      await ev(`document.querySelector("#column").style.width = "${width}px"`);
      await assertCanon();
    }
    await ev(`document.documentElement.setAttribute("data-t3x-fixture", "default-app-sidebar-light"); document.querySelector(".cap").textContent = "Default app-sidebar light tokens from main-CQXOblKU.css. Not the current user theme."; document.querySelector("#column").style.width = "280px"`);
    const light = await assertContrast("default-app-sidebar-light");
    for (const width of [280, 200, 140]) {
      await ev(`document.querySelector("#column").style.width = "${width}px"`);
      await assertCanon();
    }
    await ev(`document.documentElement.setAttribute("data-t3x-fixture", "default-app-sidebar-dark"); document.querySelector("#column").style.width = "280px"`);
    await open("/mix.html");
    const empty = await ev(`document.querySelector(".t3x-g-empty")?.textContent || ""`);
    assert.match(empty, /this group/);
    const mixed = await ev(`(() => {
      const scroller = document.querySelector('[data-slot="sidebar-content"]');
      const row = document.querySelector('[data-thread-id="mix-both"]');
      const view = scroller.getBoundingClientRect();
      scroller.scrollTop += row.getBoundingClientRect().top - view.top - 28;
      const box = row.getBoundingClientRect();
      const view2 = scroller.getBoundingClientRect();
      return {
        top: box.top - view2.top, bottom: view2.bottom - box.bottom, height: box.height,
        state: row.querySelector(".t3x-g-state-text").textContent,
        badges: row.querySelector(".t3x-g-badges").textContent,
      };
    })()`);
    assert.ok(mixed.top >= 0 && mixed.bottom >= -1 && mixed.height > 24, JSON.stringify(mixed));
    assert.equal(mixed.state, "State unavailable");
    assert.match(mixed.badges, /Recorded approval request/);
    assert.match(mixed.badges, /Child work recorded/);
    await ev(`document.querySelector("#column").style.width = "140px"`);
    const long = await ev(`(() => {
      const scroller = document.querySelector('[data-slot="sidebar-content"]');
      const row = document.querySelector('[data-thread-id="mix-long"]');
      scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 28;
      const title = row.querySelector(".t3x-g-title");
      const project = row.querySelector(".t3x-g-project");
      return { titleClip: title.scrollWidth - title.clientWidth, projectClip: project.scrollWidth - project.clientWidth, ellipsis: getComputedStyle(title).textOverflow, overflow: document.querySelector("#column").scrollWidth - document.querySelector("#column").clientWidth };
    })()`);
    assert.ok(long.titleClip <= 1, JSON.stringify(long));
    assert.ok(long.projectClip <= 1, JSON.stringify(long));
    assert.notEqual(long.ellipsis, "ellipsis");
    assert.ok(long.overflow <= 1, JSON.stringify(long));

    previewBody = buildPreview({
      meta: synth, beforeJs, afterJs, beforeCss, afterCss,
      caption: "Synthetic fixture. Same viewport, selection and scroll. Theme and font follow the host. Not a live list.",
    });
    validatePreview(previewBody, beforeJs, afterJs);
    runtimeErrors.length = 0;
    await open("/preview.html");
    const preview = await ev(`(async () => { const start = Date.now(); while (Date.now() - start < 8000 && !window.__previewState) await new Promise((r) => setTimeout(r, 40)); return window.__previewState; })()`);
    assert.ok(preview.after.rows > 1, JSON.stringify(preview));
    assert.ok(preview.before.rows > 1, JSON.stringify(preview));
    assert.equal(preview.after.selected, pinOf(synth));
    assert.equal(preview.before.selected, pinOf(synth));
    assert.equal(preview.after.scroll, 0);
    assert.equal(preview.before.scroll, 0);
    assert.equal(preview.after.detailsOpen, false);
    assert.deepEqual(preview.errors, []);
    assert.deepEqual(runtimeErrors, []);
    const syntheticHost = await assertHostInjection(pinOf(synth));

    let recordedRecovered = null;
    if (recorded) {
      const out = path.join(SRC, "task-output", "visual");
      fs.mkdirSync(out, { recursive: true });
      for (const name of fs.readdirSync(out)) {
        if (name.endsWith(".png") || name === "geometry.json") fs.rmSync(path.join(out, name));
      }
      await open("/rec-before.html");
      const recBefore = await ev(`window.__measure()`);
      await shot(out, "before-recent-280-dark.png");
      await open("/rec.html");
      const recStart = await ev(`(() => ({ open: document.querySelector(".t3x-g-details").open, scroll: document.querySelector('[data-slot="sidebar-content"]').scrollTop }))()`);
      assert.equal(recStart.open, false, JSON.stringify(recStart));
      assert.equal(recStart.scroll, 0, JSON.stringify(recStart));
      const recAfter = await ev(`window.__measure()`);
      assert.equal(recAfter.selected, pinOf(recorded));
      assert.equal(recBefore.selected, pinOf(recorded));
      recordedRecovered = recBefore.top - recAfter.top;
      assert.ok(recordedRecovered >= recAfter.rowH, JSON.stringify({ recBefore, recAfter, recordedRecovered }));
      await assertCanon();
      await shot(out, "after-recent-280-dark.png");
      const audit = await ev(`(() => {
        const states = [...document.querySelectorAll(".t3x-g-state-text")].map((node) => node.textContent);
        const sample = document.querySelector('[aria-current="page"]');
        const link = sample;
        link.blur();
        const idleOutline = getComputedStyle(link).outlineStyle;
        link.focus({ preventScroll: true });
        const focused = getComputedStyle(link);
        return {
          states: states.length,
          stateOk: states.every((text) => text === "State unavailable"),
          pinnedBadge: document.querySelector('[data-thread-id="${pinOf(recorded)}"] .t3x-g-badge')?.textContent || "",
          cue: document.querySelector(".t3x-g-cue")?.textContent || "",
          counts: document.querySelector(".t3x-g-counts")?.textContent || "",
          olderOpen: document.querySelector('[data-t3x-g-toggle="older"]')?.getAttribute("aria-expanded"),
          olderText: document.querySelector('[data-t3x-g-toggle="older"]')?.textContent || "",
          idleOutline,
          focusOutline: focused.outlineWidth,
          edge: focused.boxShadow,
          detailsOpen: document.querySelector(".t3x-g-details").open,
          scroll: document.querySelector('[data-slot="sidebar-content"]').scrollTop,
        };
      })()`);
      assert.equal(audit.stateOk, true);
      assert.ok(audit.states > 10 && audit.states < recorded.threads.length, JSON.stringify(audit.states));
      assert.equal(audit.pinnedBadge, "Run recorded");
      assert.match(audit.cue, /Read incomplete/);
      assert.match(audit.counts, new RegExp(`${recorded.threads.length} top-level threads`));
      assert.equal(audit.olderOpen, "false");
      assert.match(audit.olderText, /State unavailable/);
      assert.equal(audit.idleOutline, "none");
      assert.ok(parseFloat(audit.focusOutline) >= 2, audit.focusOutline);
      assert.match(audit.edge, /inset/);
      assert.equal(audit.detailsOpen, false);
      assert.equal(audit.scroll, 0);
      await shot(out, "after-focus-280-dark.png");
      await ev(`(() => { const details = document.querySelector(".t3x-g-details"); details.open = true; document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0; })()`);
      const openDetails = await ev(`(() => ({ open: document.querySelector(".t3x-g-details").open, scroll: document.querySelector('[data-slot="sidebar-content"]').scrollTop }))()`);
      assert.equal(openDetails.open, true);
      assert.equal(openDetails.scroll, 0);
      await shot(out, "details-open-280-dark.png");
      for (const width of [200, 140]) {
        await ev(`document.querySelector("#column").style.width = "${width}px"`);
        await assertCanon();
        await shot(out, `after-recent-${width}-dark.png`);
      }
      await ev(`document.documentElement.setAttribute("data-t3x-fixture", "default-app-sidebar-light"); document.querySelector(".cap").textContent = "Default app-sidebar light tokens from main-CQXOblKU.css. Not the current user theme."`);
      for (const width of [280, 200, 140]) {
        await ev(`document.querySelector("#column").style.width = "${width}px"`);
        await assertCanon();
        await shot(out, `after-recent-${width}-light.png`);
      }
      await ev(`(() => { document.documentElement.setAttribute("data-t3x-fixture", "default-app-sidebar-dark"); document.querySelector("#column").style.width = "280px"; const mode = document.querySelector("#t3x-g-mode"); mode.value = "activity"; mode.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await assertCanon();
      await shot(out, "after-activity-280-dark.png");
      await ev(`(() => { const mode = document.querySelector("#t3x-g-mode"); mode.value = "project"; mode.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await assertCanon();
      await shot(out, "after-project-280-dark.png");
      await open("/mix.html");
      await ev(`(() => { const scroller = document.querySelector('[data-slot="sidebar-content"]'); const row = document.querySelector('[data-thread-id="mix-both"]'); scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 28; })()`);
      const inView = await ev(`(() => { const scroller = document.querySelector('[data-slot="sidebar-content"]'); const row = document.querySelector('[data-thread-id="mix-both"]'); const view = scroller.getBoundingClientRect(); const box = row.getBoundingClientRect(); return { top: box.top - view.top, bottom: view.bottom - box.bottom, height: box.height }; })()`);
      assert.ok(inView.top >= 0 && inView.bottom >= -1 && inView.height > 24, JSON.stringify(inView));
      await shot(out, "mixed-unknown-positive-in-view-280-dark.png");
      await ev(`document.querySelector("#column").style.width = "140px"`);
      await ev(`(() => { const scroller = document.querySelector('[data-slot="sidebar-content"]'); const row = document.querySelector('[data-thread-id="mix-long"]'); scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 28; })()`);
      await shot(out, "mixed-long-140-dark.png");
      const recPreview = buildPreview({
        meta: recorded, beforeJs, afterJs, beforeCss, afterCss,
        caption: `Recorded metadata at 1:13 AM. ${recorded.threads.length} threads, all State unavailable. Same viewport, selection and scroll. Not a live list. Theme and font follow the host.`,
      });
      validatePreview(recPreview, beforeJs, afterJs);
      previewBody = recPreview;
      const recordedHost = await assertHostInjection(pinOf(recorded));
      const recState = await ev(`window.__previewState`);
      assert.ok(recState.after.rows > 1, JSON.stringify(recState));
      assert.ok(recState.before.rows > 1, JSON.stringify(recState));
      assert.equal(recState.after.selected, pinOf(recorded));
      assert.equal(recState.before.selected, pinOf(recorded));
      assert.equal(recState.after.scroll, 0);
      assert.equal(recState.before.scroll, 0);
      assert.equal(recState.after.detailsOpen, false);
      assert.equal(recState.before.detailsOpen, false);
      assert.deepEqual(recState.errors, []);
      assert.deepEqual(runtimeErrors, []);
      await shot(out, "preview-before-after-280.png");
      const dest = path.join(SRC, "preview.html");
      fs.writeFileSync(dest, recPreview);
      fs.writeFileSync(path.join(out, "geometry.json"), JSON.stringify({
        synthetic: { before, after, recovered, dark, light, held, fits: fits.filter((row) => !row.fits) },
        recorded: { before: recBefore, after: recAfter, recovered: recordedRecovered, audit, preview: dest },
        shots,
        fixture: "default app-sidebar tokens from main-CQXOblKU.css; not the current user theme or selected font",
        hostInjection: {
          note: "Injected host variables only (--background #0a0a0a, --foreground #f5f5f5, Liberation Sans). Sidebar variables absent. Not the default app-sidebar fixture and not a claim about the current user theme.",
          synthetic: hostSlim(syntheticHost),
          recorded: hostSlim(recordedHost),
        },
      }, null, 2));
    }
    for (const dest of shots) assert.ok(fs.statSync(dest).size > 1000, dest);
  } finally {
    clearTimeout(killTimer);
    try { ws?.close(); } catch { /* already closed */ }
    chrome.kill("SIGKILL");
    await new Promise((resolve) => {
      if (chrome.exitCode != null || chrome.signalCode != null) resolve();
      else {
        chrome.once("exit", resolve);
        setTimeout(resolve, 3000);
      }
    });
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
