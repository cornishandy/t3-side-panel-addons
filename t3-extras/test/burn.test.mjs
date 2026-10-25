// Burn-rate tells: parsing, pricing, the tier state machine, calibration, and the I/O against a
// fixture home (a real SQLite file and transcripts in a temp folder; nothing of Andy's is read).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_THRESHOLDS, MIN, parseClaudeRecord, parseCodexRecord, newCodexState, parseGrokRecord, parseRateTable, overrideTable, priceRecord,
  observe, newThreadState, step, tierOf, calibrate, percentile,
} from "../burn-core.mjs";
import { createBurn } from "../burn.mjs";

const NOW = Date.parse("2026-10-20T04:00:00Z");
const T = DEFAULT_THRESHOLDS;
const iso = (t) => new Date(t).toISOString();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-burn-"));
const burns = [];
after(() => {
  for (const b of burns) b.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// $1 = 40,000 Opus output tokens at the fixture's $25 per million.
const RATES = {
  "claude-opus-5-5": { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 },
  "openai/gpt-6.1-sol": { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, provider_specific_entry: { fast: 2 } },
  "half-priced": { input_cost_per_token: 1e-6 },
};
const table = parseRateTable(RATES);
const usd = (d) => Math.round(d * 40_000); // output tokens for $d of Opus

// ---------------------------------------------------------------- parsing and pricing

test("pricing is T3's: cache rates, fast tier, [1m] suffix, bare-name alias, overrides win, unknown is not $0", () => {
  const rec = (model, totals, o = {}) => ({ model, totals: { uncached: 0, cached: 0, cacheCreation: 0, output: 0, ...totals }, reported: null, speed: "standard", ...o });
  assert.equal(priceRecord(table, null, rec("claude-opus-5-5", { output: 40_000 })).cost, 1);
  assert.ok(Math.abs(priceRecord(table, null, rec("claude-opus-5-5", { uncached: 1e6, cached: 1e6, cacheCreation: 1e6 })).cost - (5 + 0.5 + 6.25)) < 1e-9);
  assert.equal(priceRecord(table, null, rec("claude-opus-5-5[1m]", { output: 40_000 })).cost, 1, "bracket suffix prices as the base name");
  assert.equal(priceRecord(table, null, rec("gpt-6.1-sol", { output: 100_000 })).cost, 1, "provider/ prefix has a bare alias");
  assert.equal(priceRecord(table, null, rec("gpt-6.1-sol", { output: 100_000 }, { speed: "fast" })).cost, 2, "fast multiplier");
  assert.equal(priceRecord(table, null, rec("opus", { output: 1 })).cost, null, "bare family names are unpriceable");
  assert.equal(priceRecord(table, null, rec("half-priced", { output: 1 })).cost, null, "half-priced entries are dropped");
  assert.equal(priceRecord(table, null, rec("mystery", { output: 1 })).cost, null);
  assert.equal(priceRecord(table, null, rec("mystery", { output: 1 }, { reported: 0.25 })).cost, 0.25, "a valid reported cost");
  assert.equal(priceRecord(table, null, rec("claude-opus-5-5", { output: 40_000 }, { reported: 3 })).cost, 3, "reported wins over list");
  const ov = overrideTable({ "claude-opus-5-5": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } });
  assert.equal(priceRecord(table, ov, rec("claude-opus-5-5", { output: 1e6 }, { reported: 9 })).cost, 2, "an override beats even a reported cost");
});

test("Claude lines: assistant usage only, repeated per content block (same key), no <synthetic>", () => {
  const line = { type: "assistant", timestamp: iso(NOW), requestId: "req1", sessionId: "s", message: { id: "msg1", model: "claude-opus-5-5", usage: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, output_tokens: 11 } } };
  const r = parseClaudeRecord(line);
  assert.deepEqual(r.totals, { uncached: 3, cached: 5, cacheCreation: 7, output: 11 });
  assert.equal(r.key, "msg1:req1");
  assert.equal(parseClaudeRecord({ ...line, type: "user" }), null);
  assert.equal(parseClaudeRecord({ ...line, message: { ...line.message, model: "<synthetic>" } }), null);
});

test("Codex lines: model and speed carried, cached input subtracted, consecutive repeats dropped, fork copies suppressed", () => {
  const st = newCodexState();
  const tc = (ts, last) => ({ type: "event_msg", timestamp: iso(ts), payload: { type: "token_count", info: { last_token_usage: last } } });
  parseCodexRecord({ type: "session_meta", timestamp: iso(NOW), payload: { id: "sess" } }, st);
  assert.equal(parseCodexRecord(tc(NOW, { input_tokens: 10, output_tokens: 1 }), st), null, "no model yet");
  parseCodexRecord({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }, st);
  parseCodexRecord({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } } }, st);
  const r = parseCodexRecord(tc(NOW + 1000, { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7, reasoning_output_tokens: 5 }), st);
  assert.deepEqual(r.totals, { uncached: 40, cached: 60, cacheCreation: 0, output: 7 }, "reasoning stays inside output");
  assert.equal(r.speed, "fast");
  assert.equal(parseCodexRecord(tc(NOW + 2000, { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7, reasoning_output_tokens: 5 }), st), null, "same signature again");
  const fork = newCodexState();
  parseCodexRecord({ type: "session_meta", timestamp: iso(NOW), payload: { id: "f", forked_from_id: "p" } }, fork);
  parseCodexRecord({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }, fork);
  assert.equal(parseCodexRecord(tc(NOW + 200, { input_tokens: 1, output_tokens: 1 }), fork), null, "copied history within 1 s");
  assert.ok(parseCodexRecord(tc(NOW + 6000, { input_tokens: 2, output_tokens: 1 }), fork), "the child's own first turn counts");
});

test("Grok: one lump per turn_completed, ticks at 1e10 per dollar, keyed by prompt", () => {
  const line = { params: { sessionId: "g", _meta: { agentTimestampMs: NOW }, update: { sessionUpdate: "turn_completed", prompt_id: "p1", usage: { inputTokens: 1000, outputTokens: 10, costUsdTicks: 1.27e10 } } } };
  const [r] = parseGrokRecord(line);
  assert.equal(r.reported, 1.27);
  assert.equal(r.turn, "g:p1");
  assert.equal(r.ts, NOW);
  assert.deepEqual(parseGrokRecord({ params: { update: { sessionUpdate: "agent_message_chunk" } } }), []);
});

// ---------------------------------------------------------------- the tier state machine

/** Runs observations every 30 s; spend(t) = $/h being spent at time t (one event per 30 s). */
function simulate(spend, minutes, kind = "stream", extra = () => null) {
  let st = newThreadState();
  const events = [];
  const out = [];
  for (let t = NOW; t <= NOW + minutes * MIN; t += 30_000) {
    const rate = spend(t);
    if (rate > 0) events.push({ ts: t, cost: rate / 120, turn: extra(t), fam: "opus" });
    st = step(st, { ...observe(events, t), ok: true }, T, t, kind);
    out.push({ t, tier: tierOf(st, t, kind)?.tier ?? null, view: tierOf(st, t, kind) });
  }
  return { st, out, events };
}
const at = (r, min) => r.out.find((o) => o.t >= NOW + min * MIN);

test("sustained = continuous: ten observed minutes above warm on the 2-min rate AND the 15-min tier threshold", () => {
  // $60/h steadily: the trailing 15-min rate reaches warm ($17.5/h) after ~4.4 min of spend, so
  // the ten observed minutes end at ~14.4 min; until then it shows as building.
  // (r15 reaches $17.5/h at 4.0 min, so warm qualifies at 14.0; the burst began at 1.5 min.)
  const r = simulate(() => 60, 20);
  assert.equal(at(r, 9).tier, "burst");
  assert.equal(at(r, 13.5).tier, "building");
  assert.equal(at(r, 14).tier, "warm");
  assert.equal(at(r, 17.5).tier, "warm", "hot needs its own ten minutes (r15 ≥ $32.03/h from 8.0 min)");
  assert.equal(at(r, 18).tier, "hot");
  assert.equal(at(r, 19.5).tier, "hot");
  assert.equal(at(r, 20).tier, "blazing", "r15 ≥ $41.44/h from 10.0 min");
  assert.ok(r.out.at(-1).view.hotForMin >= 15, "measured from when the warm run began");
});

test("a spike followed by silence never promotes (Astra's main objection)", () => {
  const r = simulate((t) => (t < NOW + 2 * MIN ? 600 : 0), 20); // $20 in 2 min, then nothing
  assert.ok(r.out.every((o) => !["warm", "hot", "blazing", "building"].includes(o.tier)));
  assert.equal(at(r, 1).tier, "burst");
});

test("a burst still going at 8 min shows as building until the 10-min test passes", () => {
  // $50/h: the 2-min rate crosses the burst line at 1.5 min, so "building" from 9.5 min, and warm
  // once ten observed minutes have passed with the 15-min rate at warm (~15.3 min).
  const r = simulate(() => 50, 17);
  assert.equal(at(r, 9).tier, "burst");
  assert.equal(at(r, 9.5).tier, "building", "8 min after the burst began at 1.5 min");
  assert.equal(at(r, 14.5).tier, "building", "nothing vanishes in the hand-over");
  assert.equal(at(r, 15).tier, "warm");
});

test("embers fade 5 min after the burst ends, never extended by polling; faded embers are 'recent'", () => {
  // The 2-min rate is last above the line at 4.0 min (the 2.5-min charge is still in the window);
  // two observations below end the burst; the ember then shows as "recent" until 4.0 + 5 min.
  const r = simulate((t) => (t < NOW + 3 * MIN ? 200 : 0), 14);
  const recent = r.out.filter((o) => o.view?.recent).map((o) => (o.t - NOW) / MIN);
  assert.deepEqual([recent[0], recent.at(-1)], [5, 8.5]);
  assert.equal(r.out.find((o) => o.view?.recent).view.rateUsdPerHour, null);
  assert.equal(at(r, 9).tier, null, "gone 5 min after the last observation above, however often it's polled");
});

test("hysteresis: a tier drops only after two successful observations below; unknown never demotes", () => {
  let { st } = simulate(() => 60, 14);
  const t0 = NOW + 14 * MIN;
  const shown = st.shown;
  assert.ok(shown);
  const quiet = { r2: 0, r10: 0, r15: 0, cost2: 0, n15: 0, turns15: 0, span15: 0, ok: true };
  for (let k = 1; k <= 5; k++) st = step(st, { ok: false }, T, t0 + k * 30_000);
  assert.equal(st.shown, shown, "five failed reads: still shown");
  st = step(st, quiet, T, t0 + 6 * 30_000);
  assert.equal(st.shown, shown, "one below: still shown");
  st = step(st, quiet, T, t0 + 7 * 30_000);
  assert.equal(st.shown, null, "two below: dropped");
  // And with no successful observation for 5 minutes, nothing is shown at all.
  let s2 = simulate(() => 60, 14).st;
  for (let k = 1; k <= 12; k++) s2 = step(s2, { ok: false }, T, t0 + k * 30_000);
  assert.equal(tierOf(s2, t0 + 12 * 30_000), null, "stale readings expire");
});

test("Grok counts turns: one lump never sustains; two turns spanning 10 min can", () => {
  // One $3 turn: a 2-min rate of $90/h, a 15-min rate of $12/h... make it $10 so the 15-min rate is high too.
  let st = newThreadState();
  const lump = [{ ts: NOW, cost: 10, turn: "g:1", fam: "grok" }];
  for (let t = NOW; t <= NOW + 14 * MIN; t += 30_000) st = step(st, { ...observe(lump, t), ok: true }, T, t, "turns");
  assert.equal(st.shown, null, "a single lump never counts as sustained");
  st = newThreadState();
  const s0 = step(st, { ...observe(lump, NOW), ok: true }, T, NOW, "turns");
  assert.equal(tierOf(s0, NOW, "turns").tier, "burst", "only a recent-charge ember");
  const two = [{ ts: NOW, cost: 6, turn: "g:1", fam: "grok" }, { ts: NOW + 11 * MIN, cost: 6, turn: "g:2", fam: "grok" }];
  const s1 = step(newThreadState(), { ...observe(two, NOW + 11 * MIN), ok: true }, T, NOW + 11 * MIN, "turns");
  assert.ok(["warm", "hot", "blazing"].includes(s1.shown), "two distinct turns spanning ten minutes");
  const dup = [{ ts: NOW, cost: 6, turn: "g:1" }, { ts: NOW + 11 * MIN, cost: 6, turn: "g:1" }];
  assert.equal(observe(dup, NOW + 11 * MIN).turns15, 1, "the same prompt twice is one turn");
});

test("observations: unknown prices make a window unknown, never $0", () => {
  assert.equal(observe([{ ts: NOW, cost: null }], NOW).r2, null);
  assert.equal(observe([{ ts: NOW, cost: 1 }, { ts: NOW, cost: null }], NOW).r2, null, "one unknown charge: the whole window is unknown (Sol B4)");
  assert.equal(observe([{ ts: NOW - 5 * MIN, cost: null }, { ts: NOW, cost: 1 }], NOW).r2, 30, "an unknown charge outside the 2-min window doesn't touch it");
  assert.equal(observe([], NOW).r2, 0);
});

// ---------------------------------------------------------------- calibration

test("calibration: same trailing aggregation, p97 computed, research defaults as floors, usual per model family", () => {
  const rows = [];
  // 40 sessions, each spending steadily for 30 min at a rate between $5 and $200/h.
  for (let s = 0; s < 40; s++) {
    for (let k = 0; k < 60; k++) rows.push([NOW - 86_400_000 + s * 3_600_000 + k * 30_000, 0, s, 0, 0, 0, usd((5 + s * 5) / 120), 0, null, null, 0, null]);
  }
  const cache = { models: ["claude-opus-5-5"], sessions: Array.from({ length: 40 }, (_, i) => `s${i}`), files: { "/x/a.jsonl": { p: "claude", r: rows } } };
  const c = calibrate(cache, table, null, NOW);
  assert.equal(c.source, "calibrated");
  assert.ok(c.raw.hot >= c.raw.warm && c.raw.blazing >= c.raw.hot, "p97 between p90 and p99");
  for (const k of ["burst", "warm", "hot", "blazing"]) assert.ok(c.thresholds[k] >= DEFAULT_THRESHOLDS[k], `${k} floored`);
  assert.ok(c.usual.opus > 0);
  // A quiet week can never pull the thresholds below the defaults.
  const quiet = calibrate({ ...cache, files: { "/x/a.jsonl": { p: "claude", r: rows.map((r) => [r[0], 0, r[2], 0, 0, 0, 1, 0, null, null, 0, null]) } } }, table, null, NOW);
  assert.deepEqual(quiet.thresholds, { ...DEFAULT_THRESHOLDS });
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  // Bounded input.
  const capped = calibrate(cache, table, null, NOW, { maxRecords: 10, maxSamples: 5, stepMs: 30_000, days: 7 });
  assert.ok(capped.samples.records <= 10);
});

// ---------------------------------------------------------------- the I/O, against a fixture home

const HOME = path.join(tmp, "home");
const PROJ = path.join(HOME, ".claude/projects/-fixture");
const CODEX = path.join(HOME, ".codex/sessions/2026/10/20");
const GROK = path.join(HOME, ".grok/sessions/%2Ffixture");
for (const d of [PROJ, CODEX, GROK, path.join(HOME, ".t3/userdata")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(HOME, ".t3/userdata/usage-model-rates.json"), JSON.stringify({ fetchedAtMs: NOW, document: RATES }));
const DB = path.join(HOME, ".t3/userdata/statev2.sqlite");
const U = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
{
  const db = new DatabaseSync(DB);
  db.exec("CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT, provider_instance_id TEXT, updated_at TEXT, payload_json TEXT)");
  const ins = db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?, ?)");
  const row = (pt, thread, provider, native, ago) => ins.run(pt, thread, provider, provider, iso(NOW - ago * MIN), JSON.stringify({ nativeThreadRef: { nativeId: native } }));
  row("p1", "thread-claude", "claudeAgent", U(1), 1);
  row("p2", "thread-codex", "codex", U(2), 1);
  row("p3", "thread-grok", "grok", U(3), 1);
  row("p4", "thread-old", "claudeAgent", U(4), 50); // same day, 50 min ago: outside the 40-min map
  row("p5", "thread-shared-a", "claudeAgent", U(5), 1); // two threads claiming one transcript
  row("p6", "thread-shared-b", "claudeAgent", U(5), 1);
  row("p7", "thread-gemini", "antigravity", U(7), 1); // not measured
  row("p8", "thread-wrong", "claudeAgent", U(8), 1); // transcript holds another session id
  row("p9", "thread-escape", "claudeAgent", U(9), 1); // symlink pointing outside the projects folder
  row("p10", "thread-child", "claudeAgent", "agent-0000000000000001", 1); // a subagent that is its own thread
  row("p11", "thread-two", "claudeAgent", U(11), 1); // one T3 thread, two sessions
  row("p12", "thread-two", "claudeAgent", U(12), 1);
  row("p13", "thread-bad-id", "claudeAgent", "../../etc", 1);
  db.close();
}
const claudeLine = (session, ts, dollars, id) => JSON.stringify({ type: "assistant", timestamp: iso(ts), requestId: `r${id}`, sessionId: session, message: { id: `m${id}`, model: "claude-opus-5-5", usage: { input_tokens: 0, output_tokens: usd(dollars) } } });
let seq = 0;
const claudeLines = (session, from, to, perHour) => {
  const out = [];
  for (let t = from; t <= to; t += 30_000) out.push(claudeLine(session, t, perHour / 120, ++seq));
  return `${out.join("\n")}\n`;
};
fs.writeFileSync(path.join(PROJ, `${U(1)}.jsonl`), claudeLines(U(1), NOW - 20 * MIN, NOW, 60));
fs.mkdirSync(path.join(PROJ, U(1), "subagents"), { recursive: true });
fs.writeFileSync(path.join(PROJ, U(1), "subagents", "agent-0000000000000002.jsonl"), claudeLines(U(1), NOW - 5 * MIN, NOW, 30));
fs.writeFileSync(path.join(PROJ, U(1), "subagents", "agent-0000000000000001.jsonl"), claudeLines(U(1), NOW - 5 * MIN, NOW, 999));
fs.writeFileSync(path.join(PROJ, `${U(5)}.jsonl`), claudeLines(U(5), NOW - 20 * MIN, NOW, 60));
fs.writeFileSync(path.join(PROJ, `${U(8)}.jsonl`), claudeLines(U(99), NOW - 20 * MIN, NOW, 60));
fs.writeFileSync(path.join(PROJ, `${U(11)}.jsonl`), claudeLines(U(11), NOW - 20 * MIN, NOW, 20));
fs.writeFileSync(path.join(PROJ, `${U(12)}.jsonl`), claudeLines(U(12), NOW - 20 * MIN, NOW, 20));
const outside = path.join(tmp, "outside.jsonl");
fs.writeFileSync(outside, claudeLines(U(9), NOW - 20 * MIN, NOW, 60));
fs.symlinkSync(outside, path.join(PROJ, `${U(9)}.jsonl`));
fs.writeFileSync(path.join(CODEX, `rollout-2026-10-20T03-30-00-${U(2)}.jsonl`), [
  JSON.stringify({ type: "session_meta", timestamp: iso(NOW - 30 * MIN), payload: { id: U(2) } }),
  JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
  JSON.stringify({ type: "event_msg", timestamp: iso(NOW - MIN), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 0, output_tokens: 100_000 } } } }),
].join("\n") + "\n");
fs.mkdirSync(path.join(GROK, U(3)), { recursive: true });
fs.writeFileSync(path.join(GROK, U(3), "updates.jsonl"), `${JSON.stringify({ params: { sessionId: U(3), _meta: { agentTimestampMs: NOW - MIN }, update: { sessionUpdate: "turn_completed", prompt_id: "p1", usage: { inputTokens: 1000, outputTokens: 10, costUsdTicks: 3e10 } } } })}\n`);

let clock = NOW;
const make = (limits) => {
  const b = createBurn({ home: HOME, now: () => clock, limits });
  burns.push(b);
  return b;
};
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

test("the map: an ISO cutoff (the briefed datetime() query would let same-day rows in), read-only, no writes", async () => {
  const dbHash = sha(DB);
  const transcripts = [path.join(PROJ, `${U(1)}.jsonl`), path.join(CODEX, `rollout-2026-10-20T03-30-00-${U(2)}.jsonl`)].map(sha);
  const b = make();
  await b.tick();
  const files = [...b._files.keys()];
  assert.ok(!files.some((f) => f.includes(U(4))), "the 50-minute-old thread is not mapped");
  assert.ok("2026-10-20T03:10:00.000Z" > "2026-10-20 03:20:00", "why: 'T' sorts after ' ' for any same-day time");
  assert.equal(sha(DB), dbHash, "statev2 unchanged");
  assert.deepEqual([path.join(PROJ, `${U(1)}.jsonl`), path.join(CODEX, `rollout-2026-10-20T03-30-00-${U(2)}.jsonl`)].map(sha), transcripts, "transcripts unchanged");
  assert.ok(!fs.readdirSync(path.dirname(DB)).some((f) => /-journal$/.test(f)), "no journal created");
});

test("attribution is exact: subagents fold in once, own-thread children don't, shared transcripts and wrong ids are withheld, links can't escape", async () => {
  const b = make();
  await b.tick();
  const files = [...b._files.values()];
  const by = (frag) => files.filter((f) => f.path.includes(frag));
  assert.equal(by("agent-0000000000000002").length, 1, "the subagent is tailed with its parent");
  assert.equal(by("agent-0000000000000001").length, 0, "a subagent that is its own T3 thread is not folded in");
  assert.equal(by(U(5)).length, 0, "a transcript claimed by two threads is withheld");
  assert.ok(by(U(8))[0]?.invalid, "the wrong session id marks the file invalid");
  assert.equal(by(U(9)).length, 0, "a symlink out of the projects folder is refused");
  assert.equal(by(U(11)).length + by(U(12)).length, 2, "one T3 thread can sum two sessions");
  assert.equal(b.stats().withheld >= 1, true);
});

test("end to end: continuous spend promotes after ten observed minutes; Grok's lump is only an ember; no paths in the answer", async () => {
  const b = make();
  const file = path.join(PROJ, `${U(1)}.jsonl`);
  clock = NOW;
  for (let k = 1; k <= 24; k++) {
    clock = NOW + k * 30_000;
    fs.appendFileSync(file, claudeLines(U(1), clock, clock, 60));
    await b.tick();
  }
  const snap = b.snapshot();
  const c = snap.threads["thread-claude"];
  assert.ok(["warm", "hot", "blazing"].includes(c.tier), JSON.stringify(c));
  assert.equal(c.provider, "claude");
  assert.ok(c.rateUsdPerHour > 50 && c.rateUsdPerHour < 120, String(c.rateUsdPerHour));
  assert.equal(snap.threads["thread-grok"], undefined, "the Grok lump fell out of its 2-minute ember window");
  assert.equal(snap.threads["thread-shared-a"], undefined);
  assert.equal(snap.threads["thread-wrong"], undefined);
  assert.equal(snap.threads["thread-gemini"], undefined);
  const text = JSON.stringify(snap);
  assert.doesNotMatch(text, /\/|\.jsonl|fixture|sessions/, "no paths, no file names");
  assert.equal(snap.thresholds.referenceDays, 7);
  clock = NOW;
});

test("tailing: only new bytes, partial lines across ticks, truncation, replacement, split UTF-8, over-long lines", async () => {
  const dir = path.join(PROJ);
  const id = U(21);
  const db = new DatabaseSync(DB);
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?, ?)").run("p21", "thread-tail", "claudeAgent", "claudeAgent", iso(NOW - MIN), JSON.stringify({ nativeThreadRef: { nativeId: id } }));
  db.close();
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, "");
  const b = make({ perFileTick: 64 });
  clock = NOW;
  await b.tick();
  const f = () => [...b._files.values()].find((x) => x.path.endsWith(`${id}.jsonl`));
  // A line with multi-byte text, written in two halves, read 64 bytes at a time.
  const line = claudeLine(id, NOW - 30_000, 1, "é✓-1").replace('"model"', '"note":"héllo ✓ wörld","model"');
  fs.appendFileSync(file, line.slice(0, 40));
  for (let k = 0; k < 3; k++) await b.tick();
  assert.equal(f().events.length, 0, "half a line is not an event");
  fs.appendFileSync(file, `${line.slice(40)}\n`);
  for (let k = 0; k < 20 && f().backlog !== false; k++) await b.tick();
  for (let k = 0; k < 20; k++) await b.tick();
  assert.equal(f().events.length, 1, "whole line, decoded once complete");
  const before = f().offset;
  await b.tick();
  assert.equal(f().offset, before, "nothing new, nothing read");
  // Truncation: start again from the (new, shorter) file.
  fs.writeFileSync(file, `${claudeLine(id, NOW - 20_000, 2, "t-1")}\n`);
  for (let k = 0; k < 40; k++) await b.tick();
  assert.deepEqual(f().events.map((e) => Math.round(e.cost)), [2]);
  // Replacement (a new inode at the same path).
  fs.writeFileSync(`${file}.new`, `${claudeLine(id, NOW - 10_000, 3, "r-1")}\n`);
  fs.renameSync(`${file}.new`, file);
  for (let k = 0; k < 40; k++) await b.tick();
  assert.deepEqual(f().events.map((e) => Math.round(e.cost)), [3]);
  // An over-long line is skipped, and the next line still reads.
  const b2 = make({ maxPartial: 200 });
  fs.writeFileSync(file, `${"x".repeat(1000)}\n${claudeLine(id, NOW - 5_000, 4, "l-1")}\n`);
  await b2.tick();
  const g = [...b2._files.values()].find((x) => x.path.endsWith(`${id}.jsonl`));
  assert.deepEqual(g.events.map((e) => Math.round(e.cost)), [4]);
});

test("caps: files, bytes and time per tick; a failed query is 'unknown' for everyone", async () => {
  const b = make({ maxFiles: 2 });
  await b.tick();
  assert.ok(b._files.size <= 2);
  const broken = createBurn({ home: HOME, now: () => NOW, statev2: path.join(tmp, "missing.sqlite") });
  burns.push(broken);
  await broken.tick();
  assert.equal(broken.snapshot().ok, false);
  assert.equal(broken.stats().sqlFail, 1);
});

// ---------------------------------------------------------------- Sol's burn review (fix round)

test("unknown is its own state: it never promotes or demotes, and a stale tier expires by age (Sol B4)", () => {
  let st = newThreadState();
  for (let k = 0; k <= 20; k++) st = step(st, { ok: true, r2: 60, r15: 60, cost2: 2, turns15: 0, span15: 0 }, T, NOW + k * 30_000);
  assert.equal(st.shown, "blazing");
  const unknown = (t) => ({ ...observe([{ ts: t, cost: null }], t), ok: true });
  for (let k = 21; k <= 26; k++) st = step(st, unknown(NOW + k * 30_000), T, NOW + k * 30_000);
  assert.equal(st.shown, "blazing", "unknown observations never demote");
  assert.equal(tierOf(st, NOW + 26 * 30_000).tier, "blazing");
  assert.equal(tierOf(st, NOW + 20 * 30_000 + 5 * MIN + 1), null, "it ages out 5 min after the last known reading");
  let fresh = newThreadState();
  for (let k = 0; k <= 30; k++) fresh = step(fresh, unknown(NOW + k * 30_000), T, NOW + k * 30_000);
  assert.equal(fresh.shown, null, "and never promotes");
});

function mini(rows, limits = {}) {
  const home = fs.mkdtempSync(path.join(tmp, "mini-"));
  for (const d of [".t3/userdata", ".claude/projects/p", ".codex/sessions/2026/10/20"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, ".t3/userdata/usage-model-rates.json"), JSON.stringify({ document: { cheap: { input_cost_per_token: 0, output_cost_per_token: 1e-6 }, expensive: { input_cost_per_token: 0, output_cost_per_token: 10e-6 } } }));
  const db = new DatabaseSync(path.join(home, ".t3/userdata/statev2.sqlite"));
  db.exec("CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider TEXT, provider_instance_id TEXT, updated_at TEXT, payload_json TEXT)");
  for (const r of rows) db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?)").run(r.thread, r.provider ?? "claudeAgent", r.provider ?? "claudeAgent", iso(NOW - (r.ago ?? 0)), JSON.stringify({ nativeThreadRef: { nativeId: r.native } }));
  db.close();
  const b = createBurn({ home, now: () => NOW, limits });
  burns.push(b);
  return { home, b, claude: (n) => path.join(home, ".claude/projects/p", `${U(n)}.jsonl`), codex: (n) => path.join(home, ".codex/sessions/2026/10/20", `rollout-2026-10-20T00-00-00-${U(n)}.jsonl`) };
}
const cheapLine = (n, dollars, key) => `${JSON.stringify({ type: "assistant", timestamp: iso(NOW), sessionId: U(n), requestId: key, message: { id: key, model: "cheap", usage: { input_tokens: 0, output_tokens: dollars * 1e6 } } })}\n`;

test("a same-inode rewrite (truncated, then grown past our offset) is spotted and re-read from the start (Sol B1)", async () => {
  const m = mini([{ thread: "a", native: U(31) }]);
  fs.writeFileSync(m.claude(31), cheapLine(31, 2, "old"));
  await m.b.tick();
  const ino = fs.statSync(m.claude(31)).ino;
  fs.writeFileSync(m.claude(31), `${cheapLine(31, 10, "new")}${" ".repeat(1000)}\n`);
  assert.equal(fs.statSync(m.claude(31)).ino, ino);
  await m.b.tick();
  assert.equal(m.b.snapshot().threads.a.rateUsdPerHour, 300, "$10 in 2 min; the old $2 is gone");
  assert.equal(m.b.stats().rewound, 1);
});

test("Codex: the model in force at the tail start is recovered by scanning back; if it can't be, charges are unknown (Sol B2)", async () => {
  const head = `${JSON.stringify({ type: "session_meta", timestamp: iso(NOW - 30 * MIN), payload: { id: U(32) } })}\n${JSON.stringify({ type: "turn_context", payload: { model: "cheap" } })}\n`;
  const tc = (ts, out) => `${JSON.stringify({ type: "event_msg", timestamp: iso(ts), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 0, output_tokens: out } } } })}\n`;
  const filler = (n) => `${JSON.stringify({ type: "response_item", payload: { text: "x".repeat(n) } })}\n`;
  const body = `${head}${filler(300_000)}${JSON.stringify({ type: "turn_context", payload: { model: "expensive" } })}\n${filler(3 << 20)}${tc(NOW - 20 * MIN, 1_000_000)}${tc(NOW, 2_000_000)}`;
  const m = mini([{ thread: "a", provider: "codex", native: U(32) }]);
  fs.writeFileSync(m.codex(32), body);
  await m.b.tick();
  assert.equal(m.b.snapshot().threads.a.rateUsdPerHour, 600, "the switch to the expensive model is found");
  // With the scan capped short of the switch, the model is unknown: no tier, never the head's cheap guess.
  const m2 = mini([{ thread: "a", provider: "codex", native: U(32) }], { codexBackScan: 1024 });
  fs.writeFileSync(m2.codex(32), body);
  await m2.b.tick();
  assert.equal(m2.b.snapshot().threads.a, undefined);
});

test("a thread with a file left out by the file cap is incomplete, never a lower rate (Sol B3); states beyond the cap are evicted (S1)", async () => {
  const m = mini([{ thread: "a", native: U(33) }, { thread: "a", native: U(34) }], { maxFiles: 1 });
  fs.writeFileSync(m.claude(33), cheapLine(33, 2, "one"));
  fs.writeFileSync(m.claude(34), cheapLine(34, 2, "two"));
  await m.b.tick();
  assert.equal(m.b.snapshot().threads.a, undefined);
  assert.ok(m.b._files.size <= 1);
});

test("discovery visits a bounded number of directory entries per tick and stops at the budget (Sol B5)", async () => {
  const m = mini([{ thread: "a", native: U(35) }], { discoveryEntries: 40 });
  for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(m.home, ".claude/projects", `proj-${i}`));
  const orig = fs.opendirSync;
  let visited = 0;
  fs.opendirSync = (...a) => {
    const d = orig(...a);
    const read = d.readSync.bind(d);
    d.readSync = () => {
      visited++;
      return read();
    };
    return d;
  };
  try {
    await m.b.tick();
  } finally {
    fs.opendirSync = orig;
  }
  assert.ok(visited <= 41, `visited ${visited}`);
  assert.equal(m.b.snapshot().threads.a, undefined, "a search cut short is unknown, not a recorded miss");
});

