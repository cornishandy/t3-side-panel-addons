/**
 * Pure helpers for the t3-extras service (no I/O), so the tests can run them directly.
 */

export const PORT = 8793;
const hostsFor = (port) => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
// T3's renderer is t3code://app (t3code-dev://app in development). Exactly these, nothing broader.
export const ALLOWED_ORIGINS = new Set(["t3code://app", "t3code-dev://app"]);

/** Thread ids are opaque; agents' launches carry an "mcp:" prefix. Compare without it (read side only). */
export const normId = (id) => String(id ?? "").trim().replace(/^mcp:/, "");

export const shortId = (id) => normId(id).slice(0, 8);

/** Request guard: loopback Host only (DNS-rebinding), and the CORS origin to echo, if any. */
export function guard(headers, port = PORT) {
  const host = String(headers.host ?? "").toLowerCase();
  const origin = headers.origin;
  return {
    hostOk: hostsFor(port).has(host),
    allowOrigin: typeof origin === "string" && ALLOWED_ORIGINS.has(origin) ? origin : null,
    hasOrigin: typeof origin === "string",
  };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (v) => (num(v) === null ? null : Math.max(0, Math.min(100, v)));

const CLAUDE_WINDOW_NAMES = { "5-hour": ["c5h", "Claude 5-hour"], week: ["cwk", "Claude week"] };
const CODEX_WINDOW_NAMES = { "5-hour": ["x5h", "Codex 5-hour"], weekly: ["xwk", "Codex week"], week: ["xwk", "Codex week"] };

function windowView(w, names, fallbackPrefix, now) {
  // Not capped at 100: a reading past the limit keeps its overage (the drawing clamps it).
  const used = num(w?.used) === null ? null : Math.max(0, w.used);
  const [id, name] = names[w?.name] ?? [`${fallbackPrefix}-${String(w?.name ?? "window")}`, `${fallbackPrefix} ${w?.name ?? "window"}`];
  const mins = num(w?.mins);
  return {
    id,
    name,
    usedPct: used,
    leftPct: used === null ? null : Math.max(0, 100 - used),
    resetsAt: num(w?.resets_at) === null ? null : w.resets_at * 1000,
    lengthSec: mins !== null && mins > 0 ? mins * 60 : null,
    // lab-usage's projection is the % used AT the reset, worked out at `projectionAt` from
    // `projectionUsed` (its own reading; it allows for manual Codex resets).
    projection: num(w?.projection),
    projectionAt: num(w?.projection) === null ? null : now,
    projectionUsed: num(w?.projection) === null ? null : num(w?.used),
  };
}

/**
 * Trim `lab-usage --json --read-only` output into what the add-ons show. Unknown stays null
 * (shown as "—"), never 0. fetchedAt is when lab-usage ran (ms); dataAt is how old each lab's
 * numbers really are.
 */
export function usageView(raw, fetchedAt) {
  const out = { fetchedAt, claude: { ok: false }, codex: { ok: false } };
  if (!raw || typeof raw !== "object") return out;
  const now = num(raw.now) === null ? fetchedAt : raw.now * 1000;
  const c = raw.claude;
  if (c && typeof c === "object" && !c.error && Array.isArray(c.windows)) {
    const conserve = c.conserve && typeof c.conserve === "object" ? c.conserve : {};
    const tier = num(conserve.tier);
    out.claude = {
      ok: true,
      dataAt: num(c.age_min) === null ? null : now - c.age_min * 60000,
      windows: c.windows.map((w) => windowView(w, CLAUDE_WINDOW_NAMES, "Claude", now)),
      scoped: (Array.isArray(c.scoped) ? c.scoped : []).map((s) => ({ model: String(s?.model ?? ""), usedPct: pct(s?.used) })),
      tier: tier === null ? null : `T${tier}`,
      tierName: typeof conserve.tier_name === "string" ? conserve.tier_name : null,
      today: conserve.today && typeof conserve.today === "object"
        ? { share: num(conserve.today.share), spent: num(conserve.today.spent), usedUp: Boolean(conserve.today.used_up) }
        : null,
      stops: Array.isArray(conserve.stops) ? conserve.stops.map(String) : [],
      conserveError: typeof conserve.error === "string" ? conserve.error : null,
    };
  } else if (c && typeof c === "object") {
    out.claude = { ok: false, error: String(c.error ?? "unreadable") };
  }
  const x = raw.codex;
  if (x && typeof x === "object" && Array.isArray(x.windows)) {
    const live = !x.stale_since;
    const stale = typeof x.stale_since === "string" ? Date.parse(x.stale_since) : num(x.stale_since) === null ? NaN : x.stale_since * 1000;
    const chal = x.challenge && typeof x.challenge === "object" ? x.challenge : {};
    const resets = Array.isArray(x.resets) ? x.resets : [];
    out.codex = {
      ok: true,
      live,
      dataAt: live ? now : Number.isNaN(stale) ? null : stale,
      windows: x.windows.map((w) => windowView(w, CODEX_WINDOW_NAMES, "Codex", now)),
      // A gate verdict is only shown from a live read; a stale read never looks like a current GO.
      gate: live && x.gate && typeof x.gate === "object" ? { action: String(x.gate.action ?? ""), reason: String(x.gate.reason ?? "") } : null,
      level: typeof chal.level === "string" ? chal.level : null,
      challengeDay: num(chal.day),
      resetsAvailable: live ? num(x.available) : null,
      resetExpiries: live ? resets.map((r) => num(r?.expires_at)).filter((v) => v !== null).map((v) => v * 1000) : [],
      resetsAtRisk: live && Array.isArray(x.at_risk) ? x.at_risk.length : null,
      blocked: live ? x.allowed === false || Boolean(x.reached) : null,
      plan: typeof x.plan === "string" ? x.plan : null,
    };
  } else {
    out.codex = { ok: false, error: typeof raw.codex_error === "string" ? raw.codex_error.slice(0, 200) : "unreadable" };
  }
  return out;
}

// ---------- the generic lab model ----------

/** Every lab the add-ons know. Labs without a meter are listed in the detail only. */
export const LAB_INFO = [
  { id: "claude", name: "Claude", colour: "#d97757" },
  { id: "codex", name: "Codex", colour: "#2fa37a" },
  { id: "gemini", name: "Gemini", colour: "#5b8def" },
  { id: "grok", name: "Grok", colour: "#9a9aa5" },
  { id: "opencode", name: "OpenCode", colour: "#8b7fd6" },
  { id: "cursor", name: "Cursor", colour: "#8a8f98" },
  { id: "pi", name: "Pi", colour: "#c08a3e" },
  { id: "muse", name: "Muse", colour: "#c0679a" },
];
const LAB_BY_ID = Object.fromEntries(LAB_INFO.map((l) => [l.id, l]));

const ROLE_BY_ID = { c5h: "short", cwk: "long", x5h: "short", xwk: "long" };
const KIND_BY_ID = { c5h: "session", cwk: "weekly", x5h: "session", xwk: "weekly" };

/**
 * lab-usage's Claude and Codex readings as generic labs:
 * {id, name, colour, source, live, fetchedAt, windows: [{id, role, kind, label, usedPct, resetsAt,
 * lengthSec, fetchedAt, live, projection, projectionAt, projectionUsed}], verdict}.
 * role: "long" (week) or "short" (5-hour). Unknown numbers stay null.
 */
export function labsFromView(view) {
  const out = [];
  for (const id of ["claude", "codex"]) {
    const lab = view?.[id];
    if (!lab?.ok) continue;
    const live = id === "codex" ? lab.live !== false : true;
    const windows = (lab.windows ?? []).map((w) => ({
      id: w.id,
      role: ROLE_BY_ID[w.id] ?? "extra",
      kind: KIND_BY_ID[w.id] ?? "other",
      label: w.name,
      usedPct: w.usedPct,
      resetsAt: w.resetsAt,
      lengthSec: w.lengthSec ?? null,
      fetchedAt: lab.dataAt ?? null,
      live,
      projection: w.projection,
      projectionAt: w.projectionAt ?? null,
      projectionUsed: w.projectionUsed ?? null,
    }));
    const verdict = id === "claude"
      ? { tier: lab.tier, tierName: lab.tierName, today: lab.today, stops: lab.stops, scoped: lab.scoped }
      : { gate: lab.gate, level: lab.level, challengeDay: lab.challengeDay, resetsAvailable: lab.resetsAvailable, resetsAtRisk: lab.resetsAtRisk, blocked: lab.blocked };
    out.push({ ...LAB_BY_ID[id], source: "lab-usage", live, fetchedAt: lab.dataAt ?? null, windows, verdict });
  }
  return out;
}

// ---------- usage history (pure rules; the file I/O is in history.mjs) ----------

export const HISTORY = Object.freeze({
  everyMs: 10 * 60_000, // at most one sample per lab/window per 10 min
  keepMs: 15 * 86_400_000, // 15 days
  maxLines: 20_000, // global record cap
  maxBytes: 2_500_000, // global byte cap (the file is compacted below this)
  maxLineBytes: 240, // a longer line is refused
  maxReturn: 6_000, // samples returned by /history
});
const SERIES_LABS = new Set(LAB_INFO.map((l) => l.id));

/** One history sample, or null if anything is off. series = "<lab>:<long|short>". */
export function historySample(lab, role, w, ts) {
  if (!SERIES_LABS.has(lab) || (role !== "long" && role !== "short")) return null;
  const used = typeof w?.usedPct === "number" && Number.isFinite(w.usedPct) ? Math.round(w.usedPct * 100) / 100 : null;
  if (used === null || used < 0 || used > 1000 || !Number.isFinite(ts)) return null;
  const resetsAt = typeof w?.resetsAt === "number" && Number.isFinite(w.resetsAt) ? Math.round(w.resetsAt) : null;
  const lengthSec = typeof w?.lengthSec === "number" && w.lengthSec > 0 ? Math.round(w.lengthSec) : null;
  return { ts: Math.round(ts), s: `${lab}:${role}`, used, resetsAt, lengthSec };
}

/** A parsed history line, or null (bad JSON, wrong shape, too long). */
export function parseSample(line) {
  if (!line || line.length > HISTORY.maxLineBytes) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || typeof o.s !== "string") return null;
  const [lab, role] = o.s.split(":");
  return historySample(lab, role, { usedPct: o.used, resetsAt: o.resetsAt, lengthSec: o.lengthSec }, o.ts);
}

/** Samples kept after retention and the caps: the newest first wins, oldest dropped. */
export function compactSamples(samples, now) {
  const keep = samples.filter((x) => x && x.ts >= now - HISTORY.keepMs && x.ts <= now + 60_000).sort((a, b) => a.ts - b.ts);
  // Down to 90% of the line cap and 80% of the byte cap, so the next appends have room.
  let out = keep.slice(-Math.floor(HISTORY.maxLines * 0.9));
  let bytes = out.reduce((n, x) => n + JSON.stringify(x).length + 1, 0);
  let drop = 0;
  while (bytes > HISTORY.maxBytes * 0.8 && drop < out.length) bytes -= JSON.stringify(out[drop++]).length + 1;
  return drop ? out.slice(drop) : out;
}

/** Samples for one response: newest kept, at most HISTORY.maxReturn, per series in time order. */
export function boundedSamples(samples, since = 0) {
  return samples.filter((x) => x.ts >= since).slice(-HISTORY.maxReturn);
}

/**
 * The handover chain the thread belongs to, from ~/.local/share/handover/state.json (read only).
 * position is 1 for the chain's first thread, 2 after one handover, and so on.
 */
export function chainView(state, threadId) {
  if (!state || typeof state !== "object" || !threadId) return null;
  const want = normId(threadId);
  if (!want) return null;
  const threads = state.threads && typeof state.threads === "object" ? state.threads : {};
  const chains = state.chains && typeof state.chains === "object" ? state.chains : {};
  const key = Object.keys(threads).find((k) => normId(k) === want);
  if (!key) return null;
  const chainKey = Object.keys(chains).find((k) => normId(k) === normId(threads[key]?.chain));
  if (!chainKey) return null;
  const chain = chains[chainKey] ?? {};
  const history = (Array.isArray(chain.history) ? chain.history : []).filter((h) => h && typeof h === "object");
  const members = history.length ? [history[0].from, ...history.map((h) => h.to)] : [chain.owner ?? chainKey];
  let index = members.findIndex((m) => normId(m) === want);
  if (index < 0) {
    // Not in the history (yet): count predecessors instead.
    index = 0;
    const seen = new Set();
    for (let cur = threads[key]; cur?.predecessor && !seen.has(normId(cur.predecessor)); index++) {
      seen.add(normId(cur.predecessor));
      cur = threads[Object.keys(threads).find((k) => normId(k) === normId(cur.predecessor))];
    }
  }
  return {
    id: normId(chainKey),
    short: shortId(chainKey),
    title: typeof chain.title === "string" ? chain.title : null,
    file: typeof chain.file === "string" ? chain.file : null,
    position: index + 1,
    length: Math.max(members.length, index + 1),
    current: normId(chain.owner) === want,
    pending: Boolean(chain.pending),
    history: history.map((h) => ({ at: typeof h.at === "string" ? h.at : null, from: shortId(h.from), to: shortId(h.to) })),
  };
}

// /diag keeps only these keys, each checked for its type; everything else is dropped.
const COUNT = (s) => /^\d{1,6}$/.test(s);
const BOOL = (s) => s === "true" || s === "false";
const oneOf = (...values) => (s) => values.includes(s);
const FEATURE = oneOf("on", "off", "missing", "ambiguous", "unstable", "error");
const DIAG_KEYS = {
  v: oneOf("final", "r2"),
  route: oneOf("thread", "draft", "home", "other", "unknown"),
  local: BOOL,
  chain: BOOL,
  editor: BOOL,
  paused: BOOL,
  "f.panel": FEATURE,
  "f.bars": FEATURE,
  "f.header": FEATURE,
  "f.composer": FEATURE,
  cards: COUNT,
  cardsInline: COUNT,
  owned: COUNT,
  errors: COUNT,
  cardH: (s) => /^\d{1,4}(\|\d{1,4}){0,5}$/.test(s), // up to six row heights in px
  marker: oneOf("bar", "outline", "none", "norow"),
  curW: (s) => COUNT(s) || s === "none",
  usageAgeS: (s) => COUNT(s) || s === "none",
  t3cache: oneOf("waiting", "ok", "noenv", "unsupported", "absent", "missing", "schema", "error"),
  labs: COUNT,
  labsFresh: COUNT,
  labsT3: COUNT,
  hist: (s) => COUNT(s) || s === "none" || s === "broken",
  fh: BOOL,
  fb: BOOL,
  fm: BOOL,
  burnN: COUNT, // threads with a burn tier
  burnHot: COUNT, // of those: warm, hot or blazing
  burnEmber: COUNT, // of those: bursts (embers)
  burnRows: COUNT, // sidebar rows decorated
};

/** /diag stores counts, flags and a few fixed words only: never titles, paths or other text. */
export function diagEntry(params) {
  const out = {};
  for (const [k, v] of params) {
    if (Object.hasOwn(DIAG_KEYS, k) && !Object.hasOwn(out, k) && DIAG_KEYS[k](String(v))) out[k] = String(v);
  }
  return out;
}
