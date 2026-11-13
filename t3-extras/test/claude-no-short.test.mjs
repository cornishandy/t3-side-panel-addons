// Claude's plan has had no 5-hour window since 13 Nov 2026: its reading lists the week and the
// per-model weeks only. These pin what each place shows then. Invented readings only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { usageView, labsFromView } from "../lib.mjs";

const src = fs.readFileSync(new URL("../public/extras.js", import.meta.url), "utf8");
const sandbox = { window: { __T3X_TEST__: {} } };
vm.runInNewContext(src, sandbox);
const C = sandbox.window.__T3X_TEST__.core;
const plain = (v) => JSON.parse(JSON.stringify(v));

const NOW = Date.parse("2026-11-13T17:30:00Z");
const DAY = 86400e3;
const H = 3600e3;
const ENV = "env-1";
const iso = (t) => new Date(t).toISOString();
const checked = iso(NOW - 2 * 60e3);
const WEEK_END = NOW + 2 * DAY + 3 * H;
const week = (id, label, used, at = WEEK_END) => ({ id, kind: "weekly", label, usedPercent: used, resetsAt: iso(at), windowDurationMins: 10080 });

/** T3's saved record. Claude as its reading is today: no five_hour window. */
function t3Record({ claudeWeek = 14, fable = 10, gemini = false } = {}) {
  const providers = [
    { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, usageLimits: { checkedAt: checked, windows: [week("seven_day", "Weekly", claudeWeek), week("seven_day_fable", "Weekly · Fable", fable)] } },
    { instanceId: "codex", driver: "codex", enabled: true, usageLimits: { checkedAt: checked, windows: [week("primary", "Weekly", 26, NOW + 2 * DAY)] } },
  ];
  if (gemini) {
    providers.push({ instanceId: "antigravity", driver: "antigravity", enabled: true, usageLimits: { checkedAt: checked, windows: [
      { id: "gemini-5h", kind: "session", label: "Gemini · 5-hour", usedPercent: 30, resetsAt: iso(NOW + 2 * H), windowDurationMins: 300 },
      week("gemini-weekly", "Gemini · Weekly", 40, NOW + 4 * DAY),
    ] } });
  }
  return JSON.stringify({ schemaVersion: 1, environmentId: ENV, config: { providers } });
}
/** lab-usage --json as it is today: the week alone, and `five_hour: null` in the verdict. */
const labUsageRaw = (claudeWeek = 14, fable = 10) => ({
  now: NOW / 1000,
  claude: {
    age_min: 0,
    windows: [{ name: "week", used: claudeWeek, mins: 10080, resets_at: WEEK_END / 1000, projection: 20.2 }],
    scoped: [{ model: "Fable", used: fable }],
    conserve: { tier: 0, tier_name: "T0 normal", today: { share: 18.5, spent: 2.5, used_up: false }, five_hour: null, fable_stop: 90, stops: [] },
  },
  codex: { windows: [{ name: "weekly", used: 26, mins: 10080, resets_at: (NOW + 2 * DAY) / 1000 }], allowed: true },
});
function views(opts = {}) {
  const t3 = C.labsFromT3(C.projectT3Config(t3Record(opts), ENV), NOW);
  const server = labsFromView(usageView(labUsageRaw(opts.claudeWeek, opts.fable), NOW));
  return C.views(C.mergeLabs(t3, server), NOW, {});
}
const claude = (opts) => views(opts).find((v) => v.id === "claude");
const texts = (cands) => plain(cands.map((c) => C.plain(c)));

test("lab-usage's reading with the week alone: one window, no error, no short role", () => {
  const view = usageView(labUsageRaw(), NOW);
  assert.equal(view.claude.ok, true);
  assert.equal(view.claude.conserveError, null);
  assert.deepEqual(plain(view.claude.stops), []);
  const lab = labsFromView(view).find((l) => l.id === "claude");
  assert.deepEqual(plain(lab.windows.map((w) => [w.id, w.role, w.usedPct])), [["cwk", "long", 14]]);
  // A reading that does list a 5-hour window (an older lab-usage) is still drawn.
  const raw = labUsageRaw();
  raw.claude.windows.unshift({ name: "5-hour", used: 30, mins: 300, resets_at: (NOW + 2 * H) / 1000 });
  assert.deepEqual(plain(labsFromView(usageView(raw, NOW))[0].windows.map((w) => w.role)), ["short", "long"]);
});

test("T3's reading with no five_hour window: Claude has a week, a Fable limit and no short window", () => {
  const L = C.labsFromT3(C.projectT3Config(t3Record(), ENV), NOW);
  assert.deepEqual(plain(L.claude.windows.map((w) => [w.id, w.role])), [["seven_day", "long"], ["seven_day_fable", "extra"]]);
  const v = claude();
  assert.equal(v.hasData, true);
  assert.equal(v.short, null);
  assert.equal(v.sp, null);
  assert.equal(v.blocked, false);
  assert.equal(v.minLeft, 86);
});

test("healthy: every place shows the week and Fable, never a 5h number or a tank", () => {
  const v = claude();
  assert.deepEqual(texts(C.sidebarCands(v, NOW)), ["86% left · Fable 90%", "86% left", "86%"]);
  assert.deepEqual(texts(C.lineCands(v)), ["86% · Fable 90%", "86%"]);
  assert.equal(C.composerLabel(v, NOW).main, "Claude 86%");
  assert.equal(C.composerLabel(v, NOW).refill, null);
  assert.equal(C.spokenUsage(v), "Week 86% left, Fable 90% left");
  const tip = C.bTooltip(v, NOW);
  assert.match(tip, /^Claude · This Mac\. Week: 86% left; even pace \d+% left; resets .+\. Fable: 90% left; resets .+\. Updated 2 min ago\.$/);
  assert.doesNotMatch(tip, /5-hour|tank|Short window/i);
  assert.equal(C.bGeometry(v, 120, 10).tank ?? null, null, "a plain needle, never an empty tank");
  assert.deepEqual(plain(C.lowRefills(v)), []);
});

test("the week used up: \"0% left\" with the week's refill, and nothing says blocked", () => {
  const v = claude({ claudeWeek: 100, fable: 40 });
  assert.equal(v.blocked, false);
  const all = texts(C.sidebarCands(v, NOW));
  assert.match(all[0], /^0% left · Fable 60% · week refills /);
  for (const t of all) assert.doesNotMatch(t, /blocked|5h/);
  assert.match(C.composerLabel(v, NOW).main, /^Claude 0%$/);
  assert.doesNotMatch(C.bTooltip(v, NOW), /blocked|5-hour/);
  assert.deepEqual(plain(C.lowRefills(v).map((r) => r.which)), ["long"]);
});

test("Fable low: it leads by name with its refill, as with a 5-hour window", () => {
  const v = claude({ claudeWeek: 50, fable: 92 });
  assert.match(texts(C.sidebarCands(v, NOW))[0], /^50% left · Fable 8% left · refills /);
  assert.equal(C.composerLabel(v, NOW).main, "Claude Fable 8%");
});

test("legend: the tank sentence only while a shown lab has a short window", () => {
  // Claude and Codex, neither with a short window: no tank is drawn, so none is named.
  const none = views();
  assert.equal(none.filter((v) => v.hasData).some((v) => v.short), false);
  assert.equal(C.bLegend(none), "Bar: week remaining. Needle position: even weekly pace.");
  assert.equal(C.bLegend([]), "Bar: week remaining. Needle position: even weekly pace.");
  // Gemini still has a 5-hour window: the sentence is back, in that window's own word.
  const withGemini = views({ gemini: true });
  assert.equal(withGemini.find((v) => v.id === "gemini").shortTag, "5h");
  assert.equal(withGemini.find((v) => v.id === "claude").short, null);
  assert.equal(C.bLegend(withGemini), "Bar: week remaining. Needle position: even weekly pace. Tank level: 5-hour remaining, a separate limit.");
  assert.equal(C.compactLabel(withGemini.find((v) => v.id === "gemini"), NOW), "60% left · 5h 70%");
});

test("short window, one line per lab: the README's cases, word for word", () => {
  const wide = (v) => C.lineLayout(v, NOW, 400, (t) => String(t).length * 4.8);
  const narrow = (v, px) => C.lineLayout(v, NOW, px, (t) => String(t).length * 4.8);
  // Healthy: the week plus Fable; too narrow, Fable alone only when it is the lower number.
  assert.equal(wide(claude({ claudeWeek: 20, fable: 30 })).text, "80% · Fable 70%");
  assert.equal(narrow(claude({ claudeWeek: 20, fable: 62 }), 60).text, "Fable 38%");
  assert.equal(narrow(claude({ claudeWeek: 70, fable: 62 }), 60).text, "30%");
  // A low Fable leads; the week's number gives way.
  assert.equal(wide(claude({ claudeWeek: 50, fable: 92 })).text, "Fable 8% left · 50%");
  assert.equal(narrow(claude({ claudeWeek: 50, fable: 92 }), 70).text, "Fable 8% left");
  // The week low with a healthy Fable: the week and its refill clock, without Fable, at any width.
  const lowWeek = wide(claude({ claudeWeek: 90, fable: 30 }));
  assert.match(lowWeek.text, /^10% · \S+ \d+:\d\d [AP]M$/);
  assert.doesNotMatch(lowWeek.text, /Fable|5h|blocked/);
  // Both low: the week first, also when Fable is the tighter one; two lines only when needed.
  const both = wide(claude({ claudeWeek: 97, fable: 92 }));
  assert.equal(both.text, "3% · Fable 8% left");
  assert.equal(both.wrap, false);
  assert.equal(wide(claude({ claudeWeek: 90, fable: 97 })).text, "10% · Fable 3% left", "the week stays first");
  const wrapped = narrow(claude({ claudeWeek: 97, fable: 92 }), 80);
  assert.equal(wrapped.wrap, true);
  assert.deepEqual(plain(wrapped.lines.map((g) => C.plain(g))), ["3%", "Fable 8% left"]);
  // The week used up: "0%" and the week's refill clock; the chip carries the refill too.
  const out = claude({ claudeWeek: 100, fable: 40 });
  assert.match(wide(out).text, /^0% · \S+ \d+:\d\d [AP]M$/);
  assert.match(C.composerLabel(out, NOW).refill, /\d+:\d\d [AP]M$/);
  assert.equal(C.dGeometry(out, [], NOW, 180, 64, []).lane, null, "no short-window lane in the strip");
});

test("a reading that still lists a 5-hour window: the README's \"With a 5-hour window too\" cases", () => {
  const withFive = (weekUsed, fableUsed, fiveUsed) => {
    const rec = JSON.parse(t3Record({ claudeWeek: weekUsed, fable: fableUsed }));
    rec.config.providers[0].usageLimits.windows.unshift({ id: "five_hour", kind: "session", label: "Session", usedPercent: fiveUsed, resetsAt: iso(NOW + 2.5 * H), windowDurationMins: 300 });
    const t3 = C.labsFromT3(C.projectT3Config(JSON.stringify(rec), ENV), NOW);
    return C.views(C.mergeLabs(t3, labsFromView(usageView(labUsageRaw(weekUsed, fableUsed), NOW))), NOW, {}).find((v) => v.id === "claude");
  };
  const measure = (t) => String(t).length * 4.8;
  const healthy = withFive(37, 62, 30);
  assert.equal(healthy.shortTag, "5h");
  assert.ok(C.bGeometry(healthy, 120, 10).tank, "the tank is drawn");
  assert.equal(texts(C.sidebarCands(healthy, NOW))[0], "63% left · Fable 38% · 5h 70%");
  assert.equal(C.lineLayout(withFive(20, 30, 38), NOW, 400, measure).text, "80% · 5h 62%");
  // A low Fable and a low 5-hour window, healthy week: tighter first, one line if it fits, else a line each.
  const two = withFive(50, 92, 96);
  const wide = C.lineLayout(two, NOW, 400, measure);
  assert.equal(wide.text, "5h 4% · Fable 8% left");
  assert.equal(wide.wrap, false);
  const narrow = C.lineLayout(two, NOW, 80, measure);
  assert.equal(narrow.wrap, true);
  assert.deepEqual(plain(narrow.lines.map((g) => C.plain(g))), ["5h 4%", "Fable 8% left"]);
  // The week low too: the week first, with the low 5-hour window, then Fable.
  const three = C.lineLayout(withFive(97, 92, 96), NOW, 80, measure);
  assert.equal(three.wrap, true);
  assert.deepEqual(plain(three.lines.map((g) => C.plain(g))), ["3% · 5h 4%", "Fable 8% left"]);
  assert.equal(C.bLegend([healthy]), "Bar: week remaining. Needle position: even weekly pace. Tank level: 5-hour remaining, a separate limit.");
});

