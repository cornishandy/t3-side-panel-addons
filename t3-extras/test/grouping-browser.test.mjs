// Headless Chromium fixture. It never attaches to the live T3 app.
// Representative shots use the real control height. Scroll stress is a separate 80-row case.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// T3 updates its headless Chrome in place (154 → 156 …); use the newest installed version.
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
const ENV = "localenv01";

function page(base) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* Functional harness only. Not default app-sidebar tokens and not a captured user theme. */
  :root { --foreground: #f4f1ea; --border: #666; --sidebar: #161616; --background: #161616; color-scheme: dark; }
  body { margin: 0; background: #161616; color: #f4f1ea; font: 14px/1.4 system-ui, sans-serif; }
  #column { width: 280px; }
  [data-slot="sidebar-inner"] { width: 100%; height: 640px; display: flex; flex-direction: column; background: #161616; }
  [data-slot="sidebar-content"] { overflow: auto; height: 460px; }
  ul { margin: 0; padding: 0; list-style: none; }
  .native-row { padding: 8px; min-height: 28px; }
  textarea { width: 260px; margin: 8px; }
</style>
<link rel="stylesheet" href="/grouping.css">
</head>
<body>
<div id="column">
  <div data-slot="sidebar-inner">
    <input aria-label="Search threads" role="combobox" value="">
    <button type="button" aria-label="Filter threads by project">Projects</button>
    <div data-slot="sidebar-content">
      <ul>
        <li class="native-row" data-thread-item="${ENV}:thread-questions">Questions thread native</li>
        <li class="native-row slim" data-thread-item="${ENV}:thread-running">Running native</li>
        <li class="native-row thread-row-compact" data-thread-item="true">Compact native</li>
      </ul>
    </div>
  </div>
  <textarea id="composer">keep this text</textarea>
</div>
<script>
  localStorage.setItem("t3x:grouping:v1", JSON.stringify({ v: 1, mode: "activity", sort: "recent", collapsed: {} }));
  window.t3xGroupingBase = ${JSON.stringify(base)};
  window.t3xGroupingExpose = true;
  window.t3xTeardown = function () { window.__sentinel = (window.__sentinel || 0) + 1; };
  location.hash = "#/${ENV}/thread-questions";
  window.__viewBox = (el) => {
    const scroller = document.querySelector('[data-slot="sidebar-content"]');
    const view = scroller.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const iw = Math.min(b.right, view.right) - Math.max(b.left, view.left);
    const ih = Math.min(b.bottom, view.bottom) - Math.max(b.top, view.top);
    return { w: b.width, h: b.height, iw, ih, top: b.top - view.top, text: (el.textContent || "").trim() };
  };
  window.__reachAll = () => {
    const scroller = document.querySelector('[data-slot="sidebar-content"]');
    const nodes = [...scroller.querySelectorAll("[data-thread-id], [data-t3x-g-toggle], #t3x-g-mode, #t3x-g-sort, [data-t3x-g-native]")];
    const missed = [];
    for (const node of nodes) {
      node.scrollIntoView({ block: "nearest" });
      const box = window.__viewBox(node);
      if (!(box.w > 1 && box.h > 1 && box.iw > 1 && box.ih > 1)) {
        missed.push(node.getAttribute("data-thread-id") || node.getAttribute("data-t3x-g-toggle") || node.id || "native");
      }
    }
    return { missed, count: nodes.length, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
  };
</script>
<script src="/grouping.js"></script>
</body>
</html>`;
}

function canned() {
  const asOf = Date.now();
  const thread = (extra) => ({
    projectId: "proj-alpha", projectLabel: "Alpha", createdAt: asOf - 86400000,
    activityAt: asOf - 3600000, activitySource: "run", recentBucket: "today",
    activity: "open", activityLabel: "Other open threads", badges: [], shelf: "main",
    detail: "No recorded blocker in this database snapshot. This is not Ready, Idle or Finished.",
    ...extra,
  });
  return {
    ok: true, unavailable: false, reason: null, asOf, localEnvironmentId: ENV, source: "v2",
    coverage: { eligible: 9, returned: 9, truncated: false, cap: 1000, omittedUnsafeIds: 0, childLinksTruncated: false, factsIncomplete: false },
    threads: [
      thread({ id: "thread-questions", title: "Needs a recorded answer", activity: "questions", activityLabel: "Questions & approvals", recentBucket: "m15", activityAt: asOf - 60000, badges: ["Recorded question"], detail: "Recorded request in this database snapshot. A snapshot is not a live callback." }),
      thread({ id: "thread-running", title: "Run still going", projectId: "proj-beta", projectLabel: "Beta", activity: "running", activityLabel: "Run in progress", recentBucket: "m60", activityAt: asOf - 1800000, detail: "Recorded run is preparing, starting, running or waiting. This is not the Working shelf." }),
      thread({ id: "thread-child", title: "Child still recorded", activity: "child", activityLabel: "Child work recorded", recentBucket: "today", detail: "Child work recorded from a subagent status or child run, at most two levels. This is not the Waiting shelf." }),
      thread({ id: "thread-alpha", title: "Alpha open thread", activityAt: asOf - 90000000, recentBucket: "yesterday" }),
      thread({ id: "thread-bravo", title: "Bravo open thread", projectId: "proj-beta", projectLabel: "Beta", activityAt: asOf - 2000, recentBucket: "m15" }),
      thread({ id: "thread-markup", title: "<img src=x onerror=alert(1)>", recentBucket: "week", activityAt: asOf - 3 * 86400000 }),
      thread({ id: "thread-pinned", title: "Pinned note", shelf: "pinned" }),
      thread({ id: "thread-snoozed", title: "Snoozed note", shelf: "snoozed", recentBucket: "older" }),
      thread({ id: "thread-settled", title: "Settled note", shelf: "settled", recentBucket: "older" }),
    ],
  };
}

function rows80(activityFor040 = "open") {
  const asOf = Date.now();
  const threads = [];
  for (let i = 0; i < 80; i++) {
    const id = `focus-${String(i).padStart(3, "0")}`;
    const running = i === 40 && activityFor040 === "running";
    threads.push({
      id, title: `Row ${String(i).padStart(3, "0")}`,
      projectId: "proj-alpha", projectLabel: "Alpha", createdAt: asOf - 86400000,
      activityAt: asOf - 3600000 - i * 1000, activitySource: "run", recentBucket: "today",
      activity: running ? "running" : "open",
      activityLabel: running ? "Run in progress" : "Other open threads",
      badges: [], shelf: "main",
      detail: "No recorded blocker in this database snapshot. This is not Ready, Idle or Finished.",
    });
  }
  return {
    ok: true, unavailable: false, reason: null, asOf, localEnvironmentId: ENV, source: "v2",
    coverage: { eligible: 80, returned: 80, truncated: false, cap: 1000, omittedUnsafeIds: 0, childLinksTruncated: false, factsIncomplete: false },
    threads,
  };
}

test("grouped sidebar in a headless browser", { timeout: 120_000 }, async () => {
  assert.equal(fs.existsSync(CHROME), true, `missing ${CHROME}`);
  fs.mkdirSync(OUT, { recursive: true });
  const shots = {};
  const evidence = {};
  let indexOverride = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (type, body) => {
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    const asset = (name) => {
      try {
        return fs.readFileSync(path.join(SRC, "public", name));
      } catch (error) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(String(error?.code || "missing"));
        return null;
      }
    };
    if (url.pathname === "/grouping.js") {
      const body = asset("grouping.js");
      if (body) send("text/javascript; charset=utf-8", body);
      return;
    }
    if (url.pathname === "/grouping.css") {
      const body = asset("grouping.css");
      if (body) send("text/css; charset=utf-8", body);
      return;
    }
    if (url.pathname === "/ok/grouping") return send("application/json", JSON.stringify(indexOverride || canned()));
    if (url.pathname === "/bad/grouping") return send("application/json", JSON.stringify({ ok: false, unavailable: true, reason: "read", threads: null, coverage: null, asOf: Date.now(), localEnvironmentId: ENV, source: "v2" }));
    if (url.pathname === "/bad.html") return send("text/html; charset=utf-8", page("/bad/"));
    return send("text/html; charset=utf-8", page("/ok/"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  fs.mkdirSync(path.join(OUT_ROOT, "tmp"), { recursive: true });
  const profile = fs.mkdtempSync(path.join(OUT_ROOT, "tmp", "chprof-"));
  const chrome = spawn(CHROME, [
    "--headless", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`,
    "--remote-debugging-port=0", "--window-size=1280,860", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (chunk) => { stderr += chunk; });
  const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 110_000);
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
    const exceptions = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method === "Runtime.exceptionThrown") {
        exceptions.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? "exception");
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
    const shot = async (name) => {
      const clip = await ev(`(() => { const b = document.querySelector("#column")?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, width: Math.max(1, b.width), height: Math.max(1, b.height), scale: 1 } : null; })()`);
      const picture = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
      const dest = path.join(OUT, name);
      fs.writeFileSync(dest, Buffer.from(picture.result.data, "base64"));
      shots[name] = dest;
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    const ready = await ev(`(async () => {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        if (document.querySelector('[data-t3x="grouping-root"][data-ready="1"]')) return "ready";
        await new Promise((r) => setTimeout(r, 50));
      }
      return document.querySelector(".t3x-g-status")?.textContent || "no root";
    })()`);
    assert.equal(ready, "ready");
    const structure = await ev(`(() => {
      const root = document.querySelector('[data-t3x="grouping-root"]');
      const content = document.querySelector('[data-slot="sidebar-content"]');
      content.scrollTop = 0;
      const rows = [...document.querySelectorAll(".native-row")];
      const box = document.querySelector("#composer");
      box.focus();
      box.setSelectionRange(2, 5);
      return {
        first: content.firstElementChild === root,
        rowParents: rows.map((row) => row.parentElement.tagName),
        scope: document.querySelector(".t3x-g-scope")?.textContent,
        scopeTitle: document.querySelector(".t3x-g-scope")?.title,
        note: document.querySelector(".t3x-g-note")?.textContent,
        questions: document.querySelector('[data-group="questions"] .t3x-g-long')?.textContent,
        current: document.querySelector('[aria-current="page"]')?.getAttribute("data-thread-id"),
        markupImg: document.querySelector('[data-thread-id="thread-markup"] img') ? true : false,
        markupText: document.querySelector('[data-thread-id="thread-markup"] .t3x-g-title')?.textContent,
        snoozedOpen: document.querySelector('[data-t3x-g-toggle="snoozed"]')?.getAttribute("aria-expanded"),
        snoozedLink: Boolean(document.querySelector('[data-thread-id="thread-snoozed"]')),
        settledOpen: document.querySelector('[data-t3x-g-toggle="settled"]')?.getAttribute("aria-expanded"),
        selectHeight: document.querySelector("#t3x-g-mode")?.getBoundingClientRect().height,
        color: getComputedStyle(root).color,
        options: [...document.querySelectorAll("#t3x-g-mode option")].map((option) => [option.textContent, option.getAttribute("aria-label")]),
        sorts: [...document.querySelectorAll("#t3x-g-sort option")].map((option) => [option.textContent, option.getAttribute("aria-label")]),
        scroll: content.scrollTop,
        forcedHeight: getComputedStyle(root).minHeight,
      };
    })()`);
    assert.equal(structure.first, true);
    assert.deepEqual(structure.rowParents, ["UL", "UL", "UL"]);
    assert.equal(structure.scope, "This Mac · top-level threads");
    assert.match(structure.scopeTitle, /two levels/);
    assert.match(structure.scopeTitle, /no pull-request wait/);
    assert.match(structure.note, /two levels/);
    assert.match(structure.note, /no pull-request wait/);
    assert.equal(structure.questions, "Questions & approvals");
    assert.equal(structure.current, "thread-questions");
    assert.equal(structure.markupImg, false);
    assert.equal(structure.markupText, "<img src=x onerror=alert(1)>");
    assert.equal(structure.snoozedOpen, "false");
    assert.equal(structure.snoozedLink, false);
    assert.equal(structure.settledOpen, "false");
    assert.ok(structure.selectHeight >= 24);
    assert.match(structure.color, /244/);
    assert.deepEqual(structure.options, [["Native shelves", "Native shelves"], ["Activity", "Activity"], ["Recent runs", "Recent run activity"], ["Project", "Project"]]);
    assert.deepEqual(structure.sorts, [["Recent runs", "Recent run activity"], ["Title", "Title"], ["Created", "Created"]]);
    assert.equal(structure.scroll, 0);
    assert.ok(structure.forcedHeight === "0px" || structure.forcedHeight === "auto", structure.forcedHeight);
    await shot("activity.png");
    const reached = await ev(`window.__reachAll()`);
    evidence.representativeReach = reached;
    assert.deepEqual(reached.missed, []);
    assert.ok(reached.count >= 9);
    const bottom = await ev(`(() => {
      const scroller = document.querySelector('[data-slot="sidebar-content"]');
      scroller.scrollTop = scroller.scrollHeight;
      const box = window.__viewBox(document.querySelector('[data-t3x-g-toggle="settled"]'));
      return { scroll: scroller.scrollTop, ih: box.ih, h: box.h, overflow: scroller.scrollHeight > scroller.clientHeight + 1 };
    })()`);
    evidence.activityBottom = bottom;
    assert.ok(bottom.ih > 1, JSON.stringify(bottom));
    await shot("activity-bottom.png");
    await ev(`document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0`);
    const sorted = await ev(`(() => {
      const sort = document.querySelector("#t3x-g-sort");
      sort.value = "title";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
      const box = document.querySelector("#composer");
      const open = [...document.querySelectorAll('[data-group="open"] a')].map((link) => link.getAttribute("data-thread-id"));
      return {
        open, value: box.value, start: box.selectionStart, end: box.selectionEnd,
        focused: document.activeElement?.id, scroll: document.querySelector('[data-slot="sidebar-content"]').scrollTop,
      };
    })()`);
    assert.ok(sorted.open.indexOf("thread-alpha") < sorted.open.indexOf("thread-bravo"));
    assert.equal(sorted.open.length, 3);
    assert.equal(sorted.value, "keep this text");
    assert.equal(sorted.start, 2);
    assert.equal(sorted.end, 5);
    assert.equal(sorted.focused, "composer");
    assert.equal(sorted.scroll, 0);
    await ev(`(() => { const mode = document.querySelector("#t3x-g-mode"); mode.value = "recent"; mode.dispatchEvent(new Event("change", { bubbles: true })); return document.querySelector('[data-group="m15"] .t3x-g-long')?.textContent; })()`);
    const recent = await ev(`document.querySelector('[data-group="m15"] .t3x-g-long')?.textContent`);
    assert.equal(recent, "Last 15 minutes");
    await ev(`document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0`);
    await shot("recent.png");
    await ev(`(() => { const mode = document.querySelector("#t3x-g-mode"); mode.value = "project"; mode.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    const project = await ev(`document.querySelector(".t3x-g-note")?.textContent`);
    assert.match(project, /Project \(local paths\)/);
    await ev(`document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0`);
    await shot("project.png");
    const narrow = await ev(`(() => {
      document.querySelector("#column").style.width = "140px";
      const mode = document.querySelector("#t3x-g-mode");
      mode.value = "activity";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      const short = document.querySelector('[data-group="questions"] .t3x-g-short');
      const long = document.querySelector('[data-group="questions"] .t3x-g-long');
      const count = document.querySelector('[data-group="questions"] .t3x-g-count');
      const words = [...document.querySelectorAll(".t3x-g-word")].map((el) => window.__viewBox(el));
      const native = document.querySelector("[data-t3x-g-native]");
      const nativeBox = window.__viewBox(native);
      return {
        short: getComputedStyle(short).display, text: short.textContent, long: getComputedStyle(long).display, count: count.textContent,
        words, native: { ...nativeBox, clip: native.scrollWidth - native.clientWidth },
        shortClip: short.scrollWidth - short.parentElement.clientWidth,
        bar: getComputedStyle(document.querySelector(".t3x-g-bar")).flexDirection,
      };
    })()`);
    assert.equal(narrow.short, "block");
    assert.equal(narrow.text, "Questions / approvals");
    assert.equal(narrow.long, "none");
    assert.equal(narrow.count, "1");
    assert.equal(narrow.bar, "column");
    assert.ok(narrow.words.some((word) => word.text === "Group" && word.iw > 8 && word.ih > 8), JSON.stringify(narrow.words));
    assert.ok(narrow.words.some((word) => word.text === "Sort" && word.iw > 8 && word.ih > 8), JSON.stringify(narrow.words));
    assert.ok(narrow.native.iw > 20 && narrow.native.ih > 16, JSON.stringify(narrow.native));
    assert.match(narrow.native.text, /Native/);
    assert.ok(narrow.native.clip <= 2, JSON.stringify(narrow.native));
    assert.ok(narrow.shortClip <= 2, JSON.stringify(narrow));
    await shot("narrow.png");
    const narrowBottom = await ev(`(() => {
      const scroller = document.querySelector('[data-slot="sidebar-content"]');
      scroller.scrollTop = scroller.scrollHeight;
      return window.__viewBox(document.querySelector('[data-t3x-g-toggle="settled"]'));
    })()`);
    assert.ok(narrowBottom.ih > 1, JSON.stringify(narrowBottom));
    await shot("narrow-bottom.png");
    await ev(`document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0`);
    const recentNarrow = await ev(`(() => {
      const mode = document.querySelector("#t3x-g-mode");
      mode.value = "recent";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      const option = [...mode.options].find((item) => item.value === "recent");
      const sort = document.querySelector("#t3x-g-sort");
      const sortOption = [...sort.options].find((item) => item.value === "recent");
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      return {
        option: option.textContent, optionName: option.getAttribute("aria-label"),
        sort: sortOption.textContent, sortName: sortOption.getAttribute("aria-label"),
        mode: window.__viewBox(mode), full: mode.clientWidth >= mode.parentElement.clientWidth - 4,
      };
    })()`);
    assert.equal(recentNarrow.option, "Recent runs");
    assert.equal(recentNarrow.optionName, "Recent run activity");
    assert.equal(recentNarrow.sort, "Recent runs");
    assert.equal(recentNarrow.sortName, "Recent run activity");
    assert.ok(recentNarrow.mode.iw > 40 && recentNarrow.mode.ih >= 24, JSON.stringify(recentNarrow));
    assert.equal(recentNarrow.full, true);
    await shot("recent-140.png");
    await ev(`(() => { const mode = document.querySelector("#t3x-g-mode"); mode.value = "project"; mode.dispatchEvent(new Event("change", { bubbles: true })); document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0; })()`);
    await shot("project-140.png");
    const choiceFit = await ev(`(() => {
      const measure = (select) => {
        const option = select.selectedOptions[0];
        const probe = document.createElement("span");
        probe.textContent = option.textContent;
        const font = getComputedStyle(select).font;
        probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font:" + font;
        document.body.append(probe);
        const text = probe.getBoundingClientRect().width;
        probe.remove();
        const box = select.getBoundingClientRect().width;
        return {
          visible: option.textContent,
          accessible: option.getAttribute("aria-label"),
          text, box,
          fits: text + 18 <= box,
        };
      };
      const mode = document.querySelector("#t3x-g-mode");
      const sort = document.querySelector("#t3x-g-sort");
      const rows = [];
      for (const width of [140, 200, 280]) {
        document.querySelector("#column").style.width = width + "px";
        for (const option of [...mode.options]) {
          mode.value = option.value;
          mode.dispatchEvent(new Event("change", { bubbles: true }));
          rows.push({ control: "group", width, ...measure(mode) });
        }
        for (const option of [...sort.options]) {
          sort.value = option.value;
          sort.dispatchEvent(new Event("change", { bubbles: true }));
          rows.push({ control: "sort", width, ...measure(sort) });
        }
      }
      return rows;
    })()`);
    assert.equal(choiceFit.length, 21, JSON.stringify(choiceFit.length));
    for (const row of choiceFit) {
      assert.equal(row.fits, true, JSON.stringify(row));
      assert.equal(row.accessible, row.visible === "Recent runs" ? "Recent run activity" : row.visible, JSON.stringify(row));
    }
    await ev(`(() => {
      document.querySelector("#column").style.width = "280px";
      const mode = document.querySelector("#t3x-g-mode");
      mode.value = "activity";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      const sort = document.querySelector("#t3x-g-sort");
      sort.value = "recent";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      document.querySelector("#composer").focus();
    })()`);

    indexOverride = rows80("open");
    const placed = await ev(`(async () => {
      window.t3xGrouping.requestRefresh();
      const start = Date.now();
      while (Date.now() - start < 5000 && document.querySelectorAll('[data-thread-id^="focus-"]').length < 80) await new Promise((r) => setTimeout(r, 30));
      await new Promise((r) => setTimeout(r, 150));
      const sort = document.querySelector("#t3x-g-sort");
      sort.value = "title";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
      const link = document.querySelector('[data-thread-id="focus-040"]');
      const scroller = document.querySelector('[data-slot="sidebar-content"]');
      link.focus();
      scroller.scrollTop += link.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 80;
      const y = link.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      return { y, scroll: scroller.scrollTop, group: link.closest("[data-group]")?.getAttribute("data-group"), focused: document.activeElement?.getAttribute("data-thread-id"), count: document.querySelectorAll('[data-thread-id^="focus-"]').length };
    })()`);
    evidence.placed = placed;
    assert.equal(placed.count, 80, JSON.stringify(placed));
    assert.equal(placed.group, "open");
    assert.equal(placed.focused, "focus-040");
    assert.ok(Math.abs(placed.y - 80) < 2, JSON.stringify(placed));
    const moved = rows80("running");
    indexOverride = moved;
    const deferred = await ev(`(async () => {
      const before = document.querySelector('[data-t3x="grouping-root"]').dataset.asof;
      window.t3xGrouping.requestRefresh();
      const start = Date.now();
      const root = document.querySelector('[data-t3x="grouping-root"]');
      while (Date.now() - start < 4000 && root.dataset.asof === before) await new Promise((r) => setTimeout(r, 30));
      const link = document.querySelector('[data-thread-id="focus-040"]');
      const scroller = document.querySelector('[data-slot="sidebar-content"]');
      return {
        asof: root.dataset.asof, y: link.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
        scroll: scroller.scrollTop, group: link.closest("[data-group]")?.getAttribute("data-group"),
        focused: document.activeElement?.getAttribute("data-thread-id"),
        running: Boolean(document.querySelector('[data-group="running"] [data-thread-id="focus-040"]')),
      };
    })()`);
    evidence.deferred = deferred;
    assert.equal(deferred.asof, String(moved.asOf));
    assert.equal(deferred.group, "open");
    assert.equal(deferred.focused, "focus-040");
    assert.equal(deferred.running, false);
    assert.ok(Math.abs(deferred.y - placed.y) < 2, JSON.stringify({ placed, deferred }));
    assert.equal(deferred.scroll, placed.scroll);

    const anchorBody = rows80("open");
    for (let i = 0; i < 12; i++) {
      anchorBody.threads.push({
        id: `aaa-${i}`, title: `AAA ${String(i).padStart(2, "0")}`,
        projectId: "proj-alpha", projectLabel: "Alpha", createdAt: anchorBody.asOf - 86400000,
        activityAt: anchorBody.asOf - 7200000, activitySource: "run", recentBucket: "today",
        activity: "open", activityLabel: "Other open threads", badges: [], shelf: "main",
        detail: "No recorded blocker in this database snapshot. This is not Ready, Idle or Finished.",
      });
    }
    anchorBody.coverage.eligible = anchorBody.threads.length;
    anchorBody.coverage.returned = anchorBody.threads.length;
    indexOverride = rows80("open");
    const anchorBefore = await ev(`(async () => {
      document.querySelector("#composer").focus();
      await new Promise((r) => setTimeout(r, 40));
      window.t3xGrouping.requestRefresh();
      const start = Date.now();
      while (Date.now() - start < 5000 && document.querySelector('[data-thread-id="focus-040"]')?.closest("[data-group]")?.getAttribute("data-group") !== "open") await new Promise((r) => setTimeout(r, 30));
      const sort = document.querySelector("#t3x-g-sort");
      sort.value = "title";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
      const link = document.querySelector('[data-thread-id="focus-070"]');
      const scroller = document.querySelector('[data-slot="sidebar-content"]');
      scroller.scrollTop += link.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 80;
      return { y: link.getBoundingClientRect().top - scroller.getBoundingClientRect().top, scroll: scroller.scrollTop, asof: document.querySelector('[data-t3x="grouping-root"]').dataset.asof };
    })()`);
    indexOverride = anchorBody;
    const anchorAfter = await ev(`(async () => {
      const before = document.querySelector('[data-t3x="grouping-root"]').dataset.asof;
      window.t3xGrouping.requestRefresh();
      const start = Date.now();
      const root = document.querySelector('[data-t3x="grouping-root"]');
      while (Date.now() - start < 4000 && (root.dataset.asof === before || !document.querySelector('[data-thread-id="aaa-0"]'))) await new Promise((r) => setTimeout(r, 30));
      const link = document.querySelector('[data-thread-id="focus-070"]');
      const scroller = document.querySelector('[data-slot="sidebar-content"]');
      return {
        y: link.getBoundingClientRect().top - scroller.getBoundingClientRect().top, scroll: scroller.scrollTop,
        focused: document.activeElement?.id, aaa: Boolean(document.querySelector('[data-thread-id="aaa-0"]')),
      };
    })()`);
    evidence.anchor = { before: anchorBefore, after: anchorAfter };
    assert.ok(Math.abs(anchorBefore.y - 80) < 2, JSON.stringify(anchorBefore));
    assert.equal(anchorAfter.aaa, true);
    assert.equal(anchorAfter.focused, "composer");
    assert.ok(Math.abs(anchorAfter.y - anchorBefore.y) < 2, JSON.stringify(evidence.anchor));
    assert.ok(anchorAfter.scroll > anchorBefore.scroll + 20, JSON.stringify(evidence.anchor));

    const settledBody = rows80("open");
    settledBody.threads.find((row) => row.id === "focus-010").shelf = "settled";
    indexOverride = rows80("open");
    const settledFocus = await ev(`(async () => {
      window.t3xGrouping.requestRefresh();
      const start = Date.now();
      while (Date.now() - start < 5000 && document.querySelectorAll('[data-thread-id^="focus-"]').length < 80) await new Promise((r) => setTimeout(r, 30));
      const link = document.querySelector('[data-thread-id="focus-010"]');
      link.focus();
      return { focused: document.activeElement?.getAttribute("data-thread-id"), group: link.closest("[data-group]")?.getAttribute("data-group") };
    })()`);
    assert.equal(settledFocus.focused, "focus-010");
    assert.equal(settledFocus.group, "open");
    indexOverride = settledBody;
    const settledHeld = await ev(`(async () => {
      const before = document.querySelector('[data-t3x="grouping-root"]').dataset.asof;
      window.t3xGrouping.requestRefresh();
      const start = Date.now();
      const root = document.querySelector('[data-t3x="grouping-root"]');
      while (Date.now() - start < 4000 && root.dataset.asof === before) await new Promise((r) => setTimeout(r, 30));
      const link = document.querySelector('[data-thread-id="focus-010"]');
      return { focused: document.activeElement?.getAttribute("data-thread-id"), group: link?.closest("[data-group]")?.getAttribute("data-group"), present: Boolean(link) };
    })()`);
    evidence.settledHeld = settledHeld;
    assert.equal(settledHeld.present, true);
    assert.equal(settledHeld.focused, "focus-010");
    assert.equal(settledHeld.group, "open");
    const settledAfter = await ev(`(async () => {
      document.querySelector("#composer").focus();
      await new Promise((r) => setTimeout(r, 40));
      return {
        present: Boolean(document.querySelector('[data-thread-id="focus-010"]')),
        focused: document.activeElement?.id,
        open: document.querySelector('[data-t3x-g-toggle="settled"]')?.getAttribute("aria-expanded"),
      };
    })()`);
    evidence.settledAfter = settledAfter;
    assert.equal(settledAfter.present, false, JSON.stringify(settledAfter));
    assert.equal(settledAfter.focused, "composer");
    assert.equal(settledAfter.open, "false");

    indexOverride = rows80("open");
    const stressReach = await ev(`(async () => {
      document.querySelector("#composer").focus();
      window.t3xGrouping.requestRefresh();
      const start = Date.now();
      while (Date.now() - start < 5000 && document.querySelectorAll('[data-thread-id^="focus-"]').length < 80) await new Promise((r) => setTimeout(r, 30));
      return window.__reachAll();
    })()`);
    evidence.stressReach = { missed: stressReach.missed, count: stressReach.count, scrollHeight: stressReach.scrollHeight, clientHeight: stressReach.clientHeight };
    assert.deepEqual(stressReach.missed, [], JSON.stringify(stressReach.missed));
    assert.ok(stressReach.count >= 80);
    assert.ok(stressReach.scrollHeight > stressReach.clientHeight + 40);

    indexOverride = null;
    const restored = await ev(`(async () => {
      document.querySelector("#column").style.width = "280px";
      const mode = document.querySelector("#t3x-g-mode");
      mode.value = "activity";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      const sort = document.querySelector("#t3x-g-sort");
      sort.value = "recent";
      sort.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("#composer").focus();
      window.t3xGrouping.requestRefresh();
      const start = Date.now();
      while (Date.now() - start < 5000 && !document.querySelector('[data-thread-id="thread-questions"]')) await new Promise((r) => setTimeout(r, 30));
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      return document.querySelector('[data-t3x="grouping-root"]')?.getAttribute("data-ready");
    })()`);
    assert.equal(restored, "1");

    const hosts = await ev(`(async () => {
      const mode = document.querySelector("#t3x-g-mode");
      mode.value = "native";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      const start = Date.now();
      while (Date.now() - start < 2000 && !document.querySelector(".t3x-g-status")?.textContent?.includes("Native shelves")) await new Promise((r) => setTimeout(r, 30));
      const results = [];
      for (const kind of ["card", "slim", "compact"]) {
        const inner = document.querySelector('[data-slot="sidebar-inner"]');
        const old = inner.querySelector('[data-slot="sidebar-content"]');
        const neu = document.createElement("div");
        neu.setAttribute("data-slot", "sidebar-content");
        neu.dataset.layout = kind;
        const ul = document.createElement("ul");
        const li = document.createElement("li");
        li.className = kind === "slim" ? "native-row slim" : kind === "compact" ? "native-row thread-row-compact" : "native-row";
        li.setAttribute("data-thread-item", kind === "compact" ? "true" : "${ENV}:thread-questions");
        li.textContent = kind + " native row";
        ul.append(li);
        neu.append(ul);
        old.replaceWith(neu);
        const began = Date.now();
        let ok = false;
        while (Date.now() - began < 1500) {
          const root = document.querySelector('[data-t3x="grouping-root"]');
          if (root && root.parentElement === neu && neu.querySelector("#t3x-g-mode")) { ok = true; break; }
          await new Promise((r) => setTimeout(r, 40));
        }
        const root = document.querySelector('[data-t3x="grouping-root"]');
        results.push({ kind, ok, ms: Date.now() - began, mode: neu.querySelector("#t3x-g-mode")?.value || "", roots: document.querySelectorAll('[data-t3x="grouping-root"]').length, parent: root?.parentElement?.dataset?.layout || "" });
      }
      return results;
    })()`);
    evidence.hosts = hosts;
    assert.equal(hosts.length, 3);
    for (const host of hosts) {
      assert.equal(host.ok, true, JSON.stringify(host));
      assert.equal(host.mode, "native", JSON.stringify(host));
      assert.equal(host.roots, 1, JSON.stringify(host));
      assert.equal(host.parent, host.kind, JSON.stringify(host));
    }

    const back = await ev(`(async () => {
      const mode = document.querySelector("#t3x-g-mode");
      mode.value = "activity";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      const start = Date.now();
      while (Date.now() - start < 4000 && document.querySelector('[data-t3x="grouping-root"]')?.getAttribute("data-ready") !== "1") await new Promise((r) => setTimeout(r, 30));
      document.querySelector("#column").style.width = "280px";
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      return document.querySelector('[data-thread-id="thread-questions"]') ? "ready" : document.querySelector(".t3x-g-status")?.textContent;
    })()`);
    assert.equal(back, "ready");

    const search = await ev(`(() => {
      document.querySelector("#column").style.width = "280px";
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      const input = document.querySelector('[aria-label="Search threads"]');
      input.value = "hello";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const list = document.querySelector('[data-slot="sidebar-content"] ul');
      const native = [...document.querySelectorAll(".native-row")].map((row) => window.__viewBox(row));
      const controls = ["#t3x-g-mode", "#t3x-g-sort", "[data-t3x-g-native]"].map((sel) => window.__viewBox(document.querySelector(sel)));
      return {
        attr: document.documentElement.getAttribute("data-t3x-grouping"),
        ready: document.querySelector('[data-t3x="grouping-root"]').hasAttribute("data-ready"),
        display: getComputedStyle(list).display,
        status: document.querySelector(".t3x-g-status").textContent,
        stillThere: Boolean(document.querySelector(".native-row")),
        native, controls,
      };
    })()`);
    assert.equal(search.attr, null);
    assert.equal(search.ready, false);
    assert.notEqual(search.display, "none");
    assert.match(search.status, /Search is active/);
    assert.equal(search.stillThere, true);
    assert.ok(search.native.length >= 1 && search.native.every((box) => box.iw > 8 && box.ih > 8), JSON.stringify(search.native));
    assert.ok(search.controls.every((box) => box.iw > 8 && box.ih > 8), JSON.stringify(search.controls));
    await shot("fallback-search.png");
    await ev(`document.querySelector("#column").style.width = "140px"`);
    const searchNarrow = await ev(`(() => {
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      const native = [...document.querySelectorAll(".native-row")].map((row) => window.__viewBox(row));
      const controls = ["#t3x-g-mode", "#t3x-g-sort", "[data-t3x-g-native]"].map((sel) => window.__viewBox(document.querySelector(sel)));
      return { native, controls };
    })()`);
    assert.ok(searchNarrow.native.every((box) => box.iw > 8 && box.ih > 8), JSON.stringify(searchNarrow.native));
    assert.ok(searchNarrow.controls.every((box) => box.iw > 8 && box.ih > 8), JSON.stringify(searchNarrow.controls));
    await shot("fallback-search-140.png");
    await ev(`document.querySelector("#column").style.width = "280px"`);
    const filter = await ev(`(async () => {
      const input = document.querySelector('[aria-label="Search threads"]');
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const start = Date.now();
      while (Date.now() - start < 3000 && !document.querySelector('[data-ready="1"]')) await new Promise((r) => setTimeout(r, 50));
      document.querySelector('[aria-label="Filter threads by project"]').setAttribute("aria-label", "Filter threads by project: Toy");
      const again = Date.now();
      while (Date.now() - again < 2000 && document.documentElement.getAttribute("data-t3x-grouping") === "active") await new Promise((r) => setTimeout(r, 50));
      const status = document.querySelector(".t3x-g-status").textContent;
      const native = [...document.querySelectorAll(".native-row")].map((row) => window.__viewBox(row));
      document.querySelector('[aria-label^="Filter threads by project"]').setAttribute("aria-label", "Filter threads by project");
      const backAt = Date.now();
      while (Date.now() - backAt < 3000 && !document.querySelector('[data-ready="1"]')) await new Promise((r) => setTimeout(r, 50));
      return { status, native };
    })()`);
    assert.match(filter.status, /project filter/);
    assert.ok(filter.native.every((box) => box.iw > 8 && box.ih > 8), JSON.stringify(filter.native));
    const keys = await ev(`(() => {
      let prevented = false;
      const watch = (event) => { if (event.defaultPrevented) prevented = true; };
      document.addEventListener("keydown", watch, true);
      const mode = document.querySelector("#t3x-g-mode");
      mode.focus();
      mode.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true }));
      document.removeEventListener("keydown", watch, true);
      document.querySelector('[data-t3x-g-toggle="snoozed"]').click();
      return { prevented, snoozed: Boolean(document.querySelector('[data-thread-id="thread-snoozed"]')) };
    })()`);
    assert.equal(keys.prevented, false);
    assert.equal(keys.snoozed, true);
    const foreign = await ev(`(async () => {
      document.querySelector(".native-row").setAttribute("data-thread-item", "otherenv01:thread-questions");
      const start = Date.now();
      while (Date.now() - start < 2000 && document.documentElement.getAttribute("data-t3x-grouping") === "active") await new Promise((r) => setTimeout(r, 50));
      const hidden = document.documentElement.getAttribute("data-t3x-grouping");
      document.querySelector(".native-row").setAttribute("data-thread-item", "${ENV}:thread-questions");
      return hidden;
    })()`);
    assert.equal(foreign, null);
    const reloaded = await ev(`(async () => {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/grouping.js?again=1";
        script.onload = resolve;
        script.onerror = () => reject(new Error("reload failed"));
        document.body.appendChild(script);
      });
      return document.querySelectorAll('[data-t3x="grouping-root"]').length;
    })()`);
    assert.equal(reloaded, 1);
    const torn = await ev(`(() => { window.t3xTeardown(); return { sentinel: window.__sentinel, roots: document.querySelectorAll('[data-t3x="grouping-root"]').length, attr: document.documentElement.getAttribute("data-t3x-grouping") }; })()`);
    assert.equal(torn.sentinel, 1);
    assert.equal(torn.roots, 0);
    assert.equal(torn.attr, null);
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/bad.html` });
    const down = await ev(`(async () => {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        const status = document.querySelector(".t3x-g-status")?.textContent || "";
        if (status.toLowerCase().includes("unavailable")) {
          document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
          const native = [...document.querySelectorAll(".native-row")].map((row) => window.__viewBox(row));
          const controls = ["#t3x-g-mode", "#t3x-g-sort", "[data-t3x-g-native]"].map((sel) => window.__viewBox(document.querySelector(sel)));
          return { status, attr: document.documentElement.getAttribute("data-t3x-grouping"), display: getComputedStyle(document.querySelector('[data-slot="sidebar-content"] ul')).display, native, controls };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { status: document.body.innerText.slice(0, 200), attr: "timeout", display: "", native: [], controls: [] };
    })()`);
    assert.match(down.status, /unavailable/i);
    assert.equal(down.attr, null);
    assert.notEqual(down.display, "none");
    assert.ok(down.native.length >= 1 && down.native.every((box) => box.iw > 8 && box.ih > 8), JSON.stringify(down.native));
    assert.ok(down.controls.every((box) => box.iw > 8 && box.ih > 8), JSON.stringify(down.controls));
    await shot("unavailable.png");
    await ev(`(() => { document.querySelector("#column").style.width = "140px"; document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0; })()`);
    const downNarrow = await ev(`(() => {
      const native = [...document.querySelectorAll(".native-row")].map((row) => window.__viewBox(row));
      const controls = ["#t3x-g-mode", "#t3x-g-sort", "[data-t3x-g-native]"].map((sel) => window.__viewBox(document.querySelector(sel)));
      return { native, controls };
    })()`);
    assert.ok(downNarrow.native.every((box) => box.iw > 8 && box.ih > 8), JSON.stringify(downNarrow.native));
    assert.ok(downNarrow.controls.every((box) => box.iw > 8 && box.ih > 8), JSON.stringify(downNarrow.controls));
    await shot("unavailable-140.png");
    indexOverride = {
      ok: true, unavailable: false, reason: null, asOf: Date.now(), localEnvironmentId: ENV, source: "v2",
      coverage: { eligible: 5, returned: 5, truncated: false, cap: 1000, omittedUnsafeIds: 0, childLinksTruncated: false, factsIncomplete: true, questionsUnread: true },
      threads: [
        { id: "thread-approval", title: "Known approval", projectId: "proj-alpha", projectLabel: "Alpha", createdAt: Date.now() - 20 * 86400000, activityAt: null, activitySource: "unavailable", recentBucket: "unread", activity: "unknown", activityLabel: "State unavailable", badges: ["Recorded approval request", "Settled recorded"], shelf: "main", detail: "State unavailable. A value was missing, conflicting or not one this index knows." },
        { id: "thread-childgap", title: "Known child work", projectId: "proj-alpha", projectLabel: "Alpha", createdAt: Date.now() - 20 * 86400000, activityAt: null, activitySource: "unavailable", recentBucket: "unread", activity: "unknown", activityLabel: "State unavailable", badges: ["Child work recorded"], shelf: "main", detail: "State unavailable. A value was missing, conflicting or not one this index knows." },
        { id: "thread-timing", title: "Timing not read", projectId: "proj-alpha", projectLabel: "Alpha", createdAt: Date.now() - 20 * 86400000, activityAt: null, activitySource: "unavailable", recentBucket: "unread", activity: "unknown", activityLabel: "State unavailable", badges: [], shelf: "main", detail: "State unavailable. A value was missing, conflicting or not one this index knows." },
        { id: "thread-observed", title: "Observed run only", projectId: "proj-alpha", projectLabel: "Alpha", createdAt: Date.now() - 20 * 86400000, activityAt: Date.now() - 5 * 60000, activitySource: "observed", recentBucket: "unread", activity: "unknown", activityLabel: "State unavailable", badges: [], shelf: "main", detail: "State unavailable. A value was missing, conflicting or not one this index knows." },
        { id: "thread-created", title: "No event on record", projectId: "proj-alpha", projectLabel: "Alpha", createdAt: Date.now() - 20 * 86400000, activityAt: Date.now() - 20 * 86400000, activitySource: "created", recentBucket: "older", activity: "open", activityLabel: "Other open threads", badges: [], shelf: "main", detail: "No recorded blocker in this database snapshot. This is not Ready, Idle or Finished." },
      ],
    };
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    const partialReady = await ev(`(async () => {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        if (!document.body) { await new Promise((r) => setTimeout(r, 50)); continue; }
        const empty = document.querySelector(".t3x-g-empty")?.textContent || "";
        const badges = [...document.querySelectorAll(".t3x-g-badges")].map((node) => node.textContent);
        const timing = document.body.innerText.includes("timing unavailable");
        const observed = document.body.innerText.includes("observed");
        if (empty.includes("not proof") && badges.some((text) => text.includes("Recorded approval request")) && timing && observed) {
          document.querySelector('[data-slot="sidebar-inner"]').style.height = "980px";
          document.querySelector('[data-slot="sidebar-content"]').style.height = "820px";
          document.querySelector("#column").style.width = "280px";
          document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
          return { empty, badges };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { empty: document.body.innerText.slice(0, 500), badges: [] };
    })()`);
    assert.match(partialReady.empty, /not proof there are none/);
    assert.ok(partialReady.badges.some((text) => text.includes("Recorded approval request") && text.includes("Settled recorded")));
    assert.ok(partialReady.badges.some((text) => text.includes("Child work recorded")));
    await shot("partial-activity-280.png");
    const partialNarrow = await ev(`(() => {
      document.querySelector("#column").style.width = "140px";
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      const empty = document.querySelector(".t3x-g-empty");
      const badge = document.querySelector(".t3x-g-badges");
      const timing = [...document.querySelectorAll(".t3x-g-meta")].find((node) => node.textContent.includes("timing unavailable"));
      return {
        empty: empty?.textContent, short: document.querySelector('[data-group="questions"] .t3x-g-short')?.textContent,
        emptyBox: window.__viewBox(empty), badgeBox: window.__viewBox(badge), timingBox: timing ? window.__viewBox(timing) : null,
      };
    })()`);
    assert.equal(partialNarrow.short, "Questions / approvals");
    assert.match(partialNarrow.empty, /not proof/);
    assert.ok(partialNarrow.emptyBox.iw > 8 && partialNarrow.emptyBox.ih > 8, JSON.stringify(partialNarrow.emptyBox));
    assert.ok(partialNarrow.badgeBox.iw > 8 && partialNarrow.badgeBox.ih > 8, JSON.stringify(partialNarrow.badgeBox));
    assert.match(partialNarrow.timingBox?.text || "", /timing unavailable/);
    assert.ok(partialNarrow.timingBox.iw > 8 && partialNarrow.timingBox.ih > 8, JSON.stringify(partialNarrow.timingBox));
    await shot("partial-activity-140.png");
    const partialRecent = await ev(`(() => {
      document.querySelector("#column").style.width = "280px";
      const mode = document.querySelector("#t3x-g-mode");
      mode.value = "recent";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      const ids = (group) => [...document.querySelectorAll('[data-group="' + group + '"] a')].map((link) => link.getAttribute("data-thread-id"));
      return {
        long: document.querySelector('[data-group="unread"] .t3x-g-long')?.textContent,
        older: ids("older"), unread: ids("unread"),
      };
    })()`);
    assert.equal(partialRecent.long, "Timing unavailable");
    assert.deepEqual(partialRecent.older, ["thread-created"]);
    assert.ok(partialRecent.unread.includes("thread-timing"));
    assert.ok(partialRecent.unread.includes("thread-observed"));
    assert.equal(partialRecent.unread.includes("thread-created"), false);
    await shot("partial-recent-280.png");
    const partialRecentNarrow = await ev(`(() => {
      document.querySelector("#column").style.width = "140px";
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      const label = document.querySelector('[data-group="unread"] .t3x-g-short');
      return { short: label?.textContent, box: window.__viewBox(label) };
    })()`);
    assert.equal(partialRecentNarrow.short, "Timing unknown");
    assert.ok(partialRecentNarrow.box.iw > 8 && partialRecentNarrow.box.ih > 8, JSON.stringify(partialRecentNarrow.box));
    await shot("partial-recent-140.png");
    indexOverride = {
      ok: true, unavailable: false, reason: null, asOf: Date.now(), localEnvironmentId: ENV, source: "v2",
      coverage: { eligible: 2, returned: 2, truncated: false, cap: 1000, omittedUnsafeIds: 0, childLinksTruncated: false, factsIncomplete: false, questionsUnread: false },
      threads: [
        { id: "thread-pinned-approval", title: "Pinned approval", projectId: "proj-alpha", projectLabel: "Alpha", createdAt: Date.now() - 86400000, activityAt: Date.now() - 60000, activitySource: "run", recentBucket: "m15", activity: "questions", activityLabel: "Questions & approvals", badges: ["Recorded approval request"], shelf: "pinned", detail: "Recorded request in this database snapshot. A snapshot is not a live callback." },
        { id: "thread-quiet", title: "Quiet open thread", projectId: "proj-alpha", projectLabel: "Alpha", createdAt: Date.now() - 86400000, activityAt: Date.now() - 86400000, activitySource: "created", recentBucket: "older", activity: "open", activityLabel: "Other open threads", badges: [], shelf: "main", detail: "No recorded blocker in this database snapshot. This is not Ready, Idle or Finished." },
      ],
    };
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    const pinned = await ev(`(async () => {
      const start = Date.now();
      const absent = "No recorded questions or approvals in this snapshot.";
      while (Date.now() - start < 8000) {
        const column = document.querySelector("#column");
        if (!column) { await new Promise((r) => setTimeout(r, 50)); continue; }
        column.style.width = "280px";
        const empty = document.querySelector('[data-group="questions"] .t3x-g-empty')?.textContent || "";
        const pin = document.querySelector('[data-group="pinned"] [data-thread-id="thread-pinned-approval"] .t3x-g-badges')?.textContent || "";
        const questionsRows = document.querySelectorAll('[data-group="questions"] a').length;
        if (pin.includes("Recorded approval request") && empty && empty !== absent && questionsRows === 0) {
          document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
          return { empty, pin, questionsRows };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { empty: document.body.innerText.slice(0, 500), pin: "", questionsRows: -1 };
    })()`);
    assert.match(pinned.empty, /this group/);
    assert.match(pinned.empty, /another row/);
    assert.notEqual(pinned.empty, "No recorded questions or approvals in this snapshot.");
    assert.match(pinned.pin, /Recorded approval request/);
    assert.equal(pinned.questionsRows, 0);
    await shot("pinned-approval-280.png");
    const pinnedNarrow = await ev(`(() => {
      document.querySelector("#column").style.width = "140px";
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      const empty = document.querySelector('[data-group="questions"] .t3x-g-empty');
      const pin = document.querySelector('[data-group="pinned"] [data-thread-id="thread-pinned-approval"]');
      return {
        empty: empty?.textContent,
        short: document.querySelector('[data-group="questions"] .t3x-g-short')?.textContent,
        emptyBox: window.__viewBox(empty),
        pinBox: window.__viewBox(pin),
      };
    })()`);
    assert.equal(pinnedNarrow.short, "Questions / approvals");
    assert.match(pinnedNarrow.empty, /another row/);
    assert.ok(pinnedNarrow.emptyBox.iw > 8 && pinnedNarrow.emptyBox.ih > 8, JSON.stringify(pinnedNarrow.emptyBox));
    assert.ok(pinnedNarrow.pinBox.iw > 8 && pinnedNarrow.pinBox.ih > 8, JSON.stringify(pinnedNarrow.pinBox));
    await shot("pinned-approval-140.png");
    const groupLine = "No questions or approvals in this group.";
    const absentLine = "No recorded questions or approvals in this snapshot.";
    indexOverride = {
      ok: true, unavailable: false, reason: null, asOf: Date.now(), localEnvironmentId: ENV, source: "v2",
      coverage: { eligible: 1, returned: 1, truncated: false, cap: 1000, omittedUnsafeIds: 0, childLinksTruncated: false, factsIncomplete: false, questionsUnread: false },
      threads: [
        { id: "thread-unknown-input", title: "Recorded input", projectId: null, projectLabel: "No project", createdAt: null, activityAt: null, activitySource: "none", recentBucket: "none", activity: "unknown", activityLabel: "State unavailable", badges: [], shelf: "main", detail: "State unavailable. A value was missing, conflicting or not one this index knows." },
      ],
    };
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    const semantic = await ev(`(async () => {
      const start = Date.now();
      const group = ${JSON.stringify(groupLine)};
      while (Date.now() - start < 8000) {
        const column = document.querySelector("#column");
        if (!column) { await new Promise((r) => setTimeout(r, 50)); continue; }
        column.style.width = "280px";
        const empty = document.querySelector('[data-group="questions"] .t3x-g-empty')?.textContent || "";
        const row = document.querySelector('[data-group="unknown"] [data-thread-id="thread-unknown-input"]');
        const badges = row?.querySelector(".t3x-g-badges")?.textContent || "";
        const questionsRows = document.querySelectorAll('[data-group="questions"] a').length;
        if (empty === group && row && !badges && questionsRows === 0) {
          document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
          return { empty, badges, questionsRows, label: row.querySelector(".t3x-g-title")?.textContent };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { empty: document.body.innerText.slice(0, 500), badges: "missing", questionsRows: -1, label: "" };
    })()`);
    assert.equal(semantic.empty, groupLine);
    assert.notEqual(semantic.empty, absentLine);
    assert.equal(semantic.badges, "");
    assert.equal(semantic.questionsRows, 0);
    assert.equal(semantic.label, "Recorded input");
    await shot("semantic-unknown-280.png");
    const semanticNarrow = await ev(`(() => {
      document.querySelector("#column").style.width = "140px";
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      const empty = document.querySelector('[data-group="questions"] .t3x-g-empty');
      return {
        empty: empty?.textContent,
        short: document.querySelector('[data-group="questions"] .t3x-g-short')?.textContent,
        box: window.__viewBox(empty),
      };
    })()`);
    assert.equal(semanticNarrow.short, "Questions / approvals");
    assert.equal(semanticNarrow.empty, groupLine);
    assert.ok(semanticNarrow.box.iw > 8 && semanticNarrow.box.ih > 8, JSON.stringify(semanticNarrow.box));
    await shot("semantic-unknown-140.png");
    indexOverride = {
      ok: true, unavailable: false, reason: null, asOf: Date.now(), localEnvironmentId: ENV, source: "v2",
      coverage: { eligible: 1, returned: 1, truncated: false, cap: 1000, omittedUnsafeIds: 0, childLinksTruncated: false, factsIncomplete: false, questionsUnread: false },
      threads: [
        { id: "thread-quiet-only", title: "Quiet open thread", projectId: "proj-alpha", projectLabel: "Alpha", createdAt: Date.now() - 86400000, activityAt: Date.now() - 86400000, activitySource: "created", recentBucket: "older", activity: "open", activityLabel: "Other open threads", badges: [], shelf: "main", detail: "No recorded blocker in this database snapshot. This is not Ready, Idle or Finished." },
      ],
    };
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    const quietEmpty = await ev(`(async () => {
      const start = Date.now();
      const group = ${JSON.stringify(groupLine)};
      while (Date.now() - start < 8000) {
        const column = document.querySelector("#column");
        if (!column) { await new Promise((r) => setTimeout(r, 50)); continue; }
        column.style.width = "280px";
        const empty = document.querySelector('[data-group="questions"] .t3x-g-empty')?.textContent || "";
        const row = document.querySelector('[data-group="open"] [data-thread-id="thread-quiet-only"]');
        const questionsRows = document.querySelectorAll('[data-group="questions"] a').length;
        if (empty === group && row && questionsRows === 0) {
          document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
          return { empty, questionsRows, label: row.querySelector(".t3x-g-title")?.textContent };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { empty: document.body.innerText.slice(0, 500), questionsRows: -1, label: "" };
    })()`);
    assert.equal(quietEmpty.empty, groupLine);
    assert.notEqual(quietEmpty.empty, absentLine);
    assert.equal(quietEmpty.questionsRows, 0);
    assert.equal(quietEmpty.label, "Quiet open thread");
    await shot("quiet-empty-280.png");
    const quietNarrow = await ev(`(() => {
      document.querySelector("#column").style.width = "140px";
      document.querySelector('[data-slot="sidebar-content"]').scrollTop = 0;
      const empty = document.querySelector('[data-group="questions"] .t3x-g-empty');
      return {
        empty: empty?.textContent,
        short: document.querySelector('[data-group="questions"] .t3x-g-short')?.textContent,
        box: window.__viewBox(empty),
      };
    })()`);
    assert.equal(quietNarrow.short, "Questions / approvals");
    assert.equal(quietNarrow.empty, groupLine);
    assert.ok(quietNarrow.box.iw > 8 && quietNarrow.box.ih > 8, JSON.stringify(quietNarrow.box));
    await shot("quiet-empty-140.png");
    const fix5 = path.join(OUT_ROOT, "screenshots-labeled");
    fs.mkdirSync(fix5, { recursive: true });
    for (const name of ["activity.png", "recent.png", "project.png", "narrow.png", "recent-140.png", "project-140.png", "partial-activity-280.png", "partial-activity-140.png", "partial-recent-280.png", "partial-recent-140.png", "pinned-approval-280.png", "pinned-approval-140.png", "semantic-unknown-280.png", "semantic-unknown-140.png", "quiet-empty-280.png", "quiet-empty-140.png"]) {
      fs.copyFileSync(shots[name], path.join(fix5, name));
    }
    assert.deepEqual(exceptions, []);
    const names = ["activity.png", "activity-bottom.png", "recent.png", "project.png", "narrow.png", "narrow-bottom.png", "recent-140.png", "project-140.png", "fallback-search.png", "fallback-search-140.png", "unavailable.png", "unavailable-140.png", "pinned-approval-280.png", "pinned-approval-140.png", "semantic-unknown-280.png", "semantic-unknown-140.png", "quiet-empty-280.png", "quiet-empty-140.png"];
    for (const name of names) assert.ok(fs.statSync(shots[name]).size > 1000, name);
    fs.writeFileSync(path.join(OUT_ROOT, "evidence-browser.json"), JSON.stringify(evidence, null, 2));
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
