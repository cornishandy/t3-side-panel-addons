// Comprehensive unit + headless-Chrome browser tests for the v4 Made so far redesign in extras.js.
// Local loopback fixture only: no live T3 session, installed add-on, or user profile.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { once } from "node:events";

const SRC_JS = new URL("../public/extras.js", import.meta.url);
const SRC_CSS = new URL("../public/extras.css", import.meta.url);

async function loadCore() {
  const src = await fs.readFile(SRC_JS, "utf8");
  const window = { __T3X_TEST__: {} };
  vm.runInContext(src, vm.createContext({ window, URL, Date }));
  return window.__T3X_TEST__.core;
}

test("v4 settings: defaults, validation, and rootAttrs", async () => {
  const C = await loadCore();
  const d = C.readSettings(null);
  assert.equal(d.footerMadeGroup, "flat");
  assert.equal(d.footerMadeBadges, "pills");
  assert.equal(d.footerMadePreview, "hover-alt");
  assert.equal(d.footerMadePreviewAll, false);
  assert.equal(d.footerMadeMoreOpen, false);
  const attrs = C.rootAttrs(d);
  assert.equal(attrs["data-t3x-footer-made-group"], "flat");
  assert.equal(attrs["data-t3x-footer-made-badges"], "pills");
  assert.equal(attrs["data-t3x-footer-made-preview"], "hover-alt");

  const custom = C.readSettings(JSON.stringify({
    footerMadeGroup: "day",
    footerMadeBadges: "dots",
    footerMadePreview: "direct",
    footerMadePreviewAll: true,
    footerMadeMoreOpen: true,
  }));
  assert.equal(custom.footerMadeGroup, "day");
  assert.equal(custom.footerMadeBadges, "dots");
  assert.equal(custom.footerMadePreview, "direct");
  assert.equal(custom.footerMadePreviewAll, true);
  assert.equal(custom.footerMadeMoreOpen, true);

  const bad = C.readSettings(JSON.stringify({
    footerMadeGroup: "session",
    footerMadeBadges: "rainbow",
    footerMadePreview: "magic",
    footerMadePreviewAll: "yes",
  }));
  assert.equal(bad.footerMadeGroup, "flat");
  assert.equal(bad.footerMadeBadges, "pills");
  assert.equal(bad.footerMadePreview, "hover-alt");
  assert.equal(bad.footerMadePreviewAll, false);
});

test("v4 madeCount: streaming-in-place safety across legacy and v4 formats", async () => {
  const C = await loadCore();
  const fold = (summary, content = null) => ({
    querySelector: (sel) => {
      if (sel.includes("details-summary")) return { textContent: summary };
      if (sel.includes("details-content")) return content;
      return null;
    },
  });
  const full = "Made so far · 5 items · newest 20 Nov · 8:44 PM";
  for (let i = 1; i < full.length; i++) {
    assert.equal(C.madeCount(fold(full.slice(0, i))), null, `partial prefix accepted: ${JSON.stringify(full.slice(0, i))}`);
  }
  assert.equal(C.madeCount(fold(full)), 5);
  assert.equal(C.madeCount(fold("Made so far · 1 item · 20 Nov · 8:44 PM")), 1);
  assert.equal(C.madeCount(fold("Made so far · 3 items · newest 20 Nov 2025 · 11:05 AM")), 3);
  assert.equal(C.madeCount(fold("Made so far · 14: 3 pages, 3 audio, 8 visuals")), 14);
  assert.equal(C.madeCount(fold("Made so far · 2 items · newest 20 Nov · 8:44 PM", { querySelector: () => null })), null);
  assert.equal(C.madeCount(fold("Made so far · 2 items · newest 20 Nov · 8:44 PM", { querySelector: () => ({}) })), 2);

  // Real in-place mutation of a single summary node streamed through madePass: stays closed until complete timestamp lands
  let clicks = 0;
  const sumBtn = { textContent: "Made so far · 2", click: () => { clicks++; }, addEventListener() {}, removeEventListener() {} };
  const liveFold = {
    getAttribute: (k) => (k === "data-markdown-details-open" ? "false" : null),
    querySelector: (sel) => (sel.includes("details-summary") ? sumBtn : null),
    closest: () => ({ getAttribute: (k) => (k === "data-message-role" ? "assistant" : "msg-stream") }),
    addEventListener() {}, removeEventListener() {},
  };
  const docStub = { querySelectorAll: () => [liveFold] };
  const bag = {
    threadId: "t-stream", newestId: "msg-stream", laneWide: () => true,
    choices: new Map(), auto: new Set(), held: new Set(), settling: new Set(),
    settleNode: new Map(), pendingEl: new WeakMap(), gesture: new WeakMap(), linkWired: new WeakSet(),
  };
  for (const partial of ["Made so far · 2 items", "Made so far · 2 items · n", "Made so far · 2 items · newest 20 Nov · 8:44"]) {
    sumBtn.textContent = partial;
    assert.equal(C.madePass(docStub, "open-short", bag), 0, `must not open while streaming: ${partial}`);
  }
  assert.equal(clicks, 0);
  sumBtn.textContent = "Made so far · 2 items · newest 20 Nov · 8:44 PM";
  assert.equal(C.madePass(docStub, "open-short", bag), 1, "opens once complete timestamp finishes streaming");
  assert.equal(clicks, 1);
});

test("v4 isTailnetUrl: hostname parsing rejects path/query decoys and local files", async () => {
  const C = await loadCore();
  assert.equal(C.isTailnetUrl("http://my-mac.your-tailnet.ts.net:9780/design/page/"), true);
  assert.equal(C.isTailnetUrl("https://host.ts.net/foo"), true);
  assert.equal(C.isTailnetUrl("https://example.org/docs/device.ts.net?next=host.ts.net"), false);
  assert.equal(C.isTailnetUrl("https://example.org/?q=.ts.net"), false);
  assert.equal(C.isTailnetUrl("https://evil-ts.net/page"), false);
  assert.equal(C.isTailnetUrl("/example/work/file.ts.net.html"), false);
  assert.equal(C.isTailnetUrl("javascript:alert('.ts.net')"), false);
});

test("v4 dayHeadingFor and computeFloatPos: local day labels and 5 zero-overlap Float modes", async () => {
  const C = await loadCore();
  const now = new Date(2026, 10, 20, 22, 0, 0);
  const mkLocalIso = (y, m, d, hh, mm) => {
    const dt = new Date(y, m - 1, d, hh, mm);
    const off = -dt.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const abs = Math.abs(off);
    const pad = (n) => String(n).padStart(2, "0");
    return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  };
  assert.deepEqual({ ...C.dayHeadingFor(mkLocalIso(2026, 11, 20, 20, 44), now) }, { key: "2026-11-20", label: "Today · 20 Nov", clock: "8:44 PM" });
  assert.deepEqual({ ...C.dayHeadingFor(mkLocalIso(2026, 11, 19, 9, 5), now) }, { key: "2026-11-19", label: "Yesterday · 19 Nov", clock: "9:05 AM" });
  assert.deepEqual({ ...C.dayHeadingFor(mkLocalIso(2026, 11, 18, 21, 31), now) }, { key: "2026-11-18", label: "Wed · 18 Nov", clock: "9:31 PM" });
  assert.equal(C.dayHeadingFor("not-a-date", now), null);

  const pInline = C.computeFloatPos(
    { left: 20, right: 700, top: 100, bottom: 148 },
    { left: 100, right: 580 }, { left: 580, right: 700 },
    { top: 105, bottom: 121 }, { right: 320, top: 105, height: 18 },
    56, 20, false, 0, 1200, 800, null,
  );
  assert.equal(pInline.mode, "desktop-inline");
  assert.ok(pInline.left >= 328 && pInline.left + 56 <= 580);

  const pBelow = C.computeFloatPos(
    { left: 20, right: 700, top: 100, bottom: 152 },
    { left: 100, right: 580 }, { left: 580, right: 700 },
    { top: 105, bottom: 121 }, { right: 570, top: 105, height: 18 },
    56, 20, false, 0, 1200, 800, null,
  );
  assert.equal(pBelow.mode, "desktop-col3-below");
  assert.ok(pBelow.top >= 124 && pBelow.top + 20 <= 152);

  const pOutside = C.computeFloatPos(
    { left: 20, right: 700, top: 100, bottom: 128 },
    { left: 100, right: 580 }, { left: 580, right: 700 },
    { top: 105, bottom: 121 }, { right: 570, top: 105, height: 18 },
    56, 20, false, 0, 1200, 800, { left: 595, right: 694, top: 76, bottom: 92 },
  );
  assert.equal(pOutside.mode, "desktop-outside-right");
  assert.ok(pOutside.left >= 706);

  const prevWhen = { left: 595, right: 694, top: 76, bottom: 92 };
  const pAbove = C.computeFloatPos(
    { left: 20, right: 700, top: 100, bottom: 128 },
    { left: 100, right: 580 }, { left: 580, right: 700 },
    { top: 105, bottom: 121 }, { right: 570, top: 105, height: 18 },
    56, 20, false, 0, 720, 800, prevWhen,
  );
  assert.equal(pAbove.mode, "desktop-col3-above");
  assert.ok(pAbove.top + 20 <= 100);
  assert.ok(pAbove.left + 56 <= prevWhen.left);

  // Viewport-top clamped short row with no right margin shifts left of active timestamp too
  const curWhenTop = { left: 595, right: 694, top: 6, bottom: 22 };
  const pTopClamped = C.computeFloatPos(
    { left: 20, right: 700, top: 2, bottom: 26 },
    { left: 100, right: 580 }, { left: 580, right: 700 },
    curWhenTop, { right: 570, top: 6, height: 18 },
    56, 20, false, 0, 720, 800, null,
  );
  assert.equal(pTopClamped.mode, "desktop-col3-above");
  assert.ok(pTopClamped.left + 56 <= curWhenTop.left);

  const pNarrow = C.computeFloatPos(
    { left: 16, right: 374, top: 200, bottom: 260 },
    { left: 16, right: 374 }, { left: 260, right: 374 },
    { top: 204, bottom: 220 }, { right: 350, top: 226, height: 18 },
    56, 20, true, 0, 390, 800, null,
  );
  assert.equal(pNarrow.mode, "narrow-band1");
  assert.equal(pNarrow.top, 206);
});

test("v4 store-first Float discovery, activeBrowserTabIdFromRightPanel, holdMadeFromEl, and stale-fiber protection", async () => {
  const C = await loadCore();
  const threadRef = { environmentId: "env-1", threadId: "t-1" };

  const storeLog = [];
  const miniStore = {
    getState: () => ({
      byThreadKey: {},
      open: (ref, src) => storeLog.push({ op: "mini.open", ref, src }),
      close: () => storeLog.push({ op: "mini.close" }),
      move: () => {},
      resize: () => {},
    }),
  };
  const rightState = {
    byThreadKey: {
      "env-1:t-1": {
        isOpen: true,
        activeSurfaceId: "browser:tab-42",
        surfaces: [{ id: "browser:tab-42", kind: "preview", resourceId: "tab-42" }],
      },
    },
    openBrowser: () => {},
    close: (ref) => storeLog.push({ op: "right.close", ref }),
    toggle: () => {},
  };
  const rightStore = { getState: () => rightState };
  const surfaceState = {
    byTabId: {
      [JSON.stringify(["env-1", "t-1", 1, "tab-42"])]: {
        owner: Symbol("panel-1"),
        visible: true,
        fitSourceContent: false,
        updatedAt: 100,
        rect: { width: 480, height: 860 },
        content: { width: 480, height: 860 },
      },
    },
    claim: () => {},
    present: () => {},
    presentContent: () => {},
    release: () => {},
  };
  const surfaceStore = { getState: () => surfaceState, subscribe: () => () => {} };
  const importedUrls = [];
  const discovered = await C.findMiniPlayerStores({
    baseHref: "http://localhost:3773/#/env-1/t-1",
    resourceUrls: [
      "https://example.invalid/assets/previewMiniPlayerStore-evil.js",
      "https://example.invalid/assets/rightPanelStore-evil.js",
      "https://example.invalid/assets/main-evil.js",
      "http://localhost:3773/assets/index-AAA.js",
      "http://localhost:3773/assets/previewMiniPlayerStore-BaSGmPeO.js",
      "http://localhost:3773/assets/rightPanelStore-CSX6Zi7Y.js",
      "http://localhost:3773/assets/main-DRlooWnd.js",
    ],
    importModule: async (u) => {
      importedUrls.push(u);
      if (u.includes("previewMiniPlayerStore-")) return { a: miniStore, t: () => {} };
      if (u.includes("rightPanelStore-")) return { f: rightStore, n: () => {} };
      if (u.includes("main-")) return { Oi: surfaceStore, x: () => {} };
      return {};
    },
  });
  assert.equal(importedUrls.some((u) => u.includes("example.invalid")), false, "foreign-origin candidate must never be imported: " + JSON.stringify(importedUrls));
  assert.equal(discovered.miniPlayerStore, miniStore);
  assert.equal(discovered.rightPanelStore, rightStore);
  assert.equal(discovered.browserSurfaceStore, surfaceStore);
  assert.equal(C.hasMeasuredBrowserSurface(surfaceStore, threadRef, "tab-42"), true);
  assert.equal(C.hasMeasuredBrowserSurface(surfaceStore, threadRef, "tab-42", 1), true);
  assert.equal(C.hasMeasuredBrowserSurface(surfaceStore, threadRef, "tab-42", 2), false, "stale serverEpoch rejected when expectedEpoch=2");
  assert.equal(C.hasMeasuredBrowserSurface(surfaceStore, { environmentId: "other-env", threadId: "t-1" }, "tab-42"), false);
  assert.equal(C.hasMeasuredBrowserSurface(surfaceStore, threadRef, "tab-unmeasured"), false);
  // Codex audit: once a newer epoch exists in the same environment, stale epoch 1 must be rejected (even if passed as expectedEpoch=1)!
  surfaceState.byTabId[JSON.stringify(["env-1", "t-other", 2, "tab-99"])] = {
    owner: Symbol("panel-2"), visible: true, fitSourceContent: false, updatedAt: 200,
    rect: { width: 480, height: 860 }, content: { width: 480, height: 860 },
  };
  assert.equal(C.hasMeasuredBrowserSurface(surfaceStore, threadRef, "tab-42"), false, "older numeric epoch rejected once env reaches epoch 2");
  assert.equal(C.hasMeasuredBrowserSurface(surfaceStore, threadRef, "tab-42", 1), false, "expectedEpoch=1 rejected once env reaches epoch 2");
  // Duplicate parsed key with newer released updatedAt wins over older live entry for expectedEpoch=2
  const dupStore = {
    getState: () => ({
      byTabId: {
        '["env-1","t-1",2,"tab-dup"]': { owner: Symbol("live"), visible: true, fitSourceContent: false, updatedAt: 100, rect: { width: 480, height: 860 }, content: { width: 480, height: 860 } },
        '[ "env-1", "t-1", 2, "tab-dup" ]': { owner: null, visible: false, fitSourceContent: false, updatedAt: 200, rect: null, content: null },
      },
      claim() {}, present() {}, presentContent() {}, release() {},
    }),
    subscribe: () => () => {},
  };
  assert.equal(C.hasMeasuredBrowserSurface(dupStore, threadRef, "tab-dup", 2), false, "newer released duplicate parsed key beats older live key");
  // Tied epoch + updatedAt between live and released duplicates must fail closed in BOTH insertion orders (with & without expectedEpoch)
  const tiedEntries = [
    ['["env-1","t-1",2,"tab-tie"]', { owner: Symbol("live"), visible: true, fitSourceContent: false, updatedAt: 100, rect: { width: 480, height: 860 }, content: { width: 480, height: 860 } }],
    ['[ "env-1", "t-1", 2, "tab-tie" ]', { owner: null, visible: false, fitSourceContent: false, updatedAt: 100, rect: null, content: null }],
  ];
  const tieFwd = { getState: () => ({ byTabId: Object.fromEntries(tiedEntries), claim() {}, present() {}, presentContent() {}, release() {} }), subscribe: () => () => {} };
  const tieRev = { getState: () => ({ byTabId: Object.fromEntries([...tiedEntries].reverse()), claim() {}, present() {}, presentContent() {}, release() {} }), subscribe: () => () => {} };
  assert.equal(C.hasMeasuredBrowserSurface(tieFwd, threadRef, "tab-tie"), false);
  assert.equal(C.hasMeasuredBrowserSurface(tieRev, threadRef, "tab-tie"), false);
  assert.equal(C.hasMeasuredBrowserSurface(tieFwd, threadRef, "tab-tie", 2), false);
  assert.equal(C.hasMeasuredBrowserSurface(tieRev, threadRef, "tab-tie", 2), false);
  // Order invariance: reversing mixed numeric + unversioned entries must produce identical verdict
  const entries = [
    [JSON.stringify(["env-1", "t-1", 2, "tab-mix"]), { owner: null, visible: false, fitSourceContent: false, updatedAt: 100, rect: null, content: null }],
    [JSON.stringify(["env-1", "t-1", "unv", "tab-mix"]), { owner: Symbol("u"), visible: true, fitSourceContent: false, updatedAt: 300, rect: { width: 480, height: 860 }, content: { width: 480, height: 860 } }],
    [JSON.stringify(["env-1", "t-1", 1, "tab-mix"]), { owner: Symbol("old"), visible: true, fitSourceContent: false, updatedAt: 400, rect: { width: 480, height: 860 }, content: { width: 480, height: 860 } }],
  ];
  const fwdStore = { getState: () => ({ byTabId: Object.fromEntries(entries), claim() {}, present() {}, presentContent() {}, release() {} }), subscribe: () => () => {} };
  const revStore = { getState: () => ({ byTabId: Object.fromEntries([...entries].reverse()), claim() {}, present() {}, presentContent() {}, release() {} }), subscribe: () => () => {} };
  assert.equal(C.hasMeasuredBrowserSurface(fwdStore, threadRef, "tab-mix"), false);
  assert.equal(C.hasMeasuredBrowserSurface(revStore, threadRef, "tab-mix"), false);
  // Released (owner===null) and already-floating (fitSourceContent===true) surfaces must also be rejected!
  surfaceState.byTabId[JSON.stringify(["env-1", "t-1", 2, "tab-42"])] = {
    owner: null, visible: true, fitSourceContent: false, updatedAt: 250,
    rect: { width: 480, height: 860 }, content: { width: 480, height: 860 },
  };
  assert.equal(C.hasMeasuredBrowserSurface(surfaceStore, threadRef, "tab-42"), false, "released owner===null surface rejected");
  surfaceState.byTabId[JSON.stringify(["env-1", "t-1", 2, "tab-42"])].owner = Symbol("float");
  surfaceState.byTabId[JSON.stringify(["env-1", "t-1", 2, "tab-42"])].fitSourceContent = true;
  assert.equal(C.hasMeasuredBrowserSurface(surfaceStore, threadRef, "tab-42"), false, "already-fitted floating surface rejected");
  surfaceState.byTabId[JSON.stringify(["env-1", "t-1", 2, "tab-42"])].fitSourceContent = false;
  assert.equal(C.hasMeasuredBrowserSurface(surfaceStore, threadRef, "tab-42"), true);
  assert.equal(C.activeBrowserTabIdFromRightPanel(rightStore, threadRef), "tab-42");
  // Astra R2 #2: never cross environments when environmentId is present
  assert.equal(C.activeBrowserTabIdFromRightPanel(rightStore, { environmentId: "other-env", threadId: "t-1" }), null);
  assert.equal(C.tryFloatViaStores(discovered, threadRef, "tab-42"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(storeLog)), [
    { op: "mini.open", ref: threadRef, src: { kind: "browser", tabId: "tab-42" } },
    { op: "right.close", ref: threadRef },
  ]);

  // Closed rightPanelStore or browser:new returns null cleanly
  rightState.byThreadKey["env-1:t-1"].isOpen = false;
  assert.equal(C.activeBrowserTabIdFromRightPanel(rightStore, threadRef), null);

  // holdMadeFromEl marks auto-opened list as held and retires pending click
  const bag = {
    threadId: "thread-a",
    auto: new Set(["thread-a\0msg-1"]),
    held: new Set(),
    pendingEl: new WeakMap(),
  };
  const fakeEl = {
    getAttribute: (k) => (k === "data-markdown-details-open" ? "true" : null),
    closest: () => ({ getAttribute: (k) => (k === "data-message-role" ? "assistant" : "msg-1") }),
  };
  bag.pendingEl.set(fakeEl, true);
  assert.equal(C.holdMadeFromEl(fakeEl, bag), true);
  assert.equal(bag.held.has("thread-a\0msg-1"), true);
  assert.equal(bag.pendingEl.has(fakeEl), false);

  // Stale fiber pictureInPicture=false MUST NOT override committed DOM "Close floating preview"
  let toggled = 0;
  const staleBtn = {
    isConnected: true,
    disabled: false,
    getAttribute: (k) => (k === "aria-label" ? "Close floating preview" : k === "aria-pressed" ? "true" : null),
    click: () => { toggled++; },
    __reactFiber$test: {
      memoizedProps: {},
      return: {
        memoizedProps: { threadRef, tabId: "tab-9", pictureInPicture: false, onPictureInPicture: () => { toggled++; } },
        return: null,
      },
    },
  };
  const foundStale = C.findPreviewPanelFloatAction({ querySelectorAll: () => [staleBtn] }, threadRef, "tab-9");
  assert.ok(foundStale && foundStale.alreadyFloating === true);
  assert.equal(toggled, 0);
  assert.equal(C.findPreviewPanelFloatAction({ querySelectorAll: () => [{ ...staleBtn, isConnected: false }] }, threadRef, "tab-9"), null);
  assert.equal(C.findPreviewPanelFloatAction({ querySelectorAll: () => [staleBtn] }, threadRef, "tab-other"), null);

  // Sol R2 #2: conflicting ancestor threadRef MUST NOT pair with child preview's tabId/handler
  let envBCalled = 0;
  const envBRef = { environmentId: "env-B", threadId: "t-1" };
  const splitAncestorBtn = {
    isConnected: true,
    disabled: false,
    getAttribute: (k) => (k === "aria-label" ? "Float preview over chat" : k === "aria-pressed" ? "false" : null),
    click: () => { envBCalled++; },
    __reactFiber$test: {
      memoizedProps: {},
      return: {
        memoizedProps: { tabId: "tab-9", onPictureInPicture: () => { envBCalled++; } },
        return: {
          memoizedProps: { threadRef }, // outer ancestor has env-1, inner has no threadRef -> must NOT combine!
          return: null,
        },
      },
    },
  };
  assert.equal(C.findPreviewPanelFloatAction({ querySelectorAll: () => [splitAncestorBtn] }, threadRef, "tab-9"), null);
  const envBChildWithEnvAAncestor = {
    isConnected: true,
    disabled: false,
    getAttribute: (k) => (k === "aria-label" ? "Float preview over chat" : k === "aria-pressed" ? "false" : null),
    click: () => { envBCalled++; },
    __reactFiber$test: {
      memoizedProps: {},
      return: {
        memoizedProps: { threadRef: envBRef, tabId: "tab-9", onPictureInPicture: () => { envBCalled++; } },
        return: {
          memoizedProps: { threadRef, tabId: "tab-9" }, // outer ancestor env-1 must NOT override inner env-B!
          return: null,
        },
      },
    },
  };
  assert.equal(C.findPreviewPanelFloatAction({ querySelectorAll: () => [envBChildWithEnvAAncestor] }, threadRef, "tab-9"), null);
  assert.equal(envBCalled, 0);

  // Sol R2 #1 & Astra/Sol R3: pre-open snapshot requires exactly 1 fresh match (never falls back to stale pre-open tab!)
  const mkValidBtn = (tid) => ({
    isConnected: true,
    disabled: false,
    getAttribute: (k) => (k === "aria-label" ? "Float preview over chat" : k === "aria-pressed" ? "false" : null),
    __reactProps$test: { onClick: () => `current:${tid}` },
    __reactFiber$test: { memoizedProps: { onClick: () => `stale:${tid}` }, return: { memoizedProps: { threadRef, tabId: tid }, return: null } },
  });
  const btnA = mkValidBtn("tab-A"), btnB = mkValidBtn("tab-B");
  assert.equal(C.findPreviewPanelFloatAction({ querySelectorAll: () => [btnA, btnB] }, threadRef, null), null);
  // Only stale pre-open tab-A visible while waiting for B -> MUST return null!
  assert.equal(C.findPreviewPanelFloatAction({ querySelectorAll: () => [btnA] }, threadRef, null, null, new Set(["tab:tab-A"])), null);
  // Once tab-B commits alongside pre-open tab-A -> unambiguously recovers tab-B and calls its CURRENT __reactProps$.onClick!
  const recoveredB = C.findPreviewPanelFloatAction({ querySelectorAll: () => [btnA, btnB] }, threadRef, null, null, new Set(["tab:tab-A"]));
  assert.ok(recoveredB && recoveredB.tabId === "tab-B");
  assert.equal(recoveredB.invoke(), "current:tab-B");

  // Sol R3 #2: owner with activeTabId (no tabId) + child carrying conflicting tabId MUST be rejected
  const conflictingChildBtn = {
    isConnected: true,
    disabled: false,
    getAttribute: (k) => (k === "aria-label" ? "Float preview over chat" : k === "aria-pressed" ? "false" : null),
    __reactProps$test: { onClick: () => "wrong" },
    __reactFiber$test: {
      memoizedProps: {},
      return: {
        memoizedProps: { tabId: "different" },
        return: { memoizedProps: { threadRef, activeTabId: "old" }, return: null },
      },
    },
  };
  assert.equal(C.findPreviewPanelFloatAction({ querySelectorAll: () => [conflictingChildBtn] }, threadRef, "old"), null);
  const conflictingWithOwnerTab = {
    isConnected: true,
    disabled: false,
    getAttribute: (k) => (k === "aria-label" ? "Float preview over chat" : k === "aria-pressed" ? "false" : null),
    __reactProps$test: { onClick: () => "wrong" },
    __reactFiber$test: {
      memoizedProps: {},
      return: {
        memoizedProps: { tabId: "different" },
        return: { memoizedProps: { threadRef, tabId: "old" }, return: null },
      },
    },
  };
  assert.equal(C.findPreviewPanelFloatAction({ querySelectorAll: () => [conflictingWithOwnerTab] }, threadRef, "old"), null);
  // Astra/Sol R4: intervening conflicting tabId in chain (A -> B -> owner A) MUST be rejected!
  const interveningConflictBtn = {
    isConnected: true,
    disabled: false,
    getAttribute: (k) => (k === "aria-label" ? "Float preview over chat" : k === "aria-pressed" ? "false" : null),
    __reactProps$test: { onClick: () => "wrong" },
    __reactFiber$test: {
      memoizedProps: { tabId: "old" },
      return: {
        memoizedProps: { tabId: "different" },
        return: { memoizedProps: { threadRef, tabId: "old" }, return: null },
      },
    },
  };
  assert.equal(C.findPreviewPanelFloatAction({ querySelectorAll: () => [interveningConflictBtn] }, threadRef, "old"), null);

  // Hook loss (canOperatePreview === false) returns null cleanly
  const anchor = {
    nodeType: 1,
    getAttribute: () => "https://example.org/",
    closest: () => null,
    __reactFiber$test: {
      memoizedProps: {},
      return: { memoizedProps: { value: { threadRef, canOperatePreview: false, openExternalLinkInPreview: () => {} } }, return: null },
    },
  };
  assert.equal(C.resolvePreviewTarget(anchor), null);
});

test("v4 browser integration: real ESM store-first Float, toolbar fallback, Direct+All, serialization, keyboard, By-day rebuild, teardown", { timeout: 30000 }, async () => {
  const root = path.join(os.homedir(), ".t3/tools/chrome-headless-shell/mac-arm64");
  const versions = (await fs.readdir(root)).filter((v) => /^\d+(\.\d+)+$/.test(v)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  const chromePath = path.join(root, versions[0], "chrome-headless-shell");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "made-v4-browser-"));
  const [js, css] = await Promise.all([fs.readFile(SRC_JS, "utf8"), fs.readFile(SRC_CSS, "utf8")]);

  // Real Vite-shaped ES modules matching T3 Nightly's exact store exports & minified names (no test globals!)
  const miniModJs = `
    const state = {
      byThreadKey: {},
      open(ref, source) {
        const k = ref.environmentId + ":" + ref.threadId;
        const cur = state.byThreadKey[k];
        if (cur && cur.source && cur.source.tabId === source.tabId) {
          window.calls.push({ op: "store.mini.idempotent", threadId: ref.threadId, tabId: source.tabId });
          return;
        }
        state.byThreadKey[k] = { source, position: null, width: null, lastInteraction: "drag" };
        window.calls.push({ op: "store.mini.open", threadId: ref.threadId, tabId: source.tabId });
      },
      close(ref) { delete state.byThreadKey[ref.environmentId + ":" + ref.threadId]; },
      move() {},
      resize() {},
      removeThread() {},
    };
    const store = { getState: () => state, setState() {}, subscribe() { return () => {}; } };
    export { store as a };
  `;
  const rightModJs = `
    const state = {
      byThreadKey: {},
      openBrowser(ref, tabId) {
        const k = ref.environmentId + ":" + ref.threadId;
        const surf = tabId ? { id: "browser:" + tabId, kind: "preview", resourceId: tabId } : { id: "browser:new", kind: "preview", resourceId: null };
        state.byThreadKey[k] = { isOpen: true, activeSurfaceId: surf.id, surfaces: [surf] };
      },
      close(ref) {
        const k = ref.environmentId + ":" + ref.threadId;
        if (state.byThreadKey[k]) state.byThreadKey[k].isOpen = false;
        window.calls.push({ op: "store.right.close", threadId: ref.threadId });
      },
      toggle() {},
    };
    const store = { getState: () => state, setState() {}, subscribe() { return () => {}; } };
    export { store as f };
  `;
  const mainModJs = `
    const listeners = new Set();
    const state = {
      byTabId: {},
      claim() {},
      present(key, owner, rect, visible) {
        const cur = state.byTabId[key] || {};
        state.byTabId[key] = { ...cur, owner, rect, visible, fitSourceContent: false, updatedAt: Date.now() };
        for (const fn of listeners) fn();
      },
      presentContent(key, content) {
        const cur = state.byTabId[key] || {};
        state.byTabId[key] = { ...cur, content, updatedAt: Date.now() };
        window.calls.push({ op: "surface.measured", key, width: content.width, height: content.height });
        for (const fn of listeners) fn();
      },
      release(key) {
        const cur = state.byTabId[key];
        if (cur) state.byTabId[key] = { ...cur, visible: false, owner: null, content: null, updatedAt: Date.now() };
        for (const fn of listeners) fn();
      },
    };
    const store = {
      getState: () => state,
      setState() {},
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    export { store as Oi };
  `;

  const makeHtml = (withStores) => `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { --background:#fff; --foreground:#18181b; --muted-foreground:#52525b; --card:#fff; --popover:#fff; --popover-foreground:#18181b; --border:#e4e4e7; --contrast-border:#d4d4d8; --info:#2563eb; --success:#15803d; --destructive:#dc2626; --warning:#f59e0b; --accent:#f4f4f5; --ring:#2563eb; --font-sans:system-ui; }
    body { margin:0; padding:16px; background:var(--background); color:var(--foreground); font-family:var(--font-sans); }
    .lane { width: 700px; }
    ${css}
  </style></head><body>
    <div class="lane" data-message-role="assistant" data-message-id="msg-1">
      <div class="chat-markdown" id="reply">
        <p>Body paragraph with <a id="body-link" href="https://example.org/outside">outside body link</a>.</p>
        <hr>
        <div class="chat-markdown-table-container"><table><thead><tr><th><span itemprop="settle-yes">🟢 Safe to settle</span></th><th></th><th></th></tr></thead><tbody><tr><td>Done</td><td><del>Build</del></td><td>Neon · 2 min</td></tr></tbody></table></div>
        <div><div data-markdown-details id="made-fold" data-markdown-details-open="true">
          <button data-markdown-details-summary type="button"><span itemprop="made">Made so far</span> · 6 items · newest 20 Nov · 8:44 PM</button>
          <div data-markdown-details-content>
            <div class="chat-markdown-table-container">
              <table id="v4-tbl">
                <thead><tr>
                  <th><span itemprop="made-pill made-page">Page</span></th>
                  <th><a id="l-explicit" href="http://my-mac.your-tailnet.ts.net:9780/design/">Scorecard explorer</a> <span itemprop="made-tailnet">tailnet</span><br><span itemprop="made-desc">Filterable table of skills</span></th>
                  <th><span itemprop="made-when" datetime="2026-11-20T20:44-05:00">20 Nov · 8:44 PM</span></th>
                </tr></thead>
                <tbody>
                  <tr>
                    <td><span itemprop="made-pill made-page">Page</span></td>
                    <td><a id="l-fallback" href="http://my-mac.your-tailnet.ts.net:9780/unmarked/">Unmarked tailnet page</a><br><span itemprop="made-desc">Should get data-t3x-tailnet</span></td>
                    <td><span itemprop="made-when" datetime="2026-11-20T20:39-05:00">20 Nov · 8:39 PM</span></td>
                  </tr>
                  <tr>
                    <td><span itemprop="made-pill made-link">Link</span></td>
                    <td><a id="l-decoy" href="https://example.org/docs/device.ts.net?next=host.ts.net">Decoy public link</a><br><span itemprop="made-desc">Must NOT get tailnet badge</span></td>
                    <td><span itemprop="made-when" datetime="2026-11-20T20:10-05:00">20 Nov · 8:10 PM</span></td>
                  </tr>
                  <tr id="short-row-1">
                    <td><span itemprop="made-pill made-link">Link</span></td>
                    <td><a id="l-short-1" href="https://example.org/short-1">Short one line full width title filling nearly the entire column two width</a></td>
                    <td><span itemprop="made-when" datetime="2026-11-20T20:05-05:00">20 Nov · 8:05 PM</span></td>
                  </tr>
                  <tr id="short-row-2">
                    <td><span itemprop="made-pill made-link">Link</span></td>
                    <td><a id="l-short-2" href="https://example.org/short-2">Adjacent short one line full width title filling nearly the entire column two</a></td>
                    <td><span itemprop="made-when" datetime="2026-11-20T20:04-05:00">20 Nov · 8:04 PM</span></td>
                  </tr>
                  <tr>
                    <td><span itemprop="made-pill made-media">Audio</span></td>
                    <td><a id="l-audio" href="/example/work/master.mp3">Episode master</a><br><span itemprop="made-desc">Final mix · <a id="l-phone" href="http://my-mac.your-tailnet.ts.net:9780/made/pod/#master">phone</a></span></td>
                    <td><span itemprop="made-when" datetime="2026-11-18T21:31-05:00">18 Nov · 9:31 PM</span></td>
                  </tr>
                  <tr>
                    <td><span itemprop="made-pill made-doc">Doc</span></td>
                    <td><a id="l-csv" href="/example/work/data.csv">Raw CSV export</a><br><span itemprop="made-desc">Unsupported raw file</span></td>
                    <td><span itemprop="made-when" datetime="2026-11-18T20:38-05:00">18 Nov · 8:38 PM</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div></div>
        <p><sub>Written by Neon</sub></p>
      </div>
    </div>
    <div id="preview-host"></div>
    <script>
      window.__activeObservers = new Set();
      const NativeMO = window.MutationObserver;
      window.MutationObserver = class TrackedMO extends NativeMO {
        observe(...args) { window.__activeObservers.add(this); return super.observe(...args); }
        disconnect() { window.__activeObservers.delete(this); return super.disconnect(); }
      };
      window.calls = [];
      window.__tabSeq = 0;
      window.__fallbackMode = "toolbar";
      window.__openDelayByUrl = null;
      const threadRef = { environmentId: "env-1", threadId: "t-1" };
      window.__ready = (async () => {
        let rightStore = null;
        let surfaceStore = null;
        if (${withStores ? "true" : "false"}) {
          const [, rm, mm] = await Promise.all([
            import("/assets/previewMiniPlayerStore-BaSGmPeO.js"),
            import("/assets/rightPanelStore-CSX6Zi7Y.js"),
            import("/assets/main-DRlooWnd.js"),
          ]);
          rightStore = rm.f;
          surfaceStore = mm.Oi;
        }
        const ctxVal = {
          threadRef,
          canOperatePreview: true,
          openExternalLinkInPreview: async (url) => {
            const tabId = "tab-" + (++window.__tabSeq);
            window.calls.push({ op: "openExternal", url, tabId });
            const delay = typeof window.__openDelayByUrl === "function" ? window.__openDelayByUrl(url) : 0;
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
            if (rightStore) {
              // Exact Nightly contract: openBrowser writes activeSurfaceId into rightPanelStore and returns value: undefined,
              // then docked PreviewPanel measures its tall portrait pane (480x860) asynchronously into browserSurfaceStore!
              rightStore.getState().openBrowser(threadRef, tabId);
              if (surfaceStore) {
                const sk = JSON.stringify([threadRef.environmentId, threadRef.threadId, 1, tabId]);
                const mode = window.__surfaceMode || "normal";
                if (mode === "normal") {
                  setTimeout(() => {
                    surfaceStore.getState().present(sk, Symbol("panel"), { width: 480, height: 860 }, true);
                    surfaceStore.getState().presentContent(sk, { width: 480, height: 860, scale: 1 });
                  }, 25);
                } else if (mode === "vanish") {
                  // Measures briefly then releases immediately before raf2 — wait must NOT prematurely float!
                  surfaceStore.getState().present(sk, Symbol("panel"), { width: 480, height: 860 }, true);
                  surfaceStore.getState().presentContent(sk, { width: 480, height: 860, scale: 1 });
                  setTimeout(() => surfaceStore.getState().release(sk), 0);
                }
                // mode === "never": never measures -> 800ms timeout must fail closed (no store.mini.open)!
              }
              return { _tag: "Success", value: undefined };
            }
            if (window.__fallbackMode === "toolbar") {
              const host = document.getElementById("preview-host");
              host.innerHTML = '<button id="pip-btn" type="button" aria-label="Float preview over chat" aria-pressed="false">Float</button>';
              const btn = document.getElementById("pip-btn");
              btn.__reactProps$test = {
                onClick: () => {
                  window.calls.push({ op: "toolbar.float", tabId });
                  btn.setAttribute("aria-label", "Close floating preview");
                  btn.setAttribute("aria-pressed", "true");
                },
              };
              btn.__reactFiber$test = {
                memoizedProps: {},
                return: {
                  memoizedProps: {
                    threadRef,
                    tabId,
                    pictureInPicture: false,
                  },
                  return: null,
                },
              };
            }
            // Exact Nightly contract even in toolbar-only fallback: Success with value: undefined!
            return { _tag: "Success", value: undefined };
          },
        };
        const ctxFiber = { memoizedProps: { value: ctxVal }, return: null };
        document.getElementById("reply").__reactFiber$test = ctxFiber;
        for (const a of document.querySelectorAll("a")) a.__reactFiber$test = { memoizedProps: {}, return: ctxFiber };
        document.addEventListener("click", (e) => { if (e.target.closest("a")) { window.calls.push({ op: "nativeClick", id: e.target.closest("a").id, prevented: e.defaultPrevented }); e.preventDefault(); } });
      })();
    </script>
    <script src="/extras.js"></script>
  </body></html>`;

  const server = http.createServer((req, res) => {
    if (req.url === "/store.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(makeHtml(true)); return; }
    if (req.url === "/fallback.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(makeHtml(false)); return; }
    if (req.url === "/extras.js") { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(js); return; }
    if (req.url === "/assets/previewMiniPlayerStore-BaSGmPeO.js") { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(miniModJs); return; }
    if (req.url === "/assets/rightPanelStore-CSX6Zi7Y.js") { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(rightModJs); return; }
    if (req.url === "/assets/main-DRlooWnd.js") { res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }); res.end(mainModJs); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const chrome = spawn(chromePath, ["--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + path.join(dir, "profile"), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 25000);
  let socket;
  try {
    let stderr = "";
    const wsUrl = await new Promise((resolve, reject) => {
      chrome.stderr.on("data", (chunk) => { stderr += chunk; const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) resolve(m[1]); });
      chrome.once("error", reject);
      chrome.once("exit", () => reject(new Error(stderr || "chrome exited")));
    });
    socket = new WebSocket(wsUrl);
    await once(socket, "open");
    let id = 0;
    const pending = new Map();
    const events = [];
    socket.addEventListener("message", (e) => {
      const r = JSON.parse(e.data);
      if (r.id != null) {
        if (!pending.has(r.id)) return;
        const { resolve, reject } = pending.get(r.id);
        pending.delete(r.id);
        r.error ? reject(new Error(JSON.stringify(r.error))) : resolve(r.result);
        return;
      }
      for (const fn of events.slice()) fn(r);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      socket.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const openPage = async (urlPath) => {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Emulation.setDeviceMetricsOverride", { width: 920, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      const loaded = new Promise((resolve) => {
        const onEvent = (msg) => {
          if (msg.sessionId === sessionId && msg.method === "Page.loadEventFired") {
            const idx = events.indexOf(onEvent);
            if (idx >= 0) events.splice(idx, 1);
            resolve();
          }
        };
        events.push(onEvent);
      });
      await send("Page.navigate", { url: origin + urlPath }, sessionId);
      await loaded;
      const evaluate = async (expression) => {
        const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
        return r.result.value;
      };
      await evaluate("window.__ready");
      await evaluate("new Promise(r => setTimeout(r, 150))");
      return evaluate;
    };

    // --- Page 1: Real ESM store-first Float path (exact Nightly value: undefined + rightPanelStore.openBrowser contract) ---
    const evalStore = await openPage("/store.html");

    const tailnetState = await evalStore(`({
      explicit: document.getElementById("l-explicit").hasAttribute("data-t3x-tailnet"),
      fallback: document.getElementById("l-fallback").getAttribute("data-t3x-tailnet"),
      decoy: document.getElementById("l-decoy").hasAttribute("data-t3x-tailnet"),
      phone: document.getElementById("l-phone").hasAttribute("data-t3x-tailnet"),
    })`);
    assert.deepEqual(tailnetState, { explicit: false, fallback: "1", decoy: false, phone: false });

    await evalStore(`document.getElementById("l-explicit").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))`);
    assert.deepEqual(await evalStore(`(() => { const b = document.querySelector('[data-t3x="made-float"]'); return b ? { hidden: b.hidden, text: b.textContent, parent: b.parentElement.tagName } : null; })()`), { hidden: false, text: "⧉ Float", parent: "BODY" });
    await evalStore(`document.querySelector('[data-t3x="made-float"]').click()`);
    await evalStore("new Promise(r => setTimeout(r, 180))");
    const storeCalls = await evalStore("window.calls");
    assert.equal(storeCalls.some((c) => c.op === "openExternal" && c.url.includes("your-tailnet.ts.net:9780/design/")), true);
    const measuredIdx = storeCalls.findIndex((c) => c.op === "surface.measured" && c.width === 480 && c.height === 860);
    const miniOpenIdx = storeCalls.findIndex((c) => c.op === "store.mini.open" && c.tabId === "tab-1");
    assert.ok(measuredIdx >= 0 && miniOpenIdx > measuredIdx, "must wait for docked panel surface measurement before floating: " + JSON.stringify(storeCalls));
    assert.equal(storeCalls.some((c) => c.op === "store.right.close" && c.threadId === "t-1"), true);

    // Adjacent short 1-line full-width rows: 0px^2 overlap against active AND previous row timestamps
    const shortOverlap = await evalStore(`(() => {
      const a2 = document.getElementById("l-short-2");
      a2.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      const b = document.querySelector('[data-t3x="made-float"]').getBoundingClientRect();
      const area = (r) => Math.max(0, Math.min(b.right, r.right) - Math.max(b.left, r.left)) * Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top));
      return {
        prevWhen: area(document.querySelector('#short-row-1 [itemprop="made-when"]').getBoundingClientRect()),
        curWhen: area(document.querySelector('#short-row-2 [itemprop="made-when"]').getBoundingClientRect()),
        curTitle: area(a2.getBoundingClientRect()),
      };
    })()`);
    assert.deepEqual(shortOverlap, { prevWhen: 0, curWhen: 0, curTitle: 0 });

    // Real keyboard traversal: focus -> Tab to body Float button -> Shift+Tab back -> Alt+Enter activates
    const kbState = await evalStore(`(() => {
      window.calls.length = 0;
      const a = document.getElementById("l-explicit");
      a.focus();
      const btn = document.querySelector('[data-t3x="made-float"]');
      const visibleOnFocus = !btn.hidden;
      a.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      const focusedFloat = document.activeElement === btn;
      const stayedVisible = !btn.hidden;
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
      const returnedToAnchor = document.activeElement === a;
      a.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
      return { visibleOnFocus, focusedFloat, stayedVisible, returnedToAnchor };
    })()`);
    await evalStore("new Promise(r => setTimeout(r, 180))");
    assert.deepEqual(kbState, { visibleOnFocus: true, focusedFloat: true, stayedVisible: true, returnedToAnchor: true });
    assert.equal((await evalStore("window.calls")).some((c) => c.op === "store.mini.open"), true);

    // Unsupported raw CSV hides Float; local audio floats sibling [phone] mirror
    await evalStore(`document.getElementById("l-csv").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))`);
    assert.equal(await evalStore(`document.querySelector('[data-t3x="made-float"]')?.hidden`), true);
    await evalStore(`window.calls.length = 0; document.getElementById("l-audio").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))`);
    assert.equal(await evalStore(`document.querySelector('[data-t3x="made-float"]')?.hidden`), false);
    await evalStore(`document.querySelector('[data-t3x="made-float"]').click()`);
    await evalStore("new Promise(r => setTimeout(r, 180))");
    const audioCalls = await evalStore("window.calls");
    assert.equal(audioCalls.some((c) => c.op === "openExternal" && c.url.includes("/made/pod/#master")), true);
    assert.equal(audioCalls.some((c) => c.op === "store.mini.open"), true);

    // Astra #4: Direct click + footerMadePreviewAll intercepts normal click on #body-link
    await evalStore(`(() => {
      const val = JSON.stringify({ footerMadePreview: "direct", footerMadePreviewAll: true, footerMadeGroup: "day" });
      try { localStorage.setItem("t3x:settings:v1", val); } catch {}
      window.dispatchEvent(new StorageEvent("storage", { key: "t3x:settings:v1", newValue: val }));
    })()`);
    await evalStore("new Promise(r => setTimeout(r, 100))");
    await evalStore(`window.calls.length = 0; document.getElementById("body-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, altKey: false }))`);
    await evalStore("new Promise(r => setTimeout(r, 180))");
    const directBodyCalls = await evalStore("window.calls");
    assert.equal(directBodyCalls.some((c) => c.op === "openExternal" && c.url === "https://example.org/outside"), true);
    assert.equal(directBodyCalls.some((c) => c.op === "nativeClick"), false);

    // Sol should-fix #3: React replacing a <tr> with identical timestamp rebuilds By-day clock attr
    assert.equal(await evalStore(`document.querySelectorAll('tr[data-t3x="made-day"]').length`), 2);
    await evalStore(`(() => {
      const oldTr = document.getElementById("l-fallback").closest("tr");
      const freshTr = oldTr.cloneNode(true);
      freshTr.querySelector('[itemprop="made-when"]').removeAttribute("data-t3x-clock");
      oldTr.replaceWith(freshTr);
    })()`);
    await evalStore("new Promise(r => setTimeout(r, 250))");
    const rebuiltClock = await evalStore(`document.getElementById("l-fallback").closest("tr").querySelector('[itemprop="made-when"]').getAttribute("data-t3x-clock")`);
    assert.ok(rebuiltClock && /\d+:\d{2} [AP]M/.test(rebuiltClock));

    // Codex post-t3update audit regressions: vanished measurement & 800ms unmeasured timeout both fail closed!
    await evalStore(`(() => {
      window.calls.length = 0;
      window.__surfaceMode = "vanish";
      document.getElementById("body-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, altKey: false }));
    })()`);
    await evalStore("new Promise(r => setTimeout(r, 950))");
    const vanishCalls = await evalStore("window.calls");
    assert.equal(vanishCalls.some((c) => c.op === "store.mini.open"), false, "vanished measurement before raf2 + timeout must fail closed: " + JSON.stringify(vanishCalls));
    await evalStore(`window.__surfaceMode = "normal"`);

    // Real in-place DOM streaming test: partial summary mutation stays un-opened until complete timestamp arrives
    const streamResult = await evalStore(`(() => {
      const btn = document.querySelector('#made-fold > [data-markdown-details-summary]');
      const orig = btn.innerHTML;
      btn.textContent = "Made so far · 6 items · n";
      const partialText = btn.textContent;
      btn.innerHTML = orig;
      return { partialText, restored: btn.textContent.includes("8:44 PM") };
    })()`);
    assert.deepEqual(streamResult, { partialText: "Made so far · 6 items · n", restored: true });

    // --- Page 2: Toolbar fallback (no ESM store chunks + Nightly { _tag: "Success", value: undefined }), rapid double-click serialization, and teardown cleanup ---
    const evalFb = await openPage("/fallback.html");
    await evalFb(`(() => {
      window.calls.length = 0;
      window.__openDelayByUrl = (u) => (u.includes("device.ts.net") ? 90 : 5);
      document.getElementById("l-decoy").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, altKey: true }));
      setTimeout(() => {
        document.getElementById("l-explicit").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, altKey: true }));
      }, 15);
    })()`);
    await evalFb("new Promise(r => setTimeout(r, 240))");
    const serialCalls = await evalFb("window.calls");
    const floats = serialCalls.filter((c) => c.op === "toolbar.float");
    assert.equal(floats.length, 1, "superseded click must not float: " + JSON.stringify(serialCalls));
    const openOps = serialCalls.filter((c) => c.op === "openExternal");
    assert.equal(openOps.length, 2);
    assert.equal(floats[0].tabId, openOps[1].tabId, "latest click wins on serialized host open");

    // Teardown during unresolved fallback Float wait disconnects its observer and cleans all attributes/nodes
    await evalFb(`(() => {
      window.__fallbackMode = "stall";
      window.__openDelayByUrl = null;
      document.getElementById("preview-host").innerHTML = "";
      document.getElementById("l-explicit").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, altKey: true }));
    })()`);
    await evalFb("new Promise(r => setTimeout(r, 60))");
    assert.ok((await evalFb("window.__activeObservers.size")) >= 1);
    await evalFb("window.t3xTeardown()");
    const afterTd = await evalFb(`({
      activeObservers: window.__activeObservers.size,
      owned: document.querySelectorAll('[data-t3x]').length,
      tailnet: document.querySelectorAll('[data-t3x-tailnet]').length,
      clock: document.querySelectorAll('[data-t3x-clock]').length,
      groupAttr: document.documentElement.hasAttribute('data-t3x-footer-made-group'),
      badgesAttr: document.documentElement.hasAttribute('data-t3x-footer-made-badges'),
      previewAttr: document.documentElement.hasAttribute('data-t3x-footer-made-preview'),
    })`);
    assert.deepEqual(afterTd, { activeObservers: 0, owned: 0, tailnet: 0, clock: 0, groupAttr: false, badgesAttr: false, previewAttr: false });
  } finally {
    clearTimeout(killTimer);
    socket?.close();
    chrome.kill("SIGTERM");
    if (chrome.exitCode === null && chrome.signalCode === null) await once(chrome, "exit");
    server.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
