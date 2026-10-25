/* t3-extras grouping */
(function (root) {
  "use strict";
  const KEY = "t3x:grouping:v1";
  const BASE = String(root.t3xGroupingBase || "http://127.0.0.1:8793/").replace(/\/?$/, "/");
  const MODES = [
    ["native", "Native shelves", "Native shelves"],
    ["activity", "Activity", "Activity"],
    ["recent", "Recent runs", "Recent run activity"],
    ["project", "Project", "Project"],
  ];
  const SORTS = [
    ["recent", "Recent runs", "Recent run activity"],
    ["title", "Title", "Title"],
    ["created", "Created", "Created"],
  ];
  const ACTIVITY = [
    ["questions", "Questions & approvals", "Questions / approvals", false],
    ["running", "Run in progress", "Running", false],
    ["child", "Child work recorded", "Child work", false],
    ["open", "Other open threads", "Other", false],
    ["unknown", "State unavailable", "Unavailable", false],
  ];
  const BUCKETS = [
    ["m15", "Last 15 minutes", "15 min", false],
    ["m60", "15–60 minutes", "15–60 min", false],
    ["today", "Earlier today", "Today", false],
    ["yesterday", "Yesterday", "Yesterday", false],
    ["week", "Previous 7 days", "7 days", false],
    ["older", "Older", "Older", true],
    ["unread", "Timing unavailable", "Timing unknown", false],
    ["none", "No recorded run activity", "No run time", false],
  ];
  const QUESTION_BADGES = new Set([
    "Recorded input or approval",
    "Recorded question",
    "Recorded secret request",
    "Recorded proposed plan",
    "Recorded approval request",
  ]);
  const MESSAGE = {
    native: "Native shelves are showing. Pick another group to open this Mac's index.",
    anchor: "Couldn't find the thread list, so this index stays off.",
    search: "Search is active, so this index is paused. The native list stays in charge.",
    filter: "A project filter is active, so this index is paused. The native list stays in charge.",
    loading: "Reading this Mac's thread index.",
    unavailable: "Thread index unavailable. The native list stays.",
    identity: "This sidebar isn't proven to be this Mac, so the index stays off.",
    stale: "This snapshot is over a minute old, so the native list stays.",
  };

  try { root.t3xGroupingTeardown?.(); } catch { /* a previous copy of this script */ }

  let generation = 0;
  let settings = readSettings();
  let snapshot = null;
  let poll = null;
  let guard = null;
  let inflight = null;
  let observer = null;
  let modeSelect = null;
  let sortSelect = null;
  let statusEl = null;
  let countEl = null;
  let cueEl = null;
  let methodEl = null;
  let detailsEl = null;
  let detailsOpen = false;
  let groupsEl = null;
  let rootEl = null;
  const doc = () => root.document;

  function normId(id) { return String(id ?? "").trim().replace(/^mcp:/, ""); }
  function parseRoute(hash) {
    const path = String(hash ?? "").replace(/^#/, "").split(/[?#]/)[0];
    let parts;
    try { parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); }
    catch { return { kind: "unknown" }; }
    const notThreads = new Set(["settings", "draft", "projects", "pull-requests", "pair", "usage", "welcome"]);
    if (parts[0] === "draft") return { kind: "draft" };
    if (parts.length === 2 && !notThreads.has(parts[0]) && /^[A-Za-z0-9:_-]{6,}$/.test(parts[0]) && /^[A-Za-z0-9:_-]{6,}$/.test(parts[1])) {
      return { kind: "thread", environmentId: parts[0], threadId: parts[1] };
    }
    return { kind: parts.length ? "other" : "home" };
  }
  function parseThreadItem(value) {
    if (typeof value !== "string") return null;
    const split = value.indexOf(":");
    if (split <= 0) return null;
    const env = value.slice(0, split);
    const threadId = value.slice(split + 1);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(env) || !threadId || threadId.length > 300) return null;
    return { env, threadId };
  }
  function readSettings() {
    try {
      const raw = JSON.parse(root.localStorage.getItem(KEY) || "null");
      const mode = MODES.some(([id]) => id === raw?.mode) ? raw.mode : "native";
      const sort = SORTS.some(([id]) => id === raw?.sort) ? raw.sort : "recent";
      const collapsed = raw?.collapsed && typeof raw.collapsed === "object" ? raw.collapsed : {};
      return { mode, sort, collapsed };
    } catch {
      return { mode: "native", sort: "recent", collapsed: {} };
    }
  }
  function save() {
    try { root.localStorage.setItem(KEY, JSON.stringify({ v: 1, mode: settings.mode, sort: settings.sort, collapsed: settings.collapsed })); }
    catch { /* private mode: the choice lasts for this page only */ }
  }
  function sortThreads(threads, sort) {
    const out = threads.slice();
    out.sort((a, b) => {
      let diff = 0;
      if (sort === "title") diff = String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base", numeric: true });
      else if (sort === "created") diff = (b.createdAt ?? -1) - (a.createdAt ?? -1);
      else diff = (b.activityAt ?? -1) - (a.activityAt ?? -1);
      if (diff) return diff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return out;
  }
  function collapsedDefault(id, count, older) {
    if (id === "snoozed" || id === "settled") return true;
    if (older && count > 15) return true;
    return false;
  }
  function isCollapsed(id, count, older) {
    if (Object.prototype.hasOwnProperty.call(settings.collapsed, id)) return Boolean(settings.collapsed[id]);
    return collapsedDefault(id, count, older);
  }
  function present(threads, mode, sort) {
    const sorted = sortThreads(Array.isArray(threads) ? threads : [], sort);
    const pinned = sorted.filter((thread) => thread.shelf === "pinned");
    const snoozed = sorted.filter((thread) => thread.shelf === "snoozed");
    const settled = sorted.filter((thread) => thread.shelf === "settled");
    const main = sorted.filter((thread) => thread.shelf === "main");
    const groups = [];
    if (pinned.length) groups.push({ id: "pinned", long: "Pinned", short: "Pinned", threads: pinned, older: false });
    if (mode === "activity") {
      for (const [id, long, short] of ACTIVITY) {
        const rows = main.filter((thread) => thread.activity === id);
        if (!rows.length && id !== "questions") continue;
        groups.push({ id, long, short, threads: rows, older: false });
      }
    } else if (mode === "recent") {
      for (const [id, long, short, older] of BUCKETS) {
        const rows = main.filter((thread) => thread.recentBucket === id);
        if (!rows.length) continue;
        groups.push({ id, long, short, threads: rows, older });
      }
    } else if (mode === "project") {
      const map = new Map();
      for (const thread of main) {
        const key = thread.projectId || "";
        if (!map.has(key)) map.set(key, { id: key ? `p:${key}` : "p:none", long: thread.projectLabel || "No project", short: thread.projectLabel || "No project", threads: [], none: !key });
        map.get(key).threads.push(thread);
      }
      const list = [...map.values()].sort((a, b) => {
        if (a.none !== b.none) return a.none ? 1 : -1;
        return a.long.localeCompare(b.long, undefined, { sensitivity: "base" });
      });
      groups.push(...list.map((group) => ({ ...group, older: false })));
    }
    if (snoozed.length) groups.push({ id: "snoozed", long: "Snoozed", short: "Snoozed", threads: snoozed, older: false });
    if (settled.length) groups.push({ id: "settled", long: "Settled", short: "Settled", threads: settled, older: false });
    return groups;
  }
  function identityOk(localEnv, rows, route) {
    if (!localEnv) return false;
    let sawLocal = false;
    let sawOther = false;
    let sawCompact = false;
    for (const row of rows || []) {
      if (!row.env) {
        if (row.compact) sawCompact = true;
        continue;
      }
      if (normId(row.env) === normId(localEnv)) sawLocal = true;
      else sawOther = true;
    }
    if (sawOther) return false;
    if (sawLocal || (route?.kind === "thread" && normId(route.environmentId) === normId(localEnv))) return true;
    if (sawCompact) return false;
    return false;
  }
  function scanRows(inner) {
    const rows = [];
    if (!inner?.querySelectorAll) return rows;
    for (const li of inner.querySelectorAll("li[data-thread-item]")) {
      const item = parseThreadItem(li.getAttribute("data-thread-item"));
      rows.push(item ? { env: item.env, threadId: item.threadId, compact: false } : { env: null, threadId: null, compact: true });
    }
    return rows;
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = root.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }
  function anchor() {
    const all = [...doc().querySelectorAll('[data-slot="sidebar-inner"] [data-slot="sidebar-content"]')];
    const shown = all.filter(visible);
    return shown.length === 1 ? shown[0] : null;
  }
  function innerOf(host) {
    return host?.closest?.("[data-slot='sidebar-inner']") ?? null;
  }
  function searchActive() {
    const inner = innerOf(anchor());
    if (!inner) return false;
    for (const el of inner.querySelectorAll("input, [role='combobox']")) {
      if (el.getAttribute("aria-label") === "Search threads" && String(el.value || "").trim()) return true;
    }
    return false;
  }
  function filterActive() {
    const inner = innerOf(anchor());
    if (!inner) return false;
    for (const el of inner.querySelectorAll("[aria-label]")) {
      if (String(el.getAttribute("aria-label") || "").startsWith("Filter threads by project:")) return true;
    }
    return false;
  }
  function reason() {
    if (settings.mode === "native") return "native";
    if (!anchor()) return "anchor";
    if (searchActive()) return "search";
    if (filterActive()) return "filter";
    if (!snapshot) return "loading";
    if (snapshot.ok !== true || !Array.isArray(snapshot.threads)) return "unavailable";
    if (!identityOk(snapshot.localEnvironmentId, scanRows(innerOf(anchor())), parseRoute(root.location?.hash))) return "identity";
    if (typeof snapshot.asOf !== "number" || Date.now() - snapshot.asOf > 60_000) return "stale";
    return "";
  }
  let lastFetch = 0;
  function shouldFetch() {
    if (settings.mode === "native" || doc().visibilityState === "hidden") return false;
    if (!anchor() || searchActive() || filterActive()) return false;
    if (snapshot?.localEnvironmentId && !identityOk(snapshot.localEnvironmentId, scanRows(innerOf(anchor())), parseRoute(root.location?.hash))) return false;
    return true;
  }
  function maybeFetch(force) {
    if (!shouldFetch()) return;
    if (!force && Date.now() - lastFetch < 14_000) return;
    fetchNow();
  }

  function el(tag, attrs, text) {
    const node = doc().createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value != null) node.setAttribute(key, value);
    }
    if (text != null) node.textContent = text;
    return node;
  }
  function ageText(thread, asOf) {
    if (thread.activitySource === "unavailable") return "timing unavailable";
    if (thread.activitySource === "observed" && Number.isFinite(thread.activityAt)) return `observed ${fmtAge(asOf - thread.activityAt)}`;
    if (thread.activitySource === "created" && Number.isFinite(thread.activityAt)) return `created ${fmtAge(asOf - thread.activityAt)}`;
    if (thread.activitySource === "none" || !Number.isFinite(thread.activityAt)) return "no recorded run activity";
    return fmtAge(asOf - thread.activityAt);
  }
  function questionsEmptyText(threads, coverage) {
    // Questions holds main-shelf rows only. A pinned question is outside that group.
    const inQuestions = (thread) => thread.shelf === "main" && thread.activity === "questions";
    const knownRequest = (thread) => thread.activity === "questions" || (thread.badges || []).some((badge) => QUESTION_BADGES.has(badge));
    const outside = (threads || []).some((thread) => knownRequest(thread) && !inQuestions(thread));
    if (outside || coverage?.questionsUnread) {
      return "No questions or approvals in this group. A known request can sit on another row, and an unfinished read is not proof there are none.";
    }
    // A finished read is not proof the snapshot has no questions. Unknown request
    // or plan semantics stay out of this group, so the empty line stays group-scoped.
    return "No questions or approvals in this group.";
  }
  function fmtAge(ms) {
    const minutes = Math.floor(Math.max(0, ms) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  }
  function countSentence() {
    const coverage = snapshot?.coverage;
    if (!coverage) return "";
    return coverage.truncated
      ? `Showing ${coverage.returned} of ${coverage.eligible}. This index stops at ${coverage.cap}.`
      : `${coverage.eligible} top-level threads.`;
  }
  function incompleteCue() {
    const coverage = snapshot?.coverage;
    if (!coverage) return "";
    if (coverage.factsIncomplete || coverage.questionsUnread || coverage.childLinksTruncated) {
      return "Read incomplete. State unavailable can be an unread fact, not only a cutoff.";
    }
    return "";
  }
  function methodText() {
    const coverage = snapshot?.coverage;
    if (!coverage || typeof snapshot.asOf !== "number") return "";
    const when = new Date(snapshot.asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const parts = [];
    if (coverage.childLinksTruncated) parts.push("Child evidence was cut off, so some threads say State unavailable instead of showing no child work.");
    if (coverage.factsIncomplete) parts.push("Some recorded requests, approvals or plans were cut off, so those threads say State unavailable instead of showing no blocker.");
    if (coverage.omittedUnsafeIds) parts.push(`${coverage.omittedUnsafeIds} rows omitted for an unusual id.`);
    parts.push(`Snapshot ${when}.`);
    return parts.join(" ");
  }
  function icon(kind) {
    const svg = doc().createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "t3x-g-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const add = (tag, attrs) => {
      const node = doc().createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      svg.append(node);
    };
    const stroke = { fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round" };
    const mark = "M9.6 9.4a2.4 2.4 0 1 1 3.5 2.1c-.7.4-1.1.9-1.1 1.7V14.2M12 17h.01";
    if (kind === "pin") add("path", { ...stroke, d: "M9 3.5h6M10.2 3.5 11 8H8l4 5 4-5h-3l.8-4.5M12 13v7.5" });
    else if (kind === "chat") add("path", { ...stroke, d: "M5 6.5h14v8.5H9L5 18.5V6.5z" });
    else if (kind === "activity") add("path", { ...stroke, d: "M3.5 12h3.2l2.2-5 3.8 10 2.3-5H20.5" });
    else if (kind === "branch") {
      add("circle", { ...stroke, cx: "7", cy: "6", r: "2" });
      add("circle", { ...stroke, cx: "7", cy: "18", r: "2" });
      add("circle", { ...stroke, cx: "17", cy: "7", r: "2" });
      add("path", { ...stroke, d: "M7 8v8M7 12c4 0 5.5-1.5 8-5" });
    } else if (kind === "folder") add("path", { ...stroke, d: "M4 8h6l2 2h8v9H4V8z" });
    else if (kind === "clock") {
      add("circle", { ...stroke, cx: "12", cy: "12", r: "8" });
      add("path", { ...stroke, d: "M12 8v5l3 2" });
    } else if (kind === "question") {
      add("circle", { ...stroke, cx: "12", cy: "12", r: "8" });
      add("path", { ...stroke, d: mark });
    } else if (kind === "unknown") {
      add("rect", { ...stroke, x: "4", y: "4", width: "16", height: "16", rx: "3" });
      add("path", { ...stroke, d: mark });
    } else if (kind === "snooze") add("path", { ...stroke, d: "M5 7h7L5 14h7M13 13h6l-6 6h6" });
    else if (kind === "archive") {
      add("path", { ...stroke, d: "M4 7h16v3H4zM6 10v8h12v-8M10 14h4" });
    } else if (kind === "chevronDown") add("path", { ...stroke, d: "M6 9l6 6 6-6" });
    else add("path", { ...stroke, d: "M9 6l6 6-6 6" });
    return svg;
  }
  function groupIcon(id) {
    const known = { pinned: "pin", questions: "question", running: "activity", child: "branch", open: "chat", unknown: "unknown", snoozed: "snooze", settled: "archive" };
    if (known[id]) return known[id];
    if (String(id).startsWith("p:")) return "folder";
    return "clock";
  }
  function stateIcon(thread) {
    if (thread.activity === "unknown" || thread.activityLabel === "State unavailable") return "unknown";
    return groupIcon(thread.activity);
  }
  function collapsedAttention(group, open) {
    if (open) return "";
    const threads = group.threads || [];
    const has = (pred) => threads.some(pred);
    let text = "";
    if (has((thread) => (thread.badges || []).some((badge) => QUESTION_BADGES.has(badge)))) text = "Request recorded";
    else if (has((thread) => thread.activity === "child" || (thread.badges || []).includes("Child work recorded"))) text = "Child recorded";
    else if (has((thread) => thread.activity === "running")) text = "Run in progress";
    else if (group.id !== "unknown" && has((thread) => thread.activity === "unknown" || thread.activityLabel === "State unavailable")) text = "State unavailable";
    if (!text || text === group.long || text === group.short) return "";
    return text;
  }
  function renderThread(thread, route, env) {
    const current = route.kind === "thread" && normId(route.environmentId) === normId(env) && normId(route.threadId) === normId(thread.id);
    const link = el("a", {
      href: `#/${encodeURIComponent(env)}/${encodeURIComponent(thread.id)}`,
      "data-thread-id": thread.id, "data-t3x-g-focus": `thread:${thread.id}`,
    });
    if (current) link.setAttribute("aria-current", "page");
    link.title = thread.detail || thread.activityLabel;
    link.append(el("span", { class: "t3x-g-title" }, thread.title));
    const meta = el("span", { class: "t3x-g-meta" });
    meta.append(el("span", { class: "t3x-g-project" }, thread.projectLabel || "No project"));
    meta.append(el("span", { class: "t3x-g-age" }, ageText(thread, snapshot.asOf)));
    link.append(meta);
    const state = el("span", { class: "t3x-g-state" });
    state.append(icon(stateIcon(thread)));
    state.append(el("span", { class: "t3x-g-state-text" }, thread.activityLabel || ""));
    link.append(state);
    if (thread.badges?.length) {
      const badges = el("span", { class: "t3x-g-badges" });
      for (const badge of thread.badges) badges.append(el("span", { class: "t3x-g-badge" }, badge));
      link.append(badges);
    }
    return link;
  }
  function renderGroup(group, route, env) {
    const open = !isCollapsed(group.id, group.threads.length, group.older);
    const header = el("button", {
      type: "button", "data-t3x-g-toggle": group.id, "data-t3x-g-focus": `toggle:${group.id}`,
      "aria-expanded": open ? "true" : "false",
    });
    header.append(icon(groupIcon(group.id)), icon(open ? "chevronDown" : "chevron"));
    header.append(el("span", { class: "t3x-g-long" }, group.long), el("span", { class: "t3x-g-short" }, group.short));
    const attention = collapsedAttention(group, open);
    if (attention) header.append(el("span", { class: "t3x-g-attn" }, attention));
    header.append(el("span", { class: "t3x-g-count" }, String(group.threads.length)));
    const section = el("section", { "data-group": group.id });
    section.append(header);
    if (open) {
      if (!group.threads.length) section.append(el("p", { class: "t3x-g-empty" }, questionsEmptyText(snapshot.threads, snapshot.coverage)));
      for (const thread of group.threads) section.append(renderThread(thread, route, env));
    }
    return section;
  }
  let pendingPaint = false;
  let lastHost = null;
  function focusInsideGroups() {
    const active = doc().activeElement;
    return !!(active && groupsEl && groupsEl.contains(active));
  }
  function captureAnchors(scroller) {
    if (!scroller || !groupsEl) return [];
    const view = scroller.getBoundingClientRect();
    const found = [];
    for (const node of groupsEl.querySelectorAll("[data-t3x-g-focus]")) {
      const box = node.getBoundingClientRect();
      if (box.height <= 0 || box.width <= 0) continue;
      if (box.bottom <= view.top + 1 || box.top >= view.bottom - 1) continue;
      found.push({ key: node.getAttribute("data-t3x-g-focus"), offset: box.top - view.top });
      if (found.length >= 4) break;
    }
    return found;
  }
  function restoreAnchors(scroller, anchors) {
    if (!scroller || !anchors.length) return;
    for (const anchor of anchors) {
      if (!anchor.key) continue;
      const again = groupsEl.querySelector(`[data-t3x-g-focus="${cssEscape(anchor.key)}"]`);
      if (!again) continue;
      const view = scroller.getBoundingClientRect();
      const box = again.getBoundingClientRect();
      const delta = box.top - view.top - anchor.offset;
      if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
      return;
    }
  }
  function paint(opts = {}) {
    if (!rootEl) return;
    const why = reason();
    const show = why === "";
    const host = anchor();
    if (snapshot?.asOf) rootEl.dataset.asof = String(snapshot.asOf);
    if (!opts.userAction && show && focusInsideGroups() && rootEl.isConnected && host && rootEl.parentElement === host) {
      pendingPaint = true;
      return;
    }
    pendingPaint = false;
    if (show) {
      rootEl.setAttribute("data-ready", "1");
      doc().documentElement.setAttribute("data-t3x-grouping", "active");
    } else {
      rootEl.removeAttribute("data-ready");
      doc().documentElement.removeAttribute("data-t3x-grouping");
    }
    statusEl.textContent = show ? "" : (MESSAGE[why] || MESSAGE.unavailable);
    if (countEl) countEl.textContent = show ? countSentence() : "";
    if (cueEl) {
      const cue = show ? incompleteCue() : "";
      cueEl.textContent = cue;
      cueEl.hidden = !cue;
    }
    if (methodEl) methodEl.textContent = methodText();
    const scroller = scrollParent(rootEl);
    const anchors = captureAnchors(scroller);
    const active = doc().activeElement;
    const focusKey = active && rootEl.contains(active) ? active.getAttribute("data-t3x-g-focus") : null;
    groupsEl.replaceChildren();
    if (show) {
      const route = parseRoute(root.location.hash);
      const env = snapshot.localEnvironmentId;
      for (const group of present(snapshot.threads, settings.mode, settings.sort)) {
        groupsEl.append(renderGroup(group, route, env));
      }
    }
    restoreAnchors(scroller, anchors);
    if (focusKey) {
      const again = rootEl.querySelector(`[data-t3x-g-focus="${cssEscape(focusKey)}"]`);
      if (again && again !== doc().activeElement) again.focus({ preventScroll: true });
    }
  }
  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === "function") return root.CSS.escape(value);
    return String(value).replace(/[^A-Za-z0-9_-]/g, "\\$&");
  }
  function scrollParent(node) {
    let current = node?.parentElement;
    while (current) {
      const style = root.getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(`${style.overflow}`)) return current;
      current = current.parentElement;
    }
    return null;
  }
  let lastGate = "";
  function hostAttached(host) {
    return !!(host && rootEl && rootEl.isConnected && rootEl.parentElement === host);
  }
  function reconcile(force, userAction) {
    const host = anchor();
    const attached = hostAttached(host);
    const gate = `${settings.mode}|${settings.sort}|${reason()}|${snapshot?.asOf || 0}|${attached ? 1 : 0}`;
    if (!force && host === lastHost && attached && gate === lastGate) return;
    lastHost = host;
    lastGate = gate;
    mount();
    paint({ userAction: !!userAction });
    if (pendingPaint) lastGate = "";
  }
  function fetchNow() {
    lastFetch = Date.now();
    const gen = generation;
    inflight?.abort();
    const ctrl = new root.AbortController();
    inflight = ctrl;
    root.fetch(`${BASE}grouping`, { cache: "no-store", signal: ctrl.signal }).then((res) => {
      if (!res.ok) throw new Error("status");
      return res.json();
    }).then((body) => {
      if (gen !== generation) return;
      snapshot = body && typeof body === "object" ? body : { ok: false, threads: null };
      reconcile(true);
    }).catch((error) => {
      if (gen !== generation || error?.name === "AbortError") return;
      snapshot = { ok: false, unavailable: true, reason: "read", threads: null, asOf: Date.now() };
      reconcile(true);
    });
  }
  function arm() {
    if (poll) clearInterval(poll);
    if (guard) clearInterval(guard);
    poll = null;
    guard = null;
    if (doc().visibilityState === "hidden") {
      reconcile(true);
      return;
    }
    if (settings.mode !== "native") {
      guard = root.setInterval(() => { reconcile(false); maybeFetch(false); }, 400);
      poll = root.setInterval(() => maybeFetch(true), 15_000);
      maybeFetch(true);
    }
    reconcile(true);
  }
  function mount() {
    const host = anchor();
    if (!host || !rootEl) return;
    if (rootEl.parentElement !== host || host.firstElementChild !== rootEl) host.insertBefore(rootEl, host.firstChild);
  }
  function addChoices(select, rows) {
    for (const [id, visible, accessible] of rows) {
      const option = el("option", { value: id, "aria-label": accessible }, visible);
      if (accessible !== visible) option.title = accessible;
      select.append(option);
    }
  }
  function build() {
    rootEl = el("div", { "data-t3x": "grouping-root", "data-t3x-grouping-root": "" });
    const bar = el("div", { class: "t3x-g-bar" });
    const modeLabel = el("label", { class: "t3x-g-field" });
    modeLabel.append(el("span", { class: "t3x-g-word" }, "Group"));
    modeSelect = el("select", { id: "t3x-g-mode", "data-t3x-g-focus": "mode", "aria-describedby": "t3x-g-scope" });
    addChoices(modeSelect, MODES);
    modeSelect.value = settings.mode;
    modeLabel.append(modeSelect);
    const sortLabel = el("label", { class: "t3x-g-field t3x-g-field-sort" });
    sortLabel.append(el("span", { class: "t3x-g-word" }, "Sort"));
    sortSelect = el("select", {
      id: "t3x-g-sort", "data-t3x-g-focus": "sort",
      title: "Sort applies only to this index. Recent run activity is request, start and finish times, not token updates.",
    });
    addChoices(sortSelect, SORTS);
    sortSelect.value = settings.sort;
    sortLabel.append(sortSelect);
    const native = el("button", {
      type: "button", "data-t3x-g-native": "", "data-t3x-g-focus": "native",
      "aria-label": "Native shelves for thread actions",
      title: "Native shelves for thread actions. Menus, drag and multiselect stay on Native shelves.",
    }, "Native");
    bar.append(modeLabel, sortLabel, native);
    const scope = el("p", { id: "t3x-g-scope", class: "t3x-g-scope" }, "This Mac · top-level threads");
    scope.title = "Project groups are physical project ids (local paths), not T3's repository grouping. Recent run activity uses request, start and finish times. A row marked created has no run event, and only after both time reads finished. Unread timing stays unavailable, not created or Older. Child work is recorded at most two levels in this snapshot, not the Waiting shelf, and there is no pull-request wait. Menus, drag and multiselect stay on Native shelves. This index is not the Working shelf.";
    countEl = el("p", { class: "t3x-g-counts" }, "");
    const line = el("div", { class: "t3x-g-line" });
    line.append(scope, countEl);
    cueEl = el("p", { class: "t3x-g-cue", hidden: "" }, "");
    detailsEl = el("details", { class: "t3x-g-details" });
    const summary = el("summary", { "data-t3x-g-focus": "details" }, "Index details");
    const note = el("p", { class: "t3x-g-note" }, "Project (local paths). Child work is recorded at most two levels, not the Waiting shelf. There is no pull-request wait.");
    methodEl = el("p", { class: "t3x-g-method" }, "");
    detailsEl.append(summary, note, methodEl);
    detailsEl.open = detailsOpen;
    detailsEl.addEventListener("toggle", () => { detailsOpen = detailsEl.open; });
    statusEl = el("p", { class: "t3x-g-status", "aria-live": "polite" }, "");
    groupsEl = el("div", { class: "t3x-g-groups" });
    rootEl.append(bar, line, cueEl, detailsEl, statusEl, groupsEl);
    rootEl.addEventListener("change", (event) => {
      if (event.target === modeSelect) {
        settings.mode = MODES.some(([id]) => id === modeSelect.value) ? modeSelect.value : "native";
        save();
        arm();
      } else if (event.target === sortSelect) {
        settings.sort = SORTS.some(([id]) => id === sortSelect.value) ? sortSelect.value : "recent";
        save();
        reconcile(true, true);
      }
    });
    rootEl.addEventListener("click", (event) => {
      if (event.target.closest("[data-t3x-g-native]")) {
        settings.mode = "native";
        modeSelect.value = "native";
        save();
        arm();
        return;
      }
      const toggle = event.target.closest("[data-t3x-g-toggle]");
      if (!toggle) return;
      const id = toggle.getAttribute("data-t3x-g-toggle");
      settings.collapsed[id] = toggle.getAttribute("aria-expanded") === "true";
      save();
      reconcile(true, true);
    });
    rootEl.addEventListener("focusout", () => {
      root.setTimeout(() => {
        if (!pendingPaint || focusInsideGroups()) return;
        paint({ userAction: false });
      }, 0);
    });
  }
  function ownCleanup() {
    generation++;
    if (poll) clearInterval(poll);
    if (guard) clearInterval(guard);
    poll = null;
    guard = null;
    inflight?.abort();
    inflight = null;
    observer?.disconnect();
    observer = null;
    rootEl?.remove();
    rootEl = null;
    try { doc()?.documentElement?.removeAttribute("data-t3x-grouping"); } catch { /* document already gone */ }
    root.removeEventListener?.("hashchange", onHash);
    doc()?.removeEventListener?.("visibilitychange", onVisible);
    doc()?.removeEventListener?.("input", onInput, true);
  }
  function onHash() { reconcile(true, true); maybeFetch(false); }
  function onVisible() { arm(); }
  function onInput() { reconcile(false); maybeFetch(false); }
  function start() {
    build();
    if (typeof root.MutationObserver === "function") {
      let queued = false;
      observer = new root.MutationObserver(() => {
        if (queued) return;
        queued = true;
        root.setTimeout(() => { queued = false; reconcile(false); }, 200);
      });
      observer.observe(doc().documentElement, { subtree: true, childList: true });
    }
    root.addEventListener("hashchange", onHash);
    doc().addEventListener("visibilitychange", onVisible);
    doc().addEventListener("input", onInput, true);
    arm();
  }
  function wrap() {
    const current = root.t3xTeardown;
    if (typeof current === "function" && current.__t3xGrouping) return;
    const prev = typeof current === "function" ? current : null;
    const wrapped = function t3xTeardown() {
      try { root.t3xGroupingTeardown?.(); } catch { /* own cleanup already attempted */ }
      if (prev) prev();
    };
    wrapped.__t3xGrouping = true;
    root.t3xTeardown = wrapped;
  }
  root.t3xGroupingTeardown = ownCleanup;
  wrap();
  function requestRefresh() { fetchNow(); }
  const api = { present, sortThreads, readSettings, parseRoute, parseThreadItem, normId, identityOk, scanRows, requestRefresh, ageText, questionsEmptyText };
  if (root.t3xGroupingExpose) root.t3xGrouping = api;
  try { if (doc()) start(); } catch { /* leave the native list alone */ }
})(globalThis);
