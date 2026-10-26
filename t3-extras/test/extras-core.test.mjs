// The pure part of public/extras.js, run in a VM (no browser needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../public/extras.js", import.meta.url), "utf8");
const sandbox = { window: { __T3X_TEST__: {} } };
vm.runInNewContext(src, sandbox);
const C = sandbox.window.__T3X_TEST__.core;
const plain = (v) => JSON.parse(JSON.stringify(v)); // values from the VM have its own prototypes
const fonts = JSON.parse(fs.readFileSync(new URL("../fonts.json", import.meta.url), "utf8")).families;

const NOW = Date.parse("2026-10-20T02:00:00Z");
const MIN = 60e3;
const H = 3600e3;
const DAY = 86400e3;

test("the file stops before touching the DOM when loaded for tests", () => {
  assert.equal(typeof C.labView, "function");
});

test("routes: only #/<environment>/<thread> is a thread; drafts and pages are not", () => {
  const env = "11111111-2222-4333-8444-555555555555";
  const th = "a06b79b7-0000-4000-8000-0000000000aa";
  assert.deepEqual(plain(C.parseRoute(`#/${env}/${th}`)), { kind: "thread", environmentId: env, threadId: th });
  assert.equal(C.parseRoute(`#/${env}/${encodeURIComponent("mcp:" + th)}`).threadId, "mcp:" + th);
  assert.equal(C.parseRoute(`#/${env}/${th}?x=1#frag`).threadId, th);
  assert.equal(C.parseRoute("#/draft/abc123456").kind, "draft");
  for (const h of ["#/settings/general", "#/projects/abcdef12", "#/pull-requests", "#/", "", "#/usage/abcdefgh", "#/a/b/c"]) {
    assert.notEqual(C.parseRoute(h).kind, "thread", h);
  }
  assert.equal(C.parseRoute("#/%E0%A4%A/x").kind, "unknown");
});

// ---------------------------------------------------------------- settings and fonts

test("settings: defaults, bad values ignored, unknown keys dropped", () => {
  const d = C.readSettings(null);
  assert.deepEqual(plain(d.fontHead), { family: "off", size: null });
  assert.equal(d.printOnly, true);
  assert.equal(d.showPartly, false);
  assert.equal(d.marker, "bar");
  assert.equal(d.fontTargets.headings, true);
  const s = C.readSettings(JSON.stringify({ usageHeader: false, marker: "neon", fontHead: { family: "Neucha", size: 125 }, fontBody: { family: "<script>", size: 133 }, fontTargets: { composer: false, bogus: 1 }, extra: 1 }));
  assert.equal(s.usageHeader, false);
  assert.equal(s.marker, "bar");
  assert.deepEqual(plain(s.fontHead), { family: "Neucha", size: 125 });
  assert.deepEqual(plain(s.fontBody), { family: "off", size: null }, "bad family and an off-step size are dropped");
  assert.equal(s.fontTargets.composer, false);
  assert.equal("extra" in s, false);
  assert.equal(C.readSettings("{not json").fontHead.family, "off");
  for (const bad of [79, 155, 101, "120"]) assert.equal(C.readSettings(JSON.stringify({ fontHead: { family: "Neucha", size: bad } })).fontHead.size, null);
});

test("round 1's 3A-3D presets migrate to heading + body families, targets kept", () => {
  const m = (font) => {
    const s = C.readSettings(JSON.stringify({ font, fontTargets: { quotes: false } }));
    return [s.fontHead.family, s.fontBody.family, s.fontTargets.quotes];
  };
  assert.deepEqual(m("3A"), ["Caveat", "Kalam", false]);
  assert.deepEqual(m("3B"), ["Noteworthy", "Bradley Hand", false]);
  assert.deepEqual(m("3C"), ["Architects Daughter", "Patrick Hand", false]);
  assert.deepEqual(m("3D"), ["SignPainter", "Chalkboard SE", false]);
  assert.deepEqual(m("off"), ["off", "off", false]);
  // Once the new keys exist, the old one is ignored.
  assert.equal(C.readSettings(JSON.stringify({ font: "3A", fontHead: { family: "Neucha" } })).fontBody.family, "off");
  for (const [h, b] of Object.values(plain(C.LEGACY_PRESETS))) {
    assert.ok(fonts.some((f) => f.name === h) && fonts.some((f) => f.name === b), `${h}/${b} are in fonts.json`);
  }
});

const names = (groups) => groups.flatMap((g) => g.options.map((o) => o.name));
test("interface fonts: every area opts in independently; old settings never enable them", () => {
  const areas = plain(C.INTERFACE_TARGETS).map(([key]) => key);
  assert.equal(areas.length, 16);
  assert.equal(new Set(areas).size, areas.length);
  for (const raw of [null, '{"font":"3A"}', '{"fontMain":{"family":"Kalam"}}']) {
    const s = C.readSettings(raw);
    assert.equal(s.interfaceFontsOpen, false);
    for (const key of areas) {
      assert.equal(s.fontTargets[key], false, key);
      assert.equal(C.rootAttrs(s)[`data-t3x-ft-${key}`], null, key);
    }
  }
  for (const key of areas) {
    const s = C.readSettings(JSON.stringify({ interfaceFontsOpen: true, fontTargets: { [key]: true } }));
    assert.equal(s.interfaceFontsOpen, true);
    assert.equal(s.fontMain.family, "off", "selections can be saved while the font is off");
    for (const other of areas) assert.equal(s.fontTargets[other], key === other);
    const again = C.readSettings(JSON.stringify(s));
    assert.equal(again.fontTargets[key], true);
    assert.equal(C.rootAttrs(again)[`data-t3x-ft-${key}`], "");
  }
  const bad = C.readSettings('{"interfaceFontsOpen":"yes","fontTargets":{"settinglabels":"true","bogus":true}}');
  assert.equal(bad.interfaceFontsOpen, false);
  assert.equal(bad.fontTargets.settinglabels, false);
  assert.equal("bogus" in bad.fontTargets, false);
});
test("main text font: its own pick, off by default, two targets on by default, kept through presets", () => {
  const d = C.readSettings(null);
  assert.deepEqual(plain(d.fontMain), { family: "off", size: null });
  assert.equal(d.fontTargets.replies, true);
  assert.equal(d.fontTargets.mine, true);
  const s = C.readSettings(JSON.stringify({ fontMain: { family: "Neucha", size: 115 }, fontTargets: { mine: false } }));
  assert.deepEqual(plain(s.fontMain), { family: "Neucha", size: 115 });
  assert.deepEqual(plain(s.fontHead), { family: "off", size: null }, "picking the main text font alone leaves the others off");
  assert.equal(s.fontTargets.mine, false);
  assert.equal(s.fontTargets.replies, true);
  assert.equal(C.readSettings(JSON.stringify({ fontMain: { family: "<b>", size: 115 } })).fontMain.family, "off");
  assert.equal(C.readSettings(JSON.stringify({ font: "3A", fontMain: { family: "Kalam" } })).fontHead.family, "Caveat", "an old preset still migrates beside a main text pick");
  assert.equal(C.readSettings(JSON.stringify({ font: "3A" })).fontMain.family, "off", "old presets never set the main text font");
  const a = C.rootAttrs(s);
  assert.equal(a["data-t3x-ft-replies"], "");
  assert.equal(a["data-t3x-ft-mine"], null);
});

test("Print only (default) hides partly joined and joined; the chips reveal them as specified", () => {
  const base = C.readSettings(null);
  const printOnly = names(C.fontOptions(fonts, base, "off"));
  assert.equal(printOnly.length, 51 - 13 - 2);
  assert.ok(!printOnly.includes("Caveat") && !printOnly.includes("SignPainter"));
  const partly = names(C.fontOptions(fonts, { ...base, showPartly: true }, "off"));
  assert.equal(partly.length, 51 - 2);
  assert.ok(partly.includes("Caveat") && !partly.includes("Over the Rainbow"));
  const all = names(C.fontOptions(fonts, { ...base, printOnly: false, showPartly: false }, "off"));
  assert.equal(all.length, 51, "joined fonts appear when both chips are off");
  // A migrated joined choice stays listed, labelled, never silently replaced.
  const kept = C.fontOptions(fonts, base, "SignPainter").flatMap((g) => g.options).find((o) => o.name === "SignPainter");
  assert.ok(kept.hidden);
  assert.match(kept.label, /\bcursive\b/);
  assert.doesNotMatch(kept.label, /joined/);
  assert.match(kept.label, /hidden by the filter/);
});

test("pickers: two groups, narrowest first, tags from the measurements", () => {
  const groups = plain(C.fontOptions(fonts, C.readSettings(null), "off", () => true));
  assert.deepEqual(groups.map((g) => g.label), ["Handwritten", "Condensed print"]);
  const hand = groups[0].options;
  assert.equal(hand[0].name, "Just Another Hand", "the narrowest hand first");
  const widths = hand.map((o) => fonts.find((f) => f.name === o.name).width);
  for (let i = 1; i < widths.length; i++) assert.ok(Math.round(widths[i] / 10) >= Math.round(widths[i - 1] / 10), "sorted by width");
  assert.match(hand[0].label, /★ · narrow, tall/);
  assert.ok(groups[1].options.every((o) => fonts.find((f) => f.name === o.name).group === "cond"));
  const mac = C.fontOptions(fonts, C.readSettings(null), "off", () => false).flatMap((g) => g.options).find((o) => o.name === "Noteworthy");
  assert.match(mac.label, /not on this Mac/);
});

// ---------------------------------------------------------------- T3's pace maths

const win = (o) => ({ id: "w", kind: "weekly", usedPct: 40, resetsAt: NOW + 4 * DAY, lengthSec: 7 * 86400, fetchedAt: NOW - MIN, ...o });

test("pace: T3's exact maths (remaining rounded, even pace, ±5 points; exactly 5 is on pace)", () => {
  // 3 of 7 days gone: elapsed 3/7 = 42.857%.
  const p = C.paceOf(win({ usedPct: 37.6 }), NOW);
  assert.equal(p.left, 62);
  assert.equal(p.timeLeft, 57);
  assert.ok(Math.abs(p.elapsed - 3 / 7) < 1e-12);
  assert.equal(p.pace, "under");
  const at = (used) => C.paceOf(win({ usedPct: used }), NOW).pace;
  const e = (3 / 7) * 100;
  assert.equal(at(e + 5), "on", "exactly +5 is on pace");
  assert.equal(at(e + 5.0001), "ahead");
  assert.equal(at(e - 5), "on");
  assert.equal(at(e - 5.0001), "under");
  // No reset or no length: no pace line, as in T3.
  assert.equal(C.paceOf(win({ resetsAt: null }), NOW).timeLeft, null);
  assert.equal(C.paceOf(win({ lengthSec: null, kind: "other" }), NOW).pace, null);
  assert.equal(C.paceOf(win({ usedPct: 104 }), NOW).left, 0);
  assert.equal(C.paceOf(win({ usedPct: null }), NOW), null);
});

test("window bounds: no valid length means no pace, except Grok's disclosed 7-day / calendar-month guess", () => {
  const grok = C.windowBounds({ kind: "weekly", resetsAt: NOW + DAY, lengthSec: null, assumeLength: true });
  assert.equal(grok.end - grok.start, 7 * DAY);
  assert.equal(grok.assumed, "week");
  for (const lengthSec of [null, undefined, 0, -60]) {
    assert.equal(C.windowBounds({ kind: "weekly", resetsAt: NOW + DAY, lengthSec }), null, `no guess without Grok's flag (${lengthSec})`);
  }
  for (const lengthSec of [0, -60]) assert.equal(C.windowBounds({ kind: "weekly", resetsAt: NOW + DAY, lengthSec, assumeLength: true }), null, "an invalid length is never replaced");
  const mar31 = Date.parse("2027-03-31T12:00:00Z");
  const m = C.windowBounds({ kind: "monthly", resetsAt: mar31, assumeLength: true });
  assert.equal(new Date(m.start).toISOString(), "2027-02-28T12:00:00.000Z", "Feb has no 31st");
  assert.equal(m.assumed, "month");
  const nov15 = C.windowBounds({ kind: "monthly", resetsAt: Date.parse("2026-11-15T00:00:00Z"), assumeLength: true });
  assert.equal(new Date(nov15.start).toISOString(), "2026-10-15T00:00:00.000Z");
  assert.notEqual(nov15.end - nov15.start, 30 * DAY, "never an assumed 30 days");
  assert.equal(C.windowBounds({ kind: "other", resetsAt: NOW }), null);
});

// ---------------------------------------------------------------- T3's cache, fail closed

const ENV = "0f0e0d0c-0b0a-4908-8706-050403020100";
const iso = (t) => new Date(t).toISOString();
const checked = iso(NOW - 2 * MIN);
function t3Record(over = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    environmentId: ENV,
    config: {
      secretSetting: "should never be read",
      providers: [
        { instanceId: "codex", driver: "codex", enabled: true, status: "ready", credentialFingerprint: "fp-SECRET", auth: { email: "andy@example.com" },
          usageLimits: { checkedAt: checked, credentialFingerprint: "fp-SECRET2", windows: [{ id: "primary", kind: "weekly", label: "Weekly", usedPercent: 51, resetsAt: iso(NOW + 4 * DAY), windowDurationMins: 10080 }], resetCredits: { availableCount: 3, nextExpiresAt: iso(NOW + 2 * DAY), nextCreditId: "cred-SECRET" } } },
        { instanceId: "codex_openai_api", driver: "codex", enabled: true, usageLimits: { checkedAt: checked, unavailable: { reason: "unsupported" }, windows: [] } },
        { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, usageLimits: { checkedAt: checked, windows: [
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 32, resetsAt: iso(NOW + 4 * H), windowDurationMins: 300 },
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 37, resetsAt: iso(NOW + 5.8 * DAY), windowDurationMins: 10080 },
          { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 15, resetsAt: iso(NOW + 5.8 * DAY), windowDurationMins: 10080 },
        ] } },
        { instanceId: "grok", driver: "grok", enabled: true, usageLimits: { checkedAt: checked, windows: [{ id: "subscription", kind: "weekly", label: "Weekly", usedPercent: 73, resetsAt: iso(NOW + 4.9 * DAY) }] } },
        { instanceId: "antigravity", driver: "antigravity", enabled: true, usageLimits: { checkedAt: checked, windows: [
          { id: "3p-5h", kind: "session", label: "Claude & GPT (shared) · 5-hour", usedPercent: 0, resetsAt: iso(NOW + 5 * H), windowDurationMins: 300 },
          { id: "gemini-5h", kind: "session", label: "Gemini · 5-hour", usedPercent: 14.29409, resetsAt: iso(NOW + 0.6 * H), windowDurationMins: 300 },
          { id: "3p-weekly", kind: "weekly", label: "Claude & GPT (shared) · Weekly", usedPercent: 0, resetsAt: iso(NOW + 7 * DAY), windowDurationMins: 10080 },
          { id: "gemini-weekly", kind: "weekly", label: "Gemini · Weekly", usedPercent: 53.561273, resetsAt: iso(NOW + 4.9 * DAY), windowDurationMins: 10080 },
        ] } },
        { instanceId: "opencode", driver: "opencode", enabled: true, usageLimits: { checkedAt: checked, unavailable: { reason: "unsupported" }, windows: [] } },
        { instanceId: "cursor", driver: "cursor", enabled: false, usageLimits: null },
      ],
    },
    ...over,
  });
}

test("T3's record: only numbers, labels, times and status survive; nothing else is kept", () => {
  const p = C.projectT3Config(t3Record(), ENV);
  assert.equal(p.state, "ok");
  const text = JSON.stringify(p);
  for (const secret of ["SECRET", "andy@example.com", "secretSetting", "credentialFingerprint", "nextCreditId"]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(Object.keys(p.providers[0]).sort(), ["canonical", "enabled", "lab", "limits"]);
});

test("T3's record keeps no provider or window ids of its own: known buckets get our fixed names, the rest are dropped", () => {
  const sentinel = "acct-private@example.test";
  const p = C.projectT3Config({ schemaVersion: 1, environmentId: ENV, config: { providers: [
    { instanceId: sentinel, driver: "codex", usageLimits: { checkedAt: checked, windows: [{ id: sentinel, label: sentinel, kind: "weekly", usedPercent: 20 }, { id: "primary", label: sentinel, kind: "weekly", usedPercent: 30, resetsAt: iso(NOW + DAY), windowDurationMins: 10080 }] } },
    { instanceId: "x", driver: sentinel, usageLimits: { checkedAt: checked, windows: [] } },
  ] } }, ENV);
  assert.ok(!JSON.stringify(p).includes(sentinel));
  assert.equal(p.providers.length, 1, "unknown drivers dropped");
  assert.equal(p.providers[0].canonical, false);
  assert.deepEqual(plain(p.providers[0].limits.windows.map((w) => [w.id, w.label])), [["primary", "Weekly"]]);
});

test("T3's record fails closed: another schema, another environment, bad JSON, wrong shape", () => {
  assert.equal(C.projectT3Config(t3Record({ schemaVersion: 2 }), ENV).state, "schema");
  assert.equal(C.projectT3Config(t3Record(), "another-env").state, "schema");
  assert.equal(C.projectT3Config("{nope", ENV).state, "schema");
  assert.equal(C.projectT3Config(JSON.stringify({ schemaVersion: 1, environmentId: ENV, config: {} }), ENV).state, "schema");
  assert.equal(C.projectT3Config(undefined, ENV).state, "missing");
  assert.equal(C.projectT3Config(JSON.parse(t3Record()), ENV).state, "ok", "a stored object works too");
  assert.equal(C.projectT3Config(t3Record(), null).state, "schema");
});

const t3labs = () => C.labsFromT3(C.projectT3Config(t3Record(), ENV), NOW);

test("labs from T3: Claude, Codex (not its paid API instance), Gemini with shared windows as extras, Grok", () => {
  const L = t3labs();
  const roles = (id) => L[id].windows.map((w) => [w.id, w.role]);
  assert.deepEqual(plain(roles("claude")), [["five_hour", "short"], ["seven_day", "long"], ["seven_day_fable", "extra"]]);
  assert.deepEqual(plain(roles("codex")), [["primary", "long"]], "no made-up 5-hour row");
  assert.equal(L.codex.canonical, true, "the codex instance, not codex_openai_api");
  assert.equal(L.codex.resetCredits.availableCount, 3);
  assert.deepEqual(plain(roles("gemini")), [["3p-5h", "extra"], ["gemini-5h", "short"], ["3p-weekly", "extra"], ["gemini-weekly", "long"]]);
  assert.equal(L.gemini.windows[0].group, "Claude/GPT via Antigravity");
  assert.deepEqual(plain(roles("grok")), [["subscription", "long"]]);
  assert.equal(L.opencode.hasMeter, false);
  assert.equal(L.cursor.enabled, false);
  assert.equal(L.claude.live, true);
  const old = C.labsFromT3(C.projectT3Config(t3Record(), ENV), NOW + 20 * MIN);
  assert.equal(old.claude.live, false, "older than 15 min by checkedAt = stale");
});

const serverLabs = [
  { id: "claude", name: "Claude", colour: "#d97757", source: "lab-usage", live: true, fetchedAt: NOW - 3 * MIN, verdict: { tier: "T0", tierName: "T0 normal" }, windows: [
    { id: "c5h", role: "short", kind: "session", usedPct: 30, resetsAt: NOW + 4 * H, lengthSec: 18000, fetchedAt: NOW - 3 * MIN, live: true, projection: 80, projectionAt: NOW - MIN, projectionUsed: 30 },
    { id: "cwk", role: "long", kind: "weekly", usedPct: 36, resetsAt: NOW + 5.8 * DAY, lengthSec: 604800, fetchedAt: NOW - 3 * MIN, live: true, projection: 210, projectionAt: NOW - MIN, projectionUsed: 36 },
  ] },
  { id: "codex", name: "Codex", colour: "#2fa37a", source: "lab-usage", live: true, fetchedAt: NOW - MIN, verdict: { gate: { action: "GO", reason: "x" } }, windows: [
    { id: "xwk", role: "long", kind: "weekly", usedPct: 50, resetsAt: NOW + 4 * DAY, lengthSec: 604800, fetchedAt: NOW - MIN, live: true, projection: 116.7, projectionAt: NOW - MIN, projectionUsed: 50 },
  ] },
];

test("merge: T3's numbers in the bars, lab-usage's projection and verdict beside them; every lab listed once", () => {
  const m = C.mergeLabs(t3labs(), serverLabs);
  assert.deepEqual(plain(m.map((l) => l.id)), ["claude", "codex", "gemini", "grok", "opencode", "cursor", "pi", "muse"]);
  const claude = m[0];
  assert.equal(claude.source, "t3");
  assert.equal(claude.windows.find((w) => w.role === "long").usedPct, 37, "T3's number, not lab-usage's 36");
  assert.equal(claude.windows.find((w) => w.role === "long").projection, 210);
  assert.equal(claude.verdict.tier, "T0");
  assert.equal(m[4].hasMeter, false);
  assert.equal(m[4].noMeter, "T3 has no meter for it");
  assert.equal(m[5].noMeter, "turned off in T3");
  assert.equal(m[6].noMeter, "no meter yet");
  // T3's cache unavailable: Claude and Codex fall back to lab-usage; the rest have no meter.
  const fb = C.mergeLabs(null, serverLabs);
  assert.equal(fb[0].source, "lab-usage");
  assert.equal(fb[0].windows.find((w) => w.role === "long").usedPct, 36);
  assert.equal(fb[2].hasMeter, false);
});

const view = (id, now = NOW, labs = C.mergeLabs(t3labs(), serverLabs)) => C.labView(labs.find((l) => l.id === id), now, {});

function grokReading(limits = { checkedAt: checked, windows: [] }, enabled = true, now = NOW) {
  const record = JSON.parse(t3Record());
  const p = record.config.providers.find((p) => p.driver === "grok");
  p.usageLimits = limits;
  p.enabled = enabled;
  return C.views(C.mergeLabs(C.labsFromT3(C.projectT3Config(record, ENV), now), serverLabs), now, {});
}

test("Grok with no percentage stays visible, unknown and separate from measured zero", () => {
  const vs = grokReading();
  const g = vs.find((v) => v.id === "grok");
  assert.deepEqual(plain(C.visibleLabs(vs).map((v) => v.id)), ["claude", "codex", "gemini", "grok"]);
  assert.equal(g.hasData, false);
  assert.equal(g.minLeft, null);
  assert.equal(g.windows.length, 0);
  assert.equal(g.stale, false);
  assert.equal(C.compactLabel(g, NOW), "— · unavailable");
  assert.match(C.bTooltip(g, NOW), /Grok did not report a usage percentage/);
  assert.match(C.bTooltip(g, NOW), /Last checked 2 min ago/);
  assert.equal(C.forecast(g, NOW).state, "unavailable");
  assert.notEqual(C.mostConstrained(vs).id, "grok", "missing usage never looks like a tightest limit");
  const summary = C.composerSummary(vs, NOW);
  assert.match(summary.main, / · Grok —$/);
  assert.equal(summary.view.id, C.mostConstrained(vs).id, "the real tightest limit stays primary");
  assert.equal(summary.unknown[0].id, "grok");

  const measured = grokReading({ checkedAt: checked, windows: [{ id: "subscription", kind: "weekly", usedPercent: 0 }] }).find((v) => v.id === "grok");
  assert.equal(measured.hasData, true);
  assert.equal(measured.lp.left, 100);
  assert.equal(C.compactLabel(measured, NOW), "100% left", "an explicit zero is a real reading");
});

test("missing Grok readings keep failure and staleness visible; disabled providers stay hidden", () => {
  const stale = grokReading(undefined, true, NOW + 16 * MIN).find((v) => v.id === "grok");
  assert.equal(stale.stale, true);
  assert.match(C.bTooltip(stale, NOW + 16 * MIN), /\(stale\)/);
  const failed = grokReading({ checkedAt: checked, windows: [], unavailable: { reason: "probeFailed" } }).find((v) => v.id === "grok");
  assert.equal(failed.noMeter, "T3 couldn't read it");
  assert.match(C.bTooltip(failed, NOW), /T3 couldn't read it/);
  assert.ok(!C.visibleLabs(grokReading(undefined, false)).some((v) => v.id === "grok"));
  assert.ok(!C.visibleLabs(C.views(C.mergeLabs({}, []), NOW, {})).length, "unconfigured providers aren't invented");
  assert.equal(C.composerSummary([], NOW), null);
});

test("the composer can show Grok unavailable even when no numeric meters exist", () => {
  const only = grokReading().filter((v) => v.id === "grok");
  const summary = C.composerSummary(only, NOW);
  assert.equal(summary.main, "Grok —");
  assert.equal(summary.refill, null);
  assert.equal(summary.view.hasData, false);
  assert.equal(summary.unknown.length, 1);
});

test("lab views: stale by source, the composer's lab counts short windows too", () => {
  const vs = C.views(C.mergeLabs(t3labs(), serverLabs), NOW, {});
  assert.deepEqual(plain(vs.filter((v) => v.hasData).map((v) => v.id)), ["claude", "codex", "gemini", "grok"]);
  const g = vs.find((v) => v.id === "grok");
  assert.equal(C.mostConstrained(vs).id, "grok", "Grok has 27% left, the least");
  // Make Gemini's 5-hour window the tightest limit of all.
  const tight = C.mergeLabs(t3labs(), serverLabs).map((l) => (l.id === "gemini" ? { ...l, windows: l.windows.map((w) => (w.id === "gemini-5h" ? { ...w, usedPct: 95 } : w)) } : l));
  assert.equal(C.mostConstrained(C.views(tight, NOW, {})).id, "gemini");
  assert.equal(g.stale, false);
  assert.equal(C.labView(C.mergeLabs(t3labs(), serverLabs)[0], NOW + 16 * MIN, {}).stale, true);
  assert.match(C.compactLabel(view("claude"), NOW), /^63% left · 5h 68% · refills /, "12 points ahead of its clock: amber, so its refill shows");
  assert.equal(C.compactLabel(view("codex"), NOW), "49% left");
});

test("T3's blocking rule: Claude's week used up blocks its 5-hour window (empty tank, no pace)", () => {
  const labs = C.mergeLabs(t3labs(), serverLabs).map((l) => (l.id === "claude" ? { ...l, windows: l.windows.map((w) => (w.role === "long" ? { ...w, usedPct: 100 } : w)) } : l));
  const v = C.labView(labs[0], NOW, {});
  assert.equal(v.blocked, true);
  assert.equal(v.sp.left, 0);
  assert.equal(v.sp.pace, null);
  assert.equal(C.compactLabel(v, NOW), `0% left · 5h blocked · week refills ${C.fmtClock(v.long.resetsAt, NOW)}`);
  assert.match(C.bTooltip(v, NOW), /5-hour: blocked by the weekly limit until /);
  const g = C.bGeometry(v, 200, 17);
  assert.equal(g.tank.level, 0);
  assert.equal(g.tank.amber, false);
});

// ---------------------------------------------------------------- B geometry and words

test("B: fill = long window left, needle at its even pace, tank level = 5-hour left on its own scale", () => {
  const v = view("claude");
  const g = C.bGeometry(v, 200, 17);
  assert.ok(Math.abs(g.fillW - 200 * 0.63) < 1e-9);
  assert.ok(Math.abs(g.tank.cx - 200 * v.lp.timeLeftExact / 100) < 1e-9);
  assert.ok(Math.abs(g.tank.level - 0.68) < 1e-9);
  assert.equal(g.needle, null);
  // Codex reports no 5-hour window: the plain line, never an empty tank.
  const x = C.bGeometry(view("codex"), 200, 17);
  assert.equal(x.tank, null);
  assert.ok(x.needle);
  // Missing short-window reading (null %): also the plain line.
  const labs = C.mergeLabs(t3labs(), serverLabs).map((l) => (l.id === "claude" ? { ...l, windows: l.windows.filter((w) => w.role !== "short") } : l));
  assert.equal(C.bGeometry(C.labView(labs[0], NOW, {}), 200, 17).tank, null);
});

test("B: amber comes from unrounded values (5-hour window more than 5 points ahead of its clock)", () => {
  // Gemini's 5-hour: 0.6 h left of 5 h = 88% elapsed. Used 93.0001 is 5.0001 points ahead.
  const at = (used) => {
    const labs = C.mergeLabs(t3labs(), serverLabs).map((l) => (l.id === "gemini" ? { ...l, windows: l.windows.map((w) => (w.id === "gemini-5h" ? { ...w, usedPct: used } : w)) } : l));
    return C.bGeometry(C.labView(labs.find((l) => l.id === "gemini"), NOW, {}), 200, 17).tank.amber;
  };
  assert.equal(at(93.0001), true);
  assert.equal(at(93), false, "exactly 5 points is on pace");
});

test("B: the tooltip says both scales in Astra's words", () => {
  const t = C.bTooltip(C.labView(withWin("claude", "short", { usedPct: 20 }), NOW, {}), NOW); // on pace: no refill lead
  assert.match(t, /^Claude · This Mac\. Week: 63% left; even pace 83% left; resets \S+ .+\. 5-hour: 80% left; even pace \d+% left; resets .+\. Amber tank means spending more than 5 percentage points ahead of the 5-hour clock\. Updated 2 min ago\.$/);
  const grok = C.bTooltip(view("grok"), NOW);
  assert.match(grok, /Pace assumed: Grok doesn't report its window length\./);
  assert.doesNotMatch(grok, /5-hour/);
  const vs = C.views(C.mergeLabs(t3labs(), serverLabs), NOW, {});
  assert.equal(C.bLegend(vs), "Bar: week remaining. Needle position: even weekly pace. Tank level: 5-hour remaining, a separate limit.");
  const monthly = vs.map((v) => (v.hasData ? { ...v, longWord: "Month", longAdj: "monthly" } : v));
  assert.equal(C.bLegend(monthly), "Bar: month remaining. Needle position: even monthly pace. Tank level: 5-hour remaining, a separate limit.");
});

// ---------------------------------------------------------------- D: forecast, history, geometry

test("forecast uses lab-usage's projection (% used AT reset): one rate for the line, crossing and words", () => {
  const v = view("codex");
  const f = C.forecast(v, NOW);
  const end = v.long.resetsAt;
  const rate = (116.7 - 50) / (end - (NOW - MIN));
  assert.equal(f.source, "lab-usage");
  assert.ok(Math.abs(f.rate - rate) < 1e-15);
  assert.equal(f.state, "out");
  assert.ok(Math.abs(f.crossing - ((NOW - MIN) + 50 / rate)) < 1);
  assert.match(f.text, /^Estimated to run out \S+ .+ at this pace$/);
  const g = C.dGeometry(v, [], NOW, 300, 64);
  assert.ok(Math.abs(g.cross.x - 300 * (f.crossing - (end - 7 * DAY)) / (7 * DAY)) < 1e-6, "the ✕ sits where the words say");
  assert.equal(g.proj[1][0], g.cross.x);
});

test("a Codex manual reset counts: 70% used, 1 day before the reset, runs out (not 'lasts')", () => {
  // Six days into the week, 70% used: the plain average since the window start (70 × 7/6 = 82%)
  // would promise enough. A manual reset 12 hours ago restarted the count, so lab-usage projects
  // 70 × 36/12 = 210% at the reset.
  const t = NOW - MIN;
  const lu = [{ ...serverLabs[1], windows: [{ ...serverLabs[1].windows[0], usedPct: 70, resetsAt: NOW + DAY, projection: 70 * ((NOW + DAY - (t - 12 * H)) / (12 * H)), projectionAt: t, projectionUsed: 70 }] }];
  const labs = C.mergeLabs(t3labs(), lu).map((l) => (l.id === "codex" ? { ...l, windows: l.windows.map((w) => ({ ...w, usedPct: 70, resetsAt: NOW + DAY })) } : l));
  const v = C.labView(labs[1], NOW, {});
  assert.ok(70 * 7 / 6 < 100, "the plain average would say it lasts");
  const f = C.forecast(v, NOW);
  assert.equal(f.state, "out");
  assert.ok(Math.abs(v.epochStart - (t - 12 * H)) < 1000, "the usage epoch comes from the projection");
  assert.ok(f.crossing < NOW + DAY);
});

test("lab-usage's projection is used only for the reading it was made from (Sol's cases)", () => {
  const w = (o) => ({ id: "primary", role: "long", kind: "weekly", usedPct: 20, resetsAt: NOW + 3 * DAY, lengthSec: 7 * 86400, fetchedAt: NOW, live: true, ...o });
  const t3lab = (o) => ({ id: "codex", name: "Codex", colour: "#000", source: "t3", live: true, hasMeter: true, fetchedAt: NOW, windows: [w(o)] });
  const lu = (o, lab = {}) => ({ id: "codex", source: "lab-usage", live: true, fetchedAt: NOW, ...lab, windows: [w({ usedPct: 20, projectionUsed: 20, projectionAt: NOW, projection: 40, ...o })] });
  const fc = (t, s, fails = {}) => C.forecast(C.labView(C.mergeLabs({ codex: t }, [s]).find((x) => x.id === "codex"), NOW, fails), NOW);
  assert.equal(fc(t3lab({}), lu({})).source, "lab-usage", "fresh, same reset, same usage: used");
  // Another reset (and 70% vs 20%): dropped; Codex's epoch is then unknown.
  assert.equal(fc(t3lab({ usedPct: 70, resetsAt: NOW + DAY }), lu({ resetsAt: NOW + 3 * DAY })).state, "unavailable");
  assert.equal(fc(t3lab({}), lu({ resetsAt: NOW + 3 * DAY + 121e3 })).state, "unavailable", "more than 120 s apart");
  assert.equal(fc(t3lab({}), lu({ resetsAt: NOW + 3 * DAY + 119e3 })).source, "lab-usage");
  // Stale or failed lab-usage: dropped.
  assert.equal(fc(t3lab({ usedPct: 85 }), lu({ usedPct: 10, live: false, fetchedAt: NOW - 2 * H, projectionUsed: 10, projectionAt: NOW - 2 * H, projection: 20 }, { live: false, fetchedAt: NOW - 2 * H }), { labUsage: NOW - MIN }).state, "unavailable");
  assert.equal(fc(t3lab({}), lu({}, { fetchedAt: NOW - 11 * MIN })).state, "unavailable", "older than 10 min");
  assert.equal(fc(t3lab({}), lu({}), { labUsage: NOW - MIN }).state, "unavailable", "a failed refresh");
  // More than 3 points apart, or a drop since it was worked out (a manual reset).
  assert.equal(fc(t3lab({ usedPct: 24 }), lu({})).state, "unavailable");
  assert.equal(fc(t3lab({ usedPct: 1 }), lu({ usedPct: 80, projectionUsed: 80, projectionAt: NOW - MIN, projection: 150 })).state, "unavailable");
  assert.equal(fc(t3lab({ usedPct: 19, fetchedAt: NOW }), lu({ projectionAt: NOW - MIN })).state, "unavailable", "dropped 1 point since");
  // Claude keeps a known epoch, so it falls back to the average since the window start.
  const claude = { ...t3lab({ id: "seven_day" }), id: "claude", name: "Claude" };
  assert.equal(C.forecast(C.labView(C.mergeLabs({ claude }, [{ ...lu({ resetsAt: NOW + DAY }), id: "claude" }])[0], NOW, {}), NOW).source, "average");
});

test("no valid length, no pace: Claude and Codex never get a made-up week (Sol's cases)", () => {
  for (const len of [null, 0, -60]) {
    const lab = { id: "claude", name: "Claude", colour: "#000", source: "t3", live: true, hasMeter: true, fetchedAt: NOW, windows: [{ id: "seven_day", role: "long", kind: "weekly", usedPct: 20, resetsAt: NOW + 3 * DAY, lengthSec: len, fetchedAt: NOW, live: true }] };
    assert.equal(C.labView(lab, NOW, {}).lp.pace, null, String(len));
    assert.equal(C.bGeometry(C.labView(lab, NOW, {}), 200, 17).needle, null, "no pace line");
  }
  const rec = (mins) => ({ schemaVersion: 1, environmentId: ENV, config: { providers: [
    { instanceId: "codex", driver: "codex", usageLimits: { checkedAt: checked, windows: [{ id: "primary", kind: "weekly", usedPercent: 20, resetsAt: iso(NOW + 3 * DAY), windowDurationMins: mins }] } },
    { instanceId: "grok", driver: "grok", usageLimits: { checkedAt: checked, windows: [{ id: "subscription", kind: "weekly", usedPercent: 20, resetsAt: iso(NOW + 3 * DAY), windowDurationMins: mins }] } },
  ] } });
  for (const mins of [-1, 0]) {
    const L = C.labsFromT3(C.projectT3Config(rec(mins), ENV), NOW);
    assert.equal(C.labView(L.codex, NOW, {}).lp.pace, null);
    assert.equal(C.labView(L.grok, NOW, {}).lp.pace, null, "Grok too: an invalid length is not missing");
  }
  const L = C.labsFromT3(C.projectT3Config(rec(undefined), ENV), NOW);
  assert.equal(C.labView(L.codex, NOW, {}).lp.pace, null);
  assert.equal(C.labView(L.grok, NOW, {}).lp.bounds.assumed, "week", "only Grok, only when it reports no length");
});

test("footer team list: four choices, start-open by default, always on <html>", () => {
  assert.deepEqual(plain(C.FOOTER_TEAM.map(([v]) => v)), ["always-show", "start-open", "start-folded", "always-hide"]);
  const d = C.readSettings(null);
  assert.equal(d.footerTeam, "start-open");
  assert.equal(C.rootAttrs(d)["data-t3x-footer-team"], "start-open", "the default is set too");
  assert.equal(C.readSettings(JSON.stringify({ footerTeam: "always-hide" })).footerTeam, "always-hide");
  assert.equal(C.readSettings(JSON.stringify({ footerTeam: "sideways" })).footerTeam, "start-open");
  assert.equal(C.rootAttrs(C.readSettings(JSON.stringify({ footerTeam: "start-folded" })))["data-t3x-footer-team"], "start-folded");
  assert.equal(C.rootAttrs({ ...d, tighter: false })["data-t3x-tight"], null);
  assert.equal(C.rootAttrs(d)["data-t3x-working"], "", "the stronger Working divider is on by default");
  assert.equal(C.rootAttrs(C.readSettings(JSON.stringify({ workingHeader: false })))["data-t3x-working"], null);
  assert.equal(C.readSettings(JSON.stringify({ workingHeader: "no" })).workingHeader, true, "a non-boolean is ignored");
});

test("footer team list: start-folded clicks each footer list once (WeakSet), never again; always-show opens on switch", () => {
  // A fake T3 collapsible: clicking its summary flips React's open state, like Base UI.
  const details = (open) => {
    const el = { attrs: { "data-markdown-details-open": String(open) }, clicks: 0, getAttribute: (k) => el.attrs[k] };
    el.btn = { click() { el.clicks++; el.attrs["data-markdown-details-open"] = String(el.attrs["data-markdown-details-open"] !== "true"); } };
    el.querySelector = (sel) => (sel === ":scope > [data-markdown-details-summary]" ? el.btn : null);
    return el;
  };
  const a = details(true);
  const b = details(false);
  let list = [a, b];
  const root = { querySelectorAll: (sel) => (sel === C.FOOTER_DETAILS ? list : []) };
  const seen = new WeakSet();
  assert.equal(C.footerPass(root, "start-folded", seen), 1);
  assert.equal(a.attrs["data-markdown-details-open"], "false");
  assert.equal(b.clicks, 0, "a folded one is left alone");
  a.btn.click(); // Andy opens it again
  assert.equal(C.footerPass(root, "start-folded", seen), 0, "never re-folded");
  assert.equal(a.attrs["data-markdown-details-open"], "true");
  const c = details(true);
  list = [a, b, c];
  assert.equal(C.footerPass(root, "start-folded", seen), 1, "a new footer is folded once");
  assert.equal(c.clicks, 1);
  for (const mode of ["start-open", "always-hide", "always-show"]) assert.equal(C.footerPass(root, mode, new WeakSet()), 0, mode);
  assert.equal(C.footerPass(root, "always-show", seen, true), 2, "switching to always-show opens the folded ones");
  assert.ok([a, b, c].every((x) => x.attrs["data-markdown-details-open"] === "true"));
  assert.match(C.FOOTER_DETAILS, /^\.chat-markdown > hr:last-of-type \+ \.chat-markdown-table-container:has\(\[itemprop~="settle-yes"\], \[itemprop~="settle-no"\]\) \+ div > \[data-markdown-details\]$/);
});

test("forecast boundary states: no usage, zero elapsed, limit reached, stale, expired, future start", () => {
  const base = view("claude");
  const with_ = (o, vo = {}) => C.forecast({ ...base, ...vo, long: { ...base.long, projection: null, ...o } }, NOW);
  assert.equal(with_({ usedPct: 0 }).text, "No usage measured yet");
  assert.equal(with_({ usedPct: 0 }).crossing, undefined);
  const limit = with_({ usedPct: 104 });
  assert.equal(limit.state, "limit");
  assert.equal(limit.text, "Limit reached (104% used)");
  const stale = C.forecast({ ...base, stale: true, age: 40 * MIN }, NOW);
  assert.equal(stale.state, "stale");
  assert.doesNotMatch(stale.text, /last/i, "stale never says it lasts");
  assert.equal(C.forecast({ ...base, lp: { ...base.lp, bounds: { start: NOW - DAY, end: NOW - 1 } } }, NOW).text, "Estimate unavailable");
  assert.equal(C.forecast({ ...base, lp: { ...base.lp, bounds: { start: NOW + 1, end: NOW + DAY } } }, NOW).state, "unavailable");
  // Zero elapsed: the reading was taken at the window start.
  assert.equal(with_({ fetchedAt: base.epochStart }).state, "unavailable");
  // Without a projection: the average since the window start.
  const avg = with_({});
  assert.equal(avg.source, "average");
  assert.ok(Math.abs(avg.rate - 37 / (NOW - 2 * MIN - base.epochStart)) < 1e-15);
  // Codex without lab-usage: its epoch can move (manual resets), so no estimate.
  const codexOnlyT3 = C.labView(C.mergeLabs(t3labs(), [])[1], NOW, {});
  assert.equal(C.forecast(codexOnlyT3, NOW).state, "unavailable");
  // Lasting: the words never promise a crossing.
  const lasts = with_({ usedPct: 5 });
  assert.equal(lasts.state, "lasts");
  assert.equal(lasts.text, "Estimated to last until reset at this pace.");
  assert.match(C.forecast(view("grok"), NOW).text, /pace assumed: Grok doesn't report its window length/);
});

test("history runs break at gaps, at usage drops (resets) and never mix reset epochs", () => {
  const b = { start: NOW - 3 * DAY, end: NOW + 4 * DAY };
  const sm = (dtMin, used, resetsAt = b.end) => ({ ts: NOW - dtMin * MIN, used, resetsAt });
  const samples = [sm(200, 10), sm(190, 11), sm(180, 12), /* 60-min gap */ sm(120, 14), sm(110, 15), /* drop */ sm(100, 2), sm(90, 3), sm(80, 50, b.end - 7 * DAY) /* old epoch */];
  const segs = C.seriesSegments(samples, b, { t: NOW - 70 * MIN, u: 4 });
  assert.deepEqual(plain(segs).map((s) => s.map((p) => p.u)), [[10, 11, 12], [14, 15], [2, 3], [50], [4]], "the other epoch's sample stands alone");
  assert.equal(C.seriesSegments([sm(20, 1), { ts: NOW - 10 * MIN, used: 2 }], b, null).length, 1, "a sample with no reset time is left out");
});

test("history runs (Sol's cases): every drop breaks, even 0.4 → 0; reset epochs must match to the minute", () => {
  const b = { start: NOW - DAY, end: NOW + 6 * DAY };
  assert.equal(C.seriesSegments([{ ts: NOW - 20 * MIN, used: 0.4, resetsAt: b.end }, { ts: NOW - 10 * MIN, used: 0, resetsAt: b.end }], b, null).length, 2);
  assert.equal(C.seriesSegments([{ ts: NOW - 20 * MIN, used: 10, resetsAt: b.end - 5 * MIN }, { ts: NOW - 10 * MIN, used: 11, resetsAt: b.end }], b, null).length, 2);
  // The same reset reported as …59.882 and …00.337 (T3 and lab-usage) is one epoch.
  const end = Date.parse("2026-10-25T21:00:00.337Z");
  const b2 = { start: end - 7 * DAY, end };
  assert.equal(C.seriesSegments([{ ts: NOW - 20 * MIN, used: 10, resetsAt: Date.parse("2026-10-25T20:59:59.882Z") }, { ts: NOW - 10 * MIN, used: 11, resetsAt: end }], b2, null).length, 1);
});

test("D: the estimate before logging is marked and only drawn when its start is known and recent", () => {
  const v = view("claude");
  const none = C.dGeometry(v, [], NOW, 300, 64);
  assert.ok(none.estimate, "no history yet: a straight, marked guess from the window start");
  assert.equal(none.segs.length, 1, "just the current reading");
  const logged = C.dGeometry(v, [{ ts: v.epochStart + 5 * MIN, used: 0.5, resetsAt: v.long.resetsAt }, { ts: v.epochStart + 15 * MIN, used: 1, resetsAt: v.long.resetsAt }], NOW, 300, 64);
  assert.equal(logged.estimate, null, "logged from the start: nothing to estimate");
  // Monthly: the start is older than 15 days of history, so the past is left blank.
  const monthly = { ...v, epochStart: NOW - 20 * DAY, lp: { ...v.lp, bounds: { start: NOW - 20 * DAY, end: NOW + 10 * DAY } } };
  assert.equal(C.dGeometry(monthly, [], NOW, 300, 64).estimate, null);
  // Codex without lab-usage: unknown epoch, no estimate line.
  assert.equal(C.dGeometry(C.labView(C.mergeLabs(t3labs(), [])[1], NOW, {}), [], NOW, 300, 64).estimate, null);
});

test("D: the 5-hour lane sits at its true time; only the hit target is widened", () => {
  const v = view("claude");
  const g = C.dGeometry(v, [], NOW, 300, 64);
  const b = v.lp.bounds;
  const sb = C.windowBounds(v.short);
  assert.ok(Math.abs(g.lane.x - 300 * (sb.start - b.start) / (b.end - b.start)) < 1e-9);
  assert.ok(Math.abs(g.lane.w - 300 * (5 * H) / (7 * DAY)) < 1e-9, "5 hours of a week = 2.98% of the width");
  assert.ok(g.lane.hitW >= 8 && g.lane.w < 9);
  assert.ok(Math.abs(g.lane.fill - 0.32) < 1e-9, "filled to its own % used");
  assert.equal(C.dGeometry(view("codex"), [], NOW, 300, 64).lane, null);
  // Drawing clamps past 100%.
  const over = { ...v, long: { ...v.long, usedPct: 130 } };
  assert.equal(C.dGeometry(over, [], NOW, 300, 64).cur[1], 0);
});

test("one series per lab: T3 samples first, the service's only where T3 has none within 10 min", () => {
  const t3s = [{ ts: NOW - 60 * MIN, used: 10 }, { ts: NOW - 50 * MIN, used: 11 }];
  const srv = [{ ts: NOW - 58 * MIN, used: 9 }, { ts: NOW - 30 * MIN, used: 12 }, { ts: NOW - 20 * MIN, used: 13 }];
  assert.deepEqual(plain(C.mergeSeries(t3s, srv)).map((x) => x.used), [10, 11, 12, 13]);
  assert.equal(C.mergeSeries(Array.from({ length: 3000 }, (_, i) => ({ ts: i, used: 1 })), []).length, C.HIST.maxPerSeries);
});

// ---------------------------------------------------------------- unchanged from round 1

test("the three gate verdicts each read differently", () => {
  assert.equal(C.gateLabel("GO"), "GO");
  assert.equal(C.gateLabel("REDEEM"), "Reset needed");
  assert.equal(C.gateLabel("CLAUDE"), "Use Claude");
  assert.equal(C.gateLabel(undefined), "—");
});

test("lab-usage counts as failed after a failed refresh or an unreachable service", () => {
  assert.equal(C.labUsageFailedSince({ fetchedAt: NOW - MIN, failedAt: NOW - 1000 }, null), NOW - 1000);
  assert.equal(C.labUsageFailedSince({ fetchedAt: NOW, failedAt: NOW - 1000 }, null), null, "an older failure was healed");
  assert.equal(C.labUsageFailedSince({ fetchedAt: NOW }, NOW - 5), NOW - 5);
  const failed = C.labView(C.mergeLabs(null, serverLabs)[0], NOW, { labUsage: NOW - 1000 });
  assert.equal(failed.stale, true);
  assert.equal(C.forecast(failed, NOW).state, "stale");
});

test("times and ages read plainly", () => {
  assert.equal(C.fmtAge(30e3), "just now");
  assert.equal(C.fmtAge(14 * 60e3), "14 min ago");
  assert.equal(C.fmtAge(undefined), "age unknown");
  assert.match(C.fmtReset(NOW + 41 * 60e3, NOW), /^refills in 41 min \(\d{1,2}:\d{2}\s?[AP]M\)$/);
  assert.match(C.fmtReset(NOW + (2 * 60 + 5) * 60e3, NOW), /^refills in 2 h 5 min \(\d{1,2}:\d{2}\s?[AP]M\)$/);
  assert.equal(C.fmtReset(null, NOW), "refill time unknown");
  assert.equal(C.fmtPct(null), "—");
  assert.equal(C.fmtPct(0), "0%");
});

test("handover request is provider-neutral and never asks to send by itself", () => {
  assert.doesNotMatch(C.HANDOVER_REQUEST, /claude|codex|gemini|CLAUDE\.md/i);
  assert.match(C.HANDOVER_REQUEST, /handover finalize/);
  assert.equal(C.chainLabel({ position: 2 }), "Handover 2");
  assert.equal(C.chainLabel(null), null);
});

test("contrast picks readable marker colours", () => {
  assert.ok(C.contrast([0, 0, 0], [255, 255, 255]) > 20);
  assert.ok(C.contrast([250, 240, 250], [255, 255, 255]) < 1.2);
});

// ---------------------------------------------------------------- refill times (Andy, 20 Oct)

const withWin = (id, role, o) => C.mergeLabs(t3labs(), serverLabs).map((l) => (l.id === id ? { ...l, windows: l.windows.map((w) => (w.role === role ? { ...w, ...o } : w)) } : l)).find((l) => l.id === id);

test("refills: clock time beside the countdown; over a day, the weekday and time", () => {
  const at = NOW + (60 + 12) * 60e3;
  const clock = new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  assert.equal(C.fmtReset(at, NOW), `refills in 1 h 12 min (${clock})`);
  assert.match(C.fmtReset(NOW + 3 * DAY, NOW), /^refills \S+ \d{1,2}:\d{2}\s?[AP]M$/);
  assert.equal(C.fmtClock(at, NOW), clock);
  assert.match(C.fmtClock(NOW + 3 * DAY, NOW), /^\S+ \d{1,2}:\d{2}\s?[AP]M$/);
});

test("refills in the sidebar label: only when running low; one line; narrow drops the word 'refills'", () => {
  assert.equal(C.compactLabel(C.labView(withWin("claude", "short", { usedPct: 20 }), NOW, {}), NOW), "63% left · 5h 80%", "on pace, 80% left: not low");
  const low = C.labView(withWin("claude", "short", { usedPct: 88 }), NOW, {});
  const clock = C.fmtClock(low.short.resetsAt, NOW);
  assert.equal(C.compactLabel(low, NOW), `63% left · 5h 12% · refills ${clock}`);
  assert.equal(C.compactLabel(low, NOW, true), `63% left · 5h 12% · ${clock}`);
  assert.ok(!C.compactLabel(low, NOW).includes("\n"));
  // Ahead of its clock (amber) counts too, even with more than 25% left.
  const ahead = C.labView(withWin("claude", "short", { usedPct: 30 }), NOW, {}); // 20% of its 5 h gone, 30% used, 70% left
  assert.equal(ahead.sp.pace, "ahead");
  assert.match(C.compactLabel(ahead, NOW), / · refills /);
  // Blocked: it refills when the week does.
  const blocked = C.labView(withWin("claude", "long", { usedPct: 100 }), NOW, {});
  assert.equal(C.compactLabel(blocked, NOW), `0% left · 5h blocked · week refills ${C.fmtClock(blocked.long.resetsAt, NOW)}`);
  assert.match(C.bTooltip(blocked, NOW), /^Week: 0% left \(5-hour blocked too\), refills /);
  // The long window at 15% or less: "week refills Sat 8:07 PM".
  const week = C.labView(withWin("codex", "long", { usedPct: 86 }), NOW, {});
  assert.match(C.compactLabel(week, NOW), /^14% left · week refills \S+ \d{1,2}:\d{2}\s?[AP]M$/);
  assert.equal(C.compactLabel(C.labView(withWin("codex", "long", { usedPct: 84 }), NOW, {}), NOW), "16% left");
});

test("refills in the header tooltip (it leads) and the composer chip", () => {
  const low = C.labView(withWin("claude", "short", { usedPct: 88 }), NOW, {});
  const clock = C.fmtClock(low.short.resetsAt, NOW);
  assert.ok(C.bTooltip(low, NOW).startsWith(`5-hour: 12% left, refills ${clock}. Claude · This Mac.`));
  assert.ok(C.bTooltip(C.labView(withWin("claude", "short", { usedPct: 20 }), NOW, {}), NOW).startsWith("Claude · This Mac."), "not low: as before");
  const c = C.composerLabel(low, NOW);
  assert.equal(c.main, "Claude 5h 12%");
  const sameDay = new Date(low.short.resetsAt).toDateString() === new Date(NOW).toDateString();
  assert.match(c.refill, sameDay ? /^\d{1,2}:\d{2}\s?[AP]M$/ : /^\S+ \d{1,2}:\d{2}\s?[AP]M$/, "AM/PM kept; another day keeps its day (Sol S3)");
  const multi = C.labView({ id: "codex", name: "Codex", hasMeter: true, fetchedAt: NOW, live: true, windows: [{ role: "long", kind: "weekly", usedPct: 90, lengthSec: 604800, resetsAt: NOW + 3 * DAY }] }, NOW, {});
  assert.equal(C.composerLabel(multi, NOW).refill, C.fmtClock(NOW + 3 * DAY, NOW));
  assert.match(C.fmtReset(NOW + 29_000, NOW), /^refills in under 1 min \(/, "never 'in 0 min' (Sol S2)");
  assert.equal(C.composerLabel(C.labView(withWin("claude", "short", { usedPct: 20 }), NOW, {}), NOW).refill, null);
  const week = C.labView(withWin("codex", "long", { usedPct: 90 }), NOW, {});
  assert.equal(C.composerLabel(week, NOW).main, "Codex 10%");
  assert.ok(C.composerLabel(week, NOW).refill);
});


// ---------------------------------------------------------------- burn tells: rows and words

/** A fixture row in T3's real shape (bundle main-*.js): <li data-thread-item="ENV:THREAD"> around
 *  a sidebar-row-card / -slim button; compact rows: <li data-thread-item="true"> + thread-row-ID. */
function row(item, testid) {
  return {
    getAttribute: (k) => (k === "data-thread-item" ? item : null),
    querySelector: (sel) => {
      if (sel === '[data-testid="sidebar-row-slim"]') return testid === "sidebar-row-slim" ? {} : null;
      if (sel === '[data-testid^="thread-row-"]') return testid?.startsWith("thread-row-") ? { getAttribute: () => testid } : null;
      return null;
    },
  };
}
const LOCAL = "0f0e0d0c-0b0a-4908-8706-050403020100";
test("burn rows: this Mac's card/slim rows by exact thread id; compact rows only with proof they're local", () => {
  const threads = { "a06b79b7-0000-4000-8000-000000000001": { tier: "warm" }, "thread:delegate-1:%2Fx.y": { tier: "burst" }, "mcp:806769b1-0000": { tier: "hot" }, "remote-thread-1": { tier: "warm" }, "compact-only-1": { tier: "warm" } };
  const lis = [
    row(`${LOCAL}:a06b79b7-0000-4000-8000-000000000001`, "sidebar-row-card"),
    row(`${LOCAL}:thread:delegate-1:%2Fx.y`, "sidebar-row-slim"), // colons and % in the id: split at the first colon only
    row(`${LOCAL}:mcp:806769b1-0000`, "sidebar-row-card"),
    row("99999999-0000-4000-8000-000000000000:remote-thread-1", "sidebar-row-card"), // another environment
    row(`${LOCAL}:not-hot-0001`, "sidebar-row-card"),
    row("true", "thread-row-a06b79b7-0000-4000-8000-000000000001"), // compact, proven by the card row above
    row("true", "thread-row-compact-only-1"), // compact, no proof
  ];
  const got = C.burnTargets(lis, threads, LOCAL, { kind: "home" }).map((t) => [t.threadId, t.kind]);
  assert.deepEqual(plain(got), [
    ["a06b79b7-0000-4000-8000-000000000001", "card"],
    ["thread:delegate-1:%2Fx.y", "slim"],
    ["mcp:806769b1-0000", "card"],
    ["a06b79b7-0000-4000-8000-000000000001", "compact"],
  ]);
  // The open local thread's route is proof too.
  const open = C.burnTargets(lis, threads, LOCAL, { kind: "thread", environmentId: LOCAL, threadId: "compact-only-1" });
  assert.ok(open.some((t) => t.threadId === "compact-only-1"));
  assert.deepEqual(plain(C.burnTargets(lis, threads, null, null)), [], "no local environment known: nothing");
  assert.deepEqual(plain(C.parseThreadItem("env:a:b")), { env: "env", threadId: "a:b" });
  assert.equal(C.parseThreadItem("true"), null);
  assert.equal(C.parseThreadItem(":x"), null);
});

test("burn words: ember for bursts ('recorded' for Grok, 'Recent' once faded), building = ember + thin strip, chips for heat", () => {
  const b = C.burnView({ tier: "burst", burstUsd: 1.6, provider: "claude" });
  assert.deepEqual([b.ember, b.strip, b.chip], [true, null, null]);
  assert.equal(b.tooltip, "Short burst: about $1.60 in the last 2 minutes. Estimated API cost equivalent; not your subscription charge.");
  assert.match(C.burnView({ tier: "burst", burstUsd: 2, provider: "grok" }).tooltip, /^Short burst: about \$2\.00 recorded in the last 2 minutes\./);
  assert.match(C.burnView({ tier: "burst", recent: true, burstUsd: 2 }).tooltip, /^Recent burst:/);
  const bl = C.burnView({ tier: "building", rateUsdPerHour: 48.2, hotForMin: 9 });
  assert.deepEqual([bl.ember, bl.strip, bl.chip], [true, "thin", null]);
  assert.match(bl.tooltip, /^Running hot \(building\): about \$48 per hour for 9 minutes\./);
  const w = C.burnView({ tier: "warm", rateUsdPerHour: 31.4, hotForMin: 42, usualUsdPerHour: 5.16 });
  assert.equal(w.chip, "🔥 $31/h · 42 min");
  assert.equal(w.chipShort, "$31/h", "narrow sidebar: rate only; minutes in the tooltip");
  assert.equal(w.tooltip, "Burning about $31 per hour for 42 minutes. Estimated API cost equivalent; not your subscription charge. Your usual is about $5.16/h (your last 7 days, same model).");
  assert.match(C.burnView({ tier: "blazing", rateUsdPerHour: 90, hotForMin: 20 }).tooltip, /^Blazing: burning about \$90 per hour/);
  assert.equal(C.burnView({ tier: "nonsense" }), null);
  assert.equal(C.burnView(null), null);
  assert.equal(C.readSettings(null).burnTells, true, "on by default");
});

test("Gemini falls back to Google's per-model quota (T3's fallback) when there is no Gemini weekly row", () => {
  const rec = JSON.parse(t3Record());
  rec.config.providers.find((p) => p.driver === "antigravity").usageLimits.windows = [
    { id: "3p-weekly", kind: "weekly", label: "Claude & GPT (shared) · Weekly", usedPercent: 0, resetsAt: iso(NOW + 7 * DAY), windowDurationMins: 10080 },
    { id: "3p-5h", kind: "session", label: "Claude & GPT (shared) · 5-hour", usedPercent: 0, resetsAt: iso(NOW + 5 * H), windowDurationMins: 300 },
    { id: "gemini-quota", kind: "other", label: "Gemini · Reported quota", usedPercent: 5.911773, resetsAt: iso(NOW + 4 * H) },
  ];
  const L = C.labsFromT3(C.projectT3Config(rec, ENV), NOW);
  assert.deepEqual(plain(L.gemini.windows.map((w) => [w.id, w.role, w.label])), [["3p-weekly", "extra", "Weekly"], ["3p-5h", "extra", "5-hour"], ["gemini-quota", "long", "Quota"]]);
  assert.equal(L.gemini.hasMeter, true);
  const v = C.labView(C.mergeLabs(L, []).find((l) => l.id === "gemini"), NOW);
  assert.equal(v.hasData, true);
  assert.equal(Math.round(v.lp.left), 94);
  assert.equal(v.lp.pace ?? null, null, "no window length, so no made-up pace");
});

test("sidebar sections: T3's row ages read as hours; statuses read as null", () => {
  assert.deepEqual(["now", "24m", "13h", "2d", " 1h ", "Done", "Working", "Approval", "3w", "", null].map(C.rowAgeHours), [0, 0.4, 13, 48, 1, null, null, null, null, null, null]);
});

test("sidebar sections: older threads start after the newest run of activity", () => {
  // Andy's sidebar at 8 PM, 25 Oct 2026: eight under 3 h, then nine from 12 h to 1 d.
  assert.equal(C.olderCutoff([0, 0.4, 0.4, 0.8, 0.9, 1, 1, 2, 12, 13, 14, 17, 21, 24, 24, 24, 24]), 12);
  // A session that runs on past 3 h stays current while the gaps stay under 2 h.
  assert.equal(C.olderCutoff([0.1, 0.5, 1, 2, 3, 4, 12, 13]), 12);
  // Nothing recent: the newest 3 stay, then the gap decides (2 h, or half the previous age).
  assert.equal(C.olderCutoff([5, 6, 9, 20, 48, 72]), 20);
  assert.equal(C.olderCutoff([24, 24, 48, 120, 144]), 120);
  // "Recent" counts from the newest thread, not from now.
  assert.equal(C.olderCutoff([5, 5.5, 7.5, 8, 30, 31]), 30);
  // Folding one thread, or none, saves nothing.
  assert.equal(C.olderCutoff([1, 2, 3, 10]), null);
  assert.equal(C.olderCutoff([1, 2, 4]), null);
  assert.equal(C.olderCutoff([]), null);
  // Unsorted input and statuses (null) are handled.
  assert.equal(C.olderCutoff([24, null, 0.5, 13, 1, null, 0.2, 12]), 12);
});

test("one-row titles: only a short trailing (N) or (Model) is kept", () => {
  assert.deepEqual(["Thread health watch (48)", "Sidebar sections and titles (2)", "Review: plan (Astra)", "Good Boy (2026) film podcast", "(2)", "x (a very long parenthetical that is not a chain number)", "Ends with (nested (x))"].map(C.titleSuffix),
    ["(48)", "(2)", "(Astra)", "", "", "", ""]);
});

test("gaps by time: a gap only where both times are known and 25+ min apart", () => {
  const M = 60e3, T = 1e12;
  assert.deepEqual([...C.gapsBefore([T, T - 5 * M, T - 30 * M, T - 54 * M, T - 80 * M])], [false, false, true, false, true]);
  assert.deepEqual([...C.gapsBefore([T, null, T - 90 * M, T - 200 * M])], [false, false, false, true]); // unknown: no gap either side
  assert.deepEqual([...C.gapsBefore([T, T - 25 * M + 1])], [false, false]);
  assert.deepEqual([...C.gapsBefore([T - 60 * M, T])], [false, false]); // out of order: no gap
  assert.deepEqual([...C.gapsBefore([])], []);
});
