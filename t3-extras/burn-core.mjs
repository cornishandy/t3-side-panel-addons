/**
 * Burn-rate tells: the pure parts (no I/O), so the tests can run them directly.
 *
 *  - Transcript parsers and pricing are ports of T3's own (server bundle: parseClaudeRecord,
 *    parseCodexRecord, parseGrokRecord, usagePricing.priceUsage), so a thread's dollars match T3's
 *    usage page: "API-equivalent cost", not a subscription charge.
 *  - Rates: trailing 2-, 10- and 15-minute $/h from priced events, by event time.
 *  - Tiers (BRIEF-burn + Astra's pre-OK, binding): sustained heat needs ten observed minutes of
 *    continuous spending; Grok counts turns; a tier drops only after two successful observations
 *    below it; unknown observations never demote.
 *  - Calibration: the same trailing-window aggregation over Andy's last 7 days (T3's usage scan
 *    cache), with the research defaults as floors.
 */

export const MIN = 60_000;
export const WINDOWS = Object.freeze({ w2: 2 * MIN, w10: 10 * MIN, w15: 15 * MIN });
export const KEEP_MS = 35 * MIN; // events kept per file
export const SUSTAIN_MS = 10 * MIN; // observed continuity needed for warm/hot/blazing
export const BUILDING_MS = 8 * MIN; // a burst still going at 8 min is "building"
export const EMBER_FADE_MS = 5 * MIN; // an ember stays 5 min after its burst ends
export const OBS_GAP_MS = 75_000; // a longer gap between observations breaks continuity
export const STALE_MS = 5 * MIN; // no successful observation for this long: show nothing

// Research defaults (Grok 4.7, calibration.json, 19 Oct 2026; 7 days): 2-min p95, 15-min p90/p99.
// p97 is in neither file: interpolated between p95 (22.6289) and p99 (41.435). They are also floors.
export const DEFAULT_THRESHOLDS = Object.freeze({ burst: 45.6542, warm: 17.5066, hot: 32.0320, blazing: 41.435 });
const TIERS = ["warm", "hot", "blazing"];
const RANK = { null: 0, warm: 1, hot: 2, blazing: 3 };

// ---------------------------------------------------------------- parsing (ports of T3's)

const tokenCount = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
const totalTokens = (t) => t.uncached + t.cached + t.cacheCreation + t.output;
function parseTs(v) {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Claude: one assistant line per content block, each repeating the message's usage; the key
 *  (message id : request id) lets the caller keep the first only. */
export function parseClaudeRecord(o) {
  if (!o || typeof o !== "object" || o.type !== "assistant") return null;
  const m = o.message;
  if (!m || typeof m !== "object" || !m.usage || typeof m.usage !== "object") return null;
  const ts = parseTs(o.timestamp);
  if (ts === null) return null;
  const model = typeof m.model === "string" ? m.model : "";
  if (!model || model === "<synthetic>") return null;
  const mid = typeof m.id === "string" ? m.id : null;
  const rid = typeof o.requestId === "string" ? o.requestId : null;
  const u = m.usage;
  return {
    ts,
    model,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : "",
    totals: { uncached: tokenCount(u.input_tokens), cached: tokenCount(u.cache_read_input_tokens), cacheCreation: tokenCount(u.cache_creation_input_tokens), output: tokenCount(u.output_tokens) },
    reported: typeof o.costUSD === "number" && Number.isFinite(o.costUSD) ? o.costUSD : null,
    speed: u.speed === "fast" ? "fast" : "standard",
    key: mid === null && rid === null ? null : `${mid ?? ""}:${rid ?? ""}`,
    turn: null,
  };
}

/** Codex: per-event deltas from last_token_usage; model and speed carried in state; consecutive
 *  repeats dropped (across ticks too: the state lives with the file); fork copies suppressed. */
export const FORK_COPY_MAX_GAP_MS = 1000;
export function newCodexState() {
  return { model: "", speed: "standard", sessionId: "", lastSig: null, sawMeta: false, forking: false, forkAnchor: 0 };
}
function isForkedMeta(p) {
  if (typeof p.forked_from_id === "string") return true;
  return typeof p?.source?.subagent?.thread_spawn?.parent_thread_id === "string";
}
export function parseCodexRecord(o, st) {
  if (!o || typeof o !== "object" || !o.payload || typeof o.payload !== "object") return null;
  const p = o.payload;
  if (o.type === "session_meta") {
    if (st.sawMeta) return null;
    st.sawMeta = true;
    const id = p.id ?? p.session_id;
    if (typeof id === "string") st.sessionId = id;
    const t = parseTs(o.timestamp);
    if (t !== null && isForkedMeta(p)) {
      st.forking = true;
      st.forkAnchor = t;
    }
    return null;
  }
  if (o.type === "turn_context") {
    if (typeof p.model === "string") st.model = p.model;
    return null;
  }
  if (p.type === "thread_settings_applied") {
    const tier = p.thread_settings?.service_tier;
    st.speed = tier === "priority" || tier === "fast" ? "fast" : tier === "ultrafast" ? "ultrafast" : "standard";
    return null;
  }
  if (p.type !== "token_count") return null;
  const last = p.info?.last_token_usage;
  if (!last || typeof last !== "object") return null;
  const ts = parseTs(o.timestamp);
  if (ts === null || !st.model) return null;
  const sig = JSON.stringify(last);
  if (sig === st.lastSig) return null;
  st.lastSig = sig;
  if (st.forking) {
    if (ts - st.forkAnchor < FORK_COPY_MAX_GAP_MS) {
      st.forkAnchor = ts;
      return null;
    }
    st.forking = false;
  }
  const input = tokenCount(last.input_tokens);
  const cached = tokenCount(last.cached_input_tokens);
  const cacheCreation = tokenCount(last.cache_write_input_tokens);
  const totals = { uncached: Math.max(0, input - cached - cacheCreation), cached, cacheCreation, output: tokenCount(last.output_tokens) };
  if (totalTokens(totals) === 0) return null;
  return { ts, model: st.model, sessionId: st.sessionId, totals, reported: null, speed: st.speed, key: null, turn: null };
}

/** Grok: one lump per turn_completed; cost in ticks (1 USD = 1e10 ticks); split per model like T3. */
export const GROK_TICKS_PER_USD = 1e10;
const ticksToUsd = (t) => (typeof t === "number" && Number.isFinite(t) && t >= 0 ? t / GROK_TICKS_PER_USD : null);
function grokTotals(r) {
  if (!r || typeof r !== "object") return null;
  return {
    input: tokenCount(r.inputTokens), output: tokenCount(r.outputTokens), cachedRead: tokenCount(r.cachedReadTokens),
    cacheCreation: tokenCount(r.cacheCreationTokens), ticks: typeof r.costUsdTicks === "number" && Number.isFinite(r.costUsdTicks) ? r.costUsdTicks : null,
  };
}
const grokUsage = (t) => ({ uncached: Math.max(0, t.input - t.cachedRead - t.cacheCreation), cached: t.cachedRead, cacheCreation: t.cacheCreation, output: t.output });
export function parseGrokRecord(o) {
  const params = o?.params;
  const up = params?.update;
  if (!up || typeof up !== "object" || up.sessionUpdate !== "turn_completed" || !up.usage || typeof up.usage !== "object") return [];
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
  const promptId = typeof up.prompt_id === "string" ? up.prompt_id : null;
  let ts = typeof params._meta?.agentTimestampMs === "number" && Number.isFinite(params._meta.agentTimestampMs) ? params._meta.agentTimestampMs : null;
  if (ts === null && typeof o.timestamp === "number" && Number.isFinite(o.timestamp)) ts = o.timestamp > 0xe8d4a51000 ? o.timestamp : o.timestamp * 1000;
  if (ts === null) return [];
  const top = grokTotals(up.usage);
  if (!top) return [];
  const entries = [];
  if (up.usage.modelUsage && typeof up.usage.modelUsage === "object") {
    for (const [model, raw] of Object.entries(up.usage.modelUsage)) {
      const t = model ? grokTotals(raw) : null;
      if (t) entries.push({ model, t });
    }
  }
  const turn = promptId === null ? null : `${sessionId}:${promptId}`;
  if (!entries.length) {
    const totals = grokUsage(top);
    if (totalTokens(totals) === 0) return [];
    return [{ ts, model: "grok", sessionId, totals, reported: ticksToUsd(top.ticks), speed: "standard", key: turn === null ? null : `${turn}:grok`, turn }];
  }
  const topUsd = ticksToUsd(top.ticks);
  let ticked = 0;
  let untickedTokens = 0;
  for (const e of entries) {
    const n = totalTokens(grokUsage(e.t));
    if (!n) continue;
    if (e.t.ticks !== null) ticked += ticksToUsd(e.t.ticks) ?? 0;
    else untickedTokens += n;
  }
  const remaining = topUsd === null ? null : Math.max(0, topUsd - ticked);
  const out = [];
  for (const e of entries) {
    const totals = grokUsage(e.t);
    const n = totalTokens(totals);
    if (!n) continue;
    let reported = ticksToUsd(e.t.ticks);
    if (reported === null && remaining !== null && untickedTokens > 0) reported = remaining * (n / untickedTokens);
    out.push({ ts, model: e.model, sessionId, totals, reported, speed: "standard", key: turn === null ? null : `${turn}:${e.model}`, turn });
  }
  return out;
}

// ---------------------------------------------------------------- pricing (port of usagePricing)

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function readTokenRates(e, suffix, standard) {
  const input = finite(e[`input_cost_per_token${suffix}`]);
  const output = finite(e[`output_cost_per_token${suffix}`]);
  if (input === null || output === null) return null;
  const cache = (name, field) => finite(e[`${name}${suffix}`]) ?? (standard && standard.input > 0 ? (standard[field] / standard.input) * input : input);
  return { input, output, cacheRead: cache("cache_read_input_token_cost", "cacheRead"), cacheCreation: cache("cache_creation_input_token_cost", "cacheCreation") };
}
const scaleRates = (r, k) => ({ input: r.input * k, output: r.output * k, cacheRead: r.cacheRead * k, cacheCreation: r.cacheCreation * k });
const sameTok = (a, b) => (a === null || b === null ? a === b : a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheCreation === b.cacheCreation);
const normKey = (m) => m.trim().toLowerCase();
const bare = (k) => k.slice(k.lastIndexOf("/") + 1);

/** T3's LiteLLM-derived table (usage-model-rates.json "document"). */
export function parseRateTable(doc) {
  const table = new Map();
  if (!doc || typeof doc !== "object") return table;
  for (const [name, e] of Object.entries(doc)) {
    if (!e || typeof e !== "object") continue;
    const std = readTokenRates(e, "");
    if (!std) continue;
    const key = normKey(name);
    if (!key) continue;
    const fast = finite(e.provider_specific_entry?.fast);
    table.set(key, { ...std, fast: fast !== null && fast > 0 ? scaleRates(std, fast) : readTokenRates(e, "_priority", std), ultrafast: readTokenRates(e, "_ultrafast", std) });
  }
  const aliases = new Map();
  for (const [key, rate] of table) {
    const a = bare(key);
    if (!a || a === key || table.has(a)) continue;
    const held = aliases.get(a);
    if (held === undefined) aliases.set(a, rate);
    else if (held !== null && !(sameTok(held, rate) && sameTok(held.fast, rate.fast) && sameTok(held.ultrafast, rate.ultrafast))) aliases.set(a, null);
  }
  for (const [a, r] of aliases) if (r !== null) table.set(a, r);
  return table;
}
/** T3's settings.usagePriceOverrides ($ per million tokens), which win over everything. */
export function overrideTable(overrides) {
  const out = new Map();
  if (!overrides || typeof overrides !== "object") return out;
  for (const [model, p] of Object.entries(overrides)) {
    if (!p || typeof p !== "object" || finite(p.inputCostPerMillionTokens) === null || finite(p.outputCostPerMillionTokens) === null) continue;
    out.set(model.trim(), {
      input: p.inputCostPerMillionTokens / 1e6, output: p.outputCostPerMillionTokens / 1e6,
      cacheRead: (finite(p.cacheReadCostPerMillionTokens) ?? p.inputCostPerMillionTokens) / 1e6,
      cacheCreation: (finite(p.cacheWriteCostPerMillionTokens) ?? p.inputCostPerMillionTokens) / 1e6, fast: null, ultrafast: null,
    });
  }
  return out;
}
const UNPRICEABLE = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"]);
function lookupRate(table, model) {
  let key = normKey(model);
  const br = key.indexOf("[");
  if (br !== -1) key = key.slice(0, br);
  const b = bare(key);
  if (!b || UNPRICEABLE.has(b)) return null;
  return table.get(key) ?? null;
}
/** {cost, source}: cost null when it can't be priced (never a $0 observation). */
export function priceRecord(table, overrides, r) {
  if (r.speed === "unknown") return { cost: null, source: "unpriced" }; // a tier we couldn't settle: never guessed
  const override = overrides?.get(r.model.trim());
  const reported = override === undefined && finite(r.reported) !== null ? r.reported : null;
  const rate = override ?? lookupRate(table, r.model);
  if (!rate) return reported === null ? { cost: null, source: "unpriced" } : { cost: reported, source: "providerReported" };
  const tier = (r.speed === "standard" ? null : rate[r.speed]) ?? rate;
  const t = r.totals;
  const list = t.uncached * tier.input + t.cached * tier.cacheRead + t.cacheCreation * tier.cacheCreation + t.output * tier.output;
  if (reported !== null) return { cost: reported, source: "providerReported" };
  return { cost: list, source: "modelPriced" };
}

export function family(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("astra")) return "astra";
  if (/-sol(\b|-|$)|sol$/.test(m)) return "sol";
  if (m.includes("grok")) return "grok";
  return "other";
}

// ---------------------------------------------------------------- rates

/** One observation of a thread at `now` from its priced events [{ts, cost|null, tokens, turn, fam}]. */
export function observe(events, now) {
  const out = { r2: null, r10: null, r15: null, cost2: 0, n15: 0, turns15: 0, span15: 0, fam: null };
  const sums = { w2: [0, 0, 0], w10: [0, 0, 0], w15: [0, 0, 0] }; // priced cost, priced count, unpriced count
  const turns = new Map(); // turn id -> ts
  const famCost = {};
  for (const e of events) {
    if (e.ts > now + MIN) continue;
    for (const [k, w] of Object.entries(WINDOWS)) {
      if (e.ts <= now - w) continue;
      if (e.cost === null) sums[k][2]++;
      else {
        sums[k][0] += e.cost;
        sums[k][1]++;
      }
    }
    if (e.ts > now - WINDOWS.w15) {
      if (e.turn) turns.set(e.turn, Math.max(turns.get(e.turn) ?? 0, e.ts));
      if (e.cost !== null && e.fam) famCost[e.fam] = (famCost[e.fam] ?? 0) + e.cost;
    }
  }
  for (const [k, w] of Object.entries(WINDOWS)) {
    const [cost, , unpriced] = sums[k];
    // Unknown magnitude: one charge we can't price makes the window's rate unknown (not $0, and
    // not the priced part alone, which would understate it).
    const rate = unpriced > 0 ? null : cost / (w / 3_600_000);
    out[`r${k.slice(1)}`] = rate;
  }
  out.cost2 = sums.w2[0];
  out.n15 = sums.w15[1];
  out.turns15 = turns.size;
  if (turns.size) {
    const t = [...turns.values()];
    out.span15 = Math.max(...t) - Math.min(...t);
  }
  out.fam = Object.entries(famCost).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return out;
}

// ---------------------------------------------------------------- tiers (Astra's state machine)

export function newThreadState() {
  return { shown: null, shownSince: null, below: 0, runStart: { warm: null, hot: null, blazing: null }, lastObs: null, lastOk: null, burstStart: null, burstLastAbove: null, burstBelow: 0, burstEnd: null, burstUsd: 0, lastRate15: null, lastRate2: null };
}

/**
 * Advance one thread by one observation. obs.ok false = unknown (a failed or incomplete read):
 * nothing is demoted or promoted, and continuity restarts. kind: "stream" (Claude, Codex) or
 * "turns" (Grok). Returns the new state (the input is not changed).
 */
export function step(prev, obs, thr, now, kind = "stream") {
  const st = structuredClone(prev);
  // Unknown (a failed read, or a window holding a charge of unknown price) is its own state: it
  // never promotes or demotes; continuity restarts; and the last known tier expires only by age.
  if (!obs || !obs.ok || obs.r2 === null || obs.r2 === undefined || obs.r15 === null || obs.r15 === undefined) {
    st.runStart = { warm: null, hot: null, blazing: null };
    st.lastObs = null;
    return st;
  }
  if (st.lastObs !== null && now - st.lastObs > OBS_GAP_MS) st.runStart = { warm: null, hot: null, blazing: null }; // a missed observation
  st.lastObs = now;
  st.lastOk = now;
  const r2 = obs.r2 ?? null;
  const r15 = obs.r15 ?? null;
  st.lastRate2 = r2;
  st.lastRate15 = r15;
  // Sustained: the 15-min rate at the tier's threshold AND (streaming) the 2-min rate above warm on
  // every observation; Grok instead needs two distinct turns spanning ten minutes.
  const holds = (tier) => {
    if (r15 === null || r15 < thr[tier]) return false;
    if (kind === "turns") return obs.turns15 >= 2 && obs.span15 >= SUSTAIN_MS;
    return r2 !== null && r2 > thr.warm;
  };
  for (const t of TIERS) st.runStart[t] = holds(t) ? (st.runStart[t] ?? now) : null;
  const qualified = [...TIERS].reverse().find((t) => st.runStart[t] !== null && (kind === "turns" || now - st.runStart[t] >= SUSTAIN_MS)) ?? null;
  if (RANK[qualified] > RANK[st.shown]) {
    if (!st.shown) st.shownSince = kind === "turns" ? now : st.runStart.warm ?? now;
    st.shown = qualified;
    st.below = 0;
  } else if (st.shown && !holds(st.shown)) {
    st.below++;
    if (st.below >= 2) {
      // Down to the highest lower tier that still holds, else off.
      const lower = TIERS.slice(0, TIERS.indexOf(st.shown)).reverse().find((t) => holds(t)) ?? null;
      st.shown = lower;
      if (!lower) st.shownSince = null;
      st.below = 0;
    }
  } else st.below = 0;
  // Bursts: the 2-min rate at the burst threshold. It ends after two observations below; the
  // ember then fades from the last moment it was above (polling never extends it).
  if (r2 !== null && r2 >= thr.burst) {
    st.burstStart ??= now;
    st.burstLastAbove = now;
    st.burstBelow = 0;
    st.burstEnd = null;
    st.burstUsd = obs.cost2;
  } else if (st.burstStart !== null) {
    st.burstBelow++;
    if (st.burstBelow >= 2) {
      st.burstEnd = st.burstLastAbove;
      st.burstStart = null;
      st.burstBelow = 0;
    }
  }
  return st;
}

/** What the sidebar shows for a thread, or null. */
export function tierOf(st, now, kind = "stream") {
  if (st.lastOk === null || now - st.lastOk > STALE_MS) return null; // stale readings expire
  if (st.shown) return { tier: st.shown, rateUsdPerHour: st.lastRate15, hotForMin: Math.max(0, Math.floor((now - (st.shownSince ?? now)) / MIN)) };
  if (st.burstStart !== null) {
    const forMs = now - st.burstStart;
    if (kind === "stream" && forMs >= BUILDING_MS) return { tier: "building", rateUsdPerHour: st.lastRate15, hotForMin: Math.floor(forMs / MIN), burstUsd: st.burstUsd };
    return { tier: "burst", rateUsdPerHour: st.lastRate2, hotForMin: Math.floor(forMs / MIN), burstUsd: st.burstUsd };
  }
  if (st.burstEnd !== null && now - st.burstEnd < EMBER_FADE_MS) return { tier: "burst", recent: true, rateUsdPerHour: null, hotForMin: 0, burstUsd: st.burstUsd };
  return null;
}

// ---------------------------------------------------------------- calibration

const monotonic = (t) => ({ ...t, hot: Math.max(t.hot, t.warm), blazing: Math.max(t.blazing, t.hot, t.warm) });

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] * (1 - (k - lo)) + sorted[hi] * (k - lo);
}

export const CALIBRATION_LIMITS = Object.freeze({ maxRecords: 400_000, maxSamples: 600_000, stepMs: 30_000, days: 7 });

/**
 * Thresholds from T3's usage scan cache (usage-scan-cache-v5.json), with the SAME aggregation as
 * the live tells: per provider session (Claude subagent files folded into their parent), trailing
 * 2- and 15-minute $/h sampled every 30 s wherever the trailing window holds priced spend.
 * burst = p95 of 2-min, warm/hot/blazing = p90/p97/p99 of 15-min; never below the defaults.
 * usual[family] = the median 15-min rate of sessions mostly spent on that model family.
 */
export function calibrate(cache, table, overrides, now, limits = CALIBRATION_LIMITS) {
  const cut = now - limits.days * 86_400_000;
  const models = Array.isArray(cache?.models) ? cache.models : [];
  const files = cache?.files && typeof cache.files === "object" ? cache.files : {};
  const speeds = ["standard", "fast", "ultrafast"];
  const byThread = new Map();
  let records = 0;
  for (const [path, entry] of Object.entries(files)) {
    if (records >= limits.maxRecords) break;
    const provider = typeof entry?.p === "string" ? entry.p : "";
    const sessions = Array.isArray(cache.sessions) ? cache.sessions : [];
    for (const row of Array.isArray(entry?.r) ? entry.r : []) {
      if (!Array.isArray(row) || !(row[0] >= cut) || row[0] > now) continue;
      if (++records > limits.maxRecords) break;
      const model = models[row[1]] ?? "";
      const rateModel = Number.isInteger(row[11]) ? models[row[11]] : null;
      const totals = { uncached: tokenCount(row[3]), cached: tokenCount(row[4]), cacheCreation: tokenCount(row[5]), output: tokenCount(row[6]) };
      const { cost } = priceRecord(table, overrides, { model: rateModel ?? model, totals, reported: finite(row[9]), speed: speeds[row[10]] ?? "standard" });
      if (cost === null) continue;
      const sub = provider === "claude" && path.includes("/subagents/") ? path.slice(0, path.indexOf("/subagents/")).split("/").pop() : null;
      const key = `${provider}:${sub ?? sessions[row[2]] ?? path}`;
      if (!byThread.has(key)) byThread.set(key, []);
      byThread.get(key).push({ ts: row[0], cost, fam: family(model) });
    }
  }
  const s2 = [];
  const s15 = [];
  const famSamples = {};
  let samples = 0;
  for (const evs of byThread.values()) {
    evs.sort((a, b) => a.ts - b.ts);
    const famCost = {};
    for (const e of evs) famCost[e.fam] = (famCost[e.fam] ?? 0) + e.cost;
    const fam = Object.entries(famCost).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
    // Sliding windows over a 30-s grid from the first event to 15 min after the last.
    let i2 = 0;
    let i15 = 0;
    let j = 0;
    let c2 = 0;
    let c15 = 0;
    const start = Math.ceil(evs[0].ts / limits.stepMs) * limits.stepMs;
    for (let t = start; t <= evs.at(-1).ts + WINDOWS.w15 && samples < limits.maxSamples; t += limits.stepMs) {
      while (j < evs.length && evs[j].ts <= t) {
        c2 += evs[j].cost;
        c15 += evs[j].cost;
        j++;
      }
      while (i2 < j && evs[i2].ts <= t - WINDOWS.w2) c2 -= evs[i2++].cost;
      while (i15 < j && evs[i15].ts <= t - WINDOWS.w15) c15 -= evs[i15++].cost;
      if (c2 > 1e-12) s2.push(c2 * 30);
      if (c15 > 1e-12) {
        const r = c15 * 4;
        s15.push(r);
        (famSamples[fam] ??= []).push(r);
      }
      samples++;
    }
  }
  s2.sort((a, b) => a - b);
  s15.sort((a, b) => a - b);
  const pick = (arr, p, floor) => Math.max(floor, percentile(arr, p) ?? floor);
  const usual = {};
  for (const [f, arr] of Object.entries(famSamples)) {
    arr.sort((a, b) => a - b);
    if (arr.length >= 20) usual[f] = Math.round(percentile(arr, 0.5) * 100) / 100;
  }
  return {
    source: s15.length >= 50 ? "calibrated" : "default",
    referenceDays: limits.days,
    computedAt: now,
    population: "provider sessions (Claude subagents folded in), trailing 2-/15-min $/h every 30 s while spending",
    samples: { w2: s2.length, w15: s15.length, records: Math.min(records, limits.maxRecords) },
    // The percentiles before the floors, so it's visible when the floors are doing the work.
    raw: { burst: percentile(s2, 0.95), warm: percentile(s15, 0.9), hot: percentile(s15, 0.97), blazing: percentile(s15, 0.99) },
    thresholds: s15.length >= 50 && s2.length >= 50
      ? monotonic({ burst: pick(s2, 0.95, DEFAULT_THRESHOLDS.burst), warm: pick(s15, 0.9, DEFAULT_THRESHOLDS.warm), hot: pick(s15, 0.97, DEFAULT_THRESHOLDS.hot), blazing: pick(s15, 0.99, DEFAULT_THRESHOLDS.blazing) })
      : { ...DEFAULT_THRESHOLDS },
    usual,
  };
}
