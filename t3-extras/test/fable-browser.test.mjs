// Headless Chromium shots of the Fable usage indicator. It never attaches to the live app.
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
const OUT = path.join(os.homedir(), "Library/Caches/fable-usage-indicator/build");

const THEMES = {
  dark: {
    "--background": "#171717", "--foreground": "#f5f5f4", "--muted-foreground": "#a8a29e",
    "--sidebar": "#141414", "--sidebar-foreground": "#f5f5f4", "--sidebar-muted-foreground": "#a8a29e",
    "--card": "#1c1917", "--popover": "#1c1917", "--popover-foreground": "#f5f5f4",
    "--border": "#44403c", "--warning": "#f59e0b", "--warning-foreground": "#fbbf24", "--destructive": "#ef4444",
  },
  light: {
    "--background": "#fafaf9", "--foreground": "#1c1917", "--muted-foreground": "#57534e",
    "--sidebar": "#f5f5f4", "--sidebar-foreground": "#1c1917", "--sidebar-muted-foreground": "#57534e",
    "--card": "#ffffff", "--popover": "#ffffff", "--popover-foreground": "#1c1917",
    "--border": "#e7e5e4", "--warning": "#d97706", "--warning-foreground": "#b45309", "--destructive": "#dc2626",
  },
};

// T3's own --font-sans (its app bundle), so the fixture draws at the add-ons' real 11 px font.
const APP_FONT = `-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif`;

/** The production sidebar and chip renderers, cut from extras.js, run on invented readings. */
function productionScript() {
  const src = fs.readFileSync(path.join(SRC, "public/extras.js"), "utf8");
  const cut = (from, to, start = 0) => {
    const a = src.indexOf(from, start);
    const b = src.indexOf(to, a + from.length);
    assert.ok(a >= 0 && b > a, `extras.js still has: ${from.trim()}`);
    return src.slice(a, b);
  };
  const bars = cut("    update(node, vs, now) {", "\n  };", src.indexOf("  features.bars = {"));
  const chip = cut("    update(node, vs, now) {", "\n  };", src.indexOf("  features.composer = {"));
  const measure = cut("  function makeMeasure(", "  features.bars = {");
  const key = cut("  const viewKey =", "\n");
  const driver = fs.readFileSync(new URL("./fixtures/fable-production-driver.js", import.meta.url), "utf8");
  return `<script>\n(() => {\n${driver.replace("/*MEASURE*/", () => measure).replace("/*KEY*/", () => key).replace("/*BARS*/", () => bars).replace("/*CHIP*/", () => chip)}\n})();\n</script>`;
}

function page() {
  const themeCss = Object.entries(THEMES).map(([name, vars]) =>
    `#${name} { ${Object.entries(vars).map(([k, v]) => `${k}: ${v}`).join("; ")} }`).join("\n");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/extras.css">
<style>
  :root { --font-sans: ${APP_FONT}; }
  ${themeCss}
  body { margin: 0; background: #111; font-family: system-ui, sans-serif; }
  section { padding: 12px; }
  #dark { background: #171717; color: #f5f5f4; }
  #light { background: #fafaf9; color: #1c1917; }
  .shot { display: inline-block; vertical-align: top; margin: 0 12px 12px 0; }
  .cap { font: 600 11px/1.3 system-ui, sans-serif; margin: 0 0 4px; opacity: .7; }
  .col { width: 226px; background: var(--sidebar); color: var(--sidebar-foreground); border-radius: 8px; }
  .wide { width: 360px; }
  .t3x-pop { position: static; width: 344px; }
  #nofg { --warning-foreground: initial; }
</style>
</head>
<body>
<section id="dark"></section>
<section id="light"></section>
<div id="nofg"><span class="t3x-low">Fable 8%</span></div>
<script>window.__T3X_TEST__ = {};</script>
<script src="/extras.js"></script>
<script>
const C = window.__T3X_TEST__.core;
const NOW = Date.parse("2026-10-20T02:00:00Z");
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const SVG = "http://www.w3.org/2000/svg";
function lab(opts) {
  const fetchedAt = NOW - 2 * MIN;
  const weekAt = NOW + 3 * DAY;
  const windows = [{ id: "seven_day", role: "long", kind: "weekly", label: "Weekly", usedPct: opts.week, resetsAt: weekAt, lengthSec: 7 * 86400, fetchedAt, live: true }];
  if (opts.five !== undefined) windows.push({ id: "five_hour", role: "short", kind: "session", label: "Session", usedPct: opts.five, resetsAt: NOW + 2.5 * HOUR, lengthSec: 5 * 3600, fetchedAt, live: true });
  if (opts.fable !== undefined) windows.push({ id: "seven_day_fable", role: "extra", kind: "weekly", label: "Weekly", usedPct: opts.fable, resetsAt: weekAt, lengthSec: 7 * 86400, fetchedAt, live: true });
  return {
    id: "claude", name: "Claude", colour: "#d97757", source: "t3", canonical: true, enabled: true,
    fetchedAt, live: true, hasMeter: true, windows, resetCredits: null, unavailable: null,
    verdict: { tier: "T0", tierName: "T0 normal", fableStop: opts.stop ?? null, scoped: [] },
    verdictLive: true, verdictAt: NOW - MIN,
  };
}
const view = (opts) => C.labView(lab(opts), NOW, {});
function s(name, attrs, kids) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "text") { node.textContent = v; continue; }
    node.setAttribute(k, typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v));
  }
  for (const kid of kids || []) if (kid) node.append(kid);
  return node;
}
function svgBar(v, width, height, size) {
  const g = C.bGeometry(v, width, height, size);
  const kids = [s("rect", { class: "t3x-b-track", x: g.track.x, y: g.track.y, width: g.track.w, height: g.track.h, rx: g.track.r })];
  if (g.fillW > 0) kids.push(s("rect", { class: "t3x-b-fill", x: 0, y: g.track.y, width: g.fillW, height: g.track.h, rx: g.track.r, fill: v.colour }));
  if (g.fable) {
    const f = g.fable;
    kids.push(s("rect", { class: "t3x-b-track", x: f.track.x, y: f.track.y, width: f.track.w, height: f.track.h, rx: f.track.r }));
    if (f.zero) kids.push(s("rect", { class: "t3x-b-zero", x: f.zero.x, y: f.zero.y, width: f.zero.w, height: f.zero.h, rx: 1 }));
    if (f.fillW > 0) kids.push(s("rect", { class: "t3x-b-fill", x: 0, y: f.track.y, width: f.fillW, height: f.track.h, rx: f.track.r, fill: v.colour }));
  }
  if (g.stop) kids.push(s("line", { class: "t3x-b-stop", x1: g.stop.x, x2: g.stop.x, y1: g.stop.y1, y2: g.stop.y2 }));
  if (g.needle) kids.push(s("line", { class: "t3x-b-needle", x1: g.needle.x, x2: g.needle.x, y1: g.needle.y1, y2: g.needle.y2 }));
  if (g.needleBelow) kids.push(s("line", { class: "t3x-b-needle", x1: g.needleBelow.x, x2: g.needleBelow.x, y1: g.needleBelow.y1, y2: g.needleBelow.y2 }));
  if (g.tank) {
    const t = g.tank;
    const lh = t.h * t.level;
    if (!t.twin) {
      kids.push(s("rect", { class: "t3x-b-tank", x: t.x, y: 0.5, width: t.w, height: t.h - 1, rx: t.r }));
      if (lh > 0) kids.push(s("rect", { class: "t3x-b-level" + (t.amber ? " t3x-amber" : ""), x: t.x + 1, y: t.h - 0.5 - Math.max(0, lh - 1), width: t.w - 2, height: Math.max(0, lh - 1), rx: Math.max(0, t.r - 1), fill: t.amber ? null : v.colour }));
    } else {
      kids.push(s("rect", { class: "t3x-b-tank", x: t.x, y: 0.5, width: t.w, height: t.h, rx: t.r }));
      if (lh > 1) kids.push(s("rect", { class: "t3x-b-level" + (t.amber ? " t3x-amber" : ""), x: t.x + 1, y: t.h - Math.max(0, lh - 1), width: t.w - 2, height: Math.max(0, lh - 1), rx: Math.max(0, t.r - 1), fill: t.amber ? null : v.colour }));
    }
  }
  return s("svg", { class: "t3x-b", width, height, viewBox: "0 0 " + width + " " + height }, kids);
}
function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function measureOf(host) {
  let probe = host.querySelector(":scope > .t3x-meas");
  if (!probe) { probe = h("span", "t3x-meas"); host.append(probe); }
  return (text) => { probe.textContent = text ?? ""; return probe.getBoundingClientRect().width; };
}
function fillParts(val, parts) {
  parts.forEach((p, i) => {
    if (i) val.append(document.createTextNode(" · "));
    if (p.low) val.append(h("span", "t3x-low", p.t));
    else val.append(document.createTextNode(p.t));
  });
}
function stacked(v) {
  const host = h("div", "t3x-bars");
  host.setAttribute("data-t3x", "bars");
  host.style.width = "226px";
  const bar = h("span", "t3x-bar");
  host.append(bar);
  document.body.append(host);
  const content = Math.max(80, Math.round(host.clientWidth - 16));
  const measure = measureOf(host);
  const valW = Math.max(0, content - measure(v.name) - 8);
  const parts = C.fitParts(C.sidebarCands(v, NOW), valW, measure);
  const val = h("span", "t3x-bar-val" + (parts.some((p) => p.low) ? " t3x-bar-low" : ""));
  fillParts(val, parts);
  const glyph = h("span", "t3x-bar-glyph");
  glyph.append(svgBar(v, content, 17, "md"));
  bar.append(h("span", "t3x-bar-label", v.name), val, glyph);
  return host;
}
function oneLine(v, px) {
  const host = h("div", "t3x-bars t3x-bars-c");
  host.setAttribute("data-t3x", "bars");
  host.style.width = px + "px";
  const bar = h("span", "t3x-bar");
  host.append(bar);
  document.body.append(host);
  const width = Math.max(80, Math.round(host.clientWidth - 16));
  const content = width;
  const fs = parseFloat(getComputedStyle(host).fontSize) || 11;
  const gw = Math.max(28, width - 136);
  const room = Math.max(0, content - 3.6 * fs - gw - 12);
  const measure = measureOf(host);
  const layout = C.lineLayout(v, NOW, room, measure);
  const val = h("span", "t3x-bar-val" + (layout.wrap ? " t3x-wrap" : ""));
  if (layout.wrap) {
    layout.lines.forEach((g, i) => {
      if (i) val.append(document.createTextNode(" "));
      const line = h("span", "t3x-ph");
      fillParts(line, g);
      val.append(line);
    });
  } else if (layout.parts) fillParts(val, layout.parts);
  else val.textContent = layout.text;
  const glyph = h("span", "t3x-bar-glyph");
  glyph.append(svgBar(v, gw, 12, "sm"));
  bar.append(h("span", "t3x-bar-label", v.name), glyph, val);
  val.dataset.room = String(Math.round(room));
  val.dataset.wrap = layout.wrap ? "1" : "0";
  return host;
}
function popRow(name, row) {
  const val = h("span", "t3x-row-val");
  if (row.plain) val.append(document.createTextNode(row.lead));
  else val.append(h("b", "", row.lead));
  if (row.rest) val.append(document.createTextNode(" · " + row.rest));
  if (row.second) val.append(h("div", "", row.second));
  const line = h("div", "t3x-row");
  line.append(h("span", "t3x-row-name", name), val);
  return line;
}
function popover(blocks) {
  const pop = h("div", "t3x-pop");
  const head = h("header", "t3x-pop-head");
  head.append(h("strong", "", "Usage · This Mac"), h("span", "t3x-muted", "T3 cache read 2 min ago"));
  pop.append(head);
  for (const block of blocks) pop.append(block);
  return pop;
}
function legend(v) {
  const box = h("div", "t3x-legend");
  box.append(h("div", "", C.bLegend([v])));
  box.append(h("div", "", "Strip: time across the window, height = % used. Dashed diagonal = even pace; solid = measured; faint dashes = estimated before logging; dots = projection; ✕ = estimated run-out. Lane below: the 5-hour window at its real time, filled to its own % used."));
  for (const line of C.fableLegend([v])) box.append(h("div", "", line));
  return box;
}
function forecastLines(v) {
  const box = h("div", "");
  for (const line of C.forecastBlocks(v, NOW).lines) box.append(h("div", "t3x-fc t3x-fc-" + line.kind, line.text));
  return box;
}
function bigBar(v) {
  const box = h("div", "t3x-b-big");
  box.append(svgBar(v, 312, 22, "lg"));
  return box;
}
const cases = {
  healthy: view({ week: 20, five: 38, fable: 30, stop: 90 }),
  low8: view({ week: 45, five: 38, fable: 92, stop: 90 }),
  mid14: view({ week: 45, five: 38, fable: 86, stop: 90 }),
  zero: view({ week: 45, five: 38, fable: 100, stop: 90 }),
  both: view({ week: 45, five: 96, fable: 92, stop: 90 }),
};
function mount(theme) {
  const root = document.getElementById(theme);
  const side = h("div", "shot");
  side.dataset.shot = "sidebar";
  side.append(h("div", "cap", "Sidebar"));
  const col = h("div", "col");
  for (const key of ["healthy", "low8", "mid14", "zero", "both"]) {
    const block = stacked(cases[key]);
    block.dataset.case = key;
    col.append(block);
  }
  side.append(col);
  const line = h("div", "shot");
  line.dataset.shot = "oneline";
  line.append(h("div", "cap", "One-line mode"));
  const lineCol = h("div", "col");
  lineCol.append(oneLine(cases.healthy, 226), oneLine(cases.low8, 226), oneLine(cases.zero, 226), oneLine(cases.both, 180));
  lineCol.lastElementChild.dataset.case = "wrap";
  line.append(lineCol);
  const pop = h("div", "shot");
  pop.dataset.shot = "popover";
  pop.append(h("div", "cap", "Popover"));
  const healthyFc = C.forecast(cases.healthy, NOW);
  const card = popover([
    legend(cases.healthy),
    h("h3", "", "Claude"),
    bigBar(cases.healthy),
    forecastLines(cases.healthy),
    popRow("Week", { lead: C.fmtPct(cases.healthy.lp.left) + " left", rest: "20% used · even pace " + (cases.healthy.lp.timeLeft ?? "—") + "% left · " + C.fmtReset(cases.healthy.long.resetsAt, NOW), second: null }),
    popRow("5-hour", { lead: C.fmtPct(cases.healthy.sp.left) + " left", rest: "even pace " + (cases.healthy.sp.timeLeft ?? "—") + "% left · " + C.fmtReset(cases.healthy.short.resetsAt, NOW), second: null }),
    popRow("Projection", { plain: true, lead: "about " + Math.round(healthyFc.endUsed) + "% used at reset (average since the window started)", rest: "", second: null }),
    popRow("Fable", C.scopedRowText(cases.healthy.fable, cases.healthy, NOW)),
    h("div", "cap", "At the stop"),
    forecastLines(cases.low8),
    bigBar(cases.low8),
    popRow("Fable", C.scopedRowText(cases.low8.fable, cases.low8, NOW)),
    h("div", "cap", "At zero"),
    forecastLines(cases.zero),
    bigBar(cases.zero),
    popRow("Fable", C.scopedRowText(cases.zero.fable, cases.zero, NOW)),
  ]);
  pop.append(card);
  root.append(side, line, pop);
}
mount("dark");
mount("light");
const nofg = document.getElementById("nofg");
document.getElementById("dark").append(nofg);
nofg.style.setProperty("--warning-foreground", "initial");
nofg.style.setProperty("--warning", "initial");
function rgb(css) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d");
  cx.fillStyle = "#000";
  cx.fillStyle = css || "#000";
  const hex = cx.fillStyle;
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function composite(layers) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.clearRect(0, 0, 1, 1);
  for (const [color, alpha] of layers) {
    cx.globalAlpha = alpha;
    cx.fillStyle = color;
    cx.fillRect(0, 0, 1, 1);
  }
  return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3);
}
function contrastOf(theme) {
  const root = document.getElementById(theme);
  const low = root.querySelector("[data-case=low8] .t3x-low");
  const surface = getComputedStyle(root.querySelector(".col")).backgroundColor;
  const warnCss = getComputedStyle(low).color;
  const fg = getComputedStyle(root.querySelector(".t3x-bars")).color;
  const zero = root.querySelector("[data-case=zero] .t3x-b-zero");
  const markCss = getComputedStyle(zero).fill;
  const surf = composite([[surface, 1]]);
  const track = composite([[surface, 1], [fg, 0.14]]);
  return {
    text: C.contrast(rgb(warnCss), surf),
    mark: C.contrast(rgb(markCss), track),
    warnCss, markCss,
  };
}
const cut = [...document.querySelectorAll(".t3x-bar-val")].filter((el) => {
  const clipped = getComputedStyle(el).overflow !== "visible" && el.scrollWidth > el.clientWidth + 1;
  return clipped && (el.querySelector(".t3x-low") || el.dataset.wrap === "1");
}).map((el) => el.textContent);
const wrap = document.querySelector("#dark [data-case=wrap] .t3x-bar-val");
window.__SHOTS__ = {
  cut,
  wrapText: wrap.innerText.replace(/\\s+/g, " ").trim(),
  wrapFlag: wrap.dataset.wrap,
  low8: document.querySelector("#dark [data-case=low8] .t3x-low")?.textContent ?? "",
  mid14low: Boolean(document.querySelector("#dark [data-case=mid14] .t3x-low")),
  sidebarStop: Boolean(document.querySelector("#dark [data-shot=sidebar] .t3x-b-stop")),
  popStop: Boolean(document.querySelector("#dark [data-shot=popover] .t3x-b-stop")),
  zeroMark: Boolean(document.querySelector("#dark [data-case=zero] .t3x-b-zero")),
  fableFill: document.querySelector("#dark [data-case=low8] .t3x-b-fill")?.getAttribute("fill") ?? "",
  popTracks: document.querySelectorAll("#dark [data-shot=popover] .t3x-b-big .t3x-b-track").length,
  lines: [...document.querySelectorAll("#dark [data-shot=oneline] .t3x-bar-val")].map((el) => ({ text: el.textContent, wrap: el.dataset.wrap || "0", over: el.scrollWidth > el.clientWidth + 1, overflow: getComputedStyle(el).overflow })),
  contrast: { dark: contrastOf("dark"), light: contrastOf("light") },
  noFg: getComputedStyle(document.querySelector("#nofg .t3x-low")).color,
};
</script>
${productionScript()}
</body>
</html>`;
}

/** The real renderer at the app's font: literal strings from FINAL-d33d65bc.md, and nothing cut. */
function checkProduction(prod) {
  const row = (mode, name, px = 226) => {
    const found = prod.rows.find((r) => r.mode === mode && r.name === name && r.px === px);
    assert.ok(found, `${mode} ${name} ${px}`);
    return found;
  };
  assert.match(prod.font, /11px/, "the fixture draws at the add-ons' 11 px");
  // At the board's sidebar width no value is cut off or spills out of its column, low or not.
  for (const r of prod.rows.filter((x) => x.px === 226 && !x.today && !(x.mode === "line" && x.name === "blockedOut"))) {
    assert.ok(r.scroll <= r.width + 1 && r.textLeft >= -1 && r.textRight <= r.width + 1, `${r.mode} ${r.name}: "${r.text}" ${r.scroll} px in ${r.width} px`);
  }
  // One-line mode (U4).
  assert.equal(row("line", "healthy").text, "80% · 5h 62%");
  assert.equal(row("line", "low").text, "Fable 8% left");
  assert.equal(row("line", "low").warn, true);
  assert.equal(row("line", "lowNoStop").text, "Fable 14% left");
  assert.equal(row("line", "lowNoStop").warn, false, "above the stop it is not a warning");
  for (const px of [226, 160]) {
    assert.equal(row("line", "lowNoStop", px).overflow, "visible", `a low limit is never ellipsized, warning colour or not (${px} px)`);
    assert.equal(row("line", "lowNoStop", px).text, "Fable 14% left");
  }
  const both = row("line", "both");
  assert.deepEqual(both.lines, ["5h 4%", "Fable 8% left"], "two low limits break between the limits");
  assert.equal(both.text.includes("·"), false, "no dot is left at the end of the first line");
  assert.equal(both.lineTops.length, 2);
  assert.ok(both.lineTops[1] > both.lineTops[0], "the second limit is on its own line");
  assert.equal(row("line", "fiveOnly").text, `55% · 5h 20% · ${prod.clocks.five}`);
  assert.equal(row("line", "fiveOnly").text, row("line", "fiveOnlyToday").text, "only the 5-hour window low reads exactly as today");
  assert.equal(row("line", "weekOnly").text, row("line", "weekOnlyToday").text, "only the week low reads exactly as today");
  // A low week's number never gives way (S1). W4: the week's group first, then Fable's, on one
  // line when they fit and two lines when they do not, never a third.
  assert.deepEqual(row("line", "weekAndFable").lines, ["3%", "Fable 8% left"]);
  assert.deepEqual(row("line", "allThree").lines, ["3% · 5h 4%", "Fable 8% left"]);
  assert.equal(row("line", "allThree").lineTops.length, 2);
  assert.deepEqual(row("line", "week12").lines, ["12%", "Fable 5% left"], "Fable lower than the low week: the week's line still first");
  assert.equal(row("line", "weekFableOut").text, "3% · Fable out");
  assert.deepEqual(row("line", "weekFableOut").lines, [], "the two groups share the line when they fit");
  const blockedOut = row("line", "blockedOut");
  assert.deepEqual(blockedOut.lines, ["0% · 5h blocked", "Fable out"]);
  assert.equal(blockedOut.overflow, "visible", "the week's group is not cut");
  assert.ok(blockedOut.scroll - blockedOut.width <= 4 && blockedOut.textLeft >= -4 && blockedOut.textRight <= blockedOut.width + 4, `"0% · 5h blocked" runs at most a few px past its column: ${blockedOut.scroll} in ${blockedOut.width}, ${blockedOut.textLeft} to ${blockedOut.textRight}`);
  // W1: equal shown numbers go to the broader limit.
  assert.deepEqual(row("line", "tieLow").lines, ["5h 8%", "Fable 8% left"]);
  assert.equal(row("line", "tieHealthy").text, "80% · 5h 62%");
  assert.equal(prod.chipTie, "Claude 5h 62%");
  assert.equal(prod.chipTieWeek, "Claude 62%");
  // W2: one-line mode, healthy, the approved line too wide with Fable second.
  assert.equal(row("line", "fableLowest").text, "Fable 38%", "Fable lower than the week: the week's number gives way");
  assert.equal(row("line", "fableLowest").warn, false);
  assert.equal(row("line", "weekLower").text, "30% · 5h 100%", "the week lower: today's line");
  assert.equal(row("line", "fiveTighter").text, "60% · 5h 48%");
  // W3: the two-line sidebar drops one healthy number, the less tight one.
  assert.equal(row("side", "fableLowest").text, "60% left · Fable 38%");
  assert.equal(row("side", "weekAndFable").text.startsWith("3% "), true, row("side", "weekAndFable").text);
  // The two-line sidebar (U3), at the board's width.
  assert.equal(row("side", "healthy").text, "80% left · Fable 70% · 5h 62%");
  assert.equal(row("side", "low").text, `55% · Fable 8% · ${prod.clocks.week}`, "V1: the word left gives way, the week's number and the refill time stay");
  assert.equal(row("side", "low").warn, true);
  assert.equal(row("side", "both").text, "55% · Fable 8% left · 5h 4%");
  assert.equal(row("side", "lowNoStop").overflow, "visible");
  assert.equal(row("side", "fiveOnly").shown, `55% left · 5h 20% · ${prod.clocks.five}`);
  assert.equal(row("side", "fiveOnly").shown, row("side", "fiveOnlyToday").shown, "only the 5-hour window low reads exactly as today at this width");
  // F6: the hover tooltip follows every per-model reading.
  assert.match(prod.tip.before, /Opus: 70% left/);
  assert.match(prod.tip.after, /Opus: 60% left/);
  assert.match(prod.tip.frac71, /Opus: 71% left/);
  assert.match(prod.tip.frac70, /Opus: 70% left/, "a change that moves the shown whole number refreshes the tooltip");
  assert.match(prod.tip.spoken, /Opus 70% left/);
  // F5 (U9, U10): the chip's sentence comes first; today's tooltip follows unchanged.
  assert.equal(prod.chip.text, "Claude Fable 70%");
  assert.ok(prod.chip.title.startsWith("Fable's own weekly limit, 70% left; it counts only Fable work. Most constrained measured lab right now. Claude · This Mac. Week: 80% left;"), prod.chip.title);
  assert.match(prod.chip.title, /5-hour: 80% left/);
  assert.match(prod.chip.title, /Fable: 70% left; resets /);
  assert.ok(prod.chip.title.endsWith("Click for details."));
  assert.equal(prod.chip.spoken, prod.chip.title);
  assert.equal(prod.chip.plainTitle, prod.chip.title.replace("Fable's own weekly limit, 70% left; it counts only Fable work. ", "").replace(/ Fable: 70% left; resets [^.]+\./, ""), "apart from Fable's own two sentences, today's text");
}

test("browser shots of the sidebar, one-line mode and popover", async () => {
  assert.equal(fs.existsSync(CHROME), true, "headless Chrome is installed");
  fs.mkdirSync(OUT, { recursive: true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (type, body) => { res.writeHead(200, { "content-type": type }); res.end(body); };
    if (url.pathname === "/extras.css") return send("text/css; charset=utf-8", fs.readFileSync(path.join(SRC, "public/extras.css")));
    if (url.pathname === "/extras.js") return send("text/javascript; charset=utf-8", fs.readFileSync(path.join(SRC, "public/extras.js")));
    return send("text/html; charset=utf-8", page());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fable-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`,
    "--remote-debugging-port=0", "--window-size=1400,1600", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (chunk) => { stderr += chunk; });
  const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 90_000);
  let ws;
  try {
    let wsUrl = "";
    for (let i = 0; i < 100 && !wsUrl; i++) {
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
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
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
      if (message.result?.exceptionDetails) throw new Error(JSON.stringify(message.result.exceptionDetails).slice(0, 1200));
      return message.result?.result?.value;
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1800, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    const ready = await ev(`(async () => {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        if (window.__SHOTS__) return "ready";
        await new Promise((r) => setTimeout(r, 40));
      }
      return "no shots";
    })()`);
    assert.equal(ready, "ready");
    const prod = await ev("window.__PROD__");
    fs.writeFileSync(path.join(OUT, "production.json"), JSON.stringify(prod, null, 2));
    checkProduction(prod);
    const info = await ev("window.__SHOTS__");
    assert.deepEqual(info.cut, [], "a fitted value is cut off");
    assert.equal(info.wrapFlag, "1", "both-low one-line wraps");
    assert.equal(info.wrapText.includes("·"), false, info.wrapText);
    assert.match(info.wrapText, /5h 4%/);
    assert.match(info.wrapText, /Fable 8% left/);
    assert.match(info.low8, /Fable 8%/);
    assert.equal(info.mid14low, false, "14% left is above the stop, so it is not a warning");
    assert.equal(info.sidebarStop, false, "the stop tick is not on the sidebar bar");
    assert.equal(info.popStop, true, "the stop tick is on the popover's big bar");
    assert.equal(info.zeroMark, true);
    assert.equal(info.fableFill, "#d97757", "Fable's fill stays the lab colour");
    for (const theme of ["dark", "light"]) {
      assert.ok(info.contrast[theme].text >= 4.5, `${theme} warning text ${info.contrast[theme].text.toFixed(2)}:1`);
      assert.ok(info.contrast[theme].mark >= 3, `${theme} end mark ${info.contrast[theme].mark.toFixed(2)}:1 against the track`);
    }
    fs.writeFileSync(path.join(OUT, "contrast.json"), JSON.stringify({ contrast: info.contrast, noFg: info.noFg, wrapText: info.wrapText }, null, 2));
    for (const theme of ["dark", "light"]) {
      for (const name of ["sidebar", "oneline", "popover"]) {
        const clip = await ev(`(() => { const b = document.querySelector("#${theme} [data-shot=${name}]").getBoundingClientRect(); return { x: b.x, y: b.y, width: Math.ceil(b.width), height: Math.ceil(b.height), scale: 1 }; })()`);
        const picture = await send("Page.captureScreenshot", { format: "png", clip });
        fs.writeFileSync(path.join(OUT, `${name}-${theme}.png`), Buffer.from(picture.result.data, "base64"));
      }
    }
  } finally {
    clearTimeout(killTimer);
    try { ws?.close(); } catch { /* already closed */ }
    chrome.kill("SIGTERM");
    server.close();
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the profile can outlive the process */ }
  }
});
