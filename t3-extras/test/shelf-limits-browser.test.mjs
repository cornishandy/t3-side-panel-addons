// Snoozed & Settled count + time-period shelf limits (A''):
// - Unified stepper + unit chips (rows | min | hours | days | No limit), default 3 rows each
// - Snoozed "waking in less than T" (snoozedUntil) & Settled "settled less than T ago" (settledAt)
// - Trusted CDP mouse clicks after typing in Settings fields (incl. -, +, unit chip, No limit, Reset defaults)
// - Draft discard on Reset defaults, Escape, teardown, and cross-window storage sync
// - Pressed Show N more stability while row 1 has focus (Sol Blocker 3)
// - Same-scope <ul> replacement preserving pagination reveal in rows mode (Sol Blocker 4)
// - Time-mode Show N older / Show N later, zero-match header anchor, Show 25 more time filtering,
//   keyboard focus transfer when settled:more hides or focused toggle disappears, stale-DB badge cross-check,
//   unknown-time fail-open in time mode ONLY (never rows mode), hover-pause on 30s tick, multi-select, drag, teardown.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
function newestHeadlessChrome() {
  const root = path.join(os.homedir(), ".t3/tools/chrome-headless-shell/mac-arm64");
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((v) => /^\d+(\.\d+)+$/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return path.join(root, versions[0] ?? "missing", "chrome-headless-shell");
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root {
    --foreground:#eee; --background:#151515; --border:#555; --popover:#222; --muted-foreground:#a1a1aa;
    --sidebar:#18181b; --sidebar-foreground:#e4e4e7; --sidebar-muted-foreground:#a1a1aa;
    --sidebar-row-hover:rgba(255,255,255,0.06); --accent:#2a2a2a; --primary:#7aa2ff; --ring:#7aa2ff;
    --info:#3b82f6; --info-foreground:#93c5fd; --warning:#f59e0b; --warning-foreground:#fde68a;
    --font-sans:Arial,sans-serif; --font-mono:Menlo,monospace; color-scheme:dark;
  }
  body { margin:0; background:#151515; color:#eee; font:14px/1.4 var(--font-sans); }
  #side { width:280px; background:var(--sidebar); color:var(--sidebar-foreground); font-size:13px; }
  #side ul { margin:0; padding:4px 0; }
  #side li { list-style:none; }
  li[data-thread-item] { padding-block: 2px; }
  .shelf-row { display:flex; gap:8px; height:28px; align-items:center; padding:0 8px; }
  .shelf-toggle { display:flex; align-items:center; gap:6px; width:100%; height:28px; padding:0 8px; border:0; background:transparent; color:inherit; cursor:pointer; text-align:left; }
  .more-native { display:flex; align-items:center; width:100%; height:28px; padding:0 8px; border:0; background:transparent; color:var(--sidebar-muted-foreground); cursor:pointer; text-align:left; }
  .ml-auto { margin-left:auto; }
</style>
<link rel="stylesheet" href="/extras.css"></head><body>
<div id="side" data-slot="sidebar-content" data-sidebar-scope="all">
  <ul id="list" role="presentation"></ul>
</div>
<button id="anchor" type="button" style="position:fixed;left:320px;bottom:20px">✦</button>
<button id="outside-btn" type="button" style="position:fixed;left:380px;bottom:20px">Outside</button>
<script>
window.__HARNESS__ = (() => {
  const side = document.getElementById("side");
  // Match Andy's live snoozed wake times (h from now) & settled ages (h ago)
  const SNOOZED_WAKES_H = [1.3, 11.5, 11.5, 12.5, 26.5, 36.5, 132.5];
  const SETTLED_AGES_H = [
    0.5, 0.9, 1.1, 5.7, 8.0, 10.2, 22.8, 23.2, 23.8, 23.9, // page 1 (10 rows: 2 <1h, 3 <3h, 6 <12h, 10 <24h)
    ...Array.from({ length: 20 }, (_, i) => 25 + i),       // next 20 rows: 25h..44h (<48h)
    50, 60, 70, 80, 90,                                    // last 5 rows on page 2 (>48h)
    100, 110, 120, 130, 140, 150,
  ];
  const state = {
    scope: "all",
    snoozedExpanded: false,
    settledExpanded: true,
    settledMounted: 10,
    settledTotal: 41,
    snoozedTotal: SNOOZED_WAKES_H.length,
    routeId: "a1",
    snoozedToggleClicks: 0,
    settledToggleClicks: 0,
    settledMoreClicks: 0,
    dragSettled: false,
    replaceUlOnMore: false,
    asyncInPlaceMore: false,
    overrideBadges: {},
  };
  function ageBadge(h) {
    if (h < 1 / 60) return "now";
    if (h < 1) return Math.floor(h * 60) + "m";
    if (h < 24) return Math.floor(h) + "h";
    return Math.floor(h / 24) + "d";
  }
  function currentUl() { return side.querySelector("ul"); }
  function makeRow(id, shelf, title, badge) {
    const li = document.createElement("li");
    li.setAttribute("data-thread-item", "env-1:" + id);
    li.className = "list-none";
    const row = document.createElement("div");
    row.setAttribute("data-testid", shelf ? "sidebar-row-slim" : "sidebar-row-card");
    if (shelf) row.setAttribute("data-sidebar-parent", "shelf:" + shelf);
    if (state.routeId === id) row.setAttribute("aria-current", "page");
    row.className = "shelf-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row-btn";
    btn.textContent = title;
    btn.style.cssText = "border:0;background:transparent;color:inherit;text-align:left;flex:1;cursor:pointer;padding:0";
    row.appendChild(btn);
    if (badge !== undefined) {
      const slot = document.createElement("span");
      slot.className = "relative ml-auto";
      const inner = document.createElement("span");
      inner.textContent = state.overrideBadges[id] ?? badge;
      slot.appendChild(inner);
      row.appendChild(slot);
    }
    li.appendChild(row);
    return li;
  }
  function renderList(replaceUl = false) {
    side.setAttribute("data-sidebar-scope", state.scope);
    let ul = currentUl();
    if (replaceUl) {
      const nextUl = document.createElement("ul");
      nextUl.id = "list";
      nextUl.setAttribute("role", "presentation");
      ul.replaceWith(nextUl);
      ul = nextUl;
    } else {
      ul.innerHTML = "";
    }
    const ph = document.createElement("li");
    ph.setAttribute("data-testid", "sidebar-active-placeholder");
    ph.className = "list-none";
    ul.appendChild(ph);
    ul.appendChild(makeRow("a1", null, "Active thread 1"));
    ul.appendChild(makeRow("a2", null, "Active thread 2"));

    const snHeader = document.createElement("li");
    snHeader.setAttribute("data-testid", "sidebar-snoozed-header");
    snHeader.className = "list-none";
    const snBtn = document.createElement("button");
    snBtn.type = "button";
    snBtn.className = "shelf-toggle";
    snBtn.setAttribute("data-testid", "sidebar-snoozed-shelf-toggle");
    snBtn.setAttribute("aria-expanded", String(state.snoozedExpanded));
    snBtn.innerHTML = '<span>Snoozed</span><span aria-hidden="true" class="flex-1"></span><span>' + state.snoozedTotal + '</span>';
    snBtn.addEventListener("click", () => {
      state.snoozedToggleClicks++;
      state.snoozedExpanded = !state.snoozedExpanded;
      renderList();
    });
    snHeader.appendChild(snBtn);
    ul.appendChild(snHeader);
    const snPrefix = state.scope === "all" ? "sn" : state.scope + "-sn";
    if (state.snoozedExpanded) {
      for (let i = 1; i <= state.snoozedTotal; i++) {
        ul.appendChild(makeRow(snPrefix + i, "snoozed", "Snoozed " + i, "in " + Math.ceil(SNOOZED_WAKES_H[i - 1] || 24) + "h"));
      }
    }

    const stHeader = document.createElement("li");
    stHeader.setAttribute("data-testid", "sidebar-settled-header");
    stHeader.className = "list-none";
    const stBtn = document.createElement("button");
    stBtn.type = "button";
    stBtn.className = "shelf-toggle" + (state.dragSettled ? " text-primary" : "");
    stBtn.setAttribute("data-testid", "sidebar-settled-shelf-toggle");
    stBtn.setAttribute("aria-expanded", String(state.settledExpanded));
    stBtn.innerHTML = '<span>Settled</span><span aria-hidden="true" class="flex-1"></span><span>' + state.settledTotal + '</span>';
    stBtn.addEventListener("click", () => {
      state.settledToggleClicks++;
      state.settledExpanded = !state.settledExpanded;
      renderList();
    });
    stHeader.appendChild(stBtn);
    ul.appendChild(stHeader);
    const stPh = document.createElement("li");
    stPh.setAttribute("data-testid", "sidebar-settled-placeholder");
    stPh.className = "list-none";
    if (state.dragSettled) stPh.innerHTML = "<div>Drop to settle</div>";
    ul.appendChild(stPh);

    const stPrefix = state.scope === "all" ? "st" : state.scope + "-st";
    if (state.settledExpanded) {
      const mounted = Math.min(state.settledMounted, state.settledTotal);
      for (let i = 1; i <= mounted; i++) {
        const h = SETTLED_AGES_H[i - 1] ?? (100 + i);
        ul.appendChild(makeRow(stPrefix + i, "settled", "Settled " + i, ageBadge(h)));
      }
      if (state.settledTotal > mounted) {
        const moreLi = document.createElement("li");
        moreLi.className = "list-none";
        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "more-native";
        moreBtn.setAttribute("data-sidebar-row", "settled:more");
        moreBtn.setAttribute("data-sidebar-parent", "shelf:settled");
        moreBtn.textContent = "Show 25 more";
        moreBtn.addEventListener("click", () => {
          if (moreBtn.getAttribute("aria-disabled") === "true") return;
          state.settledMoreClicks++;
          if (state.asyncInPlaceMore) {
            moreBtn.setAttribute("aria-disabled", "true");
            moreBtn.textContent = "Loading...";
            setTimeout(() => {
              const prevMounted = state.settledMounted;
              state.settledMounted = Math.min(state.settledTotal, state.settledMounted + 25);
              const u = currentUl();
              const stPrefixNow = state.scope === "all" ? "st" : state.scope + "-st";
              const frag = document.createDocumentFragment();
              for (let j = prevMounted + 1; j <= state.settledMounted; j++) {
                const hj = SETTLED_AGES_H[j - 1] ?? (100 + j);
                frag.appendChild(makeRow(stPrefixNow + j, "settled", "Settled " + j, ageBadge(hj)));
              }
              moreLi.before(frag);
              if (state.settledTotal <= state.settledMounted) {
                moreLi.remove();
              } else {
                moreBtn.removeAttribute("aria-disabled");
                moreBtn.textContent = "Show 25 more";
              }
            }, 80);
            return;
          }
          state.settledMounted = Math.min(state.settledTotal, state.settledMounted + 25);
          renderList(state.replaceUlOnMore);
        });
        moreLi.appendChild(moreBtn);
        ul.appendChild(moreLi);
      }
    }
  }
  renderList();
  return {
    state,
    renderList,
    setScope(nextScope, settledTotal = 10) {
      state.scope = nextScope;
      state.settledTotal = settledTotal;
      state.settledMounted = Math.min(10, settledTotal);
      renderList();
    },
    setRoute(id) {
      state.routeId = id;
      const ul = currentUl();
      for (const el of ul.querySelectorAll('[aria-current="page"]')) el.removeAttribute("aria-current");
      const row = ul.querySelector('li[data-thread-item="env-1:' + id + '"] > div');
      if (row) row.setAttribute("aria-current", "page");
    },
    setDrag(settled) {
      state.dragSettled = settled;
      const ul = currentUl();
      ul.querySelector('[data-testid="sidebar-settled-shelf-toggle"]')?.classList.toggle("text-primary", settled);
      const stPh = ul.querySelector('li[data-testid="sidebar-settled-placeholder"]');
      if (stPh) stPh.innerHTML = settled ? "<div>Drop to settle</div>" : "";
    },
    dropSettledRow(newId) {
      state.dragSettled = false;
      state.settledTotal++;
      if (state.settledExpanded) state.settledMounted++;
      renderList();
      if (newId) {
        const first = currentUl().querySelector('li[data-thread-item] [data-sidebar-parent="shelf:settled"]')?.closest("li");
        if (first) first.setAttribute("data-thread-item", "env-1:" + newId);
      }
    },
  };
})();
window.__T3X_PICK_TEST__ = {};
</script>
<script src="/extras.js"></script>
</body></html>`;

function buildGroupingPayload(mode = "live") {
  const now = Date.now();
  const H = 3600e3;
  if (mode === "none") return { ok: false, unavailable: true, localEnvironmentId: "env-1", asOf: now, threads: [] };
  const SNOOZED_WAKES_H = [1.3, 11.5, 11.5, 12.5, 26.5, 36.5, 132.5];
  const SETTLED_AGES_H = [
    0.5, 0.9, 1.1, 5.7, 8.0, 10.2, 22.8, 23.2, 23.8, 23.9,
    ...Array.from({ length: 20 }, (_, i) => 25 + i),
    50, 60, 70, 80, 90,
    100, 110, 120, 130, 140, 150,
  ];
  const threads = [];
  SNOOZED_WAKES_H.forEach((h, i) => {
    threads.push({ id: `sn${i + 1}`, snoozedUntil: now + Math.round(h * H), settledAt: null, ageAt: now - H });
    threads.push({ id: `projB-sn${i + 1}`, snoozedUntil: now + Math.round(h * H), settledAt: null, ageAt: now - H });
  });
  SETTLED_AGES_H.forEach((h, i) => {
    const settledAt = mode === "stale-st1" && i === 0 ? now - 72 * H : now - Math.round(h * H);
    threads.push({ id: `st${i + 1}`, settledAt, snoozedUntil: null, ageAt: settledAt });
    threads.push({ id: `projB-st${i + 1}`, settledAt, snoozedUntil: null, ageAt: settledAt });
  });
  return { ok: true, asOf: now, localEnvironmentId: "env-1", threads };
}

test("shelf limits (A''): count + time modes, real CDP clicks, draft guards, pagination, focus transfer, stale DB, drag, teardown", { timeout: 90_000 }, async () => {
  const CHROME = newestHeadlessChrome();
  assert.ok(fs.existsSync(CHROME), `headless Chrome missing: ${CHROME}`);
  let groupingMode = "live";
  let groupingRequests = 0;
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname;
    const file = { "/extras.css": "text/css", "/extras.js": "text/javascript" }[name];
    res.writeHead(200, { "Content-Type": `${file || "text/html"}; charset=utf-8`, "Cache-Control": "no-store" });
    if (name === "/font-catalog") return res.end(JSON.stringify({ families: [] }));
    if (name === "/grouping") {
      groupingRequests++;
      return res.end(JSON.stringify(buildGroupingPayload(groupingMode)));
    }
    if (name !== "/" && !file) return res.end("{}");
    res.end(file ? fs.readFileSync(path.join(SRC, "public", name.slice(1)), "utf8").replace('const BASE = "http://127.0.0.1:8793/";', 'const BASE = location.origin + "/";') : PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-shelf-a2-"));
  const chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--window-size=1100,880", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 85_000);
  let ws;
  try {
    let wsUrl = "";
    for (let i = 0; i < 100 && !wsUrl; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const [port] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
        wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch {}
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
    const settle = () => ev(`new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => r(1))), 320))`);
    const waitQuick = () => ev(`new Promise(r => setTimeout(() => requestAnimationFrame(() => r(1)), 50))`);
    const mouse = (type, x, y, button = "left", clickCount = 1) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : button, clickCount: type === "mouseMoved" ? 0 : clickCount });
    const centerOf = (sel) => ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) throw new Error("missing " + ${JSON.stringify(sel)});
      el.scrollIntoView({ block: "center" });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
    const realClick = async (sel, holdMs = 0) => {
      const { x, y } = await centerOf(sel);
      await mouse("mouseMoved", x, y);
      await waitQuick();
      await mouse("mousePressed", x, y);
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      await mouse("mouseReleased", x, y);
      await waitQuick();
    };
    const realKey = async (key, code = key, vk = 0) => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
      await waitQuick();
    };
    const url = `http://127.0.0.1:${server.address().port}/`;
    const loadFresh = async (settingsObj = null) => {
      await send("Page.navigate", { url });
      await settle();
      if (settingsObj === null) await ev(`localStorage.removeItem("t3x:settings:v1"), 1`);
      else await ev(`localStorage.setItem("t3x:settings:v1", ${JSON.stringify(JSON.stringify(settingsObj))}), 1`);
      await send("Page.navigate", { url });
      assert.equal(await ev(`(async () => {
        for (let i = 0; i < 100; i++) {
          if (window.__T3X_PICK_TEST__?.openPanel && document.querySelector('[data-testid="sidebar-settled-shelf-toggle"]')) return "ready";
          await new Promise(r => setTimeout(r, 50));
        }
        return "missing";
      })()`), "ready");
      await waitQuick();
    };
    const openSettings = async () => {
      await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById("anchor")), 1`);
      await waitQuick();
      await ev(`(() => { const d = document.querySelector(".t3x-more"); if (!d.open) d.querySelector("summary").click(); return 1; })()`);
      await waitQuick();
    };
    const snap = () => ev(`(() => {
      const ul = document.querySelector("#side ul");
      const shelfInfo = (shelf) => {
        const rows = [...ul.querySelectorAll('li[data-thread-item]')].filter(li => li.querySelector('[data-sidebar-parent="shelf:' + shelf + '"]'));
        const visible = rows.filter(li => li.checkVisibility()).map(li => li.getAttribute("data-thread-item").slice(6));
        const togLi = ul.querySelector('li[data-t3x="shelf-more-' + shelf + '"]');
        const togBtn = togLi?.querySelector("button");
        const prev = togLi?.previousElementSibling;
        return {
          expanded: document.querySelector('[data-testid="sidebar-' + shelf + '-shelf-toggle"]')?.getAttribute("aria-expanded"),
          mounted: rows.length,
          visible,
          toggleVisible: Boolean(togLi && !togLi.hidden && togLi.checkVisibility()),
          toggleText: togBtn?.textContent?.trim() ?? null,
          togglePrevThread: prev?.getAttribute?.("data-thread-item")?.slice(6) ?? null,
          togglePrevTestId: prev?.getAttribute?.("data-testid") ?? null,
          toggleHasThreadItem: Boolean(togLi?.hasAttribute("data-thread-item")),
        };
      };
      const nativeMore = ul.querySelector('button[data-sidebar-row="settled:more"]');
      return {
        snoozed: shelfInfo("snoozed"),
        settled: shelfInfo("settled"),
        nativeMoreVisible: Boolean(nativeMore && nativeMore.checkVisibility()),
        activeFocus: document.activeElement?.getAttribute?.("data-focus") ?? document.activeElement?.getAttribute?.("data-t3x-shelf-toggle") ?? document.activeElement?.getAttribute?.("data-testid") ?? document.activeElement?.id ?? document.activeElement?.tagName,
        settings: JSON.parse(localStorage.getItem("t3x:settings:v1") || "{}"),
        harness: { ...window.__HARNESS__.state },
      };
    })()`);

    await send("Runtime.enable");
    await send("Page.enable");

    // 1. Astra/Sol R3 check: even when /grouping is unavailable ("none"), default 3 rows caps 10 -> 3!
    groupingMode = "none";
    await loadFresh();
    let s = await snap();
    assert.equal(s.snoozed.expanded, "false", "closed Snoozed stays closed on install");
    assert.deepEqual(s.settled.visible, ["st1", "st2", "st3"], "rows mode caps even without timestamps");
    assert.equal(s.settled.toggleText, "Show 7 more");
    assert.equal(s.settled.toggleHasThreadItem, false);
    assert.equal(s.nativeMoreVisible, false);

    // 2. Sol Blocker 3: Focus row 1 in Settled, press and hold Show 6 more for 150ms, then release -> MUST expand (never shift out from under pointer!).
    await ev(`document.querySelector('li[data-thread-item="env-1:st1"] button').focus(), 1`);
    await waitQuick();
    s = await snap();
    assert.deepEqual(s.settled.visible, ["st1", "st2", "st3", "st4"]);
    assert.equal(s.settled.toggleText, "Show 6 more");
    await realClick('[data-t3x-shelf-toggle="settled"]', 150);
    s = await snap();
    assert.equal(s.settled.visible.length, 10, "holding pointer on Show 6 more while row 1 had focus still expands cleanly");
    assert.equal(s.settled.toggleText, "Show fewer");

    // 3. Sol Blocker 4: Same-scope <ul> replacement on native settled:more in ROWS mode keeps pagination reveal!
    await ev(`window.__HARNESS__.state.replaceUlOnMore = true, 1`);
    await openSettings();
    await realClick('[data-focus="shelf-input-settled"]');
    await ev(`(() => { const inp = document.querySelector('[data-focus="shelf-input-settled"]'); inp.value = "10"; return 1; })()`);
    await realKey("Enter", "Enter", 13);
    await waitQuick();
    assert.equal((await snap()).settled.visible.length, 10);
    assert.equal((await snap()).nativeMoreVisible, true);
    await realClick('button[data-sidebar-row="settled:more"]');
    await settle();
    s = await snap();
    assert.equal(s.settled.mounted, 35);
    assert.equal(s.settled.visible.length, 35, "same-scope <ul> replacement on settled:more preserves rows-mode reveal");
    assert.equal(s.settled.toggleText, "Show fewer");

    // 4. Sol Blocker 1 + Opus applyFonts catch: REAL trusted CDP clicks after typing in a closed Snoozed field!
    groupingMode = "live";
    // 4a. Type 5 then physically click + -> saves 6, opens Snoozed, focus stays on shelf-plus-snoozed!
    await loadFresh();
    await openSettings();
    await ev(`(() => { const inp = document.querySelector('[data-focus="shelf-input-snoozed"]'); inp.focus(); inp.value = "5"; return 1; })()`);
    await realClick('[data-focus="shelf-plus-snoozed"]');
    await settle();
    s = await snap();
    assert.equal(s.snoozed.expanded, "true");
    assert.equal(s.settings.snoozedRule.value, 6, "type 5 then physical click + yields 6");
    assert.equal(s.activeFocus, "shelf-plus-snoozed");

    // 4b. Type 5 then physically click − -> saves 4, opens Snoozed, focus stays on shelf-minus-snoozed!
    await loadFresh();
    await openSettings();
    await ev(`(() => { const inp = document.querySelector('[data-focus="shelf-input-snoozed"]'); inp.focus(); inp.value = "5"; return 1; })()`);
    await realClick('[data-focus="shelf-minus-snoozed"]');
    await settle();
    s = await snap();
    assert.equal(s.snoozed.expanded, "true");
    assert.equal(s.settings.snoozedRule.value, 4, "type 5 then physical click − yields 4");
    assert.equal(s.activeFocus, "shelf-minus-snoozed");

    // 4c. Type 5 then physically click No limit -> switches to No limit AND remembers 5 in last.rows!
    await loadFresh();
    await openSettings();
    await ev(`(() => { const inp = document.querySelector('[data-focus="shelf-input-snoozed"]'); inp.focus(); inp.value = "5"; return 1; })()`);
    await realClick('[data-focus="shelf-unit-snoozed-all"]');
    await settle();
    s = await snap();
    assert.equal(s.snoozed.expanded, "true");
    assert.equal(s.settings.snoozedRule.unit, "all", "type 5 then physical click No limit activates all");
    assert.equal(s.settings.snoozedRule.last.rows, 5, "remembers typed 5 under rows before switching to all");
    assert.equal(s.activeFocus, "shelf-unit-snoozed-all");

    // 4d. Sol R2 Blocker: Type 5 then physically click Reset defaults -> discards 5, keeps 3 rows, leaves Snoozed CLOSED!
    await loadFresh();
    await openSettings();
    await ev(`(() => { const inp = document.querySelector('[data-focus="shelf-input-snoozed"]'); inp.focus(); inp.value = "5"; return 1; })()`);
    await realClick('[data-focus="reset"]');
    await settle();
    s = await snap();
    assert.equal(s.snoozed.expanded, "false", "Reset defaults discards draft and NEVER opens closed Snoozed");
    assert.equal(s.settings.snoozedRule.value, 3);

    // 5. Sol Blocker 2: Escape, storage sync, and t3xTeardown NEVER commit an unsaved draft!
    // 5a. Escape
    await loadFresh();
    await openSettings();
    await ev(`(() => { const inp = document.querySelector('[data-focus="shelf-input-snoozed"]'); inp.focus(); inp.value = "5"; return 1; })()`);
    await realKey("Escape", "Escape", 27);
    await settle();
    s = await snap();
    assert.equal(s.snoozed.expanded, "false", "Escape discards draft and never opens Snoozed");
    assert.equal(s.settings.snoozedRule?.value ?? 3, 3);

    // 5b. Incoming cross-window storage event (never commits draft, clears expandedAll, never opens closed shelf!)
    await loadFresh();
    await ev(`document.querySelector('[data-t3x-shelf-toggle="settled"]').click(), 1`);
    await waitQuick();
    assert.equal((await snap()).settled.visible.length, 10);
    await openSettings();
    await ev(`(() => {
      const inp = document.querySelector('[data-focus="shelf-input-snoozed"]');
      inp.focus();
      inp.value = "5";
      window.dispatchEvent(new StorageEvent("storage", {
        key: "t3x:settings:v1",
        newValue: JSON.stringify({ snoozedRule: { unit: "rows", value: 6 }, settledRule: { unit: "rows", value: 4 } }),
      }));
      return 1;
    })()`);
    await settle();
    s = await snap();
    assert.equal(s.snoozed.expanded, "false", "storage sync never opens closed Snoozed");
    assert.equal(await ev(`document.querySelector('[data-focus="shelf-input-snoozed"]').value`), "6", "incoming storage value wins over unsaved draft");
    assert.equal(s.settled.visible.length, 4, "incoming storage rule change clears expandedAll on Settled");

    // 5c. t3xTeardown discards unsaved draft!
    await loadFresh();
    await openSettings();
    await ev(`(() => {
      const inp = document.querySelector('[data-focus="shelf-input-snoozed"]');
      inp.focus();
      inp.value = "5";
      window.t3xTeardown();
      return 1;
    })()`);
    await waitQuick();
    assert.equal(await ev(`window.__HARNESS__.state.snoozedExpanded`), false, "teardown never opens closed Snoozed");
    assert.equal(await ev(`JSON.parse(localStorage.getItem("t3x:settings:v1") || "{}").snoozedRule?.value ?? 3`), 3, "teardown never saves unsaved draft 5");

    // 6. TIME MODE: Snoozed waking within 12 hours (3 of 7 match -> Show 4 later) + Settled within 12 hours (6 of 10 -> Show 4 older) + live summaries!
    // Also verify /grouping fetch runs even when timeGaps is OFF!
    groupingRequests = 0;
    await loadFresh({ timeGaps: false });
    await openSettings();
    await realClick('[data-focus="shelf-unit-snoozed-hours"]');
    await settle();
    s = await snap();
    assert.ok(groupingRequests >= 1, "/grouping fetched for time mode even with timeGaps off");
    assert.equal(s.snoozed.expanded, "true", "switching Snoozed to hours opens it once");
    assert.deepEqual(s.snoozed.visible, ["sn1", "sn2", "sn3"], "Snoozed <12h keeps 3 soonest wakes (1.3h, 11.5h, 11.5h)");
    assert.equal(s.snoozed.toggleText, "Show 4 later");
    assert.equal(await ev(`document.querySelector('[data-shelf-summary="snoozed"]').textContent`), "Waking in less than 12 hours · 3 now");

    await realClick('[data-focus="shelf-unit-settled-hours"]');
    await settle();
    s = await snap();
    assert.equal(s.settled.visible.length, 6, "Settled <12h keeps 6 rows");
    assert.equal(s.settled.toggleText, "Show 4 older");
    assert.equal(await ev(`document.querySelector('[data-shelf-summary="settled"]').textContent`), "Settled less than 12 hours ago · 6 now");

    // 7. ZERO MATCHES in time mode (< 10 min on Settled -> 0 rows visible, "Show 10 older" anchored right after settled placeholder!).
    await realClick('[data-focus="shelf-unit-settled-min"]');
    await waitQuick();
    await ev(`(() => { const inp = document.querySelector('[data-focus="shelf-input-settled"]'); inp.focus(); inp.value = "10"; return 1; })()`);
    await realKey("Enter", "Enter", 13);
    await waitQuick();
    s = await snap();
    assert.equal(s.settled.visible.length, 0, "<10 min matches 0 rows honestly");
    assert.equal(s.settled.toggleVisible, true, "zero-match toggle still visible");
    assert.equal(s.settled.toggleText, "Show 10 older");
    assert.equal(s.settled.togglePrevTestId, "sidebar-settled-placeholder", "zero-match toggle anchored right after placeholder");
    await realClick('[data-t3x-shelf-toggle="settled"]');
    s = await snap();
    assert.equal(s.settled.visible.length, 10);
    assert.equal(s.settled.toggleText, "Show fewer");
    assert.equal(s.settled.togglePrevTestId, "sidebar-settled-placeholder", "Show fewer stays at header/placeholder anchor");

    // 8. TIME-MODE native Show 25 more (Grok's rule + Sol's focus transfer + real-T3 async in-place button):
    // Re-open Settings (realClick on Show 10 older closed the popover as expected),
    // set Settled to 2 days (48h) -> all 10 page-1 rows match -> native Show 25 more is visible ->
    // activate Show 25 more via keyboard in real-T3 async mode (aria-disabled="true" in place, rows appended 80ms later) ->
    // 25 new rows load (20 < 48h, 5 > 48h) -> 30 rows show, 5 older rows fold behind "Show 5 older",
    // and focus transfers from hidden settled:more to Show 5 older!
    await openSettings();
    await realClick('[data-focus="shelf-unit-settled-days"]');
    await waitQuick();
    await ev(`(() => { const inp = document.querySelector('[data-focus="shelf-input-settled"]'); inp.focus(); inp.value = "2"; return 1; })()`);
    await realKey("Enter", "Enter", 13);
    await waitQuick();
    s = await snap();
    assert.equal(s.settled.visible.length, 10);
    assert.equal(s.settled.toggleVisible, false);
    assert.equal(s.nativeMoreVisible, true);
    // Close popover first, enable real-T3 async in-place settled:more, focus it and activate via Enter!
    await realKey("Escape", "Escape", 27);
    await ev(`window.__HARNESS__.state.asyncInPlaceMore = true; document.querySelector('button[data-sidebar-row="settled:more"]').focus(); 1`);
    await realKey("Enter", "Enter", 13);
    await settle();
    s = await snap();
    assert.equal(s.settled.mounted, 35);
    assert.equal(s.settled.visible.length, 30, "time-mode Show 25 more filters newly loaded rows by < 2 days (30 match, 5 fold)");
    assert.equal(s.settled.toggleText, "Show 5 older");
    assert.equal(s.nativeMoreVisible, false);
    assert.equal(s.activeFocus, "settled", "focus transferred from hidden native settled:more to Show 5 older");

    // 8b. HOVER PAUSE (Spec C.4 / Opus P1 + Grok Nit #2 cross-shelf pointerout):
    // Set Settled to < 31 min (st1 = 30m visible; st2..st10 folded). Hover st1 with real CDP pointer.
    // Mutate st1's badge text in-place "30m" -> "31m" (mimicking T3's 1-minute tick -> MutationObserver).
    // st1 MUST remain visible under the pointer until the pointer moves off Settled (even onto a Working row a1!).
    await loadFresh({ settledRule: { unit: "min", value: 31 } });
    s = await snap();
    assert.deepEqual(s.settled.visible, ["st1"], "only st1 (30m) matches < 31 min before hover");
    assert.equal(s.settled.toggleText, "Show 9 older");
    const st1Pos = await centerOf('li[data-thread-item="env-1:st1"]');
    await mouse("mouseMoved", st1Pos.x, st1Pos.y);
    await waitQuick();
    // Simulate T3's 1-minute age-badge tick on the hovered row (30m -> 31m) without moving the pointer!
    await ev(`(() => {
      const badge = document.querySelector('li[data-thread-item="env-1:st1"] span.ml-auto > span:first-child');
      badge.firstChild.data = "31m";
      return badge.textContent;
    })()`);
    await settle();
    s = await snap();
    assert.deepEqual(s.settled.visible, ["st1"], "hovered st1 does NOT vanish when T3's minute badge ticks 30m -> 31m");
    assert.equal(await ev(`document.querySelector('li[data-thread-item="env-1:st1"]').checkVisibility()`), true);
    // Now move pointer off Settled onto Active/Working row a1 (verifying cross-shelf pointerout resumes folding!).
    const a1Pos = await centerOf('li[data-thread-item="env-1:a1"]');
    await mouse("mouseMoved", a1Pos.x, a1Pos.y);
    await waitQuick();
    s = await snap();
    assert.deepEqual(s.settled.visible, [], "moving pointer off Settled onto Working row a1 resumes deferred fold");
    assert.equal(s.settled.toggleText, "Show 10 older");
    // Park cursor away from all rows before subsequent checks.
    await mouse("mouseMoved", 1, 1);
    await waitQuick();

    // 9. Focus transfer when focused fold toggle disappears (e.g. rule becomes No limit or all rows match):
    // Load with Snoozed open at < 12h so "Show 4 later" is visible, focus it, then change Snoozed via storage to 10 days -> focus returns to Snoozed header!
    await loadFresh({ snoozedRule: { unit: "hours", value: 12 }, settledRule: { unit: "rows", value: 3 } });
    await ev(`window.__HARNESS__.state.snoozedExpanded = true; window.__HARNESS__.renderList(); 1`);
    await settle();
    await ev(`document.querySelector('[data-t3x-shelf-toggle="snoozed"]').focus(), 1`);
    await ev(`(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "t3x:settings:v1",
        newValue: JSON.stringify({
          snoozedRule: { unit: "days", value: 10 },
          settledRule: { unit: "rows", value: 3 },
        }),
      }));
      return 1;
    })()`);
    await waitQuick();
    s = await snap();
    assert.equal(s.snoozed.toggleVisible, false);
    assert.equal(s.activeFocus, "sidebar-snoozed-shelf-toggle", "disappearing focused toggle returns focus to native shelf header");

    // 10. Stale DB cross-check: /grouping returns 72h for st1 while live DOM badge says "now" -> st1 MUST stay visible at < 1 hour!
    groupingMode = "stale-st1";
    await loadFresh({ settledRule: { unit: "hours", value: 1 } });
    await ev(`window.__HARNESS__.state.overrideBadges.st1 = "now"; window.__HARNESS__.renderList(); 1`);
    await settle();
    s = await snap();
    assert.ok(s.settled.visible.includes("st1"), "stale 72h DB snapshot overridden by live 'now' DOM badge");
    assert.equal(s.settled.visible.length, 2, "st1 ('now') and st2 (0.9h) stay visible under < 1h");
    assert.equal(s.settled.toggleText, "Show 8 older");

    // 11. Multi-select, drag-and-drop, and teardown cleanup.
    groupingMode = "live";
    await loadFresh();
    await ev(`document.querySelector('li[data-thread-item="env-1:st1"]').dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })), 1`);
    await waitQuick();
    assert.equal((await snap()).settled.visible.length, 10, "Shift-click unhides folded Settled rows");
    await realKey("Escape", "Escape", 27);
    assert.equal((await snap()).settled.visible.length, 3);
    await ev(`window.__HARNESS__.setDrag(true), 1`);
    await waitQuick();
    await ev(`window.__HARNESS__.dropSettledRow("st-dropped"), 1`);
    await settle();
    assert.equal((await snap()).settled.toggleText, "Show 8 more");
    await ev(`window.t3xTeardown(), 1`);
    await waitQuick();
    assert.equal(await ev(`document.querySelectorAll('[data-t3x-shelf-folded], [data-t3x-settled-folded], [data-t3x^="shelf-more-"]').length`), 0);

    assert.deepEqual(exceptions, []);
  } finally {
    clearTimeout(killTimer);
    try { ws?.close(); } catch {}
    chrome.kill("SIGKILL");
    await new Promise((resolve) => {
      if (chrome.exitCode != null || chrome.signalCode != null) resolve();
      else { chrome.once("exit", resolve); setTimeout(resolve, 3000); }
    });
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
