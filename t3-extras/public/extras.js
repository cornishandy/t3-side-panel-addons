/*
 * t3-extras: Andy's add-ons for T3 Code (Nightly). Plain JS, no build step, no framework.
 * The keeper's inline loader fetches this file from 127.0.0.1:8793 and inserts it inline.
 *
 * Rules this file keeps (BRIEF-extras + ADDENDUM-1 + Astra round 1; BRIEF-round2 + STEER + Astra round 2):
 *  - Only appends its own nodes (marked data-t3x) next to/inside T3's markup; never moves,
 *    edits or removes T3's own nodes. Sidebar polish is CSS only, switched by <html> attributes.
 *  - Finds anchors by data-* attributes; skips a feature when its anchor is missing or ambiguous.
 *  - One throttled MutationObserver that ignores its own nodes; every handler in try/catch; it
 *    pauses itself after repeated errors, so a broken add-on can't freeze T3.
 *  - Usage: one item per lab. Numbers come from T3's own cached quota readings (its IndexedDB,
 *    read only, closed at once) and lab-usage (tier, gate, projection). REMAINING everywhere;
 *    unknown is "—", never 0; stale is marked and never looks current.
 *  - History: our own IndexedDB ring (t3x-usage-history), bounded; never T3's database.
 *  - Handover: inserts a request at the end of the composer (never replaces, never sends).
 */
(() => {
  "use strict";
  const W = window;
  const BASE = "http://127.0.0.1:8793/";
  const MIN = 60e3;
  const HOUR = 3600e3;
  const DAY = 86400e3;
  const STALE_MS = 10 * MIN; // lab-usage readings
  const T3_STALE_MS = 15 * MIN; // T3's own readings, by usageLimits.checkedAt
  const POLL_MS = 60e3;
  const SETTINGS_KEY = "t3x:settings:v1";
  const HIST = Object.freeze({ everyMs: 10 * MIN, keepMs: 15 * DAY, gapMs: 25 * MIN, maxRecords: 20_000, maxRecordBytes: 200, maxBytes: 4_000_000, maxPerSeries: 2_500 });

  // ===================================================================== core (pure, unit-tested)

  // Only verified noninteractive text leaves. These are separate from the older, opt-out targets.
  const INTERFACE_TARGETS = [
    ["settingtitles", "Settings section headings"],
    ["settinglabels", "Settings labels"],
    ["settingdescriptions", "Settings descriptions"],
    ["menutitles", "Menu group headings"],
    ["popovertitles", "Popover titles"],
    ["dialogtitles", "Dialog titles"],
    ["dialogdescriptions", "Dialog descriptions"],
    ["alerttitles", "Alert dialog titles"],
    ["alertdescriptions", "Alert dialog descriptions"],
    ["sheettitles", "Side sheet titles"],
    ["sheetdescriptions", "Side sheet descriptions"],
    ["toasttitles", "Notification titles"],
    ["toastdescriptions", "Notification descriptions"],
    ["plantext", "Proposed plan text"],
    ["addonheadings", "Add-ons panel headings"],
    ["addonnotes", "Add-ons panel notes"],
  ];
  const TARGETS = ["composer", "quotes", "projects", "pills", "headings", "replies", "mine", ...INTERFACE_TARGETS.map(([key]) => key)];
  const DEFAULTS = Object.freeze({
    usageHeader: true,
    usageComposer: true,
    usageSidebar: true,
    usageSidebarShort: true, // one line per lab while the window is under SHORT_WINDOW px tall
    burnTells: true,
    handoverButton: true,
    chainPill: true,
    tighter: true,
    inlineIcon: true,
    projectFull: true,
    workingHeader: true,
    compactThreads: true,
    marker: "bar", // bar | outline | off
    fontHead: Object.freeze({ family: "off", size: null }), // size null = the font's own default
    fontBody: Object.freeze({ family: "off", size: null }), // retained only as the migration source
    fontSchema: 2,
    fontComposer: Object.freeze({ family: "off", size: null }),
    fontQuotes: Object.freeze({ family: "off", size: null }),
    fontInterface: Object.freeze({ family: "off", size: null }),
    fontPlans: Object.freeze({ family: "off", size: null }),
    fontQuestions: Object.freeze({ family: "off", size: null }),
    fontReasoning: Object.freeze({ family: "off", size: null }),
    fontViz: Object.freeze({ family: "off", size: null }),
    fontFooter: Object.freeze({ family: "off", size: null }),
    fontTables: Object.freeze({ family: "off", size: null }),
    fontLinks: Object.freeze({ family: "off", size: null }),
    fontPaths: Object.freeze({ family: "off", size: null }),
    fontThreadtitles: Object.freeze({ family: "off", size: null }),
    fontTooltips: Object.freeze({ family: "off", size: null }),
    fontUsage: Object.freeze({ family: "off", size: null }),
    fontSidebar: Object.freeze({ family: "off", size: null }),

    fontPrompts: Object.freeze({ family: "off", size: null }), // messages you have sent
    fontMain: Object.freeze({ family: "off", size: null }), // assistant reply prose
    printOnly: true,
    showPartly: false,
    interfaceFontsOpen: false,
    footerTeam: "start-open", // the reply footer's team list: always-show | start-open | start-folded | always-hide
    fontTargets: Object.freeze({ composer: true, quotes: true, projects: true, pills: true, headings: true, replies: true, mine: true, ...Object.fromEntries(INTERFACE_TARGETS.map(([key]) => [key, false])) }),
  });
  const BOOL_KEYS = ["usageHeader", "usageComposer", "usageSidebar", "usageSidebarShort", "burnTells", "handoverButton", "chainPill", "tighter", "inlineIcon", "projectFull", "workingHeader", "compactThreads", "printOnly", "showPartly", "interfaceFontsOpen"];
  const MARKERS = ["bar", "outline", "off"];
  const FOOTER_TEAM = [
    ["always-show", "Always show"],
    ["start-open", "Start open, click to fold"],
    ["start-folded", "Start folded, click to open"],
    ["always-hide", "Always hide"],
  ];
  // Round 1's four presets, as heading + body families.
  const LEGACY_PRESETS = { "3A": ["Caveat", "Kalam"], "3B": ["Noteworthy", "Bradley Hand"], "3C": ["Architects Daughter", "Patrick Hand"], "3D": ["SignPainter", "Chalkboard SE"] };
  const familyName = (v) => (typeof v === "string" && (v === "off" || /^[A-Za-z0-9 ]{2,40}$/.test(v)) ? v : null);
  const sizePct = (v) => (Number.isInteger(v) && v >= 80 && v <= 150 && v % 5 === 0 ? v : null);
  const fontPick = (v) => ({ family: familyName(v?.family) ?? "off", size: sizePct(v?.size) });


  // Eighteen public areas. Body stays a migration source only. Presentation of the
  // pickers is separate: these ids, aliases and the source graph do not depend on the panel.
  const FONT_ROLES = Object.freeze([
    Object.freeze({ id: "head", key: "fontHead", alias: "T3X Heading", attr: "data-t3x-fh", title: "Headings" }),
    Object.freeze({ id: "composer", key: "fontComposer", alias: "T3X Composer", attr: "data-t3x-fc", title: "Message composer" }),
    Object.freeze({ id: "prompts", key: "fontPrompts", alias: "T3X Prompts", attr: "data-t3x-fprompts", title: "Your prompts" }),
    Object.freeze({ id: "main", key: "fontMain", alias: "T3X Main", attr: "data-t3x-fm", title: "Replies" }),
    Object.freeze({ id: "quotes", key: "fontQuotes", alias: "T3X Quotes", attr: "data-t3x-fq", title: "Quotes" }),
    Object.freeze({ id: "footer", key: "fontFooter", alias: "T3X Footer", attr: "data-t3x-ffooter", title: "Reply footer" }),
    Object.freeze({ id: "reasoning", key: "fontReasoning", alias: "T3X Reasoning", attr: "data-t3x-fr", title: "Reasoning" }),
    Object.freeze({ id: "plans", key: "fontPlans", alias: "T3X Plans", attr: "data-t3x-fp", title: "Plans" }),
    Object.freeze({ id: "questions", key: "fontQuestions", alias: "T3X Questions", attr: "data-t3x-fquestions", title: "Questions" }),
    Object.freeze({ id: "viz", key: "fontViz", alias: "T3X Viz", attr: "data-t3x-fv", title: "Visualizations" }),
    Object.freeze({ id: "interface", key: "fontInterface", alias: "T3X Interface", attr: "data-t3x-fi", title: "Interface" }),
    Object.freeze({ id: "tables", key: "fontTables", alias: "T3X Tables", attr: "data-t3x-ftables", title: "Tables" }),
    Object.freeze({ id: "links", key: "fontLinks", alias: "T3X Links", attr: "data-t3x-flinks", title: "Links" }),
    Object.freeze({ id: "paths", key: "fontPaths", alias: "T3X Paths", attr: "data-t3x-fpaths", title: "File paths" }),
    Object.freeze({ id: "threadtitles", key: "fontThreadtitles", alias: "T3X Thread titles", attr: "data-t3x-fthreadtitles", title: "Thread titles" }),
    Object.freeze({ id: "tooltips", key: "fontTooltips", alias: "T3X Tooltips", attr: "data-t3x-ftooltips", title: "Tooltips" }),
    Object.freeze({ id: "usage", key: "fontUsage", alias: "T3X Usage", attr: "data-t3x-fusage", title: "Usage page" }),
    Object.freeze({ id: "sidebar", key: "fontSidebar", alias: "T3X Sidebar", attr: "data-t3x-fsidebar", title: "Sidebar labels" }),
  ]);
  const FONT_ROLE_BY_ID = Object.create(null);
  for (const role of FONT_ROLES) FONT_ROLE_BY_ID[role.id] = role;

  function cleanSource(value, id) {
    if (value === "native" || value === "own") return value;
    if (typeof value !== "string" || !value.startsWith("link:")) return "native";
    const target = value.slice(5);
    if (!FONT_ROLE_BY_ID[target] || target === id) return "native";
    return `link:${target}`;
  }
  function inferSource(id, picks, plantext) {
    const pick = picks[id] || { family: "off", size: null };
    if (id === "plans" && pick.family === "off" && plantext && picks.interface && picks.interface.family !== "off") return "link:interface";
    return pick.family === "off" ? "native" : "own";
  }
  /** A present invalid map (array, null, non-object) is all native and does not infer.
   *  A present invalid entry is native. An absent map or entry infers from the stored pick. */
  function normalizeFontSources(raw, out, plantext) {
    const ids = FONT_ROLES.map((role) => role.id);
    const picks = Object.create(null);
    for (const role of FONT_ROLES) picks[role.id] = out[role.key];
    const allNative = () => {
      const sources = Object.create(null);
      for (const id of ids) sources[id] = "native";
      return sources;
    };
    if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) return allNative();
    const present = raw !== undefined;
    const sources = Object.create(null);
    for (const id of ids) {
      if (!present || !Object.prototype.hasOwnProperty.call(raw, id)) sources[id] = inferSource(id, picks, plantext);
      else sources[id] = cleanSource(raw[id], id);
    }
    return sources;
  }
  /** Terminal role id, or null when the chain is native or enters a cycle. Each start walks
   *  its own chain, so the result does not depend on key order. */
  function resolveFontGraph(sources) {
    const ids = FONT_ROLES.map((role) => role.id);
    const safe = sources && typeof sources === "object" && !Array.isArray(sources) ? sources : {};
    const terminal = Object.create(null);
    for (const start of ids) {
      const seen = new Set();
      let cur = start;
      let found = null;
      for (let n = 0; n <= ids.length; n++) {
        if (seen.has(cur)) { found = null; break; }
        seen.add(cur);
        const src = Object.prototype.hasOwnProperty.call(safe, cur) ? safe[cur] : "native";
        if (src === "own") { found = cur; break; }
        if (typeof src === "string" && src.startsWith("link:")) {
          const next = src.slice(5);
          if (!ids.includes(next) || next === cur) { found = null; break; }
          cur = next;
          continue;
        }
        found = null;
        break;
      }
      terminal[start] = found;
    }
    return terminal;
  }
  function effectiveFontPick(settings, role) {
    const blank = { family: "off", size: null };
    if (!FONT_ROLE_BY_ID[role]) return { ...blank };
    const terminal = resolveFontGraph(settings && settings.fontSources)[role];
    if (!terminal) return { ...blank };
    const pick = settings[FONT_ROLE_BY_ID[terminal].key];
    if (!pick || pick.family === "off") return { ...blank };
    return { family: pick.family, size: pick.size ?? null };
  }
  function fontLinkWouldCycle(sources, role, target) {
    if (!FONT_ROLE_BY_ID[role] || !FONT_ROLE_BY_ID[target] || role === target) return true;
    const seen = new Set();
    let cur = target;
    while (cur && !seen.has(cur)) {
      if (cur === role) return true;
      seen.add(cur);
      const src = sources && Object.prototype.hasOwnProperty.call(sources, cur) ? sources[cur] : "native";
      if (typeof src === "string" && src.startsWith("link:")) cur = src.slice(5);
      else return false;
    }
    return true;
  }
  function usagePageHash(hash) {
    const path = String(hash ?? "").replace(/^#/, "").split(/[?#]/)[0];
    let parts;
    try {
      parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    } catch {
      return false;
    }
    return parts.length === 1 && parts[0] === "usage";
  }
  function usageContainerMatches(classNames, headingText, hash) {
    if (!usagePageHash(hash)) return false;
    const names = new Set(String(classNames ?? "").split(/\s+/).filter(Boolean));
    for (const need of ["mx-auto", "flex", "w-full", "flex-col", "gap-6", "px-5", "pt-6", "pb-12", "sm:px-6"]) {
      if (!names.has(need)) return false;
    }
    return String(headingText ?? "").trim() === "Usage";
  }

  function readSettings(raw) {
    let s = {};
    try {
      s = raw ? JSON.parse(raw) : {};
    } catch {}
    if (!s || typeof s !== "object") s = {};
    const hasPrompts = Object.prototype.hasOwnProperty.call(s, "fontPrompts");
    const out = { ...DEFAULTS, fontHead: { ...DEFAULTS.fontHead }, fontBody: { ...DEFAULTS.fontBody }, fontMain: fontPick(s.fontMain), fontTargets: { ...DEFAULTS.fontTargets } };
    for (const k of BOOL_KEYS) if (typeof s[k] === "boolean") out[k] = s[k];
    if (MARKERS.includes(s.marker)) out.marker = s.marker;
    if (FOOTER_TEAM.some(([v]) => v === s.footerTeam)) out.footerTeam = s.footerTeam;
    if (s.fontHead || s.fontBody) {
      out.fontHead = fontPick(s.fontHead);
      out.fontBody = fontPick(s.fontBody);
    } else if (LEGACY_PRESETS[s.font]) {
      const [head, body] = LEGACY_PRESETS[s.font];
      out.fontHead = { family: head, size: null };
      out.fontBody = { family: body, size: null };
    }
    if (s.fontTargets && typeof s.fontTargets === "object") {
      for (const t of TARGETS) if (typeof s.fontTargets[t] === "boolean") out.fontTargets[t] = s.fontTargets[t];
    }
    const migrated = { Composer: out.fontBody, Quotes: out.fontBody, Interface: out.fontMain,
      Plans: out.fontTargets.plantext ? out.fontMain : DEFAULTS.fontPlans };
    for (const name of ["Composer", "Quotes", "Interface", "Plans", "Questions", "Reasoning", "Viz", "Footer", "Tables", "Links", "Paths", "Threadtitles", "Tooltips", "Usage", "Sidebar"]) {
      const key = `font${name}`;
      out[key] = fontPick(s.fontSchema === 2 || Object.prototype.hasOwnProperty.call(s, key) ? s[key] : migrated[name]);
    }
    // The raw key is the once marker; explicit Off survives later Main/mine changes.
    out.fontPrompts = fontPick(hasPrompts ? s.fontPrompts : out.fontTargets.mine !== false ? out.fontMain : DEFAULTS.fontPrompts);
    out.fontSchema = 2;
    out.fontSources = normalizeFontSources(Object.prototype.hasOwnProperty.call(s, "fontSources") ? s.fontSources : undefined, out, out.fontTargets.plantext === true);
    return out;
  }

  // ---------- font lists ----------

  /** Which styles the two filter chips show: print always; semi-cursive ("partly") with "Show semi-cursive"
   *  or with "Print only" off; cursive ("joined") only when both chips are off. */
  function fontVisible(f, s) {
    if (f.style === "print") return true;
    if (f.style === "partly") return Boolean(s.showPartly || !s.printOnly);
    return !s.printOnly && !s.showPartly;
  }
  function fontTags(f, native = true) {
    return [
      f.narrow ? "narrow" : null,
      f.tall ? "tall" : null,
      f.style === "partly" ? "semi-cursive" : f.style === "joined" ? "cursive" : null,
      f.hard ? "hard to read small" : null,
      f.source === "mac" ? (native ? "on your Mac" : "not on this Mac") : null,
      f.source === "t3" ? f.note : null,
    ].filter(Boolean);
  }
  /** T3's own typography settings (Settings → Appearance), listed first in the font menus. They
   *  follow T3's current values live through its CSS variables, so they need no font file and take
   *  no size. Visualizations are left out: their sandboxed frames can't see T3's variables. */
  const T3_SYSTEM_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const T3_FONTS = Object.freeze([
    ["T3 interface font", "var(--font-sans)", "follows T3's interface font"],
    ["T3 composer font", "var(--font-composer, var(--font-sans))", "follows T3's composer font"],
    ["T3 code font", "var(--font-mono)", "follows T3's code font"],
    ["T3 system font", T3_SYSTEM_STACK, "T3's built-in default"],
  ].map(([name, css, note]) => Object.freeze({ name, css, note, source: "t3", group: "t3", style: "print", width: 0 })));
  const t3Font = (name) => T3_FONTS.find((f) => f.name === name) || null;

  /** Picker groups, narrowest first (the board's measured sentence width); near-ties put ★ first.
   *  The current choice always stays listed, marked when the filter would hide it.
   *  T3's own fonts come first when the catalog carries them, except for Visualizations. */
  function fontOptions(catalog, s, current, native = () => true, role = null) {
    const groups = [["t3", "T3 Code settings"], ["hand", "Handwritten"], ["cond", "Condensed print"]].filter(([g]) => g !== "t3" || role !== "viz");
    return groups.map(([g, label]) => ({
      label,
      options: (Array.isArray(catalog) ? catalog : [])
        .filter((f) => f && f.group === g && (fontVisible(f, s) || f.name === current))
        .sort((a, b) => Math.round(a.width / 10) - Math.round(b.width / 10) || Number(Boolean(b.star)) - Number(Boolean(a.star)) || a.width - b.width)
        .map((f) => {
          const hidden = !fontVisible(f, s);
          const tags = fontTags(f, f.source !== "mac" || native(f.name));
          return { name: f.name, hidden, label: `${f.name}${f.star ? " ★" : ""}${tags.length ? ` · ${tags.join(", ")}` : ""}${hidden ? " (hidden by the filter)" : ""}` };
        }),
    })).filter((g) => g.options.length);
  }

  /** Follow the displayed menu order, retaining a missing Mac choice as an anchor. */
  function fontNeighbor(catalog, settings, current, direction, native = () => true, role = null) {
    const entries = fontOptions(catalog, settings, current, native, role).flatMap((g) => g.options);
    const available = new Set((catalog ?? []).filter((f) => (f.source !== "mac" || native(f.name)) && (f.source !== "t3" || role !== "viz")).map((f) => f.name));
    const start = entries.findIndex((f) => f.name === current);
    const delta = direction < 0 ? -1 : 1;
    for (let n = 1; n <= entries.length; n++) {
      const i = start < 0 ? (delta > 0 ? n - 1 : entries.length - n) : (start + delta * n + entries.length) % entries.length;
      const name = entries[i].name;
      if (name !== current && available.has(name)) return name;
    }
    return null;
  }

  // ---------- routes, formatting ----------

  const normId = (id) => String(id ?? "").trim().replace(/^mcp:/, "");

  // Routes are in the hash (#/$environmentId/$threadId). Two-segment routes that are not threads:
  const NOT_THREADS = new Set(["settings", "draft", "projects", "pull-requests", "pair", "usage", "welcome"]);
  function parseRoute(hash) {
    const path = String(hash ?? "").replace(/^#/, "").split(/[?#]/)[0];
    const seg = path.split("/").filter(Boolean);
    let parts;
    try {
      parts = seg.map((s) => decodeURIComponent(s));
    } catch {
      return { kind: "unknown" };
    }
    if (parts[0] === "draft") return { kind: "draft" };
    if (parts.length === 2 && !NOT_THREADS.has(parts[0]) && /^[A-Za-z0-9:_-]{6,}$/.test(parts[0]) && /^[A-Za-z0-9:_-]{6,}$/.test(parts[1])) {
      return { kind: "thread", environmentId: parts[0], threadId: parts[1] };
    }
    return { kind: parts.length ? "other" : "home" };
  }

  const known = (v) => typeof v === "number" && Number.isFinite(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmtPct = (v) => (known(v) ? `${Math.round(v)}%` : "—");

  function fmtAge(ms) {
    if (!known(ms)) return "age unknown";
    const m = Math.max(0, Math.floor(ms / 60e3));
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  const fmtWhen = (at) => {
    if (!known(at)) return "unknown";
    const d = new Date(at);
    return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  };
  const fmtTime = (at, ampm = true) => {
    const s = new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return ampm ? s : s.replace(/\s?[AaPp]\.?[Mm]\.?$/, "");
  };
  /** A reset as a clock time: "1:59 AM" within 24 h, else "Sat 8:07 PM". */
  const fmtClock = (at, now) => (!known(at) ? "unknown" : at - now < 24 * 3600e3 ? fmtTime(at) : fmtWhen(at));
  /** "refills in 1 h 12 min (1:59 AM)"; over 24 h "refills Sat 8:07 PM". */
  function fmtReset(at, now) {
    if (!known(at)) return "refill time unknown";
    const ms = at - now;
    if (ms <= 0) return "refilling now";
    if (ms < 60e3) return `refills in under 1 min (${fmtTime(at)})`;
    const mins = Math.round(ms / 60e3);
    if (mins < 60) return `refills in ${mins} min (${fmtTime(at)})`;
    if (mins < 24 * 60) return `refills in ${Math.floor(mins / 60)} h ${mins % 60} min (${fmtTime(at)})`;
    return `refills ${fmtWhen(at)}`;
  }

  // lab-usage's gate verdicts (read only here), each with its own plain label.
  const GATE_LABELS = { GO: "GO", REDEEM: "Reset needed", CLAUDE: "Use Claude" };
  const gateLabel = (action) => GATE_LABELS[action] ?? (action ? String(action).slice(0, 16) : "—");

  // ---------- labs ----------

  const LABS = [
    { id: "claude", name: "Claude", colour: "#d97757" },
    { id: "codex", name: "Codex", colour: "#2fa37a" },
    { id: "gemini", name: "Gemini", colour: "#5b8def" },
    { id: "grok", name: "Grok", colour: "#9a9aa5" },
    { id: "opencode", name: "OpenCode", colour: "#8b7fd6" },
    { id: "cursor", name: "Cursor", colour: "#8a8f98" },
    { id: "pi", name: "Pi", colour: "#c08a3e" },
    { id: "muse", name: "Muse", colour: "#c0679a" },
  ];
  const DRIVER_LAB = { claudeAgent: "claude", codex: "codex", antigravity: "gemini", grok: "grok", opencode: "opencode", cursor: "cursor", pi: "pi", muse: "muse" };
  // Labs whose windows are known by id; the rest go by kind (first weekly/monthly = long, first session = short).
  // Ids in order of preference. gemini-quota: Google's per-model Gemini quota (no stated window
  // length), T3's fallback when Google's quota summary comes back empty.
  const LONG_ID = { claude: ["seven_day"], gemini: ["gemini-weekly", "gemini-quota"] };
  const SHORT_ID = { claude: ["five_hour"], gemini: ["gemini-5h"] };
  const EXTRA_GROUP = { gemini: { "3p-5h": "Claude/GPT via Antigravity", "3p-weekly": "Claude/GPT via Antigravity" } };

  /** A window's start and end, from its reset and a valid length; as in T3, no valid length means
   *  no pace. The one disclosed inference: a Grok window reporting no length at all
   *  (assumeLength) is taken as 7 days (weekly) or the calendar month before its reset (monthly). */
  function windowBounds(w) {
    if (!w || !known(w.resetsAt)) return null;
    const end = w.resetsAt;
    if (known(w.lengthSec) && w.lengthSec > 0) return { start: end - w.lengthSec * 1000, end, assumed: null };
    if (w.assumeLength !== true || (w.lengthSec !== null && w.lengthSec !== undefined)) return null;
    if (w.kind === "weekly") return { start: end - 7 * DAY, end, assumed: "week" };
    if (w.kind === "monthly") {
      const e = new Date(end);
      const y = e.getUTCFullYear();
      const m = e.getUTCMonth() - 1;
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const start = Date.UTC(y, m, Math.min(e.getUTCDate(), lastDay), e.getUTCHours(), e.getUTCMinutes(), e.getUTCSeconds(), e.getUTCMilliseconds());
      return { start, end, assumed: "month" };
    }
    return null;
  }

  /** T3's own pace maths (ChatGptUsageButton bundle): remaining, even pace and ahead/on/under at
   *  ±5 points; no window length or reset means no pace. Exact values kept for colour and geometry. */
  function paceOf(w, now) {
    if (!w || !known(w.usedPct)) return null;
    const used = w.usedPct;
    const leftExact = 100 - clamp(used, 0, 100);
    const out = { used, left: Math.round(leftExact), leftExact, elapsed: null, timeLeft: null, timeLeftExact: null, pace: null, bounds: windowBounds(w) };
    const b = out.bounds;
    if (!b || !(b.end - b.start > 0)) return out;
    const D = b.end - b.start;
    const elapsed = clamp((D - (b.end - now)) / D, 0, 1);
    const diff = used - elapsed * 100;
    return { ...out, elapsed, timeLeftExact: (1 - elapsed) * 100, timeLeft: Math.round((1 - elapsed) * 100), pace: diff > 5 ? "ahead" : diff < -5 ? "under" : "on" };
  }

  // ---------- T3's cached server config -> numbers only ----------

  const T3_KINDS = new Set(["session", "weekly", "monthly", "other"]);
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  const isoMs = (v) => {
    if (typeof v !== "string" || v.length > 40) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };
  // The quota buckets T3 reports, by id -> our own fixed name and label. Anything else is dropped,
  // so no provider- or account-specific string ever enters the model.
  const BUCKETS = {
    five_hour: "Session", seven_day: "Weekly", seven_day_fable: "Weekly · Fable", seven_day_opus: "Weekly · Opus", seven_day_sonnet: "Weekly · Sonnet",
    primary: null, secondary: null, subscription: null, // labelled by kind
    "gemini-5h": "5-hour", "gemini-weekly": "Weekly", "gemini-quota": "Quota", "3p-5h": "5-hour", "3p-weekly": "Weekly",
  };
  const KIND_LABEL = { session: "Session", weekly: "Weekly", monthly: "Monthly", other: "Window" };
  function projectLimits(u) {
    if (!u || typeof u !== "object") return null;
    const windows = (Array.isArray(u.windows) ? u.windows : []).slice(0, 16)
      .filter((w) => w && typeof w === "object" && typeof w.id === "string" && Object.hasOwn(BUCKETS, w.id))
      .map((w) => {
        const id = Object.keys(BUCKETS).find((k) => k === w.id); // our own string, not T3's
        const kind = T3_KINDS.has(w.kind) ? w.kind : "other";
        const absent = w.windowDurationMins === undefined || w.windowDurationMins === null;
        return {
          id,
          kind,
          label: BUCKETS[id] ?? KIND_LABEL[kind],
          usedPercent: known(w.usedPercent) ? w.usedPercent : null,
          resetsAt: isoMs(w.resetsAt),
          durationMins: known(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : null,
          durationAbsent: absent, // absent (Grok may infer) vs present but invalid (never inferred)
        };
      });
    const rc = u.resetCredits && typeof u.resetCredits === "object" ? u.resetCredits : null;
    const un = u.unavailable && typeof u.unavailable === "object" ? u.unavailable : null;
    return {
      checkedAt: isoMs(u.checkedAt),
      windows,
      resetCredits: rc ? { availableCount: known(rc.availableCount) ? rc.availableCount : null, nextExpiresAt: isoMs(rc.nextExpiresAt) } : null,
      unavailable: un ? { reason: un.reason === "unsupported" || un.reason === "probeFailed" ? un.reason : "other" } : null,
    };
  }
  /** The persisted record ({schemaVersion: 1, environmentId, config}) cut down to providers'
   *  numbers, labels, times and status. Anything unexpected fails closed ("schema"). */
  function projectT3Config(value, envId) {
    if (value === undefined || value === null) return { state: "missing" };
    let rec = value;
    if (typeof rec === "string") {
      if (rec.length > 16e6) return { state: "schema" };
      try {
        rec = JSON.parse(rec);
      } catch {
        return { state: "schema" };
      }
    }
    if (!rec || typeof rec !== "object" || rec.schemaVersion !== 1 || !envId || normId(rec.environmentId) !== normId(envId)) return { state: "schema" };
    const providers = rec.config && typeof rec.config === "object" && Array.isArray(rec.config.providers) ? rec.config.providers : null;
    if (!providers) return { state: "schema" };
    return {
      state: "ok",
      // Only known drivers, as our lab id; the instance only as "is it the driver's own instance".
      providers: providers.slice(0, 40).filter((p) => p && typeof p === "object" && typeof p.driver === "string" && Object.hasOwn(DRIVER_LAB, p.driver)).map((p) => ({
        lab: DRIVER_LAB[p.driver],
        canonical: p.instanceId === p.driver,
        enabled: p.enabled !== false,
        limits: projectLimits(p.usageLimits),
      })),
    };
  }

  /** Generic labs from T3's readings: {id: {..., windows: [{role: long|short|extra}], hasMeter}}. */
  function labsFromT3(projected, now) {
    const out = {};
    if (projected?.state !== "ok") return out;
    for (const p of projected.providers) {
      const id = p.lab;
      if (!LABS.some((l) => l.id === id)) continue;
      const lim = p.limits;
      const ws = (lim?.windows ?? []).filter((w) => known(w.usedPercent));
      const prev = out[id];
      // Several instances of one driver (Codex and its paid API instance): keep the one with a
      // meter, preferring the instance named like the driver.
      if (prev?.hasMeter && (!ws.length || prev.canonical)) continue;
      const byId = (map) => (map[id] ? map[id].map((x) => ws.find((w) => w.id === x)).find(Boolean) ?? null : undefined);
      const long = byId(LONG_ID) !== undefined ? byId(LONG_ID) : ws.find((w) => w.kind === "weekly") ?? ws.find((w) => w.kind === "monthly") ?? ws.find((w) => w.kind === "other") ?? null;
      const short = byId(SHORT_ID) !== undefined ? byId(SHORT_ID) : ws.find((w) => w.kind === "session" && w !== long) ?? null;
      const checkedAt = lim?.checkedAt ?? null;
      const stale = !known(checkedAt) || now - checkedAt > T3_STALE_MS;
      const windows = ws.map((w) => ({
        id: w.id,
        role: w === long ? "long" : w === short ? "short" : "extra",
        group: EXTRA_GROUP[id]?.[w.id] ?? null,
        kind: w.kind,
        label: w.label,
        usedPct: Math.max(0, w.usedPercent),
        resetsAt: w.resetsAt,
        lengthSec: w.durationMins ? w.durationMins * 60 : null,
        // Grok reports no window length; only then is one assumed (and said so).
        assumeLength: id === "grok" && w.durationAbsent,
        fetchedAt: checkedAt,
        live: !stale,
      }));
      out[id] = {
        ...LABS.find((l) => l.id === id),
        source: "t3",
        canonical: p.canonical,
        enabled: p.enabled,
        fetchedAt: checkedAt,
        live: !stale,
        windows,
        resetCredits: lim?.resetCredits ?? null,
        unavailable: lim?.unavailable ?? null,
        hasMeter: Boolean(long),
      };
    }
    return out;
  }

  /** Every lab once: T3's numbers where it has them (they match T3's own UI), lab-usage's tier,
   *  gate and projections beside them; lab-usage's own numbers only when T3 has none. */
  function mergeLabs(t3labs, serverLabs) {
    return LABS.map((info) => {
      const t = t3labs?.[info.id];
      const s = (Array.isArray(serverLabs) ? serverLabs : []).find((l) => l && l.id === info.id);
      if (t?.hasMeter) {
        // lab-usage's projection, with what's needed to check it belongs to this reading (labView).
        const windows = t.windows.map((w) => {
          const sw = w.role === "extra" ? null : s?.windows?.find((x) => x.role === w.role);
          return sw && known(sw.projection)
            ? { ...w, projection: sw.projection, projectionAt: sw.projectionAt, projectionUsed: sw.projectionUsed, projectionResetsAt: sw.resetsAt ?? null, projectionFrom: { live: s.live !== false && sw.live !== false, at: s.fetchedAt ?? null } }
            : w;
        });
        return { ...t, windows, verdict: s?.verdict ?? null, verdictLive: s?.live ?? null, verdictAt: s?.fetchedAt ?? null };
      }
      if (s && (s.windows ?? []).some((w) => w.role === "long" && known(w.usedPct))) {
        return { ...info, ...s, hasMeter: true, verdictLive: s.live, verdictAt: s.fetchedAt };
      }
      const why = !t ? "no meter yet"
        : t.enabled === false ? "turned off in T3"
        : t.unavailable?.reason === "unsupported" ? "T3 has no meter for it"
        : t.unavailable?.reason === "probeFailed" ? "T3 couldn't read it"
        : `${info.name} did not report a usage percentage`;
      // A configured quota provider remains visible when its response has no number.
      // Keep unknown separate from measured zero, and do not add disabled/unconfigured labs.
      const showUnknown = Boolean(t && t.enabled !== false && ["claude", "codex", "gemini", "grok"].includes(info.id));
      return { ...info, ...t, hasMeter: false, showUnknown, windows: [], noMeter: why };
    });
  }

  /** lab-usage's projection is used only for the reading it was made from: a fresh, unfailed
   *  lab-usage snapshot (≤ 10 min), the same reset (± 120 s), the same usage (± 3 points), and no
   *  drop in T3's usage since it was worked out (a drop = a reset). */
  function projectionFits(w, now, fails) {
    if (!w || !known(w.projection) || !known(w.projectionAt) || !known(w.projectionUsed)) return false;
    const from = w.projectionFrom;
    if (from) {
      if (!from.live || !known(from.at) || now - from.at > STALE_MS || now - w.projectionAt > STALE_MS || fails.labUsage) return false;
      if (!known(w.projectionResetsAt) || !known(w.resetsAt) || Math.abs(w.projectionResetsAt - w.resetsAt) > 120e3) return false;
      if (!known(w.usedPct) || Math.abs(w.usedPct - w.projectionUsed) > 3) return false;
      if (known(w.fetchedAt) && w.fetchedAt >= w.projectionAt && w.usedPct < w.projectionUsed) return false;
    }
    return true;
  }
  const NO_PROJECTION = { projection: null, projectionAt: null, projectionUsed: null, projectionResetsAt: null, projectionFrom: null };

  /** What every place shows for one lab. fails: {labUsage, t3} = when that source last failed. */
  function labView(lab, now, fails = {}) {
    if (!lab?.hasMeter) {
      const age = known(lab?.fetchedAt) ? now - lab.fetchedAt : null;
      const failed = lab?.source === "t3" ? fails.t3 : fails.labUsage;
      return { ...lab, hasData: false, minLeft: null, age, stale: age === null || age > (lab?.source === "t3" ? T3_STALE_MS : STALE_MS) || Boolean(failed) || lab?.live === false };
    }
    let long = lab.windows.find((w) => w.role === "long") ?? null;
    if (long && known(long.projection) && !projectionFits(long, now, fails)) long = { ...long, ...NO_PROJECTION };
    const short = lab.windows.find((w) => w.role === "short") ?? null;
    const lp = paceOf(long, now);
    if (!lp) return { ...lab, hasData: false };
    const age = known(lab.fetchedAt) ? now - lab.fetchedAt : null;
    const failed = lab.source === "t3" ? fails.t3 : fails.labUsage;
    const stale = age === null || age > (lab.source === "t3" ? T3_STALE_MS : STALE_MS) || Boolean(failed) || lab.live === false;
    // T3's rule: once Claude's week or Codex's weekly limit is used up, the 5-hour window shows
    // as fully used, with no pace, until the weekly reset.
    const blocked = Boolean(short && (lab.id === "claude" || lab.id === "codex") && long.usedPct >= 100);
    const sp = !short ? null : blocked ? { used: 100, left: 0, leftExact: 0, elapsed: null, timeLeft: null, timeLeftExact: null, pace: null, bounds: windowBounds(short) } : paceOf(short, now);
    const limits = [lp.leftExact, short && !blocked ? sp?.leftExact : null].filter(known);
    // The usage epoch: lab-usage's projection P = u·(end−s)/(t−s) gives its start s (it moves
    // after a manual Codex reset); otherwise the window start, unless the lab has manual resets.
    let epochStart = null;
    const b = lp.bounds;
    if (b && known(long.projection) && known(long.projectionUsed) && known(long.projectionAt) && long.projection > long.projectionUsed) {
      const s = (long.projectionUsed * b.end - long.projection * long.projectionAt) / (long.projectionUsed - long.projection);
      if (known(s) && s >= b.start - HOUR && s < long.projectionAt) epochStart = Math.max(s, b.start);
    } else if (b && lab.id !== "codex" && !lab.resetCredits) {
      epochStart = b.start;
    }
    const shortHours = short && known(short.lengthSec) ? short.lengthSec / 3600 : null;
    return {
      ...lab,
      hasData: true,
      long,
      short: short && sp ? short : null,
      lp,
      sp: short ? sp : null,
      blocked,
      stale,
      age,
      epochStart,
      epochUnknown: lab.id === "codex" || Boolean(lab.resetCredits),
      minLeft: limits.length ? Math.min(...limits) : null,
      longWord: long.kind === "monthly" ? "Month" : long.kind === "weekly" ? "Week" : "Window",
      longAdj: long.kind === "monthly" ? "monthly" : long.kind === "weekly" ? "weekly" : "main",
      shortWord: shortHours ? (Number.isInteger(shortHours) ? `${shortHours}-hour` : `${Math.round(shortHours * 60)}-minute`) : "Short window",
      shortTag: shortHours && Number.isInteger(shortHours) ? `${shortHours}h` : "short",
    };
  }

  const views = (labs, now, fails) => labs.map((l) => labView(l, now, fails));
  const compactLabs = (vs) => vs.filter((v) => v.hasData);
  const visibleLabs = (vs) => vs.filter((v) => v.hasData || v.showUnknown);
  /** The composer's lab: the one with the least left in any valid limit, short windows included. */
  function mostConstrained(vs) {
    return compactLabs(vs).filter((v) => known(v.minLeft)).reduce((a, b) => (!a || b.minLeft < a.minLeft ? b : a), null);
  }

  /** When a window is running low, its refill time goes into the compact places: the short window
   *  at ≤ 25% left, ahead of its clock (amber) or blocked; the long window at ≤ 15% left. */
  function lowRefills(v) {
    if (!v?.hasData) return [];
    const out = [];
    if (v.short && v.sp) {
      // Blocked: it refills with the long window, whose own note (it's at 0%) says when.
      if (!v.blocked && (v.sp.leftExact <= 25 || v.sp.pace === "ahead")) out.push({ which: "short", at: v.short.resetsAt, word: v.shortTag });
    }
    if (v.lp.leftExact <= 15) out.push({ which: "long", at: v.long.resetsAt, word: v.longWord.toLowerCase() });
    return out.filter((r) => known(r.at));
  }
  /** "63% left · 5h 12% · refills 1:59 AM" as parts; rw = the "refills" words, dropped when narrow. */
  function compactParts(v, now) {
    if (!v?.hasData) return v?.showUnknown ? [{ t: "— · unavailable" }] : [];
    const parts = [{ t: `${fmtPct(v.lp.left)} left` }];
    if (v.short) parts.push({ t: ` · ${v.shortTag} ${v.blocked ? "blocked" : fmtPct(v.sp?.left)}` });
    for (const r of lowRefills(v)) {
      parts.push({ t: " · " });
      if (r.which === "long") parts.push({ t: `${r.word} ` });
      parts.push({ t: "refills ", rw: true }, { t: fmtClock(r.at, now) });
    }
    return parts;
  }
  /** The composer chip: "Claude 5h 12%" (the tightest limit), plus "· refills 12:00 AM" when that
   *  one runs low; a refill on another day keeps its day ("Fri 12:00 AM"). */
  function composerLabel(v, now = Date.now()) {
    const tight = v.short && !v.blocked && known(v.sp?.leftExact) && v.sp.leftExact < v.lp.leftExact;
    const low = lowRefills(v).find((r) => (tight ? r.which === "short" : r.which === "long"));
    const sameDay = low && new Date(low.at).toDateString() === new Date(now).toDateString();
    return { main: `${v.name} ${tight ? `${v.shortTag} ` : ""}${fmtPct(v.minLeft)}`, refill: low ? (sameDay ? fmtTime(low.at) : fmtWhen(low.at)) : null };
  }
  /** The short-window sidebar line: "63% · 5h 70%", plus the refill clock when one runs low. */
  function shortBarText(v, now) {
    if (!v?.hasData) return v?.showUnknown ? "—" : "";
    const low = lowRefills(v)[0];
    return `${fmtPct(v.lp.left)}${v.short ? ` · ${v.shortTag} ${v.blocked ? "blocked" : fmtPct(v.sp?.left)}` : ""}${low ? ` · ${fmtClock(low.at, now)}` : ""}`;
  }
  /** "63% left · 5h 70%" (+ refill times when low); narrow drops the "refills" words. */
  function compactLabel(v, now = Date.now(), narrow = false) {
    if (!v?.hasData && !v?.showUnknown) return null;
    return compactParts(v, now).filter((p) => !(narrow && p.rw)).map((p) => p.t).join("");
  }

  // Keep the tightest measured limit, with explicit notices for missing quota readings.
  // Missing readings never enter the percentage comparison or its projections/history.
  function composerSummary(vs, now) {
    const unknown = visibleLabs(vs).filter((v) => !v.hasData);
    const measured = mostConstrained(vs);
    const view = measured ?? unknown[0];
    if (!view) return null;
    const c = measured ? composerLabel(measured, now) : { main: `${view.name} —`, refill: null };
    const extra = unknown.filter((v) => v !== view).map((v) => `${v.name} —`);
    return { view, main: [c.main, ...extra].join(" · "), refill: c.refill, unknown };
  }

  /** B's tooltip (Astra round 2, exact wording; "Week" becomes "Month" for monthly plans). */
  function bTooltip(v, now) {
    if (!v?.hasData) return `${v?.name ?? "Lab"} · This Mac. Usage unavailable: ${v?.noMeter ?? "no reading yet"}.${known(v?.age) ? ` Last checked ${fmtAge(v.age)}${v.stale ? " (stale)" : ""}.` : ""}`;
    const lp = v.lp;
    const out = [];
    // Running low: lead with the refill time.
    for (const r of lowRefills(v)) {
      if (r.which === "short") out.push(`${v.shortWord}: ${fmtPct(v.sp.left)} left, refills ${fmtClock(r.at, now)}.`);
      else out.push(`${v.longWord}: ${fmtPct(lp.left)} left${v.blocked ? ` (${v.shortWord} blocked too)` : ""}, refills ${fmtClock(r.at, now)}.`);
    }
    out.push(`${v.name} · This Mac.`);
    out.push(`${v.longWord}: ${fmtPct(lp.left)} left; even pace ${known(lp.timeLeft) ? `${lp.timeLeft}% left` : "unknown"}; resets ${fmtWhen(v.long.resetsAt)}.`);
    if (v.short) {
      if (v.blocked) out.push(`${v.shortWord}: blocked by the ${v.longAdj} limit until ${fmtWhen(v.long.resetsAt)}.`);
      else out.push(`${v.shortWord}: ${fmtPct(v.sp.left)} left; even pace ${known(v.sp.timeLeft) ? `${v.sp.timeLeft}% left` : "unknown"}; resets ${fmtWhen(v.short.resetsAt)}.`);
      out.push(`Amber tank means spending more than 5 percentage points ahead of the ${v.shortWord} clock.`);
    }
    if (lp.bounds?.assumed) out.push(`Pace assumed: ${v.name} doesn't report its window length.`);
    out.push(`Updated ${fmtAge(v.age)}${v.stale ? " (stale)" : ""}.`);
    return out.join(" ");
  }
  /** B's legend (Astra round 2), in the shown windows' own words ("month" for monthly plans). */
  function bLegend(vs) {
    const shown = (Array.isArray(vs) ? vs : []).filter((v) => v?.hasData);
    const longs = [...new Set(shown.map((v) => v.longWord.toLowerCase()))];
    const shorts = [...new Set(shown.filter((v) => v.short).map((v) => v.shortWord))];
    const unit = longs.length === 1 ? longs[0] : longs.length ? longs.join(" or ") : "week";
    const adj = longs.length === 1 ? (shown[0].longAdj) : longs.length ? shown.map((v) => v.longAdj).filter((a, i, all) => all.indexOf(a) === i).join(" or ") : "weekly";
    const short = shorts.length === 1 ? shorts[0] : shorts.length ? shorts.join(" or ") : "5-hour";
    return `Bar: ${unit} remaining. Needle position: even ${adj} pace. Tank level: ${short} remaining, a separate limit.`;
  }

  /** B, "pace needle with a 5-hour tank": track; fill = long window left; the even-pace line at
   *  the long window's time left; a tank there whose level is the short window left (its own
   *  scale). No short-window reading: the plain line, never an empty tank. */
  function bGeometry(v, width, height, size = "md") {
    const trackH = size === "lg" ? 10 : size === "sm" ? 5 : 7;
    const tankW = size === "lg" ? 8 : size === "sm" ? 5 : 6;
    const y = (height - trackH) / 2;
    const out = { width, height, track: { x: 0, y, w: width, h: trackH, r: trackH / 2 }, fillW: 0, needle: null, tank: null };
    if (!v?.hasData) return out;
    out.fillW = (width * v.lp.leftExact) / 100;
    if (!known(v.lp.timeLeftExact)) return out;
    const x = clamp((width * v.lp.timeLeftExact) / 100, tankW / 2, width - tankW / 2);
    if (v.short && v.sp && known(v.sp.leftExact)) {
      out.tank = { x: x - tankW / 2, cx: x, w: tankW, h: height, r: tankW / 2, level: v.sp.leftExact / 100, amber: v.sp.pace === "ahead", blocked: v.blocked };
    } else {
      out.needle = { x, y1: Math.max(0, y - 3), y2: Math.min(height, y + trackH + 3) };
    }
    return out;
  }

  /** One projection for D's line, crossing and words. lab-usage's projection P is the % used AT
   *  the reset, worked out at time t from reading u: rate = (P − u) / (end − t). Without it, the
   *  average since the window started, only when that start is known. */
  function forecast(v, now) {
    const w = v?.long;
    const b = v?.lp?.bounds;
    if (!w || !v.lp) return { state: "unavailable", text: "Estimate unavailable" };
    const used = w.usedPct;
    const assumed = b?.assumed ? ` (pace assumed: ${v.name} doesn't report its window length)` : "";
    if (known(used) && used >= 100) return { state: "limit", text: `Limit reached (${Math.round(used)}% used)`, anchor: { t: known(w.fetchedAt) ? w.fetchedAt : now, u: used } };
    if (v.stale) return { state: "stale", text: `Estimate withheld: the reading is ${known(v.age) ? fmtAge(v.age).replace(" ago", " old") : "of unknown age"}` };
    if (!b || !known(b.start) || !known(b.end) || !(b.end > b.start) || b.start > now || b.end <= now || !known(used)) return { state: "unavailable", text: "Estimate unavailable" };
    if (used <= 0) return { state: "none", text: "No usage measured yet" };
    let anchor;
    let rate;
    let source;
    if (known(w.projection) && known(w.projectionAt) && known(w.projectionUsed) && w.projectionAt > b.start && w.projectionAt < b.end && w.projection >= 0 && w.projectionUsed < 100) {
      anchor = { t: w.projectionAt, u: w.projectionUsed };
      rate = Math.max(0, (w.projection - w.projectionUsed) / (b.end - w.projectionAt));
      source = "lab-usage";
    } else {
      const t = known(w.fetchedAt) ? w.fetchedAt : now;
      if (v.epochUnknown || !known(v.epochStart) || t <= v.epochStart) return { state: "unavailable", text: "Estimate unavailable" };
      anchor = { t, u: used };
      rate = used / (t - v.epochStart);
      source = "average";
    }
    if (!(rate > 0)) return { state: "lasts", anchor, rate: 0, endUsed: anchor.u, source, text: `Estimated to last until reset at this pace${assumed}.` };
    const crossing = anchor.t + (100 - anchor.u) / rate;
    const endUsed = anchor.u + rate * (b.end - anchor.t);
    if (crossing < b.end) {
      return { state: "out", anchor, rate, crossing, endUsed, source, text: crossing <= now ? `Estimated to run out about now at this pace${assumed}` : `Estimated to run out ${fmtWhen(crossing)} at this pace${assumed}` };
    }
    return { state: "lasts", anchor, rate, crossing, endUsed, source, text: `Estimated to last until reset at this pace${assumed}.` };
  }

  /** Measured history as unbroken runs. A run never crosses a change of reset epoch (reset times
   *  compared to the minute; any other difference is a new epoch; samples without one are left
   *  out), a missing interval (> 25 min) or any drop in usage (a reset). cur = the latest reading,
   *  in the window's own epoch. The same rule for both stores (the ring and the service's log). */
  const epochMinute = (t) => Math.round(t / MIN);
  function seriesSegments(samples, b, cur) {
    if (!b) return [];
    const pts = (Array.isArray(samples) ? samples : [])
      .filter((x) => x && known(x.ts) && known(x.used) && x.ts >= b.start && x.ts <= b.end && known(x.resetsAt))
      .map((x) => ({ ts: x.ts, used: x.used, epoch: epochMinute(x.resetsAt) }))
      .sort((p, q) => p.ts - q.ts);
    if (cur && known(cur.t) && known(cur.u) && cur.t >= b.start && cur.t <= b.end && (!pts.length || cur.t > pts.at(-1).ts)) pts.push({ ts: cur.t, used: cur.u, epoch: epochMinute(b.end) });
    const segs = [];
    let seg = [];
    for (const x of pts) {
      const prev = seg.at(-1);
      if (prev && (x.epoch !== prev.epoch || x.ts - prev.t > HIST.gapMs || x.used < prev.u)) {
        segs.push(seg);
        seg = [];
      }
      seg.push({ t: x.ts, u: x.used, epoch: x.epoch });
    }
    if (seg.length) segs.push(seg);
    return segs;
  }

  /** One series per lab/window: T3-cache samples first, the service's lab-usage samples only
   *  where T3 has none within 10 minutes. Both lists bounded. */
  function mergeSeries(t3, srv) {
    const ok = (x) => x && known(x.ts) && known(x.used);
    const a = (Array.isArray(t3) ? t3 : []).filter(ok).sort((p, q) => p.ts - q.ts);
    const out = a.slice();
    let i = 0;
    for (const x of (Array.isArray(srv) ? srv : []).filter(ok).sort((p, q) => p.ts - q.ts)) {
      while (i < a.length && a[i].ts < x.ts - HIST.everyMs) i++;
      if (!(i < a.length && Math.abs(a[i].ts - x.ts) < HIST.everyMs)) out.push(x);
    }
    return out.sort((p, q) => p.ts - q.ts).slice(-HIST.maxPerSeries);
  }

  /** D, the run-out strip. x = the long window from start to reset; y = % used (drawing clamped
   *  to 0–100); a lane below for the short window at its true time. */
  function dGeometry(v, samples, now, width, height) {
    const b = v?.lp?.bounds;
    if (!v?.hasData || !b || !(b.end > b.start)) return null;
    const laneH = v.short ? 9 : 0;
    const gap = v.short ? 5 : 0;
    const plotH = height - laneH - gap;
    const X = (t) => width * clamp((t - b.start) / (b.end - b.start), 0, 1);
    const Y = (u) => plotH * (1 - clamp(u, 0, 100) / 100);
    const fc = forecast(v, now);
    const cur = known(v.long.fetchedAt) && known(v.long.usedPct) ? { t: v.long.fetchedAt, u: v.long.usedPct } : null;
    const runs = seriesSegments(samples, b, cur);
    const segs = runs.map((seg) => seg.map((p) => [X(p.t), Y(p.u)]));
    // Before the first logged point: a straight guess from the epoch start, marked as an estimate,
    // only when that start is known and inside what the history could have seen.
    let estimate = null;
    const es = v.epochStart;
    if (known(es) && es >= now - HIST.keepMs) {
      const first = runs.flat().find((p) => p.t >= es && p.epoch === epochMinute(b.end));
      if (first && first.t - es > HIST.gapMs) estimate = [[X(es), Y(0)], [X(first.t), Y(first.u)]];
    }
    let proj = null;
    let cross = null;
    if (fc.anchor && (fc.state === "out" || fc.state === "lasts")) {
      const end = fc.state === "out" ? [X(fc.crossing), Y(100)] : [X(b.end), Y(fc.endUsed)];
      proj = [[X(fc.anchor.t), Y(fc.anchor.u)], end];
      if (fc.state === "out") cross = { x: X(fc.crossing), y: Y(100) };
    }
    let lane = null;
    const sb = v.short ? windowBounds(v.short) : null;
    if (sb && v.sp) {
      const x0 = X(Math.max(sb.start, b.start));
      const x1 = X(Math.min(sb.end, b.end));
      if (x1 > x0) lane = { x: x0, w: x1 - x0, hitX: Math.min(x0, (x0 + x1) / 2 - 4), hitW: Math.max(8, x1 - x0), fill: clamp(v.sp.used, 0, 100) / 100, amber: v.sp.pace === "ahead", blocked: v.blocked };
    }
    return { width, height, plotH, laneY: plotH + gap, laneH, pace: [[0, plotH], [width, 0]], segs, estimate, proj, cross, cur: cur ? [X(cur.t), Y(cur.u)] : null, lane, nowX: X(now), fc };
  }

  const HANDOVER_REQUEST =
    "Please hand this thread over to a fresh thread at the next clean boundary, following the living-handoff rules: " +
    "bring the handoff file up to date, run `handover finalize`, launch the new thread with the message it prints, " +
    "then run `handover start`. Tell me which thread to use when it's done.";

  const chainLabel = (chain) => (chain && known(chain.position) ? `Handover ${chain.position}` : null);

  // WCAG contrast of two [r,g,b] (0-255).
  function contrast(a, b) {
    const lum = ([r, g, bl]) => {
      const f = (c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }

  // ---------- burn-rate tells (rows in the sidebar) ----------

  /** data-thread-item="ENV:THREAD" -> {env, threadId}; compact rows' "true" (or anything else) -> null.
   *  Environment ids have no colon; thread ids may ("mcp:…", "thread:…:…"), so split at the first. */
  function parseThreadItem(v) {
    if (typeof v !== "string") return null;
    const i = v.indexOf(":");
    if (i <= 0) return null;
    const env = v.slice(0, i);
    const threadId = v.slice(i + 1);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(env) || !threadId || threadId.length > 300) return null;
    return { env, threadId };
  }
  const BURN_TIERS = new Set(["burst", "building", "warm", "hot", "blazing"]);
  const BURN_NOTE = "Estimated API cost equivalent; not your subscription charge.";
  const money = (x) => (!known(x) ? "—" : x >= 10 ? `$${Math.round(x)}` : `$${x.toFixed(2)}`);
  /** What a sidebar row shows for one /burn entry (null = nothing). */
  function burnView(e) {
    if (!e || typeof e !== "object" || !BURN_TIERS.has(e.tier)) return null;
    const rate = known(e.rateUsdPerHour) ? Math.round(e.rateUsdPerHour) : null;
    const mins = known(e.hotForMin) ? Math.max(0, Math.round(e.hotForMin)) : null;
    const usual = known(e.usualUsdPerHour) ? ` Your usual is about ${money(e.usualUsdPerHour)}/h (your last 7 days, same model).` : "";
    if (e.tier === "burst") {
      const tip = e.recent
        ? `Recent burst: about ${money(e.burstUsd)} in 2 minutes. ${BURN_NOTE}`
        : e.provider === "grok"
          ? `Short burst: about ${money(e.burstUsd)} recorded in the last 2 minutes. ${BURN_NOTE}`
          : `Short burst: about ${money(e.burstUsd)} in the last 2 minutes. ${BURN_NOTE}`;
      return { tier: "burst", strip: null, ember: true, recent: Boolean(e.recent), chip: null, chipShort: null, tooltip: tip };
    }
    if (e.tier === "building") {
      return { tier: "building", strip: "thin", ember: true, recent: false, chip: null, chipShort: null, tooltip: `Running hot (building): about ${rate === null ? "—" : `$${rate}`} per hour for ${mins ?? "—"} minutes. ${BURN_NOTE}${usual}` };
    }
    return {
      tier: e.tier, strip: e.tier, ember: false, recent: false,
      chip: rate === null ? null : `🔥 $${rate}/h${mins === null ? "" : ` · ${mins} min`}`, chipShort: rate === null ? null : `$${rate}/h`,
      tooltip: `${e.tier === "blazing" ? "Blazing: b" : e.tier === "hot" ? "Hot: b" : "B"}urning about ${rate === null ? "—" : `$${rate}`} per hour for ${mins ?? "—"} minutes. ${BURN_NOTE}${usual}`,
    };
  }
  /** The rows to decorate: [{li, threadId, kind}] for this Mac's threads that have a tier. Card and
   *  slim rows carry their environment; a compact row (no environment) needs independent proof
   *  that it's local: the same thread on a local card/slim row, or the open local thread's route. */
  function burnTargets(lis, threads, localEnv, route) {
    const out = [];
    const local = new Set();
    const compact = [];
    if (!localEnv || !threads) return out;
    for (const li of lis) {
      const item = parseThreadItem(li.getAttribute("data-thread-item"));
      if (item) {
        if (normId(item.env) !== normId(localEnv)) continue;
        local.add(item.threadId);
        if (Object.hasOwn(threads, item.threadId)) out.push({ li, threadId: item.threadId, kind: li.querySelector('[data-testid="sidebar-row-slim"]') ? "slim" : "card" });
        continue;
      }
      const b = li.querySelector('[data-testid^="thread-row-"]');
      const id = b?.getAttribute("data-testid")?.slice("thread-row-".length);
      if (id) compact.push({ li, threadId: id, kind: "compact" });
    }
    const open = route?.kind === "thread" && normId(route.environmentId) === normId(localEnv) ? route.threadId : null;
    for (const c of compact) if (Object.hasOwn(threads, c.threadId) && (local.has(c.threadId) || c.threadId === open)) out.push(c);
    return out;
  }

  // ---------- reply footer: the team list's fold state ----------
  // T3 renders <details> as its own collapsible (open state in React), so folding means clicking
  // its summary button. Only the collapsible right after the footer's verdict table, after a
  // reply's last rule; no other collapsible is touched, and no attribute is set on T3's elements.
  const FOOTER_DETAILS = '.chat-markdown > hr:last-of-type + .chat-markdown-table-container:has([itemprop~="settle-yes"], [itemprop~="settle-no"]) + div > [data-markdown-details]';
  /** start-folded: fold each footer list once, the first time it's seen open (remembered in
   *  `seen`, a WeakSet), so Andy's own clicks are never undone. opening = the moment "always-show"
   *  is picked: open any folded one. Returns how many it clicked. */
  function footerPass(root, mode, seen, opening = false) {
    if (mode !== "start-folded" && !(mode === "always-show" && opening)) return 0;
    let clicks = 0;
    for (const el of root.querySelectorAll(FOOTER_DETAILS)) {
      const open = el.getAttribute("data-markdown-details-open") === "true";
      const btn = el.querySelector(":scope > [data-markdown-details-summary]");
      if (mode === "start-folded") {
        if (seen.has(el)) continue;
        seen.add(el);
        if (open && btn) {
          btn.click();
          clicks++;
        }
      } else if (!open && btn) {
        btn.click();
        clicks++;
      }
    }
    return clicks;
  }

  /** The <html> attributes for the CSS-only parts (the footer team mode is always set). */
  function rootAttrs(st) {
    const out = {
      "data-t3x-tight": st.tighter ? "" : null,
      "data-t3x-compact": st.compactThreads ? "" : null,
      "data-t3x-inline-icon": st.inlineIcon ? "" : null,
      "data-t3x-project-full": st.projectFull ? "" : null,
      "data-t3x-working": st.workingHeader ? "" : null,
      "data-t3x-marker": st.marker !== "off" ? st.marker : null,
      "data-t3x-footer-team": st.footerTeam,
    };
    for (const t of TARGETS) out[`data-t3x-ft-${t}`] = st.fontTargets[t] ? "" : null;
    return out;
  }

  /** When the service's lab-usage numbers count as failed (a failed refresh, or no answer). */
  function labUsageFailedSince(usage, transportFailedAt) {
    const u = usage && typeof usage === "object" ? usage : {};
    const fails = [known(u.failedAt) && u.failedAt >= (u.fetchedAt ?? 0) ? u.failedAt : null, transportFailedAt].filter(known);
    return fails.length ? Math.min(...fails) : null;
  }

  const core = {
    DEFAULTS, LEGACY_PRESETS, INTERFACE_TARGETS, FONT_ROLES, HIST, bLegend, readSettings, fontVisible, fontOptions, fontNeighbor, fontTags, T3_FONTS, parseRoute, normId, fmtPct, fmtAge, fmtReset, fmtWhen,
    effectiveFontPick, resolveFontGraph, fontLinkWouldCycle, usagePageHash, usageContainerMatches,
    FOOTER_TEAM, FOOTER_DETAILS, footerPass, rootAttrs, parseThreadItem, burnView, burnTargets, gateLabel, windowBounds, paceOf, projectT3Config, labsFromT3, mergeLabs, labView, views, visibleLabs, mostConstrained, composerSummary, compactLabel, bTooltip, bGeometry,
    forecast, seriesSegments, mergeSeries, dGeometry, fmtClock, lowRefills, compactParts, composerLabel, labUsageFailedSince, HANDOVER_REQUEST, chainLabel, contrast, STALE_MS, T3_STALE_MS,
  };
  if (W.__T3X_TEST__) {
    W.__T3X_TEST__.core = core;
    return;
  }

  // ===================================================================== DOM

  const D = document;
  const OWN = "data-t3x";
  const SVG = "http://www.w3.org/2000/svg";
  const cleanups = [];
  const timers = new Set();
  let settings = readSettings(safeGet(SETTINGS_KEY));
  let lastState = null; // last /state response (shared by every surface)
  let route = parseRoute(location.hash);
  let routeToken = 0;
  let paused = false;
  let observer = null;
  const errors = [];
  const status = {}; // feature -> "on" | "missing" | "ambiguous" | "off"

  function safeGet(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }
  function noteError(where, error) {
    const now = Date.now();
    errors.push(now);
    while (errors.length && now - errors[0] > 60e3) errors.shift();
    try {
      console.warn(`[t3-extras] ${where}:`, error);
    } catch {}
    if (errors.length > 10 && !paused) {
      paused = true;
      observer?.disconnect();
      console.warn("[t3-extras] paused after repeated errors; Shift-Cmd-R to retry");
    }
  }
  const guarded = (where, fn) => (...a) => {
    try {
      return fn(...a);
    } catch (e) {
      noteError(where, e);
    }
  };
  function every(ms, fn) {
    const id = setInterval(guarded("timer", fn), ms);
    timers.add(id);
    return id;
  }
  function later(ms, fn) {
    const id = setTimeout(() => {
      timers.delete(id);
      guarded("timer", fn)();
    }, ms);
    timers.add(id);
    return id;
  }
  function listen(target, type, fn, opts) {
    const g = guarded(type, fn);
    target.addEventListener(type, g, opts);
    cleanups.push(() => target.removeEventListener(type, g, opts));
  }

  /** Element builder: text only (never innerHTML), so titles and paths can't inject markup. */
  function h(tag, attrs = {}, ...kids) {
    const el = D.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), guarded(k, v));
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : D.createTextNode(String(kid)));
    return el;
  }
  /** SVG builder, numbers rounded to 0.1 px. */
  function s(tag, attrs = {}, ...kids) {
    const el = D.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "text") el.textContent = v;
      else el.setAttribute(k, typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v));
    }
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  }
  const pts = (list) => list.map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join(" ");

  const usable = (el) => Boolean(el && el.isConnected && !el.closest("[inert]") && el.getClientRects().length > 0);
  /** The single visible match, or null when there are none ("missing") or several ("ambiguous"). */
  function single(sel, root = D) {
    let pick = null;
    for (const el of root.querySelectorAll(sel)) {
      if (!usable(el) || el.closest(`[${OWN}]`)) continue;
      if (pick) return { el: null, why: "ambiguous" };
      pick = el;
    }
    return { el: pick, why: pick ? "on" : "missing" };
  }

  // ---------- <html> switches for the CSS-only parts ----------

  const ROOT_ATTRS = ["data-t3x-tight", "data-t3x-compact", "data-t3x-inline-icon", "data-t3x-project-full", "data-t3x-working", "data-t3x-marker", "data-t3x-footer-team", "data-t3x-fh", "data-t3x-fb", "data-t3x-fm", ...TARGETS.map((t) => `data-t3x-ft-${t}`)];
  function applyRootAttrs() {
    const r = D.documentElement;
    for (const [name, value] of Object.entries(rootAttrs(settings))) (value === null ? r.removeAttribute(name) : r.setAttribute(name, value));
    if (!settings.compactThreads) hideProjectTip();
  }
  const footerSeen = new WeakSet(); // footer team lists already handled in start-folded mode

  // Dynamic values live in one owned <style> (never on T3's own elements).
  const dyn = h("style", { [OWN]: "dyn", id: "t3x-dyn" });
  D.head.append(dyn);
  const dynVals = { mark: null, hdrW: 0 };
  function writeDyn() {
    const bases = Object.entries(roleBases).map(([k, v]) => `--t3x-base-${k}:${v};`).join("");
    dyn.textContent = `:root{${dynVals.mark ? `--t3x-mark:${dynVals.mark};` : ""}--t3x-hdr-w:${Math.ceil(dynVals.hdrW)}px;${bases}}`;
  }

  // ---------- compact threads: the project tooltip ----------
  // Compact rows hide the project name and the branch line; hovering the project icon shows both.
  // The text comes from T3's own (hidden) row nodes.
  let projectTip = null, projectTipFor = null, projectTipTimer = 0;
  function projectIconOf(node) {
    if (!D.documentElement.hasAttribute("data-t3x-compact")) return null;
    return node?.closest?.('[data-testid="sidebar-row-card"] > div.relative > div:first-child > .size-4') ?? null;
  }
  function projectTipText(icon) {
    const content = icon.parentElement?.parentElement;
    const name = content?.firstElementChild?.querySelector(":scope > span.min-w-0.flex-1")?.textContent.trim() || "";
    const meta = content?.children[2];
    const branch = meta?.querySelector(":scope > span.flex.flex-1:not(.truncate)")?.textContent.trim() || "";
    const machine = meta?.querySelector(":scope > span.flex-1.truncate")?.textContent.trim() || "";
    const diff = meta?.querySelector(":scope > span.font-mono")?.textContent.replace(/\s+/g, " ").trim() || "";
    return { name, detail: [branch ? `Branch: ${branch}` : machine, diff].filter(Boolean).join(" · ") };
  }
  function hideProjectTip() {
    if (projectTipTimer) { clearTimeout(projectTipTimer); timers.delete(projectTipTimer); projectTipTimer = 0; }
    projectTipFor = null;
    projectTip?.remove();
    projectTip = null;
  }
  function showProjectTip(icon) {
    const { name, detail } = projectTipText(icon);
    if (!name && !detail) return;
    projectTip?.remove();
    projectTip = h("div", { [OWN]: "project-tip", class: "t3x-ptip", role: "tooltip" },
      name ? h("strong", { text: name }) : null, detail ? h("span", { class: "t3x-ptip-sub", text: detail }) : null);
    D.body.append(projectTip);
    const r = icon.getBoundingClientRect(), w = projectTip.offsetWidth, ht = projectTip.offsetHeight;
    projectTip.style.left = `${Math.max(4, Math.min(r.left - 4, innerWidth - w - 4))}px`;
    projectTip.style.top = `${r.bottom + ht + 10 > innerHeight ? Math.max(4, r.top - ht - 6) : r.bottom + 6}px`;
  }
  listen(D, "pointerover", (e) => {
    const icon = projectIconOf(e.target);
    if (icon && icon === projectTipFor) return;
    hideProjectTip();
    if (!icon) return;
    projectTipFor = icon;
    projectTipTimer = later(250, () => {
      projectTipTimer = 0;
      if (projectTipFor === icon && icon.isConnected && projectIconOf(icon)) showProjectTip(icon);
    });
  }, true);
  listen(D, "pointerout", (e) => { if (!e.relatedTarget) hideProjectTip(); }, true);
  listen(D, "pointerdown", hideProjectTip, true);
  listen(D, "scroll", hideProjectTip, true);
  listen(W, "blur", hideProjectTip);

  /** Selected-row marker colour: T3's primary when it stands out against the sidebar, else the text colour. */
  function toRgb(color) {
    const c = D.createElement("canvas");
    c.width = c.height = 1;
    const x = c.getContext("2d");
    x.fillStyle = "#000";
    x.fillStyle = color;
    x.fillRect(0, 0, 1, 1);
    const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  }
  function updateMarkColor() {
    const side = D.querySelector('[data-slot="sidebar-inner"]') ?? D.body;
    const cs = getComputedStyle(D.documentElement);
    const primary = cs.getPropertyValue("--primary").trim();
    const fg = cs.getPropertyValue("--sidebar-foreground").trim() || cs.getPropertyValue("--foreground").trim();
    const bg = getComputedStyle(side).backgroundColor;
    let pick = fg || "currentColor";
    if (primary && bg) {
      try {
        if (contrast(toRgb(primary), toRgb(bg)) >= 3) pick = primary;
      } catch {}
    }
    if (pick !== dynVals.mark) {
      dynVals.mark = pick;
      writeDyn();
    }
  }

  // ---------- server state ----------

  // Teardown bookkeeping: once disposed, no late response, animation frame or font callback
  // may render or mount anything again.
  let disposed = false;
  const requests = new Set(); // AbortControllers of in-flight fetches
  let rafId = 0;

  let inflight = null; // { token, p }
  async function fetchState({ fresh = false } = {}) {
    if (disposed) return;
    if (inflight && !fresh && inflight.token === routeToken) return inflight.p;
    const token = routeToken; // changes on navigation and on teardown
    const thread = route.kind === "thread" ? route.threadId : "";
    const ctrl = new AbortController();
    requests.add(ctrl);
    const kill = setTimeout(() => ctrl.abort(), fresh ? 20e3 : 10e3);
    const current = () => !disposed && token === routeToken;
    const p = fetch(`${BASE}state?thread=${encodeURIComponent(thread)}${fresh ? "&fresh=1" : ""}`, { cache: "no-store", signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`state ${r.status}`))))
      .then((st) => {
        if (!current()) return; // a response for the previous thread, or for a torn-down copy
        lastState = { ...st, receivedAt: Date.now() };
        render();
        readT3Cache();
      })
      .catch(() => {
        if (!current()) return;
        // The service didn't answer (or answered with an error): keep the old numbers, marked stale now.
        lastState = { ...(lastState ?? {}), transportFailedAt: Date.now() };
        render();
      })
      .finally(() => {
        clearTimeout(kill);
        requests.delete(ctrl);
        if (inflight?.p === p) inflight = null;
      });
    if (!fresh) inflight = { token, p };
    return p;
  }

  function syncUsageMarker() {
    if (!D || typeof D.querySelectorAll !== "function") return;
    const hash = String(location.hash ?? "");
    const wanted = new Set();
    if (usagePageHash(hash)) {
      for (const el of D.querySelectorAll("div.mx-auto.flex.w-full.flex-col")) {
        const heading = el.querySelector("h1");
        if (usageContainerMatches(el.className, heading ? heading.textContent : "", hash)) {
          el.setAttribute("data-t3x-usage-page", "1");
          wanted.add(el);
        }
      }
    }
    for (const el of D.querySelectorAll("[data-t3x-usage-page]")) {
      if (!wanted.has(el)) el.removeAttribute("data-t3x-usage-page");
    }
  }
  function checkRoute() {
    if (disposed) return false;
    syncUsageMarker();
    const next = parseRoute(location.hash);
    if (JSON.stringify(next) === JSON.stringify(route)) return false;
    route = next;
    routeToken++;
    if (lastState) lastState = { ...lastState, handover: { ...(lastState.handover ?? {}), chain: null } }; // clear on navigation
    if (pop?.kind === "chain" || pop?.kind === "handover") closePopover();
    fetchState();
    return true;
  }

  const isLocalThread = () =>
    route.kind === "thread" && Boolean(lastState?.localEnvironmentId) && normId(lastState.localEnvironmentId) === normId(route.environmentId);
  /** Why handover can't be offered here, or null. Unknown locality counts as "not here". */
  const handoverBlocker = () =>
    route.kind === "draft" ? "Not on a draft: send the first message, then hand over."
      : route.kind !== "thread" ? "Open a thread first."
      : !lastState ? "Waiting for the add-ons service to say which threads run on this Mac."
      : !lastState.localEnvironmentId ? "Can't tell whether this thread runs on this Mac (T3's environment id couldn't be read)."
      : !isLocalThread() ? "This thread runs on another machine; handover works for threads on this Mac."
      : null;

  // ---------- T3's own quota readings: its IndexedDB, read only ----------
  // Database t3code:connection-runtime, store server-config, key = this Mac's environment id.
  // Never created, upgraded or written: no version passed to open(); an upgrade (= the database
  // doesn't exist) is aborted; one readonly transaction, then the connection is closed at once.

  const T3_DB = "t3code:connection-runtime";
  const T3_STORE = "server-config";
  let t3 = { state: "waiting", labs: null, readAt: null, failedAt: null };
  let t3Inflight = null;

  // Every read in flight, so teardown can abort it. Each read's cleanup (one place): clear its
  // timer, abort its transaction if still open, close its connection.
  const t3Pending = new Set();
  function t3Get(key) {
    return new Promise((resolve, reject) => {
      let done = false;
      let db = null;
      let tx = null;
      let timer = null;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (tx) {
          try {
            tx.abort();
          } catch {}
        }
        tx = null;
        if (db) {
          try {
            db.close();
          } catch {}
        }
        db = null;
      };
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        t3Pending.delete(stop);
        cleanup();
        fn(v);
      };
      const stop = () => finish(reject, new Error("stopped"));
      if (disposed) return reject(new Error("disposed"));
      let req;
      try {
        req = indexedDB.open(T3_DB);
      } catch (e) {
        return reject(e);
      }
      t3Pending.add(stop);
      timer = setTimeout(() => finish(reject, new Error("timeout")), 5000);
      req.onupgradeneeded = () => {
        try {
          req.transaction.abort(); // the database didn't exist: don't create it
        } catch {}
        finish(resolve, undefined);
      };
      req.onblocked = () => finish(reject, new Error("blocked"));
      req.onerror = () => finish(reject, req.error);
      req.onsuccess = () => {
        const conn = req.result;
        if (done || disposed) {
          try {
            conn.close(); // a late open (after a timeout or teardown) is closed at once
          } catch {}
          return finish(reject, new Error("late"));
        }
        db = conn;
        db.onversionchange = () => finish(reject, new Error("versionchange")); // never hold up a T3 upgrade
        try {
          if (!db.objectStoreNames.contains(T3_STORE)) return finish(resolve, undefined);
          tx = db.transaction(T3_STORE, "readonly");
          const g = tx.objectStore(T3_STORE).get(key);
          g.onsuccess = () => {
            const v = g.result;
            tx = null; // finished: nothing to abort
            finish(resolve, v);
          };
          g.onerror = () => finish(reject, g.error);
          tx.onabort = () => finish(reject, tx?.error ?? new Error("abort"));
        } catch (e) {
          finish(reject, e);
        }
      };
    });
  }

  function readT3Cache() {
    if (disposed || t3Inflight) return t3Inflight;
    const envId = lastState?.localEnvironmentId;
    t3Inflight = (async () => {
      if (!envId) return { state: "noenv" };
      if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return { state: "unsupported" };
      const list = await indexedDB.databases();
      if (disposed) return { state: "disposed" }; // never open after teardown
      if (!list.some((d) => d && d.name === T3_DB)) return { state: "absent" };
      const raw = await t3Get(envId);
      if (disposed) return { state: "disposed" };
      return projectT3Config(raw, envId);
    })()
      .catch(() => ({ state: "error" }))
      .then(guarded("t3cache", (res) => {
        if (disposed) return;
        const now = Date.now();
        if (res.state === "ok") {
          t3 = { state: "ok", labs: labsFromT3(res, now), readAt: now, failedAt: null };
          logT3History(t3.labs);
        } else {
          // Keep the last good numbers (each carries its own checkedAt), marked stale.
          t3 = { ...t3, state: res.state, failedAt: t3.labs ? now : null };
        }
        render();
      }))
      .finally(() => {
        t3Inflight = null;
      });
    return t3Inflight;
  }

  // ---------- usage history: our own IndexedDB ring ----------
  // t3x-usage-history / samples, key [series, ts], index ts. One writer queue; at most one sample
  // per series per 10 min (checked inside the write transaction, so two T3 windows can't double
  // up); 15 days; record cap (and a per-record size cap, so a byte cap); bounded reads. Errors
  // are swallowed: the strip then shows only what it can estimate.

  const HIST_DB = "t3x-usage-history";
  const HIST_STORE = "samples";
  let histQueue = Promise.resolve();
  let histErrors = 0;
  let histCount = null;
  let histPrunedAt = 0;
  const histLast = new Map();
  const histBroken = () => histErrors >= 3 || typeof indexedDB === "undefined";

  function histOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(HIST_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HIST_STORE)) db.createObjectStore(HIST_STORE, { keyPath: ["s", "ts"] }).createIndex("ts", "ts");
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    });
  }
  function histTx(db, mode, body) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HIST_STORE, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("abort"));
      result = body(tx.objectStore(HIST_STORE), (v) => (result = v));
    });
  }
  function histPrune(db) {
    return histTx(db, "readwrite", (store) => {
      const idx = store.index("ts");
      const old = idx.openCursor(IDBKeyRange.upperBound(Date.now() - HIST.keepMs));
      old.onsuccess = () => {
        const c = old.result;
        if (c) {
          c.delete();
          c.continue();
        } else countAndTrim(); // only once the expired ones are gone
      };
      const countAndTrim = () => {
        const n = store.count();
        n.onsuccess = () => {
          histCount = n.result;
          let extra = n.result - HIST.maxRecords;
          if (extra <= 0) return;
          const o = idx.openCursor();
          o.onsuccess = () => {
            const c = o.result;
            if (c && extra-- > 0) {
              c.delete();
              c.continue();
            }
          };
        };
      };
    });
  }
  function histWrite(samples) {
    if (histBroken() || disposed) return;
    const due = samples.filter((x) => x && x.ts - (histLast.get(x.s) ?? 0) >= HIST.everyMs && JSON.stringify(x).length <= HIST.maxRecordBytes);
    if (!due.length) return;
    for (const x of due) histLast.set(x.s, x.ts);
    histQueue = histQueue
      .then(async () => {
        const db = await histOpen();
        try {
          await histTx(db, "readwrite", (store) => {
            for (const x of due) {
              const c = store.openCursor(IDBKeyRange.bound([x.s, -Infinity], [x.s, Infinity]), "prev");
              c.onsuccess = () => {
                const last = c.result?.value;
                if (!last || x.ts - last.ts >= HIST.everyMs) store.put(x);
              };
            }
          });
          if (histCount === null || histCount + due.length > HIST.maxRecords - 50 || Date.now() - histPrunedAt > HOUR) {
            histPrunedAt = Date.now();
            await histPrune(db);
          } else histCount += due.length;
        } finally {
          db.close();
        }
      })
      .catch(() => {
        histErrors++;
      });
  }
  function histRead(series, since) {
    if (histBroken()) return Promise.resolve([]);
    return histQueue.then(async () => {
      const db = await histOpen();
      try {
        return await histTx(db, "readonly", (store, set) => {
          const r = store.getAll(IDBKeyRange.bound([series, since], [series, Infinity]), HIST.maxPerSeries);
          r.onsuccess = () => set(r.result);
        });
      } finally {
        db.close();
      }
    }).catch(() => {
      histErrors++;
      return [];
    });
  }
  function logT3History(labs) {
    const samples = [];
    for (const lab of Object.values(labs ?? {})) {
      if (!lab.live) continue;
      for (const w of lab.windows) {
        if ((w.role !== "long" && w.role !== "short") || !known(w.fetchedAt) || !known(w.usedPct)) continue;
        samples.push({ s: `${lab.id}:${w.role}`, ts: w.fetchedAt, used: Math.round(w.usedPct * 100) / 100, resetsAt: w.resetsAt ?? null, lengthSec: w.lengthSec ?? null });
      }
    }
    histWrite(samples);
  }

  // History for the detail: our ring + the service's lab-usage log, merged; refreshed at most every minute.
  let history = { at: 0, bySeries: {}, loading: null };
  function loadHistory(vs) {
    if (history.loading || Date.now() - history.at < 60e3) return history.loading;
    const since = Date.now() - HIST.keepMs;
    const ctrl = new AbortController();
    requests.add(ctrl);
    const srv = fetch(`${BASE}history?since=${since}`, { cache: "no-store", signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (Array.isArray(j?.samples) ? j.samples.slice(-HIST.maxPerSeries * 8) : []))
      .catch(() => [])
      .finally(() => requests.delete(ctrl));
    const ids = compactLabs(vs).map((v) => `${v.id}:long`);
    history.loading = Promise.all([srv, ...ids.map((id) => histRead(id, since))])
      .then(guarded("history", ([server, ...mine]) => {
        if (disposed) return;
        const bySeries = {};
        ids.forEach((id, i) => {
          bySeries[id] = mergeSeries(mine[i], server.filter((x) => x && x.s === id));
        });
        history = { at: Date.now(), bySeries, loading: null };
        if (pop?.kind === "usage") fillPopover();
      }))
      .finally(() => {
        history.loading = null;
      });
    return history.loading;
  }

  // ---------- the one model every usage place reads ----------

  function currentViews(now = Date.now()) {
    const fails = { labUsage: labUsageFailedSince(lastState?.usage, lastState?.transportFailedAt ?? null), t3: t3.failedAt };
    return views(mergeLabs(t3.labs, lastState?.usage?.labs), now, fails);
  }

  // ---------- B glyphs ----------

  function bSvg(v, width, height, size) {
    if (!v?.hasData) return s("svg", { class: `t3x-b${v.stale ? " t3x-dim" : ""}`, width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true", focusable: "false" },
      s("text", { x: width / 2, y: height / 2, "text-anchor": "middle", "dominant-baseline": "central", "font-size": height, fill: v.colour, text: "—" }));
    const g = bGeometry(v, width, height, size);
    const kids = [
      s("rect", { class: "t3x-b-track", x: g.track.x, y: g.track.y, width: g.track.w, height: g.track.h, rx: g.track.r }),
    ];
    if (g.fillW > 0) kids.push(s("rect", { class: "t3x-b-fill", x: 0, y: g.track.y, width: g.fillW, height: g.track.h, rx: g.track.r, fill: v.colour }));
    if (g.needle) kids.push(s("line", { class: "t3x-b-needle", x1: g.needle.x, x2: g.needle.x, y1: g.needle.y1, y2: g.needle.y2 }));
    if (g.tank) {
      const t = g.tank;
      const lh = t.h * t.level;
      kids.push(
        s("rect", { class: "t3x-b-tank", x: t.x, y: 0.5, width: t.w, height: t.h - 1, rx: t.r }),
        lh > 0 ? s("rect", { class: `t3x-b-level${t.amber ? " t3x-amber" : ""}`, x: t.x + 1, y: t.h - 0.5 - Math.max(0, lh - 1), width: t.w - 2, height: Math.max(0, lh - 1), rx: Math.max(0, t.r - 1), fill: t.amber ? null : v.colour }) : null,
        t.blocked ? s("line", { class: "t3x-b-blocked", x1: t.x, x2: t.x + t.w, y1: t.h - 1, y2: 1 }) : null,
      );
    }
    return s("svg", { class: `t3x-b${v.stale ? " t3x-dim" : ""}`, width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true", focusable: "false" }, kids);
  }

  // ---------- D strips ----------

  function dSvg(v, samples, now, width, height) {
    const g = dGeometry(v, samples, now, width, height);
    if (!g) return null;
    const kids = [
      s("rect", { class: "t3x-d-bg", x: 0, y: 0, width, height: g.plotH, rx: 3 }),
      s("polyline", { class: "t3x-d-pace", points: pts(g.pace) }),
      s("line", { class: "t3x-d-now", x1: g.nowX, x2: g.nowX, y1: 0, y2: height }),
    ];
    if (g.estimate) kids.push(s("polyline", { class: "t3x-d-est", points: pts(g.estimate), stroke: v.colour }));
    for (const seg of g.segs) {
      kids.push(seg.length > 1 ? s("polyline", { class: "t3x-d-run", points: pts(seg), stroke: v.colour }) : s("circle", { class: "t3x-d-dot", cx: seg[0][0], cy: seg[0][1], r: 1.4, fill: v.colour }));
    }
    if (g.proj) kids.push(s("polyline", { class: "t3x-d-proj", points: pts(g.proj), stroke: v.colour }));
    if (g.cur) kids.push(s("circle", { class: "t3x-d-cur", cx: g.cur[0], cy: g.cur[1], r: 2.6, fill: v.colour }));
    if (g.cross) {
      const { x, y } = g.cross;
      kids.push(s("path", { class: "t3x-d-cross", d: `M${x - 3.5} ${y - 3.5} L${x + 3.5} ${y + 3.5} M${x + 3.5} ${y - 3.5} L${x - 3.5} ${y + 3.5}` }));
    }
    // The short window's own lane: its true time span, filled to its own % used.
    if (g.laneH) {
      kids.push(s("rect", { class: "t3x-d-lane", x: 0, y: g.laneY, width, height: g.laneH, rx: 2 }));
      const right = g.lane && g.lane.x < 40;
      kids.push(s("text", { class: "t3x-d-lanelabel", x: right ? width - 3 : 3, y: g.laneY + g.laneH - 2, "text-anchor": right ? "end" : "start", text: v.shortTag }));
    }
    if (g.lane) {
      const l = g.lane;
      kids.push(
        s("rect", { class: "t3x-d-slot", x: l.x, y: g.laneY, width: Math.max(1, l.w), height: g.laneH }),
        s("rect", { class: `t3x-d-slot-fill${l.amber ? " t3x-amber" : ""}${l.blocked ? " t3x-blocked" : ""}`, x: l.x, y: g.laneY + g.laneH * (1 - l.fill), width: Math.max(1, l.w), height: g.laneH * l.fill, fill: l.amber || l.blocked ? null : v.colour }),
        s("rect", { class: "t3x-d-hit", x: l.hitX, y: g.laneY - 2, width: l.hitW, height: g.laneH + 4 }, s("title", { text: `${v.shortWord} window: ${v.blocked ? "blocked" : `${fmtPct(v.sp.used)} used`}, ${fmtWhen(windowBounds(v.short)?.start)} to ${fmtWhen(v.short.resetsAt)}` })),
      );
    }
    return s("svg", { class: `t3x-d${v.stale ? " t3x-dim" : ""}`, width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${v.name} ${v.longWord.toLowerCase()} usage over time. ${g.fc.text}` }, kids);
  }

  // ---------- popover (usage detail, chain history, add-ons panel) ----------

  let pop = null;
  function closePopover(restoreFocus = false) {
    if (!pop) return;
    const { el, trigger, onClose } = pop;
    closeFontPreviews();
    pop = null;
    el.remove();
    trigger?.setAttribute("aria-expanded", "false");
    onClose?.();
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }
  function openPopover(trigger, kind, build, { width = 340, onClose } = {}) {
    if (pop && pop.kind === kind && pop.trigger === trigger) return closePopover(true);
    closePopover();
    const el = h("div", { [OWN]: "pop", class: "t3x-pop", role: "dialog", "aria-label": build.label, tabindex: "-1" });
    el.style.width = `${width}px`;
    D.body.append(el);
    pop = { el, trigger, kind, build, onClose };
    trigger.setAttribute("aria-expanded", "true");
    fillPopover();
    place();
    el.focus({ preventScroll: true });
  }
  function fillPopover() {
    if (!pop) return;
    const keep = pop.el.scrollTop;
    const focusKey = D.activeElement?.closest?.(".t3x-pop") ? D.activeElement.getAttribute("data-focus") : null;
    pop.el.replaceChildren(...[pop.build()].flat(4).filter((n) => n !== null && n !== undefined && n !== false));
    pop.el.scrollTop = keep;
    if (pop.kind === "panel") warmSelectedNames();
    if (focusKey) {
      const next = pop.el.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
      const match = /^(prev|next|minus|plus|reset)-(\w+)$/.exec(focusKey);
      let focus = next;
      if (match && (!next || next.disabled)) {
        const [, action, role] = match;
        const candidates = action === "minus" ? ["plus", "sel"] : action === "plus" ? ["minus", "sel"] : action === "reset" ? ["plus", "minus", "sel"] : ["sel"];
        focus = candidates.map((key) => pop.el.querySelector(`[data-focus="${key}-${role}"]`)).find((node) => node && !node.disabled);
      }
      if (focus?.closest("[hidden]")) focus = pop.el.querySelector('[data-focus="font-interface"]');
      focus?.focus({ preventScroll: true });
    }
  }
  function place() {
    if (!pop) return;
    const r = pop.trigger.getBoundingClientRect();
    const el = pop.el;
    const vw = innerWidth;
    const vh = innerHeight;
    const w = Math.min(el.offsetWidth, vw - 16);
    let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
    if (r.left < vw / 3) left = Math.max(8, Math.min(r.left, vw - w - 8)); // sidebar: align left
    const below = r.top < vh / 2;
    el.style.left = `${left}px`;
    el.style.maxHeight = `${Math.max(160, (below ? vh - r.bottom : r.top) - 16)}px`;
    if (below) {
      el.style.top = `${r.bottom + 6}px`;
      el.style.bottom = "";
    } else {
      el.style.bottom = `${vh - r.top + 6}px`;
      el.style.top = "";
    }
  }
  listen(D, "keydown", (e) => {
    if (e.key === "Escape" && pop) {
      if (pop.el.querySelector("select:open")) return; // native picker dismisses before its panel
      e.stopPropagation();
      closePopover(true);
    }
  }, true);
  listen(D, "pointerdown", (e) => {
    if (pop && !pop.el.contains(e.target) && !pop.trigger.contains(e.target)) closePopover();
  }, true);
  listen(W, "resize", () => { closePopover(); preserveFontWorkspaceOnResize(); });

  // ---------- usage detail (D, one strip per lab) ----------

  function usageDetail() {
    const now = Date.now();
    const vs = currentViews(now);
    const lu = lastState?.usage ?? {};
    const luFailed = labUsageFailedSince(lu, lastState?.transportFailedAt ?? null);
    const width = 312;
    const section = (v) => {
      const fc = forecast(v, now);
      const samples = history.bySeries[`${v.id}:long`] ?? [];
      const lp = v.lp;
      const rows = [];
      rows.push(h("div", { class: "t3x-row" }, h("span", { class: "t3x-row-name", text: v.longWord }),
        h("span", { class: "t3x-row-val" }, h("b", { text: `${fmtPct(lp.left)} left` }),
          ` · ${known(v.long.usedPct) ? `${Math.round(v.long.usedPct)}%` : "—"} used · even pace ${known(lp.timeLeft) ? `${lp.timeLeft}% left` : "—"} · ${fmtReset(v.long.resetsAt, now)}`)));
      if (v.short) {
        rows.push(h("div", { class: "t3x-row" }, h("span", { class: "t3x-row-name", text: v.shortWord }),
          h("span", { class: "t3x-row-val" }, v.blocked
            ? h("b", { text: `blocked by the ${v.longAdj} limit until ${fmtWhen(v.long.resetsAt)}` })
            : [h("b", { text: `${fmtPct(v.sp.left)} left` }), ` · even pace ${known(v.sp.timeLeft) ? `${v.sp.timeLeft}% left` : "—"} · ${fmtReset(v.short.resetsAt, now)}${v.sp.pace === "ahead" ? " · ahead of its clock" : ""}`])));
      }
      if (fc.source === "lab-usage") rows.push(h("div", { class: "t3x-row" }, h("span", { class: "t3x-row-name", text: "Projection" }), h("span", { class: "t3x-row-val", text: `about ${Math.round(v.long.projection)}% used at reset (lab-usage, allowing for manual resets)` })));
      else if (fc.source === "average") rows.push(h("div", { class: "t3x-row" }, h("span", { class: "t3x-row-name", text: "Projection" }), h("span", { class: "t3x-row-val", text: `about ${Math.round(fc.endUsed)}% used at reset (average since the window started)` })));
      if (lp.bounds?.assumed) rows.push(h("div", { class: "t3x-muted", text: `Pace assumed: ${v.name} doesn't report its window length (taken as ${lp.bounds.assumed === "week" ? "7 days" : "the calendar month"} before the reset).` }));
      // Claude's tier and today's share; Codex's gate, level and resets (lab-usage), shown only from a fresh read.
      const vd = v.verdict;
      const vFresh = vd && v.verdictLive !== false && known(v.verdictAt) && now - v.verdictAt <= STALE_MS && !luFailed;
      if (vd && v.id === "claude") {
        rows.push(h("div", { class: "t3x-line" }, vd.tierName ?? vd.tier ?? "tier unknown", vFresh ? "" : " (stale)",
          vd.today && known(vd.today.share) ? ` · today ${known(vd.today.spent) ? vd.today.spent.toFixed(1) : "—"} of ${vd.today.share.toFixed(1)} points` : "",
          vd.stops?.length ? ` · stops: ${vd.stops.join(", ")}` : ""));
      }
      if (v.id === "codex") {
        rows.push(h("div", { class: "t3x-line" },
          vd && vFresh && vd.gate ? `gate: ${gateLabel(vd.gate.action)} (${vd.gate.action}${vd.gate.reason ? `, ${vd.gate.reason}` : ""})` : "gate — (needs a fresh live read)",
          vd?.level ? ` · ${vd.level}${known(vd.challengeDay) ? ` day ${vd.challengeDay}` : ""}` : "",
          known(v.resetCredits?.availableCount) ? ` · banked resets ${v.resetCredits.availableCount}${known(v.resetCredits.nextExpiresAt) ? ` (next expires ${new Date(v.resetCredits.nextExpiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })})` : ""}` : vd && vFresh && known(vd.resetsAvailable) ? ` · banked resets ${vd.resetsAvailable}` : "",
          vd && vFresh && known(vd.resetsAtRisk) ? (vd.resetsAtRisk ? ` · ${vd.resetsAtRisk} at risk` : " · none at risk") : ""));
      }
      const extras = v.windows.filter((w) => w.role === "extra" && known(w.usedPct));
      if (extras.length) {
        // Grouped: "Claude/GPT via Antigravity: 5-hour 100% left, Weekly 100% left".
        const groups = new Map();
        for (const w of extras) {
          const g = w.group ?? "";
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(`${w.group ? String(w.label ?? "").replace(/^.*·\s*/, "") : w.label ?? w.id} ${Math.round(100 - clamp(w.usedPct, 0, 100))}% left`);
        }
        rows.push(h("div", { class: "t3x-muted" }, `Also: ${[...groups].map(([g, list]) => (g ? `${g}: ${list.join(", ")}` : list.join(" · "))).join(" · ")}`));
      }
      return h("section", { class: `t3x-lab${v.stale ? " t3x-stale" : ""}` },
        h("h3", {}, h("span", { class: "t3x-swatch", style: `background:${v.colour}` }), v.name, v.stale ? h("span", { class: "t3x-tag", text: "stale" }) : null),
        h("div", { class: "t3x-b-big", title: bTooltip(v, now) }, bSvg(v, width, 22, "lg")),
        dSvg(v, samples, now, width, 64),
        h("div", { class: `t3x-fc t3x-fc-${fc.state}`, text: fc.text }),
        rows,
        h("div", { class: "t3x-muted", text: `${v.source === "t3" ? "T3's reading" : "lab-usage's reading"} ${fmtAge(v.age)}` }));
    };
    const withData = vs.filter((v) => v.hasData);
    const unknown = vs.filter((v) => !v.hasData && v.showUnknown);
    const without = vs.filter((v) => !v.hasData && !v.showUnknown);
    const t3Note = t3.state === "ok" || t3.state === "waiting" ? null
      : t3.state === "absent" || t3.state === "missing" ? "T3 hasn't saved any quota readings on this Mac yet."
      : t3.state === "schema" ? "T3's saved quota readings are in a shape these add-ons don't know; showing lab-usage only."
      : t3.state === "noenv" ? "Waiting for the add-ons service to say which T3 environment is this Mac."
      : "Couldn't read T3's saved quota readings just now.";
    return [
      h("header", { class: "t3x-pop-head" }, h("strong", { text: "Usage · This Mac" }),
        h("span", { class: "t3x-muted", text: t3.readAt ? `read ${fmtAge(now - t3.readAt)}` : lu.fetchedAt ? `updated ${fmtAge(now - lu.fetchedAt)}` : "not read yet" })),
      h("div", { class: "t3x-legend" }, h("div", { text: bLegend(withData) }), h("div", { text: `Strip: time across the window, height = % used. Dashed diagonal = even pace; solid = measured; faint dashes = estimated before logging; dots = projection; ✕ = estimated run-out.${withData.some((v) => v.short) ? ` Lane below: the ${[...new Set(withData.filter((v) => v.short).map((v) => v.shortWord))].join(" or ")} window at its real time, filled to its own % used.` : ""}` })),
      luFailed ? h("div", { class: "t3x-warn", text: `${lastState?.transportFailedAt ? "Couldn't reach the add-ons service" : "lab-usage's last refresh failed"} ${fmtAge(now - luFailed)}; its numbers are marked stale.` }) : null,
      t3Note ? h("div", { class: "t3x-warn", text: t3Note }) : null,
      withData.length ? withData.map(section) : h("div", { class: "t3x-muted", text: "No usage readings yet." }),
      unknown.map((v) => h("section", { class: `t3x-lab${v.stale ? " t3x-stale" : ""}` },
        h("h3", {}, h("span", { class: "t3x-swatch", style: `background:${v.colour}` }), v.name, v.stale ? h("span", { class: "t3x-tag", text: "stale" }) : null),
        h("div", { text: "— · Usage unavailable" }),
        h("div", { class: "t3x-muted", text: v.noMeter }),
        h("div", { class: "t3x-muted", text: known(v.age) ? `T3 last checked ${fmtAge(v.age)}` : "Last check unknown" }))),
      without.length ? h("section", { class: "t3x-lab" }, h("h3", { text: "No meter yet" }),
        h("div", { class: "t3x-muted", text: without.map((v) => `${v.name} (${v.noMeter ?? "no meter yet"})`).join(" · ") })) : null,
      h("div", { class: "t3x-muted t3x-foot", text: "From T3's own saved quota readings (read only) and lab-usage --json --read-only (tier, gate, projections). Remaining is shown everywhere." }),
    ];
  }
  usageDetail.label = "Usage on this Mac";
  const openUsage = (trigger) => {
    openPopover(trigger, "usage", usageDetail, { width: 344 });
    fetchState({ fresh: true });
    readT3Cache();
    loadHistory(currentViews());
  };

  // ---------- features ----------

  const features = {};
  const sig = (node, key) => {
    if (node.__t3xSig === key) return false;
    node.__t3xSig = key;
    return true;
  };
  const viewKey = (v) => `${v.id}|${v.hasData}|${v.noMeter}|${!v.hasData ? v.fetchedAt : ""}|${v.lp?.leftExact?.toFixed(1)}|${v.lp?.timeLeftExact?.toFixed(1)}|${v.sp?.leftExact?.toFixed(1)}|${v.sp?.pace}|${v.blocked}|${v.stale}`;

  // Header: the chain pill, and one compact B glyph per lab with data (no labels; tooltips).
  features.header = {
    on: () => settings.usageHeader || settings.chainPill || settings.burnTells,
    node: null,
    find: () => single("[data-workspace-titlebar-controls] > div:not([aria-hidden])"),
    build() {
      const chain = h("button", { type: "button", class: "t3x-pill t3x-chain", [OWN]: "chain", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: (e) => openChain(e.currentTarget) });
      const heat = h("span", { class: "t3x-pill t3x-burn-hdr", [OWN]: "burn-hdr", role: "img" });
      const usage = h("button", { type: "button", class: "t3x-pill t3x-hdr-usage", [OWN]: "hdr-usage", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: (e) => openUsage(e.currentTarget) });
      const box = h("div", { [OWN]: "hdr", class: "t3x-hdr" }, heat, chain, usage);
      if (W.ResizeObserver) {
        const ro = new ResizeObserver(guarded("resize", () => {
          if (disposed) return;
          dynVals.hdrW = box.isConnected ? box.getBoundingClientRect().width + 8 : 0;
          writeDyn();
        }));
        ro.observe(box);
        cleanups.push(() => ro.disconnect());
      }
      return box;
    },
    mount: (anchor, node) => anchor.prepend(node),
    update(node, vs, now) {
      const chain = node.querySelector(".t3x-chain");
      const c = lastState?.handover?.chain;
      const showChain = settings.chainPill && isLocalThread() && c;
      chain.hidden = !showChain;
      if (showChain) {
        chain.textContent = chainLabel(c);
        chain.title = `Handover chain ${c.short} · thread ${c.position} of ${c.length}. Click for its history.`;
      }
      // The open thread's own heat, as on its sidebar row (warm, hot or blazing).
      const heat = node.querySelector(".t3x-burn-hdr");
      const hv = settings.burnTells && burnData && isLocalThread() ? burnView(burnData.threads[route.threadId]) : null;
      heat.hidden = !hv?.chip;
      if (hv?.chip) {
        heat.textContent = hv.chip;
        heat.setAttribute("data-t3x-burn", hv.tier);
        heat.title = hv.tooltip;
        heat.setAttribute("aria-label", hv.tooltip);
      }
      const usage = node.querySelector(".t3x-hdr-usage");
      usage.hidden = !settings.usageHeader;
      const labs = visibleLabs(vs);
      if (sig(usage, labs.map(viewKey).join(";"))) {
        usage.replaceChildren(...(labs.length
          ? labs.map((v) => h("span", { class: "t3x-glyph", title: bTooltip(v, now) }, bSvg(v, 34, 14, "sm")))
          : [h("span", { class: "t3x-dim", text: "Usage —" })]));
      }
      usage.setAttribute("aria-label", labs.length ? `Usage on this Mac: ${labs.map((v) => `${v.name} ${compactLabel(v, now)}${v.stale ? " (stale)" : ""}`).join("; ")}. Click for details.` : "Usage on this Mac: no readings yet. Click for details.");
      usage.title = labs.length ? "" : "Usage on this Mac: no readings yet. Click for details.";
    },
  };

  // Composer: the handover button, and the single most constrained lab (hidden first when narrow).
  features.composer = {
    on: () => settings.usageComposer || settings.handoverButton,
    node: null,
    find: () => single('[data-chat-composer-actions="right"]'),
    build() {
      const label = h("span", { class: "t3x-ho-label", text: "Prepare handover" });
      const btn = h("button", { type: "button", class: "t3x-chip t3x-handover", [OWN]: "handover", onclick: (e) => prepareHandover(e.currentTarget) },
        h("span", { class: "t3x-ho-icon", "aria-hidden": "true", text: "⇢" }), label);
      const meters = h("button", { type: "button", class: "t3x-chip t3x-meters", [OWN]: "meters", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: (e) => openUsage(e.currentTarget) });
      return h("div", { [OWN]: "composer", class: "t3x-composer" }, btn, meters);
    },
    mount: (anchor, node) => anchor.prepend(node),
    update(node, vs, now) {
      const btn = node.querySelector(".t3x-handover");
      btn.hidden = !settings.handoverButton;
      const why = handoverBlocker();
      btn.setAttribute("aria-disabled", String(Boolean(why)));
      btn.title = why ?? "Adds a handover request to the end of your message; you send it.";
      btn.setAttribute("aria-label", why ? `Prepare handover (unavailable: ${why})` : "Prepare handover: adds a request to the end of your message; you send it");
      const meters = node.querySelector(".t3x-meters");
      const c = composerSummary(vs, now);
      meters.hidden = !settings.usageComposer || !c;
      if (!c) return;
      const v = c.view;
      if (sig(meters, `${viewKey(v)}|${c.main}|${lowRefills(v).map((r) => `${r.which}${r.at}`).join()}`)) {
        meters.replaceChildren(bSvg(v, 40, 14, "sm"), h("span", { class: `t3x-meter-text${v.stale ? " t3x-dim" : ""}` }, c.main,
          c.refill ? [" · ", h("span", { class: "t3x-rw", text: "refills " }), c.refill] : null));
      }
      meters.title = `${v.hasData ? "Most constrained measured lab right now. " : ""}${bTooltip(v, now)} ${c.unknown.filter((u) => u !== v).map((u) => bTooltip(u, now)).join(" ")} Click for details.`;
      meters.setAttribute("aria-label", meters.title);
    },
  };

  // Sidebar footer: one row per lab with data, "Claude 63% left · 5h 70%" over its B glyph.
  // In a short window (switch on), one line per lab instead: name, a small glyph, "63% · 5h 70%".
  const SHORT_WINDOW = 800;
  const barsCompact = () => settings.usageSidebarShort && (W.innerHeight || 1000) < SHORT_WINDOW;
  features.bars = {
    on: () => settings.usageSidebar,
    node: null,
    find: () => single('[data-slot="sidebar-footer"]'),
    build() {
      const node = h("button", { type: "button", [OWN]: "bars", class: "t3x-bars", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: (e) => openUsage(e.currentTarget) });
      if (W.ResizeObserver) {
        const ro = new ResizeObserver(guarded("resize", () => {
          if (!disposed && node.isConnected) render();
        }));
        ro.observe(node);
        cleanups.push(() => ro.disconnect());
      }
      const onResize = guarded("resize", () => {
        if (!disposed && node.isConnected && barsCompact() !== node.classList.contains("t3x-bars-c")) render();
      });
      W.addEventListener("resize", onResize);
      cleanups.push(() => W.removeEventListener("resize", onResize));
      return node;
    },
    mount: (anchor, node) => anchor.prepend(node),
    update(node, vs, now) {
      const labs = visibleLabs(vs);
      const width = Math.max(80, Math.round((node.clientWidth || 226) - 16));
      const compact = barsCompact();
      node.classList.toggle("t3x-bars-c", compact);
      if (sig(node, `${compact ? "c" : ""}${width}#${labs.map((v) => `${viewKey(v)}|${compactLabel(v, now)}`).join(";")}`)) {
        node.replaceChildren(...(labs.length
          ? compact ? labs.map((v) => h("span", { class: `t3x-bar${v.stale ? " t3x-dim" : ""}`, title: bTooltip(v, now) },
            h("span", { class: "t3x-bar-label" }, h("span", { class: "t3x-lab-name", text: v.name })),
            h("span", { class: "t3x-bar-glyph" }, bSvg(v, Math.max(28, width - 136), 12, "sm")),
            h("span", { class: "t3x-bar-val", text: shortBarText(v, now) })))
          : labs.map((v) => h("span", { class: `t3x-bar${v.stale ? " t3x-dim" : ""}`, title: bTooltip(v, now) },
            h("span", { class: "t3x-bar-label" }, h("span", { class: "t3x-lab-name", text: v.name })),
            h("span", { class: "t3x-bar-val" }, compactParts(v, now).map((p) => (p.rw ? h("span", { class: "t3x-rw", text: p.t }) : p.t))),
            h("span", { class: "t3x-bar-glyph" }, bSvg(v, width, 17, "md"))))
          : [h("span", { class: "t3x-bar t3x-dim" }, h("span", { class: "t3x-bar-label", text: "Usage" }), h("span", { class: "t3x-bar-val", text: "—" }))]));
      }
      node.setAttribute("aria-label", labs.length ? `This Mac: ${labs.map((v) => `${v.name} ${compactLabel(v, now)}${v.stale ? " (stale)" : ""}`).join("; ")}. Click for details.` : "Usage: no readings yet. Click for details.");
    },
  };

  // ✦ panel button in the sidebar footer row (always on: it is the off switch for everything else).
  features.panel = {
    on: () => true,
    node: null,
    find: () => single('[data-slot="sidebar-footer"] > ul[data-slot="sidebar-menu"]'),
    build() {
      const btn = h("button", { type: "button", class: "t3x-star", "aria-label": "Add-ons (switch each one on or off)", title: "Add-ons", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: (e) => openPanel(e.currentTarget) }, "✦");
      return h("li", { [OWN]: "panel-li", class: "t3x-star-li" }, btn);
    },
    mount(anchor, node) {
      // After T3's own icon buttons, before its right-aligned item (if any).
      const right = [...anchor.children].find((li) => !li.hasAttribute(OWN) && li.classList.contains("ml-auto"));
      anchor.insertBefore(node, right ?? null);
    },
    update() {},
  };

  // ---------- burn-rate tells: /burn every 30 s while visible, rows decorated with our own nodes ----------

  let burnData = null; // last /burn answer
  let burnInflight = null;
  function fetchBurn() {
    if (disposed || !settings.burnTells || burnInflight) return burnInflight;
    const ctrl = new AbortController();
    requests.add(ctrl);
    const kill = setTimeout(() => ctrl.abort(), 10e3);
    burnInflight = fetch(`${BASE}burn`, { cache: "no-store", signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(guarded("burn", (j) => {
        if (disposed) return;
        burnData = j && typeof j === "object" && j.threads && typeof j.threads === "object" ? { at: Date.now(), threads: j.threads, ok: j.ok !== false } : null;
        render();
      }), () => {
        if (!disposed) burnData = null; // unreachable: show nothing rather than old heat
      })
      .finally(() => {
        clearTimeout(kill);
        requests.delete(ctrl);
        burnInflight = null;
      });
    return burnInflight;
  }

  const burnNodes = new Map(); // T3's <li> -> our node inside it
  function burnNode(li, kind) {
    const node = h("span", { [OWN]: "burn", class: "t3x-burn" },
      h("span", { class: "t3x-burn-tint", "aria-hidden": "true" }),
      h("span", { class: "t3x-burn-strip", "aria-hidden": "true" }),
      h("span", { class: "t3x-burn-ember", role: "img" }),
      h("span", { class: "t3x-burn-chip", role: "img" }));
    // The ember and chip take hover (for their tooltips); a click goes on to the row as usual.
    const forward = (e) => {
      e.preventDefault();
      e.stopPropagation();
      li.querySelector('[data-testid^="sidebar-row-"], [data-testid^="thread-row-"]')?.click();
    };
    for (const el of node.querySelectorAll(".t3x-burn-ember, .t3x-burn-chip")) el.addEventListener("click", guarded("burn-click", forward));
    node.dataset.kind = kind;
    return node;
  }
  /** Places the ember just left of the row's time/status slot and the chip left of the model icon
   *  (card) or of the time (slim), measured each time; T3's nodes are only read, never moved. */
  function layoutBurn(li, node, kind) {
    const L = li.getBoundingClientRect();
    if (!L.width) return;
    const slot = kind === "card" ? li.querySelector('[class*="group/sidebar-status-slot"]') : kind === "slim" ? li.querySelector('[data-testid="sidebar-row-slim"] > span.relative[class*="ml-auto"]') : null;
    const icon = kind === "card" ? li.querySelector('[data-testid="sidebar-row-card"] div.relative > div:nth-child(3) > span.ml-auto') : null;
    const S = slot?.getBoundingClientRect();
    const I = icon?.getBoundingClientRect();
    const px = (v) => `${Math.round(v)}px`;
    node.style.setProperty("--ex", px(S && S.width ? S.left - L.left - 10 : L.width - 18));
    node.style.setProperty("--ey", px(S && S.height ? S.top - L.top + S.height / 2 - 3 : 10));
    const besideTime = () => {
      node.style.setProperty("--cr", px(S && S.width ? L.right - S.left + 4 : 10));
      node.style.setProperty("--cy", px(S && S.height ? S.top - L.top + S.height / 2 : L.height / 2));
    };
    node.classList.toggle("t3x-burn-narrow", L.width <= 160);
    if (kind === "card" && I && I.width) {
      node.style.setProperty("--cr", px(L.right - I.left + 6));
      node.style.setProperty("--cy", px(I.top - L.top + I.height / 2));
      // The icon may have moved beside the title (or the line be short): then beside the time.
      const chip = node.querySelector(".t3x-burn-chip");
      const C = chip && !chip.hidden ? chip.getBoundingClientRect() : null;
      if (C && C.width && (C.left < L.left + 6 || C.right > L.right)) besideTime();
    } else besideTime();
  }
  const burnCounts = { rows: 0 };
  function decorateBurn() {
    const keep = new Set();
    if (settings.burnTells && burnData && lastState?.localEnvironmentId) {
      const lis = [...D.querySelectorAll("li[data-thread-item]")].slice(0, 600);
      for (const { li, threadId, kind } of burnTargets(lis, burnData.threads, lastState.localEnvironmentId, route)) {
        const v = burnView(burnData.threads[threadId]);
        if (!v) continue;
        let node = burnNodes.get(li);
        if (!node || node.dataset.kind !== kind) {
          node?.remove();
          node = burnNode(li, kind);
          burnNodes.set(li, node);
        }
        if (node.parentElement !== li) li.append(node);
        node.setAttribute("data-t3x-burn", v.tier);
        node.classList.toggle("t3x-burn-recent", v.recent);
        const ember = node.querySelector(".t3x-burn-ember");
        ember.hidden = !v.ember;
        ember.title = v.tooltip;
        ember.setAttribute("aria-label", v.tooltip);
        const chip = node.querySelector(".t3x-burn-chip");
        chip.hidden = !v.chip || kind === "compact";
        chip.textContent = v.chip ?? "";
        chip.dataset.short = v.chipShort ?? "";
        chip.title = v.tooltip;
        chip.setAttribute("aria-label", v.tooltip);
        layoutBurn(li, node, kind);
        keep.add(li);
      }
    }
    for (const [li, node] of burnNodes) {
      if (!keep.has(li)) {
        node.remove();
        burnNodes.delete(li);
      }
    }
    burnCounts.rows = keep.size;
  }

  const ORDER = ["panel", "bars", "header", "composer"];
  const insertCounts = {};
  function ensure() {
    if (paused || disposed) return;
    try {
      footerPass(D, settings.footerTeam, footerSeen);
    } catch (e) {
      noteError("footer", e);
    }
    const now = Date.now();
    const vs = currentViews(now);
    for (const name of ORDER) {
      const f = features[name];
      try {
        if (!f.on()) {
          f.node?.remove();
          status[name] = "off";
          continue;
        }
        const { el, why } = f.find();
        status[name] = why;
        if (!el) {
          if (f.node?.isConnected && !f.node.closest("[inert]")) f.node.remove();
          continue;
        }
        f.node ??= f.build();
        if (f.node.parentElement !== el) {
          // Re-inserting is cheap, but if T3 keeps removing it, stop rather than fight.
          const n = (insertCounts[name] = (insertCounts[name] ?? 0) + 1);
          if (n > 120) {
            status[name] = "unstable";
            continue;
          }
          f.mount(el, f.node);
        }
        f.update(f.node, vs, now);
      } catch (e) {
        status[name] = "error";
        noteError(name, e);
      }
    }
    try {
      decorateBurn();
    } catch (e) {
      noteError("burn", e);
    }
  }
  every(60e3, () => {
    for (const k of Object.keys(insertCounts)) insertCounts[k] = Math.max(0, insertCounts[k] - 60);
  });

  function render() {
    if (paused || disposed) return;
    ensure();
    if (pop?.kind === "usage" || pop?.kind === "chain") fillPopover();
  }

  // ---------- handover ----------

  function composerEditor() {
    const { el } = single('[data-testid="composer-editor"]');
    const ed = el?.editor;
    return ed && !ed.isDestroyed && ed.isEditable && ed.commands && typeof ed.chain === "function" ? ed : null;
  }

  /** Adds the request after whatever is already in the composer, as one undoable step. Never sends. */
  function insertRequest(ed, text) {
    const before = ed.getText();
    const end = ed.state.doc.content.size;
    let ok;
    if (!before.trim()) ok = ed.chain().focus("end").insertContent(text).run();
    else if (ed.schema?.nodes?.paragraph) ok = ed.chain().insertContentAt(end, { type: "paragraph", content: [{ type: "text", text }] }).focus("end").run();
    else ok = ed.chain().focus("end").insertContent(` ${text}`).run();
    const after = ed.getText();
    if (ok && after.includes(text) && after.startsWith(before.trimEnd())) return true;
    if (ok && after !== before) ed.commands.undo?.(); // something odd happened: put the draft back
    return false;
  }

  function toast(anchor, text) {
    const t = h("div", { [OWN]: "toast", class: "t3x-toast", role: "status", text });
    D.body.append(t);
    const r = anchor.getBoundingClientRect();
    t.style.left = `${Math.max(8, Math.min(r.left, innerWidth - t.offsetWidth - 8))}px`;
    t.style.bottom = `${innerHeight - r.top + 8}px`;
    later(2600, () => t.remove());
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function prepareHandover(btn) {
    checkRoute(); // re-check the route and locality at the moment of the click
    const why = handoverBlocker();
    if (why) {
      btn.setAttribute("aria-disabled", "true");
      btn.title = why;
      toast(btn, why);
      return;
    }
    const ed = composerEditor();
    if (ed && insertRequest(ed, HANDOVER_REQUEST)) {
      toast(btn, "Added to your message. Read it, then press Enter to send.");
      return;
    }
    const build = () => [
      h("header", { class: "t3x-pop-head" }, h("strong", { text: "Couldn't add it to the composer" })),
      h("p", { text: "Your message was left exactly as it was. Copy the request and paste it yourself:" }),
      h("blockquote", { class: "t3x-quote", text: HANDOVER_REQUEST }),
      h("button", { type: "button", class: "t3x-btn", onclick: async (e) => { e.currentTarget.textContent = (await copyText(HANDOVER_REQUEST)) ? "Copied" : "Copy failed"; } }, "Copy handover request"),
    ];
    build.label = "Handover request";
    openPopover(btn, "handover", build);
  }

  function openChain(btn) {
    const build = () => {
      const c = lastState?.handover?.chain;
      if (!c) return [h("div", { class: "t3x-muted", text: "No handover chain for this thread." })];
      const when = (at) => (at ? new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
      return [
        h("header", { class: "t3x-pop-head" }, h("strong", { text: chainLabel(c) }), h("span", { class: "t3x-muted", text: `chain ${c.short}` })),
        c.title ? h("div", { class: "t3x-line", text: c.title }) : null,
        h("div", { class: "t3x-muted", text: `This thread is ${c.position} of ${c.length}${c.current ? " (the current one)" : ""}. Handover mode: ${lastState?.handover?.mode ?? "unknown"}.` }),
        c.history.length
          ? h("ol", { class: "t3x-history" }, c.history.map((x) => h("li", {}, h("span", { class: "t3x-muted", text: when(x.at) }), ` ${x.from} → ${x.to}`)))
          : h("div", { class: "t3x-muted", text: "No handovers yet: this thread has a living handoff file." }),
        c.file ? h("code", { class: "t3x-path", text: c.file }) : null,
        c.file ? h("button", { type: "button", class: "t3x-btn", onclick: async (e) => { e.currentTarget.textContent = (await copyText(c.file)) ? "Copied" : "Copy failed"; } }, "Copy file path") : null,
      ];
    };
    build.label = "Handover chain";
    openPopover(btn, "chain", build, { width: 320 });
  }

  // ---------- fonts: three roles, each its own face alias ----------
  // "T3X Heading", "T3X Body" and "T3X Main" are FontFaces made from the chosen family, with the role's size as
  // size-adjust (no font-size or font-size-adjust in the CSS, so nothing is scaled twice) and a
  // unicode-range without the digits 0-9, so numbers stay in T3's own font. Only the chosen
  // families and demanded picker names are fetched from the allowlist; macOS uses local().

  const DIGITLESS = "U+0-2F, U+3A-10FFFF";
  const ROLE = {
    head: { key: "fontHead", alias: "T3X Heading", attr: "data-t3x-fh" },
    body: { key: "fontBody", alias: "T3X Body", attr: "data-t3x-fb" },
    main: { key: "fontMain", alias: "T3X Main", attr: "data-t3x-fm" },
    prompts: { key: "fontPrompts", alias: "T3X Prompts", attr: "data-t3x-fprompts" },
    composer: { key: "fontComposer", alias: "T3X Composer", attr: "data-t3x-fc" },
    quotes: { key: "fontQuotes", alias: "T3X Quotes", attr: "data-t3x-fq" },
    interface: { key: "fontInterface", alias: "T3X Interface", attr: "data-t3x-fi" },
    plans: { key: "fontPlans", alias: "T3X Plans", attr: "data-t3x-fp" },
    questions: { key: "fontQuestions", alias: "T3X Questions", attr: "data-t3x-fquestions" },
    reasoning: { key: "fontReasoning", alias: "T3X Reasoning", attr: "data-t3x-fr" },
    viz: { key: "fontViz", alias: "T3X Viz", attr: "data-t3x-fv" },
    footer: { key: "fontFooter", alias: "T3X Footer", attr: "data-t3x-ffooter" },
    tables: { key: "fontTables", alias: "T3X Tables", attr: "data-t3x-ftables" },
    links: { key: "fontLinks", alias: "T3X Links", attr: "data-t3x-flinks" },
    paths: { key: "fontPaths", alias: "T3X Paths", attr: "data-t3x-fpaths" },
    threadtitles: { key: "fontThreadtitles", alias: "T3X Thread titles", attr: "data-t3x-fthreadtitles" },
    tooltips: { key: "fontTooltips", alias: "T3X Tooltips", attr: "data-t3x-ftooltips" },
    usage: { key: "fontUsage", alias: "T3X Usage", attr: "data-t3x-fusage" },
    sidebar: { key: "fontSidebar", alias: "T3X Sidebar", attr: "data-t3x-fsidebar" },
  };
  let catalog = null;
  let catalogP = null;
  function loadCatalog() {
    if (catalog) return Promise.resolve(catalog);
    catalogP ??= fetch(`${BASE}font-catalog`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c) => {
        catalog = [...T3_FONTS, ...(Array.isArray(c?.families) ? c.families : []).filter((f) => f && typeof f.name === "string" && f.source !== "t3" && !t3Font(f.name)).slice(0, 200)];
        if (pop?.kind === "panel") fillPopover();
        syncFontWorkspace();
        return catalog;
      })
      .catch(() => {
        catalogP = null;
        return null;
      });
    return catalogP;
  }
  const nativeCache = new Map();
  function nativeAvailable(name) {
    if (nativeCache.has(name)) return nativeCache.get(name);
    const c = D.createElement("canvas").getContext("2d");
    const sample = "Handwriting mmmWWW iii";
    const ok = ["monospace", "serif"].some((base) => {
      c.font = `32px ${base}`;
      const a = c.measureText(sample).width;
      c.font = `32px "${name}", ${base}`;
      return Math.abs(c.measureText(sample).width - a) > 0.5;
    });
    nativeCache.set(name, ok);
    return ok;
  }
  const fontBuffers = new Map(); // shared file bytes; role loads never wait on the preview queue
  async function fontSource(f) {
    if (f.source === "google" && f.file) {
      if (!fontBuffers.has(f.file)) {
        fontBuffers.set(f.file, fetch(`${BASE}fonts/${encodeURIComponent(f.file)}`, { cache: "force-cache" })
          .then((x) => x.ok ? x.arrayBuffer() : Promise.reject(new Error(String(x.status))))
          .catch((e) => { fontBuffers.delete(f.file); throw e; }));
      }
      return (await fontBuffers.get(f.file)).slice(0); // FontFace may detach its input
    }
    if (Array.isArray(f.local) && nativeAvailable(f.name)) return f.local.map((n) => `local("${String(n).replace(/["\\]/g, "")}")`).join(", ");
    return null;
  }
  const nameFaces = new Map(); // one stable alias per catalog family, shared by every picker
  const nameAlias = (name) => `T3X Pick ${name}`;
  const nameStyle = (name) => `font-family:${t3Font(name)?.css ?? `"${nameAlias(name)}",var(--font-sans)`}`;
  let nameGeneration = 0, nameActive = 0;
  const nameQueue = [];
  function closeFontPreviews() {
    nameGeneration++;
    nameQueue.length = 0;
    for (const entry of nameFaces.values()) if (entry.face) D.fonts.delete(entry.face);
    nameFaces.clear();
  }
  function queueFontName(name, priority = false) {
    if (disposed || (pop?.kind !== "panel" && (typeof fontWorkspace === "undefined" || !fontWorkspace))) return;
    const f = catalog?.find((x) => x.name === name);
    if (!f || f.source === "t3" || (f.source === "mac" && !nativeAvailable(name))) return;
    let entry = nameFaces.get(name);
    if (!entry) {
      entry = { f, generation: nameGeneration, state: "queued", face: null };
      nameFaces.set(name, entry);
      nameQueue.push(entry);
    }
    if (priority && entry.state === "queued") {
      nameQueue.splice(nameQueue.indexOf(entry), 1);
      nameQueue.unshift(entry);
    }
    pumpFontNames();
  }
  function pumpFontNames() {
    while (!disposed && nameActive < 4 && nameQueue.length) {
      const entry = nameQueue.shift();
      if (entry.generation !== nameGeneration) continue;
      entry.state = "loading";
      nameActive++;
      (async () => {
        const src = await fontSource(entry.f);
        if (!src || disposed || entry.generation !== nameGeneration) return;
        const face = new FontFace(nameAlias(entry.f.name), src, { weight: "1 1000" });
        await face.load();
        if (disposed || entry.generation !== nameGeneration) return;
        D.fonts.add(face);
        entry.face = face;
        entry.state = "loaded";
      })().catch(() => { entry.state = "failed"; }).finally(() => {
        nameActive--;
        pumpFontNames();
      });
    }
  }
  function activePick(role) {
    const stored = settings[ROLE[role].key];
    if (role === "body" || typeof effectiveFontPick !== "function") return stored;
    return effectiveFontPick(settings, role);
  }
  function warmSelectedNames() {
    for (const role of Object.keys(ROLE)) {
      if (role === "body") continue;
      const pick = activePick(role);
      if (pick && pick.family && pick.family !== "off") queueFontName(pick.family, true);
    }
  }
  function warmMenuNames(select) {
    queueFontName(select.value, true);
    for (const option of select.options) queueFontName(option.value);
  }

  const roleFaces = Object.fromEntries(Object.keys(ROLE).map(k => [k, null])); // { key, face }
  const roleTokens = Object.fromEntries(Object.keys(ROLE).map(k => [k, 0]));
  /** An area set to one of T3's own fonts loads no face: its CSS falls back to this variable instead
   *  (written into the owned #t3x-dyn style as --t3x-base-<attr>). */
  const roleBases = {};
  function setRoleBase(role, css) {
    const key = ROLE[role].attr.slice("data-t3x-".length);
    if ((roleBases[key] ?? null) === (css ?? null)) return;
    if (css) roleBases[key] = css;
    else delete roleBases[key];
    if (typeof writeDyn === "function") writeDyn();
  }
  const sizeOf = (f, pick) => pick.size ?? (sizePct(f?.size) ?? 100);

  /** Errors are handled here, with the same token and disposal checks as success, so a late
   *  failure can never switch off a newer choice or a newer copy of the add-ons. */
  async function applyRole(role) {
    const token = ++roleTokens[role];
    if (role === "viz") beginVisualization(activePick("viz"));
    try {
      await applyRoleNow(role, token);
    } catch {
      if (!disposed && token === roleTokens[role]) { if (roleFaces[role]) D.fonts.delete(roleFaces[role].face); roleFaces[role] = null; D.documentElement.removeAttribute(ROLE[role].attr); if (role === "viz") publishVisualization(null); }
    } finally {
      if (!disposed && typeof syncFontWorkspace === "function") syncFontWorkspace();
      // the ✦ panel's font names switch to their face once it loads
      if (!disposed && typeof pop === "object" && pop?.kind === "panel" && typeof fillPopover === "function") fillPopover();
    }
  }
  async function applyRoleNow(role, token) {
    const r = ROLE[role];
    const pick = activePick(role);
    const drop = () => {
      if (roleFaces[role]) D.fonts.delete(roleFaces[role].face);
      roleFaces[role] = null;
      setRoleBase(role, null);
      D.documentElement.removeAttribute(r.attr);
      if (role === "viz") publishVisualization(null);
    };
    if (pick.family === "off") return drop();
    const cat = await loadCatalog();
    if (disposed || token !== roleTokens[role]) return;
    const f = cat?.find((x) => x.name === pick.family);
    if (!f || (f.source === "t3" && role === "viz")) return drop();
    if (f.source === "t3") {
      if (roleFaces[role]) D.fonts.delete(roleFaces[role].face);
      roleFaces[role] = null;
      setRoleBase(role, f.css);
      D.documentElement.setAttribute(r.attr, "");
      return;
    }
    setRoleBase(role, null);
    const size = sizeOf(f, pick);
    const key = `${f.name}|${size}`;
    if (roleFaces[role]?.key === key) {
      D.documentElement.setAttribute(r.attr, "");
      if (role === "viz" && !vizWire?.face) await prepareVisualization(f, size, token);
      return;
    }
    const src = await fontSource(f);
    if (disposed || token !== roleTokens[role]) return;
    if (!src) return drop();
    const face = new FontFace(r.alias, src, { unicodeRange: DIGITLESS, sizeAdjust: `${size}%`, weight: "1 1000" });
    await face.load();
    if (disposed || token !== roleTokens[role]) return;
    if (roleFaces[role]) D.fonts.delete(roleFaces[role].face);
    D.fonts.add(face);
    roleFaces[role] = { key, face };
    D.documentElement.setAttribute(r.attr, "");
    if (role === "viz") await prepareVisualization(f, size, token);
  }
  function applyFonts() {
    // applyRole handles its own failures (token- and disposal-checked); nothing late acts here.
    for (const role of Object.keys(ROLE)) if (role !== "body") applyRole(role).catch(() => {});
  }

  // Host-owned pushes only. Opaque child frames cannot request fonts or choose URLs.
  let vizWire = null, vizSelection = "", vizListening = false, vizEmbedNode = null;
  function nextVizEpoch() {
    const previous = Number.isSafeInteger(W.__t3xVizEpoch) ? W.__t3xVizEpoch : Date.now() * 1000;
    W.__t3xVizEpoch = previous + 1;
    return W.__t3xVizEpoch;
  }
  const isVizFrame = (frame) => frame?.matches?.('iframe[data-t3x-native-html="1"][sandbox="allow-scripts allow-forms"]') && !frame.closest('[data-mcp-app-fullscreen]');
  function pushVisualization(frame) {
    if (!isVizFrame(frame)) return;
    const face = vizWire?.face;
    const copy = face ? { size: face.size, source: face.source.type === "bytes" ? { type: "bytes", buf: face.source.buf.slice(0) } : { type: "local", names: [...face.source.names] } } : null;
    frame.contentWindow?.postMessage({ jsonrpc: "2.0", method: "t3x/notifications/font-faces", params: { v: 1, epoch: vizWire?.epoch ?? nextVizEpoch(), face: copy } }, "*", copy?.source.type === "bytes" ? [copy.source.buf] : []);
  }
  function onVizFrameLoad(event) {
    if (!disposed && isVizFrame(event.target)) try { pushVisualization(event.target); } catch {}
  }
  function publishVisualization(payload) {
    if (!payload && vizWire?.face === null) return;
    const epoch = nextVizEpoch();
    vizWire = { epoch, face: payload?.face ?? null };
    const root = D.documentElement;
    root.setAttribute("data-t3x-viz-epoch", String(epoch));
    if (!payload) root.removeAttribute("data-t3x-fv");
    vizEmbedNode?.remove();
    vizEmbedNode = null;
    if (payload?.base64) {
      // Only our clone serializer reads this inert metadata; native SVG stays untouched.
      if (!D.getElementById("t3x-pele-embed")) {
        vizEmbedNode = D.createElement("script");
        vizEmbedNode.type = "application/json";
        vizEmbedNode.id = "t3x-pele-embed";
        vizEmbedNode.setAttribute("data-t3x", "viz-embed");
        vizEmbedNode.textContent = JSON.stringify({v: 1, epoch, size: payload.face.size, base64: payload.base64});
        D.head.append(vizEmbedNode);
      }
    }
    for (const frame of D.querySelectorAll('iframe[data-t3x-native-html="1"]')) try { pushVisualization(frame); } catch {}
    D.dispatchEvent(new CustomEvent("t3x-pele-font", {detail: {epoch}}));
  }
  function beginVisualization(pick) {
    if (!vizListening) { D.addEventListener("load", onVizFrameLoad, true); vizListening = true; }
    const signature = JSON.stringify(pick);
    if (signature !== vizSelection) { vizSelection = signature; publishVisualization(null); }
  }
  async function prepareVisualization(f, size, token) {
    const source = await fontSource(f);
    if (disposed || token !== roleTokens.viz) return;
    let face, base64;
    if (source instanceof ArrayBuffer) {
      const bytes = new Uint8Array(source);
      if (bytes.length < 4 || bytes.length > 2_000_000 || String.fromCharCode(...bytes.subarray(0,4)) !== "wOF2") throw Error("Not a supported visualization font");
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i+32768));
      base64 = btoa(binary);
      face = {size, source:{type:"bytes",buf:source}};
    } else if (Array.isArray(f.local) && nativeAvailable(f.name)) {
      face = {size, source:{type:"local",names:[...f.local]}};
    } else throw Error("Visualization font unavailable");
    if (disposed || token !== roleTokens.viz) return;
    publishVisualization({face,base64});
  }
  function teardownVisualization() {
    if (vizListening) D.removeEventListener("load", onVizFrameLoad, true);
    vizListening = false;
    if (vizWire) publishVisualization(null);
    vizWire = null;
    vizEmbedNode?.remove();
    vizEmbedNode = null;
    D.documentElement.removeAttribute("data-t3x-viz-epoch");
  }

  // ---------- add-ons panel ----------

  function sw(label, key, note) {
    const on = settings[key];
    return h("div", { class: "t3x-set" },
      h("button", { type: "button", role: "switch", "aria-checked": String(on), class: "t3x-switch", "data-focus": `sw-${key}`, onclick: () => change({ [key]: !settings[key] }) },
        h("span", { class: "t3x-knob", "aria-hidden": "true" }), h("span", { class: "t3x-set-label", text: label })),
      note ? h("div", { class: "t3x-note", text: note }) : null);
  }
  function radio(group, value, current, label, onPick, extra) {
    return h("button", { type: "button", role: "radio", "aria-checked": String(value === current), class: "t3x-radio", "data-focus": `r-${group}-${value}`, onclick: () => onPick(value) },
      h("span", { class: "t3x-dot", "aria-hidden": "true" }), h("span", { class: "t3x-set-label", text: label }), extra ?? null);
  }
  function chip(label, key) {
    return h("button", { type: "button", class: "t3x-chipbtn", "aria-pressed": String(settings[key]), "data-focus": `chip-${key}`, onclick: () => change({ [key]: !settings[key] }) }, label);
  }
  const where = (name, ok) => {
    const st = status[name];
    if (st === "missing") return "Not on this screen right now (or not found in this build).";
    if (st === "ambiguous") return "Skipped: more than one place matched on this screen.";
    if (st === "unstable" || st === "error") return "Paused: T3 kept replacing its spot.";
    return ok ?? null;
  };
  // One viewport-bounded settings surface; navigation is deliberately not persisted as settings.
  const FONT_AREAS = [
    {id:"prompts",group:"Your text",label:"Your sent prompts",scope:"Messages you have already sent. The message composer has its own font.",sample:"Can you explain this with a small example? 123"},
    {id:"composer",group:"Your text",label:"Message composer",scope:"The message you type before sending. Sent prompts are a separate area.",sample:"Write your next message here 123",targets:[["composer","Composer text"]]},
    {id:"main",group:"Assistant replies",label:"Replies",scope:"Ordinary assistant reply prose. Headings, quotes, tables, links, file paths, reasoning, plans, questions and the footer have their own choices.",sample:"Here is the explanation, with a small example. 123",targets:[["replies","Reply prose"]]},
    {id:"head",group:"Assistant replies",label:"Reply headings & project labels",scope:"Reply headings h1–h6, project headings and add-on labels, selected below. Headings inside quotes, reasoning, plans and questions follow those areas.",sample:"A clearer plan for the next step 123",targets:[["headings","Headings in replies"],["projects","Project headings"],["pills","Add-on labels"]]},
    {id:"quotes",group:"Assistant replies",label:"Quotes in replies",scope:"Quoted passages and their headings inside replies.",sample:"“Keep the explanation close to the example.” 123",targets:[["quotes","Quotes in replies"]]},
    {id:"tables",group:"Assistant replies",label:"Tables in replies",scope:"Text in ordinary assistant tables. The reply footer and its team list use Reply footer instead.",sample:"Step     Owner     Time\nReview   Sol       10 min"},
    {id:"links",group:"Assistant replies",label:"Links in replies",scope:"Ordinary text links in assistant replies. Recognized file links use File paths. Buttons and other controls keep T3’s font.",sample:"Read the supporting source 123"},
    {id:"paths",group:"Assistant replies",label:"File paths",scope:"Recognized file links, workspace breadcrumbs and context-chip text. This takes precedence over Links; code blocks keep T3’s technical font.",sample:"src/components/FontSettings.tsx 123"},
    {id:"reasoning",group:"Assistant replies",label:"Expanded reasoning",scope:"Expanded reasoning prose and its headings. Collapsed work rows and tool output stay native.",sample:"First, consider what changes when the input grows. 123"},
    {id:"plans",group:"Assistant replies",label:"Proposed plans",scope:"Proposed plan prose and its headings. Plan controls stay native.",sample:"Review the example, then check the result. 123"},
    {id:"questions",group:"Assistant replies",label:"Questions & saved answers",scope:"Question explanations and saved-answer prose. Option buttons, shortcuts and input controls stay native.",sample:"Which result would be most useful to you? 123"},
    {id:"viz",group:"Assistant replies",label:"Visualizations & diagrams",scope:"Compatible native HTML visualizations and diagrams when the native bridge is active. Authored styles, images, canvas, math and foreign app cards may keep their own fonts. Expanded diagrams use bundled faces; Mac faces use a fresh layout in T3’s font.",sample:"Input → Process → Result 123"},
    {id:"footer",group:"Assistant replies",label:"Reply footer",scope:"The recognized verdict and plan table, immediate team list and small usage line at the end of an assistant reply. Ordinary tables are separate.",sample:"Done   Review the example\nSol · 10 min · planned 10"},
    {id:"threadtitles",group:"App & interface",label:"Thread titles",scope:"Native thread-title text and grouping thread titles. Project headings and sidebar metadata are separate.",sample:"Visualization font sections 123"},
    {id:"sidebar",group:"App & interface",label:"Sidebar & status labels",scope:"Informational sidebar metadata, branch, machine, age, state, status and grouping notes. Excludes thread titles, project headings, icons and Group, Sort or Native controls.",sample:"Working · local branch · updated just now 123"},
    {id:"interface",group:"App & interface",label:"Settings text",scope:"Only the verified noninteractive text areas selected below. Some settings notes, theme headings, account prose and the diagnostics table are not covered. Menu items, buttons and other control labels keep T3’s font.",sample:"Choose how this workspace appears. 123",targets:INTERFACE_TARGETS.filter(([key])=>key!=="plantext")},
    {id:"tooltips",group:"App & interface",label:"Tooltips",scope:"Text inside native tooltip popups. Trigger controls and icons stay native.",sample:"Show the details for this thread 123"},
    {id:"usage",group:"App & interface",label:"Usage-page text",scope:"Verified headings, explanatory text and table text on T3’s Usage page only. Buttons, numbers and technical text keep T3’s fonts.",sample:"Usage totals and breakdown 123"},
  ];
  const fontArea = id => FONT_AREAS.find(a=>a.id===id);
  const NATIVE_FONT_GUIDANCE = "Code, diffs, terminal text, ASCII digits 0–9 and control labels (buttons, menus and inputs) keep T3’s native fonts. Use T3’s font settings for technical text. Other settings prose and foreign image, canvas, math or app content are not all covered.";
  let fontWorkspace = null;
  const fontNav = {role:"main",query:"",editor:false,scroll:new Map(),indexScroll:0,returns:[]};
  function fontsCustomized() {
    return FONT_ROLES.filter(r=>activePick(r.id).family!=="off").length;
  }
  function fontResolvedText(id) {
    const pick=activePick(id), f=catalog?.find(f=>f.name===pick.family);
    if(pick.family==="off") return "T3 default";
    if(!f) return `${pick.family} · unavailable`;
    if(f.source==="t3") return id==="viz"?"T3 default":pick.family;
    if(f.source==="mac"&&!nativeAvailable(f.name)) return `${pick.family} · not installed`;
    return `${pick.family} · ${sizeOf(f,pick)}%`;
  }
  function fontSummary(id) {
    const src=settings.fontSources[id];
    return src?.startsWith("link:")?`Same as ${fontArea(src.slice(5))?.label || "another area"} · ${fontResolvedText(id)}`:fontResolvedText(id);
  }
  function rememberFontScroll() {
    if(fontWorkspace) {
      if(fontWorkspace.switchingArea)return;
      if(fontWorkspace.editor.getClientRects().length)fontNav.scroll.set(fontNav.role,fontWorkspace.editor.scrollTop);
      if(fontWorkspace.index.getClientRects().length)fontNav.indexScroll=fontWorkspace.index.scrollTop;
    }
  }
  function selectFontArea(id,{fromSource=false,returning=false}={}) {
    if(!fontArea(id)||!fontWorkspace)return;
    rememberFontScroll();
    if(fromSource)fontNav.returns.push(fontNav.role);
    else if(!returning)fontNav.returns.length=0;
    const position=fontNav.scroll.get(id)||0;
    fontWorkspace.switchingArea=true;
    fontNav.role=id;fontNav.editor=true;
    syncFontWorkspace(true);
    fontWorkspace.editor.scrollTop=position;
    fontWorkspace.switchingArea=false;
    fontWorkspace.title.focus({preventScroll:true});
  }
  function fontSelectOpen() {
    try {return !!fontWorkspace?.el.querySelector("select:open");}catch{return false;}
  }
  function closeFontWorkspace(restore=true) {
    const ui=fontWorkspace;if(!ui)return;
    rememberFontScroll();fontWorkspace=null;
    ui.el.close();ui.el.remove();closeFontPreviews();
    if(!restore||disposed)return;
    const trigger=ui.trigger?.isConnected?ui.trigger:D.querySelector('[data-t3x="panel-li"] .t3x-star');
    if(trigger?.isConnected){openPanel(trigger);pop?.el.querySelector('[data-focus="open-fonts"]')?.focus({preventScroll:true});}
  }
  function preserveFontWorkspaceOnResize() {
    const ui=fontWorkspace;if(!ui)return;
    const previous=ui.lastFocus;
    // A narrow window keeps the pane the user is working in, including active search.
    if(innerWidth<720&&previous?.isConnected&&ui.navigation.contains(previous)) {
      fontNav.editor=false;ui.el.dataset.view="index";
      ui.index.scrollTop=fontNav.indexScroll;
    }
    if(!ui.el.contains(D.activeElement)||!D.activeElement.getClientRects().length) {
      const target=previous?.isConnected&&previous.getClientRects().length?previous:fontNav.editor?ui.title:ui.search;
      target.focus({preventScroll:true});
    }
  }
  function openFontWorkspace(trigger) {
    if(fontWorkspace)return;
    const anchor=pop?.trigger||trigger;closePopover();
    const el=h("dialog",{[OWN]:"fonts",class:"t3x-font-workspace","aria-labelledby":"t3x-fonts-title"});
    const title=h("h2",{id:"t3x-fonts-title",text:"Fonts"});
    const search=h("input",{type:"search",class:"t3x-font-search",id:"t3x-font-search",placeholder:"Find an area or font",value:fontNav.query,oninput:e=>{fontNav.query=e.currentTarget.value;syncFontIndex();}});
    const index=h("div",{class:"t3x-font-index"});
    const rows=new Map();
    for(const group of ["Your text","Assistant replies","App & interface"]){
      const section=h("section",{class:"t3x-font-area-group"},h("h3",{text:group}));
      for(const area of FONT_AREAS.filter(a=>a.group===group)){
        const summary=h("span",{class:"t3x-font-area-summary"});
        const button=h("button",{type:"button",class:"t3x-font-area","data-area":area.id,onclick:()=>selectFontArea(area.id)},h("span",{class:"t3x-font-area-name",text:area.label}),summary);
        rows.set(area.id,{button,summary,section});section.append(button);
      }index.append(section);
    }
    const empty=h("div",{class:"t3x-font-empty",hidden:true},h("p",{text:"No matching areas."}),h("button",{type:"button",class:"t3x-btn",onclick:()=>{fontNav.query="";search.value="";syncFontIndex();search.focus();}},"Clear search"));index.append(empty);
    const guidance=h("p",{class:"t3x-font-guidance",text:NATIVE_FONT_GUIDANCE});index.append(guidance);
    const editor=h("section",{class:"t3x-font-editor","aria-labelledby":"t3x-font-editor-title"});
    const back=h("button",{type:"button",class:"t3x-btn t3x-font-back",onclick:()=>{rememberFontScroll();fontNav.editor=false;el.dataset.view="index";index.scrollTop=fontNav.indexScroll;const selected=rows.get(fontNav.role)?.button; (selected?.getClientRects().length?selected:search).focus({preventScroll:true});}},"Back to areas");
    const returnButton=h("button",{type:"button",class:"t3x-btn t3x-font-return",hidden:true,onclick:()=>{const id=fontNav.returns.pop();if(id)selectFontArea(id,{returning:true});}});
    const editorTitle=h("h3",{id:"t3x-font-editor-title",tabindex:"-1"});
    const scope=h("p",{class:"t3x-font-scope"});
    const targets=h("div",{class:"t3x-targets t3x-font-local-targets",role:"group","aria-label":"Applies to"});
    const source=h("select",{class:"t3x-select",id:"t3x-font-source",onchange:e=>change({fontSources:{...settings.fontSources,[fontNav.role]:e.currentTarget.value}})});
    const resolved=h("p",{class:"t3x-font-resolved",role:"status","aria-live":"polite"});
    const editSource=h("button",{type:"button",class:"t3x-btn",hidden:true,onclick:()=>selectFontArea(settings.fontSources[fontNav.role].slice(5),{fromSource:true})},"Edit source");
    const choose=family=>{const r=ROLE[fontNav.role];if(family!=="off"&&(family!==settings[r.key].family||settings.fontSources[fontNav.role]!=="own"))change({[r.key]:{family,size:null},fontSources:{...settings.fontSources,[fontNav.role]:"own"}});};
    const family=h("select",{class:"t3x-select t3x-font-select",id:"t3x-font-family","aria-label":"Font family","data-focus":"workspace-family",onpointerdown:e=>warmMenuNames(e.currentTarget),onkeydown:e=>{if([" ","Enter","ArrowDown","ArrowUp","F4"].includes(e.key))warmMenuNames(e.currentTarget);},onchange:e=>choose(e.currentTarget.value),onblur:()=>{if(fontWorkspace?.pending)syncFontWorkspace();}});
    const prev=h("button",{type:"button",class:"t3x-btn","aria-label":"Previous font",onclick:()=>choose(fontNeighbor(catalog,settings,settings[ROLE[fontNav.role].key].family,-1,nativeAvailable,fontNav.role))},"Previous");
    const next=h("button",{type:"button",class:"t3x-btn","aria-label":"Next font",onclick:()=>choose(fontNeighbor(catalog,settings,settings[ROLE[fontNav.role].key].family,1,nativeAvailable,fontNav.role))},"Next");
    const size=h("output",{id:"t3x-font-size","aria-live":"polite"});
    const step=d=>{const r=ROLE[fontNav.role],pick=settings[r.key],f=catalog?.find(f=>f.name===pick.family);change({[r.key]:{family:pick.family,size:clamp(sizeOf(f,pick)+d,80,150)}});};
    const minus=h("button",{type:"button",class:"t3x-btn","aria-label":"Smaller font",onclick:()=>step(-5)},"−");
    const plus=h("button",{type:"button",class:"t3x-btn","aria-label":"Larger font",onclick:()=>step(5)},"+");
    const reset=h("button",{type:"button",class:"t3x-btn",onclick:()=>{const r=ROLE[fontNav.role];change({[r.key]:{...settings[r.key],size:null}});}},"Default size");
    const filter=(key,label)=>h("button",{type:"button",class:"t3x-chipbtn","data-filter":key,"aria-pressed":String(settings[key]),onclick:()=>change({[key]:!settings[key]})},label);
    const own=h("div",{class:"t3x-font-own"},h("div",{class:"t3x-chips"},filter("printOnly","Print only"),filter("showPartly","Show semi-cursive")),h("p",{class:"t3x-note",text:"Turn both off to include script fonts. Narrowest first; ★ marks a good fit."}),h("label",{for:"t3x-font-family",text:"Font family"}),h("div",{class:"t3x-workspace-browse"},prev,family,next),h("div",{class:"t3x-workspace-size",role:"group","aria-label":"Font size"},h("span",{text:"Size"}),minus,size,plus,reset));
    const fontNote=h("p",{class:"t3x-note"});
    const sample=h("div",{class:"t3x-font-preview t3x-workspace-sample"});
    editor.append(back,returnButton,editorTitle,h("strong",{class:"t3x-font-scope-label",text:"Applies to"}),scope,targets,h("label",{for:"t3x-font-source",text:"Font source"}),source,resolved,editSource,own,fontNote,h("div",{class:"t3x-font-preview-label",text:"Preview"}),sample,h("p",{class:"t3x-note",text:"Changes apply immediately. A preview illustrates the face; native surfaces may have different text sizes and layout."}));
    el.append(h("header",{class:"t3x-font-workspace-head"},h("div",{},title,h("p",{text:"Choose an area, then its font"})),h("button",{type:"button",class:"t3x-btn","aria-label":"Close Fonts",onclick:()=>closeFontWorkspace()},"Close")),h("div",{class:"t3x-font-workspace-body"},h("nav",{class:"t3x-font-navigation","aria-label":"Font areas"},h("label",{for:"t3x-font-search",text:"Find an area"}),search,index),editor));
    fontWorkspace={el,trigger:anchor,search,index,editor,navigation:el.querySelector(".t3x-font-navigation"),lastFocus:null,switchingArea:true,rows,empty,guidance,title:editorTitle,scope,targets,source,resolved,editSource,own,family,prev,next,minus,plus,size,reset,sample,fontNote,returnButton,role:null,optionsKey:null};
    el.addEventListener("focusin",e=>{if(fontWorkspace?.el===el){rememberFontScroll();fontWorkspace.lastFocus=e.target;}});
    for(const pane of [index,editor])pane.addEventListener("scroll",()=>{if(fontWorkspace?.el===el)rememberFontScroll();});
    el.addEventListener("cancel",e=>{e.preventDefault();if(!fontSelectOpen())closeFontWorkspace();});
    el.addEventListener("keydown",e=>{
      if(e.key!=="Tab"||fontSelectOpen())return;
      const controls=[...el.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter(n=>n.getClientRects().length&&!n.closest("[hidden]"));
      const first=controls[0],last=controls.at(-1);
      if(e.shiftKey&&D.activeElement===first){e.preventDefault();last?.focus();}
      else if(!e.shiftKey&&D.activeElement===last){e.preventDefault();first?.focus();}
    });
    D.body.append(el);syncFontWorkspace(true);el.showModal();
    index.scrollTop=fontNav.indexScroll;editor.scrollTop=fontNav.scroll.get(fontNav.role)||0;
    fontWorkspace.switchingArea=false;
    (fontNav.editor?editorTitle:search).focus({preventScroll:true});
    loadCatalog();
  }
  function syncFontIndex() {
    const ui=fontWorkspace;if(!ui)return;
    const q=fontNav.query.trim().toLocaleLowerCase();let count=0;
    for(const area of FONT_AREAS){
      const row=ui.rows.get(area.id),summary=fontSummary(area.id);
      row.summary.textContent=summary;
      row.button.setAttribute("aria-current",String(area.id===fontNav.role));
      const nativeMatch=/code|diff|terminal|number|digit|button|control|menu|input/.test(q);
      row.button.hidden=!!q&&!`${area.label} ${area.scope} ${summary}`.toLocaleLowerCase().includes(q);
      if(!row.button.hidden)count++;
      ui.guidance.dataset.match=String(nativeMatch);
    }
    for(const section of ui.index.querySelectorAll(".t3x-font-area-group"))section.hidden=![...section.querySelectorAll(".t3x-font-area")].some(b=>!b.hidden);
    ui.empty.hidden=count>0;
  }
  function syncFontWorkspace(force=false) {
    const ui=fontWorkspace;if(!ui)return;
    const id=fontNav.role,area=fontArea(id),r=ROLE[id],pick=settings[r.key],effective=activePick(id),src=settings.fontSources[id],f=catalog?.find(f=>f.name===pick.family);
    const focusBefore=D.activeElement;
    const hadFocus=ui.el.contains(focusBefore);
    const changed=ui.role!==id;ui.role=id;
    ui.el.dataset.view=fontNav.editor?"editor":"index";
    syncFontIndex();
    ui.title.textContent=area.label;ui.scope.textContent=area.scope;
    if(changed||force){
      ui.targets.replaceChildren(...(area.targets||[]).map(([key,label])=>h("button",{type:"button",role:"checkbox","data-target":key,"aria-checked":String(settings.fontTargets[key]),class:"t3x-check",onclick:()=>change({fontTargets:{...settings.fontTargets,[key]:!settings.fontTargets[key]}})},h("span",{class:"t3x-box","aria-hidden":"true"}),h("span",{class:"t3x-set-label",text:label}))));
      ui.targets.hidden=!area.targets?.length;
    }
    for(const target of ui.targets.querySelectorAll("[data-target]"))target.setAttribute("aria-checked",String(settings.fontTargets[target.dataset.target]));
    const sourceKey=FONT_AREAS.filter(a=>!fontLinkWouldCycle(settings.fontSources,id,a.id)).map(a=>a.id).join(",");
    if(ui.sourceKey!==sourceKey||changed){
      if(D.activeElement!==ui.source||!fontSelectOpen()){
        ui.source.replaceChildren(h("option",{value:"native",text:"T3 default"}),h("option",{value:"own",text:"Own font"}),h("optgroup",{label:"Same as"},FONT_AREAS.filter(a=>!fontLinkWouldCycle(settings.fontSources,id,a.id)).map(a=>h("option",{value:`link:${a.id}`,text:`Same as ${a.label}`}))));ui.sourceKey=sourceKey;
      }
    }
    if(D.activeElement!==ui.source||!fontSelectOpen()){
      if(![...ui.source.options].some(o=>o.value===src))ui.source.append(h("option",{value:src,text:"Linked cycle · uses T3 default",disabled:true}));
      ui.source.value=src;
    }
    ui.own.hidden=src!=="own";ui.editSource.hidden=!src.startsWith("link:");
    ui.resolved.textContent=`${src.startsWith("link:")?`Same as ${fontArea(src.slice(5))?.label}. `:""}${fontResolvedText(id)}${effective.family==="off"?" · follows current T3 settings":""}`;
    const options=fontOptions(catalog,settings,pick.family,nativeAvailable,id),optionsKey=JSON.stringify([options,pick.family]);
    if(ui.optionsKey!==optionsKey){
      if(!fontSelectOpen()){
        ui.family.replaceChildren(...options.map(g=>h("optgroup",{label:g.label},g.options.filter(o=>o.name!=="off").map(o=>h("option",{value:o.name,style:nameStyle(o.name)},h("span",{text:o.name}),h("span",{class:"t3x-font-meta",text:o.label.slice(o.name.length)}))))));
        if(pick.family==="off")ui.family.prepend(h("option",{value:"off",text:catalog?"Choose a font":"Loading fonts…",disabled:true}));
        else if(![...ui.family.options].some(o=>o.value===pick.family))ui.family.prepend(h("option",{value:pick.family,text:`${pick.family} (unavailable)`}));
        ui.optionsKey=optionsKey;ui.pending=false;
      }else ui.pending=true;
    }
    if(!fontSelectOpen())ui.family.value=pick.family;
    ui.family.style.fontFamily=f?.source==="t3"?f.css:f?`"${nameAlias(f.name)}",var(--font-sans)`:"var(--font-sans)";
    ui.prev.disabled=!fontNeighbor(catalog,settings,pick.family,-1,nativeAvailable,id);ui.next.disabled=!fontNeighbor(catalog,settings,pick.family,1,nativeAvailable,id);
    const n=sizeOf(f,pick),disabled=pick.family==="off"||!f||f.source==="t3";
    ui.size.textContent=disabled?"—":`${n}%`;ui.minus.disabled=disabled||n<=80;ui.plus.disabled=disabled||n>=150;ui.reset.disabled=disabled||pick.size===null;ui.reset.textContent=`Default ${sizePct(f?.size)??100}%`;
    for(const filter of ui.own.querySelectorAll("[data-filter]"))filter.setAttribute("aria-pressed",String(settings[filter.dataset.filter]));
    const ef=catalog?.find(f=>f.name===effective.family),t3=ef?.source==="t3"&&id!=="viz";
    const loaded=t3||roleFaces[id]?.key===`${effective.family}|${sizeOf(ef,effective)}`;
    ui.fontNote.textContent=effective.family==="off"?"Your saved own font and size stay stored while this area uses the default or follows another area.":ef?.source==="t3"?(t3?"Follows your T3 setting as it changes. The size buttons don't apply to T3's own fonts.":"Visualizations can't use T3's own fonts, so they keep T3's default."):!loaded?"Loading this font, or unavailable. Text keeps T3’s font until the face is ready.":"Font ready. Digits 0–9 keep T3’s font.";
    ui.sample.textContent=area.sample;
    const native=id==="composer"?"var(--font-composer,var(--font-sans))":id==="paths"?"var(--font-mono,var(--font-sans))":"var(--font-sans)";
    ui.sample.style.fontFamily=t3?ef.css:effective.family!=="off"&&loaded?`"${r.alias}",${native}`:native;
    ui.returnButton.hidden=!fontNav.returns.length;ui.returnButton.textContent=fontNav.returns.length?`Back to ${fontArea(fontNav.returns.at(-1)).label}`:"";
    // External settings can hide a focused Own control. Keep focus in a visible modal control.
    if(hadFocus&&(!ui.el.contains(D.activeElement)||!focusBefore.getClientRects().length)) {
      (ui.source.getClientRects().length?ui.source:ui.search).focus({preventScroll:true});
    }
    warmSelectedNames();
  }
  function panelBody() {
    if (!catalog) loadCatalog();
    const mode = lastState?.handover?.mode;
    return [
      h("header", { class: "t3x-pop-head" }, h("strong", { text: "✦ Add-ons" }),
        h("span", { class: "t3x-muted", text: lastState ? "This Mac · service running" : "service not answering" })),
      h("button", {type:"button",class:"t3x-font-entry","data-focus":"open-fonts",onclick:e=>openFontWorkspace(e.currentTarget)},h("span",{text:"Fonts…"}),h("span",{class:"t3x-muted",text:fontsCustomized()?`${fontsCustomized()} customized`:"All T3 default"})),
      fontPickList(),
      paused ? h("div", { class: "t3x-warn", text: "Add-ons paused after repeated errors. Press Shift-Cmd-R to retry." }) : null,
      h("details", { class: "t3x-more", open: panelMoreOpen, ontoggle: (e) => { panelMoreOpen = e.currentTarget.open; } },
      h("summary", { "data-focus": "more" }, h("span", { text: "Settings" })),
      h("section", {}, h("h3", { text: "Usage" }),
        sw("Header glyphs (one per lab)", "usageHeader", where("header")),
        sw("Composer: the tightest lab", "usageComposer", where("composer")),
        sw("Sidebar: one row per lab", "usageSidebar", where("bars")),
        settings.usageSidebar ? sw("Sidebar: compact in a short window", "usageSidebarShort", `One line per lab while the window is under ${SHORT_WINDOW} px tall.`) : null,
        sw("Thread burn tells", "burnTells", "Gemini threads aren't measured. Estimated API cost equivalent; not your subscription charge.")),
      h("section", {}, h("h3", { text: "Handover" }),
        sw("Prepare handover button", "handoverButton", "Adds a request to your message; you send it."),
        sw("Handover chain pill", "chainPill", mode ? `Handover mode: ${mode}` : null)),
      h("section", {}, h("h3", { text: "Sidebar" }),
        sw("Compact threads", "compactThreads", "Project icon and title on one line; hover the icon for the project and branch."),
        settings.compactThreads ? null : [
          sw("Tighter rows", "tighter"),
          sw("Model icon beside the title", "inlineIcon", "Only on rows whose last line held nothing else."),
          sw("Project name in full", "projectFull", "Wraps instead of ending in \u2026; the status stays on the right."),
        ],
        sw("Stronger Working divider", "workingHeader", "The Working header in T3's working colour, bold, with a thicker line."),
        h("div", { class: "t3x-set" }, h("div", { class: "t3x-set-label", text: "Selected thread marker" }),
          h("div", { class: "t3x-radios", role: "radiogroup", "aria-label": "Selected thread marker" },
            radio("marker", "bar", settings.marker, "Bar + bold", (v) => change({ marker: v })),
            radio("marker", "outline", settings.marker, "Outline", (v) => change({ marker: v })),
            radio("marker", "off", settings.marker, "Off", (v) => change({ marker: v }))))),
      h("section", {}, h("h3", { text: "Replies" }),
        h("div", { class: "t3x-set" }, h("div", { class: "t3x-set-label", text: "Footer team list" }),
          h("div", { class: "t3x-radios t3x-col t3x-indent", role: "radiogroup", "aria-label": "Footer team list" },
            FOOTER_TEAM.map(([value, label]) => radio("footerTeam", value, settings.footerTeam, label, (v) => change({ footerTeam: v })))))),
      h("footer", { class: "t3x-pop-foot" },
        h("button", { type: "button", class: "t3x-btn", "data-focus": "reset", onclick: () => change(null) }, "Reset defaults"),
        h("span", { class: "t3x-muted" }, "Remove everything: see ", h("code", { text: "t3-extras/README.md" })))),
    ];
  }
  panelBody.label = "Add-ons";
  let panelMoreOpen = false; // the Settings disclosure, open for the rest of this session once opened
  function openPanel(btn) {
    openPopover(btn, "panel", panelBody, { width: 360 });
  }
  function change(patch) {
    const wasTeam = settings.footerTeam;
    settings = patch === null ? readSettings("{}") : readSettings(JSON.stringify({ ...settings, ...patch }));
    if (settings.footerTeam === "always-show" && wasTeam !== "always-show") {
      try {
        footerPass(D, "always-show", footerSeen, true);
      } catch (e) {
        noteError("footer", e);
      }
    }
    saveSettings();
    applyRootAttrs();
    applyFonts();
    if (settings.burnTells) fetchBurn();
    else burnData = null;
    render();
    if (pop?.kind === "panel") fillPopover();
    syncFontWorkspace();
  }
  // One row per font you picked (areas that follow it listed beside it). Clicking a name opens Fonts there.
  function openFontsAt(id, trigger) {
    if (fontWorkspace) return selectFontArea(id);
    fontNav.role = id; fontNav.editor = true; fontNav.returns.length = 0;
    openFontWorkspace(trigger);
  }
  function stepAreaFont(id, dir) {
    const r = ROLE[id], cur = settings[r.key].family;
    const next = fontNeighbor(catalog, settings, cur, dir, nativeAvailable, id);
    if (next && next !== cur) change({ [r.key]: { family: next, size: null } });
  }
  function fontStripGroups() {
    const terminal = resolveFontGraph(settings.fontSources), groups = new Map();
    for (const a of FONT_AREAS) {
      const t = terminal[a.id];
      if (!t || !ROLE[t] || settings[ROLE[t].key].family === "off") continue;
      if (!groups.has(t)) groups.set(t, []);
      if (t !== a.id) groups.get(t).push(a.id);
    }
    return [...groups].map(([id, followers]) => ({ id, followers }));
  }
  const areaTitle = (id) => FONT_ROLE_BY_ID[id]?.title ?? fontArea(id)?.label ?? id;
  /** The ✦ panel's "Your fonts": each picked font's name in its own face, with Previous/Next. */
  function fontPickList() {
    const groups = fontStripGroups();
    if (!groups.length) return null;
    return h("section", { class: "t3x-fs", "aria-label": "Your fonts" }, h("h3", { text: "Your fonts" }), groups.map(({ id, followers }) => {
      const pick = settings[ROLE[id].key], f = catalog?.find((x) => x.name === pick.family);
      const entries = catalog ? fontOptions(catalog, settings, pick.family, nativeAvailable, id).flatMap((g) => g.options) : [];
      const at = entries.findIndex((o) => o.name === pick.family);
      const t3 = f?.source === "t3" && id !== "viz";
      const loaded = roleFaces[id]?.key === `${pick.family}|${sizeOf(f, pick)}`;
      const label = areaTitle(id), also = followers.map(areaTitle);
      const arrow = (dir) => h("button", { type: "button", class: "t3x-fs-step", "data-focus": `fs-${dir < 0 ? "prev" : "next"}-${id}`, "aria-label": `${dir < 0 ? "Previous" : "Next"} font for ${label}`, title: `${dir < 0 ? "Previous" : "Next"} font`, disabled: !catalog || !f ? true : null, onclick: () => stepAreaFont(id, dir) }, dir < 0 ? "‹" : "›");
      const name = h("button", {
        type: "button", class: "t3x-fs-name", "data-focus": `fs-name-${id}`,
        title: `${label}${also.length ? ` (also ${also.join(", ")})` : ""}: ${pick.family}${f && f.source !== "t3" ? ` · ${sizeOf(f, pick)}%` : ""}. Click to edit in Fonts; ← → try the previous or next font.`,
        onclick: (e) => openFontsAt(id, e.currentTarget),
        onkeydown: (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); stepAreaFont(id, e.key === "ArrowLeft" ? -1 : 1); } },
      }, pick.family);
      name.style.fontFamily = t3 ? f.css : loaded ? `"${ROLE[id].alias}",var(--font-sans)` : "var(--font-sans)";
      return h("div", { class: "t3x-fs-row" },
        h("div", { class: "t3x-fs-area" }, h("span", { text: label }), also.length ? h("span", { class: "t3x-fs-also", text: `+ ${also.join(", ")}` }) : null,
          at >= 0 ? h("span", { class: "t3x-fs-pos", text: `${at + 1} of ${entries.length}` }) : null),
        h("div", { class: "t3x-fs-pick" }, arrow(-1), name, arrow(1)));
    }));
  }

  listen(W, "storage", (e) => {
    if (e.key === SETTINGS_KEY) {
      settings = readSettings(e.newValue);
      applyRootAttrs();
      applyFonts();
      if (pop?.kind === "panel") fillPopover();
      syncFontWorkspace();
      render();
    }
  });

  // ---------- observer, polling, diag ----------

  const isOwned = (n) => {
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    return Boolean(el && el.closest?.(`[${OWN}]`));
  };
  let scheduled = false;
  let lastRun = 0;
  const run = guarded("observer", () => {
    rafId = 0;
    if (disposed) return;
    scheduled = false;
    lastRun = performance.now();
    checkRoute();
    ensure();
  });
  observer = new MutationObserver((records) => {
    if (scheduled || paused) return;
    for (const r of records) {
      if (isOwned(r.target)) continue;
      const nodes = [...r.addedNodes, ...r.removedNodes];
      if (nodes.length && nodes.every(isOwned)) continue; // our own insert/remove
      scheduled = true;
      later(Math.max(0, 250 - (performance.now() - lastRun)), () => {
        if (!disposed) rafId = requestAnimationFrame(run);
      });
      return;
    }
  });
  observer.observe(D.body, { childList: true, subtree: true });
  cleanups.push(() => observer.disconnect());

  // Theme changes: recompute the marker colour (attributes on <html> only, cheap).
  const themeObserver = new MutationObserver(guarded("theme", () => later(50, updateMarkColor)));
  themeObserver.observe(D.documentElement, { attributes: true, attributeFilter: ["class", "data-theme-id", "data-theme-selected", "style"] });
  cleanups.push(() => themeObserver.disconnect());

  const routeTick = () => checkRoute() && render();
  every(1000, routeTick); // TanStack's pushState doesn't fire hashchange
  listen(W, "hashchange", routeTick);
  every(POLL_MS, () => {
    if (D.visibilityState === "visible") fetchState(); // T3's cache is read right after each answer
  });
  every(30e3, () => {
    if (D.visibilityState === "visible") fetchBurn();
  });
  listen(W, "focus", () => fetchBurn());
  every(30e3, () => render()); // ages and "stale" marks move on even without new data
  listen(D, "visibilitychange", () => {
    if (D.visibilityState === "visible") {
      fetchState();
      fetchBurn();
    }
  });

  // Opt-in debug counts (localStorage "t3x:diag" = "1"), plus one check-in the first time each new
  // version of the add-ons loads, so an install can be confirmed. Never titles, message text, ids,
  // account details or font choices: counts, flags and fixed words only.
  const report = () => {
    if (disposed) return;
    const vs = currentViews();
    const p = new URLSearchParams({ v: "r2", route: route.kind, local: String(isLocalThread()), chain: String(Boolean(lastState?.handover?.chain)) });
    for (const [k, v] of Object.entries(status)) p.set(`f.${k}`, v);
    const cards = [...D.querySelectorAll('[data-testid="sidebar-row-card"]')];
    p.set("cards", String(cards.length));
    p.set("cardsInline", String(cards.filter((c) => getComputedStyle(c.querySelector(":scope > div.relative") ?? c).display === "grid").length));
    p.set("cardH", cards.slice(0, 6).map((c) => c.offsetHeight).join("|"));
    const cur = D.querySelector('[data-testid^="sidebar-row-"][aria-current="page"]');
    p.set("marker", !cur ? "norow" : getComputedStyle(cur, "::after").content !== "none" ? "bar" : getComputedStyle(cur).outlineStyle !== "none" ? "outline" : "none");
    p.set("curW", cur ? getComputedStyle(cur.querySelector("span[aria-hidden].flex-1") ?? cur).fontWeight : "none");
    p.set("editor", String(Boolean(composerEditor())));
    p.set("usageAgeS", lastState?.usage?.fetchedAt ? String(Math.round((Date.now() - lastState.usage.fetchedAt) / 1000)) : "none");
    p.set("t3cache", t3.state);
    p.set("labs", String(compactLabs(vs).length));
    p.set("labsFresh", String(compactLabs(vs).filter((v) => !v.stale).length));
    p.set("labsT3", String(compactLabs(vs).filter((v) => v.source === "t3").length));
    p.set("hist", histBroken() ? "broken" : histCount === null ? "none" : String(Math.min(histCount, 999999)));
    const bt = Object.values(burnData?.threads ?? {}).filter((e) => e && BURN_TIERS.has(e.tier));
    p.set("burnN", String(bt.length));
    p.set("burnHot", String(bt.filter((e) => ["warm", "hot", "blazing"].includes(e.tier)).length));
    p.set("burnEmber", String(bt.filter((e) => e.tier === "burst").length));
    p.set("burnRows", String(burnCounts.rows));
    p.set("fh", String(D.documentElement.hasAttribute("data-t3x-fh")));
    p.set("fb", String(D.documentElement.hasAttribute("data-t3x-fb")));
    p.set("fm", String(D.documentElement.hasAttribute("data-t3x-fm")));
    p.set("owned", String(D.querySelectorAll(`[${OWN}]`).length));
    p.set("errors", String(errors.length));
    p.set("paused", String(paused));
    fetch(`${BASE}diag?${p}`, { cache: "no-store" }).catch(() => {});
  };
  if (safeGet("t3x:diag") === "1") {
    later(8000, report);
    every(5 * 60e3, report);
  } else {
    fetch(`${BASE}version`, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : null))
      .then((v) => {
        if (disposed || !v || safeGet("t3x:reported-version") === v) return;
        try {
          localStorage.setItem("t3x:reported-version", v);
        } catch {}
        later(8000, report);
      }, () => {});
  }
  try {
    localStorage.removeItem("t3x:dev-until"); // the build-time 20 s reload aid is gone
  } catch {}

  W.t3xTeardown = () => {
    teardownVisualization();
    disposed = true;
    routeToken++; // any response still on its way belongs to a torn-down copy
    inflight = null;
    for (const c of requests) c.abort();
    requests.clear();
    for (const stop of [...t3Pending]) stop(); // abort T3 reads in flight, close their connections
    if (rafId && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {}
    }
    for (const id of timers) {
      clearTimeout(id);
      clearInterval(id);
    }
    timers.clear();
    closePopover();
    closeFontWorkspace(false);
    closeFontPreviews();
    for (const f of Object.values(features)) f.node?.remove();
    D.querySelectorAll(`[${OWN}]`).forEach((n) => n.remove());
    for (const a of ROOT_ATTRS) D.documentElement.removeAttribute(a);
    for (const el of D.querySelectorAll("[data-t3x-usage-page]")) el.removeAttribute("data-t3x-usage-page");
    for (const role of Object.keys(ROLE)) {
      D.documentElement.removeAttribute(ROLE[role].attr);
      if (roleFaces[role]) D.fonts.delete(roleFaces[role].face);
      roleFaces[role] = null;
    }
    delete W.t3xTeardown;
  };

  applyRootAttrs();
  applyFonts();
  syncUsageMarker();
  updateMarkColor();
  writeDyn();
  ensure();
  fetchState();
  fetchBurn();
})();
