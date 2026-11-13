// Fable's own weekly limit (U1-U10). Invented readings only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { usageView, labsFromView, historySample, parseSample } from "../lib.mjs";
const lc = (t) => t.charAt(0).toLowerCase() + t.slice(1); // the board's "All models: estimated…"

const src = fs.readFileSync(new URL("../public/extras.js", import.meta.url), "utf8");
const load = (code) => {
  const sandbox = { window: { __T3X_TEST__: {} } };
  vm.runInNewContext(code, sandbox);
  return sandbox.window.__T3X_TEST__.core;
};
const C = load(src);
const plain = (v) => JSON.parse(JSON.stringify(v));

const NOW = Date.parse("2026-10-20T02:00:00Z");
const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 86400e3;
const PX = 96 / 20;
const STAND = {
  "55% · Fable 8% left · Sun 3:59 PM": 169,
  "55% · Fable 8% · Sun 3:59 PM": 152,
  "55% · Fable 12% · Wed 11:59 PM": 166,
  "Fable 8% left · Sun 3:59 PM": 138,
  "55% · Fable 8% left": 96,
  "Fable 8% left": 64,
};

function measurer({ weekClock, fiveClock, standWeek = "Sun 3:59 PM", standFive = "1:59 AM", shape14 = false } = {}) {
  return (text) => {
    let s = String(text ?? "");
    if (weekClock) s = s.split(weekClock).join(standWeek);
    if (fiveClock && fiveClock !== weekClock) s = s.split(fiveClock).join(standFive);
    if (shape14) s = s.replaceAll("Fable 14%", "Fable 8%");
    return Object.hasOwn(STAND, s) ? STAND[s] : s.length * PX;
  };
}

/** A Claude lab. week/five/fable/opus are percents used. null means listed with no reading. */
function lab(opts = {}) {
  const fetchedAt = opts.fetchedAt ?? NOW - 2 * MIN;
  const weekAt = opts.weekAt ?? NOW + 3 * DAY;
  const windows = [{
    id: "seven_day", role: "long", kind: "weekly", label: "Weekly",
    usedPct: opts.week ?? 45, resetsAt: weekAt, lengthSec: 7 * 86400, fetchedAt, live: true,
  }];
  if (opts.five !== undefined) {
    windows.push({
      id: "five_hour", role: "short", kind: "session", label: "Session",
      usedPct: opts.five, resetsAt: opts.fiveAt ?? NOW + 2.5 * HOUR, lengthSec: 5 * 3600, fetchedAt, live: true,
    });
  }
  const add = (model, used, at) => windows.push({
    id: `seven_day_${model}`, role: "extra", kind: "weekly", label: "Weekly",
    usedPct: used, resetsAt: at ?? weekAt, lengthSec: opts.scopedLength === null ? null : 7 * 86400,
    fetchedAt: opts.scopedAt ?? fetchedAt, live: opts.scopedLive !== false,
  });
  if (opts.fable !== undefined) add("fable", opts.fable, opts.fableAt);
  if (opts.opus !== undefined) add("opus", opts.opus, opts.opusAt);
  const verdict = opts.verdict === null ? null : {
    tier: "T0", tierName: "T0 normal",
    fableStop: opts.stop === undefined ? null : opts.stop,
    scoped: opts.serviceScoped ?? [],
  };
  return {
    id: opts.id ?? "claude", name: opts.name ?? "Claude", colour: "#d97757",
    source: "t3", canonical: true, enabled: true, fetchedAt, live: opts.live !== false,
    hasMeter: true, windows, resetCredits: null, unavailable: null,
    verdict, verdictLive: opts.verdictLive !== false,
    verdictAt: opts.verdictAt === undefined ? NOW - MIN : opts.verdictAt,
    verdictWeek: opts.serviceWeekAt === null ? null : { resetsAt: opts.serviceWeekAt ?? weekAt, lengthSec: 7 * 86400 },
  };
}
const view = (opts, fails) => C.labView(lab(opts), NOW, fails ?? {});
const textOf = (parts) => C.plain(parts);
const fitted = (v, px, measure) => textOf(C.fitParts(C.sidebarCands(v, NOW), px, measure));

test("parity: labs without a per-model limit match the previous file", () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  // The previous file computes the one-line string but does not export it. Attach it for this comparison only.
  const oldSrc = execFileSync("git", ["show", "HEAD:t3-extras/public/extras.js"], { cwd: repo, encoding: "utf8" })
    .replace("if (W.__T3X_TEST__) {", "core.shortBarText = shortBarText;\n  if (W.__T3X_TEST__) {");
  const old = load(oldSrc);
  const cases = [
    ["week healthy, 5h healthy", { week: 37, five: 20 }],
    ["week healthy, no 5h", { week: 40 }],
    ["week low, 5h healthy", { week: 90, five: 20 }],
    ["week at 100, 5h blocked", { week: 100, five: 10 }],
    ["5h low", { week: 40, five: 80 }],
    ["5h ahead of its clock", { week: 40, five: 40, fiveAt: NOW + 4.5 * HOUR }],
  ];
  for (const [name, opts] of cases) {
    const raw = lab({ ...opts, verdict: null });
    const a = old.labView(raw, NOW, {});
    const b = C.labView(raw, NOW, {});
    assert.equal(C.compactLabel(b, NOW, false), old.compactLabel(a, NOW, false), `${name} wide`);
    assert.equal(C.compactLabel(b, NOW, true), old.compactLabel(a, NOW, true), `${name} narrow`);
    assert.equal(C.shortBarText(b, NOW), old.shortBarText(a, NOW), `${name} one-line`);
    assert.deepEqual(plain(C.composerLabel(b, NOW)), plain(old.composerLabel(a, NOW)), `${name} chip`);
    assert.equal(C.bTooltip(b, NOW), old.bTooltip(a, NOW), `${name} tooltip`);
    // 13 Nov 2026: with no short window the legend no longer names a tank. The file before that change did.
    const oldLegend = b.short ? old.bLegend([a]) : old.bLegend([a]).replace(" Tank level: 5-hour remaining, a separate limit.", "");
    assert.equal(C.bLegend([b]), oldLegend, `${name} legend`);
    assert.deepEqual(plain(C.forecast(b, NOW)), plain(old.forecast(a, NOW)), `${name} forecast`);
    for (const size of ["md", "sm", "lg"]) {
      const h = size === "lg" ? 22 : size === "sm" ? 12 : 17;
      const geo = plain(C.bGeometry(b, 180, h, size));
      assert.deepEqual(geo, plain(old.bGeometry(a, 180, h, size)), `${name} glyph ${size}`);
      assert.equal(geo.fable, undefined, `${name} ${size} adds no second track`);
      assert.equal("needleBelow" in geo, false);
      assert.equal("stop" in geo, false);
    }
  }
});

test("sidebar widths for one low Fable, from the measured stand-in strings", () => {
  const v = view({ week: 45, five: 38, fable: 92, stop: 90 });
  const weekClock = C.fmtClock(v.fable.resetsAt, NOW);
  const measure = measurer({ weekClock });
  assert.match(textOf(C.sidebarCands(v, NOW)[0]), /5h 62%/, "the fullest line still carries the healthy 5-hour window");
  assert.equal(fitted(v, 165, measure), `55% · Fable 8% · ${weekClock}`);
  assert.equal(fitted(v, 145, measure), "55% · Fable 8% left");
  assert.equal(fitted(v, 120, measure), "55% · Fable 8% left");
  assert.equal(fitted(v, 80, measure), "Fable 8% left");
  const atStop = C.fitParts(C.sidebarCands(v, NOW), 165, measure).find((p) => p.t.startsWith("Fable"));
  assert.equal(atStop.t, "Fable 8%");
  assert.equal(atStop.low, true, "at or below the stop, the number keeps the warning colour");
  const bare = view({ week: 45, five: 38, fable: 92, stop: null });
  const barePart = C.fitParts(C.sidebarCands(bare, NOW), 80, measure).find((p) => p.t.startsWith("Fable"));
  assert.equal(barePart.t, "Fable 8% left");
  assert.equal(barePart.low, false, "without a numeric stop the number is not a warning");
});

test("a wider clock gives the refill up and brings the word left back", () => {
  const v = view({ week: 45, five: 38, fable: 88, stop: 90 });
  const measure = measurer({ weekClock: C.fmtClock(v.fable.resetsAt, NOW), standWeek: "Wed 11:59 PM" });
  assert.equal(fitted(v, 165, measure), "55% · Fable 12% left");
  assert.equal(C.fitParts(C.sidebarCands(v, NOW), 165, measure).find((p) => p.t.startsWith("Fable")).low, false);
});

test("Fable 14% uses the same words as 8% and is not a warning while it is above the stop", () => {
  const v = view({ week: 45, five: 38, fable: 86, stop: 90 });
  const weekClock = C.fmtClock(v.fable.resetsAt, NOW);
  const measure = measurer({ weekClock, shape14: true });
  assert.equal(fitted(v, 165, measure), `55% · Fable 14% · ${weekClock}`);
  assert.equal(fitted(v, 145, measure), "55% · Fable 14% left");
  assert.equal(fitted(v, 120, measure), "55% · Fable 14% left");
  assert.equal(fitted(v, 80, measure), "Fable 14% left");
  for (const px of [165, 145, 120, 80]) {
    const part = C.fitParts(C.sidebarCands(v, NOW), px, measure).find((p) => p.t.startsWith("Fable"));
    assert.equal(part.low, false, String(px));
  }
});

test("W3: healthy numbers give way one at a time, the less tight first, then the week's word left", () => {
  const v = view({ week: 20, five: 38, fable: 30, stop: 90 });
  const measure = measurer();
  assert.deepEqual(plain(C.sidebarCands(v, NOW).map(textOf)), ["80% left · Fable 70% · 5h 62%", "80% left · 5h 62%", "80% left", "80%"]);
  assert.equal(C.compactLabel(v, NOW, 200, measure), "80% left · Fable 70% · 5h 62%");
  assert.equal(C.compactLabel(v, NOW, 130, measure), "80% left · 5h 62%");
  assert.equal(C.compactLabel(v, NOW, 60, measure), "80% left");
  assert.equal(C.compactLabel(v, NOW, 30, measure), "80%");
  // The board's case: the 5-hour window has just refilled, so its number is the one that gives way.
  const refilled = view({ week: 40, five: 0, fable: 62 });
  assert.deepEqual(plain(C.sidebarCands(refilled, NOW).map(textOf)), ["60% left · Fable 38% · 5h 100%", "60% left · Fable 38%", "60% left", "60%"]);
  const widths = { "60% left · Fable 38% · 5h 100%": 171.1, "60% left · Fable 38%": 112.4 };
  assert.equal(C.compactLabel(refilled, NOW, 165, (t) => widths[t] ?? 40), "60% left · Fable 38%");
  // A tie keeps the 5-hour window (W1), also when Fable's exact value is the lower one.
  assert.equal(textOf(C.sidebarCands(view({ week: 20, five: 38, fable: 38 }), NOW)[1]), "80% left · 5h 62%");
  assert.equal(textOf(C.sidebarCands(view({ week: 20, five: 38, fable: 38.4 }), NOW)[1]), "80% left · 5h 62%");
  assert.deepEqual(plain(C.sidebarCands(view({ week: 20, fable: 30 }), NOW).map(textOf)), ["80% left · Fable 70%", "80% left", "80%"], "no 5-hour window");
  assert.deepEqual(plain(C.lineCands(v).map(textOf)), ["80% · 5h 62%"], "one line keeps the tighter of Fable and the 5-hour window");
});

test("only the 5-hour window low: Fable is inserted, then today's wording", () => {
  const low = view({ week: 45, five: 80, fable: 30, stop: 90 });
  const wide = C.compactParts(low, NOW).map((p) => p.t).join("");
  const narrow = C.compactParts(low, NOW).filter((p) => !p.rw).map((p) => p.t).join("");
  const cands = C.sidebarCands(low, NOW).map(textOf);
  assert.equal(cands[0], wide.replace(" · ", " · Fable 70% · "));
  assert.equal(cands[1], wide);
  assert.equal(cands[2], narrow);
  assert.equal(cands.length, 3);
  const ahead = view({ week: 45, five: 40, fiveAt: NOW + 4.5 * HOUR, fable: 30 });
  const aheadWide = C.compactParts(ahead, NOW).map((p) => p.t).join("");
  assert.match(aheadWide, /refills /, "ahead of pace still shows a refill");
  assert.equal(textOf(C.sidebarCands(ahead, NOW)[1]), aheadWide);
  assert.match(textOf(C.sidebarCands(ahead, NOW)[0]), /Fable 70%/);
});

test("two low limits and the one-line wrap", () => {
  const v = view({ week: 45, five: 96, fable: 92, stop: 90 });
  const fiveClock = C.fmtClock(v.short.resetsAt, NOW);
  const measure = measurer({ fiveClock, weekClock: C.fmtClock(v.long.resetsAt, NOW) });
  const cands = C.sidebarCands(v, NOW).map(textOf);
  assert.equal(cands[3], `Fable 8% left · 5h 4% · ${fiveClock}`, "the sooner of the two low resets");
  assert.equal(cands[4], "55% · Fable 8% left · 5h 4%");
  assert.equal(cands[5], "Fable 8% left · 5h 4%");
  assert.equal(fitted(v, 165, measure), `Fable 8% left · 5h 4% · ${fiveClock}`);
  assert.equal(fitted(v, 145, measure), "55% · Fable 8% left · 5h 4%");
  assert.equal(fitted(v, 120, measure), "Fable 8% left · 5h 4%");
  assert.equal(fitted(v, 80, measure), "Fable 8% left · 5h 4%");
  assert.equal(C.lineCands(v).length, 1);
  assert.deepEqual(plain(C.lineCands(v)[0].map((p) => p.t)), ["5h 4%", "Fable 8% left"]);
  const layout = C.lineLayout(v, NOW, 40, () => 80);
  assert.equal(layout.wrap, true);
  assert.deepEqual(plain(layout.parts.map((p) => p.t)), ["5h 4%", "Fable 8% left"]);
  assert.deepEqual(plain(layout.lines.map(textOf)), ["5h 4%", "Fable 8% left"], "a healthy week: one named limit per line, tighter first");
  assert.equal(layout.parts.some((p) => p.t.includes("·")), false);
  assert.equal(C.lineLayout(v, NOW, 200, () => 80).lines, null, "one line when the two fit");
});

test("one-line mode leads with a low limit and prefers the 5-hour window on a tie", () => {
  const low = view({ week: 45, five: 38, fable: 92, stop: 90 });
  assert.deepEqual(plain(C.lineCands(low).map(textOf)), ["Fable 8% left · 55%", "Fable 8% left"]);
  assert.equal(C.lineCands(low)[0][0].low, true);
  const out = view({ week: 45, five: 38, fable: 100 });
  assert.deepEqual(plain(C.lineCands(out).map(textOf)), ["Fable out · 55%", "Fable out"]);
  assert.equal(C.lineCands(out)[0][0].low, true, "Fable out is a warning with no numeric stop");
  const tie = view({ week: 20, five: 38, fable: 38 });
  assert.equal(textOf(C.lineCands(tie)[0]), "80% · 5h 62%");
  const fableTighter = view({ week: 20, five: 20, fable: 30 });
  assert.equal(textOf(C.lineCands(fableTighter)[0]), "80% · Fable 70%");
});

test("the chip names Fable only when it is strictly tightest, and zero leaves the comparison", () => {
  // 5-hour at 80% left, so Fable at 70% left is strictly the tightest.
  assert.equal(C.composerLabel(view({ week: 20, five: 20, fable: 30 }), NOW).main, "Claude Fable 70%");
  const low = C.composerLabel(view({ week: 45, five: 38, fable: 92, stop: 90 }), NOW);
  assert.equal(low.main, "Claude Fable 8%");
  assert.equal(low.refill, C.fmtWhen(view({ fable: 92 }).fable.resetsAt));
  assert.equal(low.scopedTight.name, "Fable");
  const zero = view({ week: 45, five: 88, fable: 100 });
  assert.equal(zero.blocked, false);
  assert.equal(C.composerLabel(zero, NOW).main, "Claude 5h 12%");
  assert.equal(C.composerLabel(view({ week: 45, five: 38, fable: 100 }), NOW).main, "Claude 55%");
  const tie = view({ week: 45, five: 38, fable: 45 });
  assert.equal(C.composerLabel(tie, NOW).main, "Claude 55%", "a tie stays with the week");
  const blocked = view({ week: 100, five: 10, fable: 50 });
  assert.equal(blocked.blocked, true, "the week at 100% still blocks the 5-hour window");
  assert.equal(C.composerLabel(blocked, NOW).main, "Claude 0%");
});

test("tooltip, spoken label and popover row use the spec's sentences", () => {
  const healthy = view({ week: 20, five: 38, fable: 30, stop: 90 });
  const elapsed = 4 * DAY;
  const endUsed = 30 + (30 / elapsed) * (3 * DAY);
  assert.ok(Math.abs(endUsed - 52.5) < 1e-6);
  const fc = C.fableForecast(healthy.fable, NOW);
  assert.equal(fc.state, "lasts");
  assert.equal(Math.round(fc.endUsed), Math.round(endUsed));
  const row = C.scopedRowText(healthy.fable, healthy, NOW);
  assert.equal(row.lead, "70% left");
  assert.equal(row.rest, `30% used · about ${Math.round(endUsed)}% used at reset`);
  assert.equal(row.second, "Your rules stop ordinary Fable work at 10% left");
  assert.match(C.bTooltip(healthy, NOW), new RegExp(`Fable: 70% left; resets ${C.fmtWhen(healthy.fable.resetsAt).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
  assert.equal(C.spokenUsage(healthy), "Week 80% left, 5-hour 62% left, Fable 70% left");
  const lines = C.forecastBlocks(healthy, NOW).lines;
  assert.deepEqual(plain(lines.map((l) => l.text)), [C.forecast(healthy, NOW).text]);

  const atStop = view({ week: 45, five: 38, fable: 92, stop: 90 });
  const stopRow = C.scopedRowText(atStop.fable, atStop, NOW);
  assert.equal(stopRow.lead, "8% left");
  assert.match(stopRow.rest, /^92% used · refills /);
  assert.equal(stopRow.second, "At or below your 10% stop: your rules don't allow ordinary Fable work");
  const runOut = C.fableForecast(atStop.fable, NOW);
  // forecast() anchors on the reading's own time, not on now, and on Fable's own window start.
  const rate = 92 / (atStop.fable.fetchedAt - atStop.fable.epochStart);
  const crossing = atStop.fable.fetchedAt + (100 - 92) / rate;
  assert.equal(runOut.state, "out");
  assert.ok(Math.abs(runOut.crossing - crossing) < 2);
  assert.notEqual(Math.round(runOut.endUsed), Math.round(C.forecast(atStop, NOW).endUsed));
  assert.deepEqual(plain(C.forecastBlocks(atStop, NOW).lines.map((l) => l.text)), [
    `All models: ${lc(C.forecast(atStop, NOW).text)}`,
    `Fable: estimated to run out ${C.fmtWhen(runOut.crossing)} at this pace`,
  ]);

  const out = view({ week: 45, five: 38, fable: 100, stop: 90 });
  assert.deepEqual(plain(C.scopedRowText(out.fable, out, NOW)), { lead: "0% left", rest: "100% used", second: null, warn: false });
  assert.equal(C.forecastBlocks(out, NOW).lines[1].text, `Fable: limit reached; refills ${C.fmtWhen(out.fable.resetsAt)}`);
  assert.match(C.bTooltip(out, NOW), /Fable: 0% left; resets /);
  assert.match(C.spokenUsage(out), /Fable 0% left/);

  const stale = view({ week: 45, five: 38, fable: 92, stop: 90, scopedAt: NOW - 20 * MIN });
  assert.equal(stale.stale, false, "a fresh week does not make the scoped reading fresh");
  assert.equal(stale.fable.stale, true);
  assert.equal(C.forecastBlocks(stale, NOW).lines[1].text, "Fable: no estimate yet");
  assert.match(C.forecastBlocks(stale, NOW).lines[0].text, /^All models: estimated to last/);
});

test("the glyph: two tracks, the tank on the week only, the tick only on the big Fable bar", () => {
  const v = view({ week: 45, five: 38, fable: 92, stop: 90 });
  const lg = C.bGeometry(v, 200, 22, "lg");
  assert.equal(lg.track.h, 10);
  assert.equal(lg.track.y, (22 - 10 - 3 - 6) / 2);
  assert.equal(lg.fable.track.h, 6);
  assert.equal(lg.fable.track.y, lg.track.y + 10 + 3);
  assert.equal(lg.fable.fillW, Math.max(6, 200 * 8 / 100));
  assert.equal(lg.fable.zero, null);
  assert.equal(lg.needle, null, "a 5-hour tank leaves no needle on the week");
  assert.ok(lg.needleBelow && lg.needleBelow.y1 < lg.needleBelow.y2);
  assert.equal(lg.tank.twin, true);
  assert.equal(lg.stop.x, 200 * 10 / 100);
  assert.equal(C.bGeometry(v, 200, 17, "md").stop, null);
  assert.equal(C.bGeometry(v, 200, 12, "sm").stop, null);
  const zero = C.bGeometry(view({ week: 45, fable: 100, stop: 90 }), 200, 22, "lg");
  assert.equal(zero.fable.fillW, 0);
  assert.deepEqual(plain(zero.fable.zero), { x: 0, y: zero.fable.track.y - 1, w: 3, h: 8 });
  assert.equal(zero.stop, null, "no tick at zero");
  assert.equal(C.bGeometry(view({ week: 45, fable: 100 }), 200, 17, "md").fable.zero.w, 2);
  const together = C.bGeometry(view({ week: 45, fable: 30 }), 200, 17, "md");
  assert.deepEqual(plain(together.needle), { x: together.needle.x, y1: 0, y2: 17 });
  assert.equal(together.needleBelow, undefined);
  const apart = C.bGeometry(view({ week: 45, fable: 30, fableAt: (view({ week: 45 }).long.resetsAt) + 3 * HOUR }), 200, 17, "md");
  const wkBot = Math.min(17, apart.track.y + apart.track.h + 1.5);
  assert.equal(apart.needle.y1, 0);
  assert.equal(apart.needle.y2, wkBot);
  const close = view({ week: 45, fable: 30, fableAt: view({ week: 45 }).long.resetsAt + 90e3 });
  assert.equal(C.resetsTogether(close.long.resetsAt, close.fable.resetsAt), true);
  assert.equal(C.bGeometry(close, 200, 17, "md").needle.y2, 17);
  assert.equal(C.bGeometry(view({ week: 45, fable: 30, stop: 101 }), 200, 22, "lg").stop, null);
  assert.equal(C.bGeometry(view({ week: 45, fable: 30, stop: -1 }), 200, 22, "lg").stop, null);
  assert.equal(view({ week: 45, fable: 30, stop: 0 }).stopLeft, 100);
  assert.equal(view({ week: 45, fable: 30, stop: 100 }).stopLeft, 0);
  assert.equal(view({ week: 45, fable: 30, stop: 90, verdictAt: null }).stopLeft, null);
  assert.equal(view({ week: 45, fable: 30, stop: 90, verdictAt: NOW - 11 * MIN }).stopLeft, null);
  assert.equal(view({ week: 45, fable: 30, stop: 90 }, { labUsage: NOW }).stopLeft, null);
});

test("legend sentences follow the thin bar and the tick", () => {
  const tick = view({ week: 45, fable: 30, stop: 90 });
  assert.deepEqual(plain(C.fableLegend([tick])), [
    "Strip: thick line = all models, thin line = Fable, both % used.",
    "Thin bar: Fable's own weekly limit, same refill. Tick: your rules stop ordinary Fable work at 10% left.",
  ]);
  const apart = view({ week: 45, fable: 30, stop: 90, fableAt: tick.long.resetsAt + 3 * HOUR });
  assert.equal(C.fableLegend([apart])[1], "Thin bar: Fable's own weekly limit. Tick: your rules stop ordinary Fable work at 10% left.");
  const zero = view({ week: 45, fable: 100, stop: 90 });
  assert.deepEqual(plain(C.fableLegend([zero])), [
    "Strip: thick line = all models, thin line = Fable, both % used.",
    "Thin bar: Fable's own weekly limit, same refill.",
  ]);
  assert.deepEqual(plain(C.fableLegend([view({ week: 45 })])), []);
});

test("merge, unread rows, a second model, and a stop that applies only to Fable", () => {
  const both = view({ week: 45, fable: 15, serviceScoped: [{ model: "fable", usedPct: 90 }, { model: "opus", usedPct: 80 }] });
  assert.equal(both.fable.used, 15);
  assert.equal(both.fable.source, "t3");
  assert.equal(both.scoped.find((e) => e.model === "opus").source, "lab-usage");
  assert.equal(both.barScoped.model, "opus", "the sidebar draws the tightest per-model limit");
  assert.equal(C.bGeometry(both, 200, 22, "lg").stop, null, "the tick is Fable's, and this bar is Opus");
  assert.equal(C.scopedRowText(both.scoped.find((e) => e.model === "opus"), both, NOW).second, null);
  const own = view({ serviceScoped: [{ model: "fable", usedPct: 40 }], serviceWeekAt: NOW + DAY });
  assert.equal(own.fable.source, "lab-usage");
  assert.equal(own.fable.resetsAt, NOW + DAY, "lab-usage's reading keeps lab-usage's own reset");
  assert.notEqual(own.fable.resetsAt, own.long.resetsAt, "T3's week is never lent to it");
  const unread = view({ fable: null, serviceScoped: [{ model: "opus", usedPct: null }] });
  assert.equal(unread.barScoped, null);
  assert.deepEqual(plain(unread.scopedNoReading.map((e) => e.name)), ["Fable", "Opus"]);
  assert.match(C.bTooltip(unread, NOW), /Fable: no reading\./);
  assert.match(C.bTooltip(unread, NOW), /Opus: no reading\./);
  assert.match(C.spokenUsage(unread), /Fable: no reading/);
  assert.equal(C.compactLabel(unread, NOW).includes("Fable"), false, "a missing reading draws no bar and no sidebar words");
  assert.equal(C.bGeometry(unread, 200, 17, "md").fable, undefined);
  const ENV = "11111111-2222-4333-8444-555555555555";
  const projected = C.projectT3Config({
    schemaVersion: 1, environmentId: ENV,
    config: { providers: [{ instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, usageLimits: {
      checkedAt: new Date(NOW).toISOString(),
      windows: [
        { id: "seven_day", kind: "weekly", usedPercent: 45, resetsAt: new Date(NOW + 3 * DAY).toISOString(), windowDurationMins: 10080 },
        { id: "seven_day_fable", kind: "weekly", usedPercent: null, resetsAt: new Date(NOW + 3 * DAY).toISOString(), windowDurationMins: 10080 },
      ],
    } }] },
  }, ENV);
  const fromT3 = C.labsFromT3(projected, NOW).claude;
  assert.equal(fromT3.windows.find((w) => w.id === "seven_day_fable").usedPct, null);
  const listed = C.labView(C.mergeLabs({ claude: fromT3 }, [])[0] ? C.mergeLabs({ claude: fromT3 }, []).find((l) => l.id === "claude") : fromT3, NOW, {});
  assert.equal(listed.scopedNoReading[0].name, "Fable");
});

test("lab-usage exposes the numeric stop and does not turn a per-model limit into a window", () => {
  const raw = {
    now: 1792447000,
    claude: {
      age_min: 1,
      windows: [{ name: "5-hour", used: 21, resets_at: 1792457999, mins: 300 }, { name: "week", used: 18, resets_at: 1792961999, mins: 10080 }],
      scoped: [{ model: "fable", used: 12 }],
      conserve: { tier: 0, tier_name: "T0 normal", fable_stop: 90, stops: [] },
    },
    codex: null,
  };
  const got = usageView(raw, 1792447000000);
  assert.equal(got.claude.fableStop, 90);
  assert.equal(got.claude.scoped[0].usedPct, 12);
  assert.deepEqual(labsFromView(got)[0].windows.map((w) => w.role), ["short", "long"]);
  assert.equal(labsFromView(got)[0].verdict.fableStop, 90);
  assert.equal(usageView({ ...raw, claude: { ...raw.claude, conserve: { tier: 0 } } }, 1792447000000).claude.fableStop, null);
  assert.equal(usageView({ ...raw, claude: { ...raw.claude, conserve: { fable_stop: null } } }, 1792447000000).claude.fableStop, null);
  assert.equal(usageView({ ...raw, claude: { ...raw.claude, conserve: { fable_stop: 101 } } }, 1792447000000).claude.fableStop, 101);
  const sample = historySample("claude", "scoped:fable", { usedPct: 12.5, resetsAt: NOW + DAY, lengthSec: 604800 }, NOW);
  assert.equal(sample.s, "claude:scoped:fable");
  assert.deepEqual(parseSample(JSON.stringify(sample)), sample);
  assert.equal(historySample("claude", "extra", { usedPct: 1, resetsAt: NOW, lengthSec: 1 }, NOW), null);
  assert.equal(historySample("claude", "scoped:Fable", { usedPct: 1, resetsAt: NOW, lengthSec: 1 }, NOW), null);
  const v = view({ week: 45, fable: 30 });
  const samples = [{ ts: v.epochStart + 30 * MIN, used: 4, resetsAt: v.long.resetsAt }];
  const fableSamples = [{ ts: v.fable.epochStart + 40 * MIN, used: 6, resetsAt: v.fable.resetsAt }];
  const strip = C.dGeometry(v, samples, NOW, 300, 64, fableSamples);
  const bare = C.dGeometry(v, samples, NOW, 300, 64);
  assert.deepEqual(strip.segs, bare.segs);
  assert.deepEqual(strip.estimate, bare.estimate);
  assert.equal(strip.cur[0], bare.cur[0]);
  assert.ok(strip.fableSegs.length >= 1);
  assert.ok(strip.fableCur);
  assert.equal(C.dGeometry(view({ week: 45 }), samples, NOW, 300, 64, fableSamples).fableSegs, undefined);
});

const FABLE = [["70", 30], ["14", 86], ["8", 92], ["0", 100], ["unread", null], ["absent", "none"]];
const FIVE = [["none", "none"], ["healthy", 38], ["low", 88]];
const STOPS = [["stop", 90], ["nostop", null]];

for (const [fableName, fableUsed] of FABLE) {
  for (const [fiveName, fiveUsed] of FIVE) {
    for (const [stopName, stop] of STOPS) {
      test(`matrix ${fableName} / 5h ${fiveName} / ${stopName}`, () => {
        const opts = { week: 45, stop };
        if (fiveUsed !== "none") opts.five = fiveUsed;
        if (fableUsed !== "none") opts.fable = fableUsed;
        const v = view(opts);
        const fiveLeft = fiveUsed === "none" ? null : Math.round(100 - fiveUsed);
        const fableLeft = fableUsed === "none" || fableUsed === null ? null : Math.round(100 - fableUsed);
        assert.equal(v.blocked, false);
        if (fableUsed === "none") {
          assert.equal(v.fable, null);
          assert.equal(v.barScoped, null);
          assert.equal(C.sidebarCands(v, NOW), null);
          assert.equal(C.spokenUsage(v), null);
          assert.doesNotMatch(C.bTooltip(v, NOW), /Fable/);
          assert.equal(C.bGeometry(v, 200, 22, "lg").fable, undefined);
          assert.equal(C.forecastBlocks(v, NOW).lines.length, 1);
          return;
        }
        if (fableUsed === null) {
          assert.equal(v.barScoped, null);
          assert.equal(v.scopedNoReading[0].name, "Fable");
          assert.match(C.bTooltip(v, NOW), /Fable: no reading\./);
          assert.match(C.spokenUsage(v), /Fable: no reading/);
          assert.equal(C.compactLabel(v, NOW).includes("Fable"), false);
          assert.equal(C.bGeometry(v, 200, 22, "lg").fable, undefined);
          return;
        }
        assert.equal(v.fable.left, fableLeft);
        assert.match(C.bTooltip(v, NOW), new RegExp(`Fable: ${fableLeft}% left; resets .+\\.`));
        assert.match(C.spokenUsage(v), new RegExp(`Fable ${fableLeft}% left`));
        const row = C.scopedRowText(v.fable, v, NOW);
        if (fableLeft === 0) {
          assert.equal(row.lead, "0% left");
          assert.equal(row.rest, "100% used");
          assert.equal(row.second, null);
        } else if (fableLeft <= 15) {
          assert.equal(row.lead, `${fableLeft}% left`);
          assert.match(row.rest, new RegExp(`^${100 - fableLeft}% used · refills `));
        } else {
          assert.equal(row.lead, `${fableLeft}% left`);
          assert.match(row.rest, new RegExp(`^${100 - fableLeft}% used`));
        }
        if (stop !== null && fableLeft > 0) {
          const at = fableLeft <= v.stopLeft;
          assert.equal(row.second, at
            ? `At or below your ${Math.round(v.stopLeft)}% stop: your rules don't allow ordinary Fable work`
            : `Your rules stop ordinary Fable work at ${Math.round(v.stopLeft)}% left`);
        } else assert.equal(row.second, null);
        const geo = C.bGeometry(v, 200, 22, "lg");
        assert.ok(geo.fable);
        assert.equal(geo.stop === null, !(stop !== null && fableLeft > 0));
        if (fableLeft <= 15) {
          for (const cand of C.sidebarCands(v, NOW)) assert.match(textOf(cand), /Fable/);
        }
        const chipLefts = [{ name: "", left: v.lp.leftExact, mid: "" }];
        if (v.short && !v.blocked) chipLefts.push({ name: "5h", left: v.sp.leftExact, mid: "5h " });
        if (fableLeft > 0) chipLefts.push({ name: "Fable", left: fableLeft, mid: "Fable " });
        const tight = chipLefts.reduce((a, b) => (b.left < a.left ? b : a));
        assert.equal(C.composerLabel(v, NOW).main, `Claude ${tight.mid}${tight.left === v.lp.leftExact && tight.name === "" ? Math.round(v.minLeft) : Math.round(tight.left)}%`);
        const fc = C.fableForecast(v.fable, NOW);
        const alarm = fableLeft === 0 || (stop !== null && fableLeft > 0 && fableLeft <= v.stopLeft) || fc.state === "out";
        const blocks = C.forecastBlocks(v, NOW).lines;
        if (!alarm) assert.deepEqual(plain(blocks.map((l) => l.text)), [C.forecast(v, NOW).text]);
        else {
          assert.equal(blocks[0].text, `All models: ${lc(C.forecast(v, NOW).text)}`);
          if (fableLeft === 0) assert.equal(blocks[1].text, `Fable: limit reached; refills ${C.fmtWhen(v.fable.resetsAt)}`);
          else if (fc.state === "out") assert.equal(blocks[1].text, `Fable: estimated to run out ${fc.crossing <= NOW ? "about now" : C.fmtWhen(fc.crossing)} at this pace`);
          else assert.equal(blocks[1].text, "Fable: estimated to last until reset at this pace.");
        }
        if (fiveLeft !== null) assert.match(C.spokenUsage(v), new RegExp(`5-hour ${fiveLeft}% left`));
      });
    }
  }
}

// ---- review round 1 (F1-F7, S1-S5): literal strings from FINAL-d33d65bc.md ----

test("F1: a reading only lab-usage reports is dated and forecast by lab-usage's own week", () => {
  const t3 = lab({ week: 20 });
  delete t3.verdict; delete t3.verdictLive; delete t3.verdictAt; delete t3.verdictWeek;
  const service = {
    id: "claude", name: "Claude", colour: "#d97757", source: "lab-usage", live: true, fetchedAt: NOW - MIN,
    windows: [{ id: "cwk", role: "long", kind: "weekly", label: "Week", usedPct: 20, resetsAt: NOW + DAY, lengthSec: 7 * 86400, fetchedAt: NOW - MIN, live: true }],
    verdict: { tier: "T0", tierName: "T0 normal", fableStop: 90, scoped: [{ model: "fable", usedPct: 60 }] },
  };
  const merged = C.mergeLabs({ claude: t3 }, [service]).find((l) => l.id === "claude");
  const v = C.labView(merged, NOW, {});
  assert.equal(v.long.resetsAt, NOW + 3 * DAY, "the week shown is T3's");
  assert.equal(v.fable.resetsAt, NOW + DAY, "Fable keeps the service's reset");
  const fc = C.fableForecast(v.fable, NOW);
  assert.equal(fc.state, "lasts", "60% used six days into a seven-day window lasts until its reset");
  assert.equal(Math.round(fc.endUsed), 70);
  assert.equal(C.scopedRowText(v.fable, v, NOW).rest, "60% used · about 70% used at reset");
  assert.match(C.bTooltip(v, NOW), new RegExp(`Fable: 40% left; resets ${C.fmtWhen(NOW + DAY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
  const noWeek = view({ serviceScoped: [{ model: "fable", usedPct: 60 }], serviceWeekAt: null });
  assert.equal(noWeek.fable.resetsAt, null);
  assert.match(C.bTooltip(noWeek, NOW), /Fable: 40% left\./, "no reset clause without a reset");
});

test("F2: Fable at or below the stop keeps the warning colour on every candidate, also when the week is low", () => {
  const v = view({ week: 90, fable: 30, stop: 20 }); // week 10% left, Fable 70% left, stop at 80% left
  const cands = C.sidebarCands(v, NOW);
  assert.equal(textOf(cands[0]), `10% left · Fable 70% · week refills ${C.fmtClock(v.long.resetsAt, NOW)}`);
  for (const c of cands) for (const p of c) if (p.t.startsWith("Fable")) assert.equal(p.low, true, textOf(c));
  assert.equal(cands[0].some((p) => p.low), true);
  const five = view({ week: 45, five: 80, fable: 30, stop: 20 }); // only the 5-hour window low
  assert.equal(C.sidebarCands(five, NOW)[0].find((p) => p.t === "Fable 70%").low, true);
});

test("F4: one-line mode reads exactly as today whenever Fable is not low", () => {
  const today = (opts) => { const { fable, ...rest } = opts; return C.shortBarText(view(rest), NOW); };
  const fiveOnly = { week: 45, five: 80, fable: 30 };
  const vFive = view(fiveOnly);
  assert.equal(C.lineLayout(vFive, NOW, 85, () => 60).text, `55% · 5h 20% · ${C.fmtClock(vFive.short.resetsAt, NOW)}`);
  assert.equal(C.lineLayout(vFive, NOW, 85, () => 60).parts, null);
  assert.equal(C.shortBarText(vFive, NOW), today(fiveOnly));
  const weekOnly = { week: 90, five: 38, fable: 30 };
  const vWeek = view(weekOnly);
  assert.equal(C.shortBarText(vWeek, NOW), `10% · 5h 62% · ${C.fmtClock(vWeek.long.resetsAt, NOW)}`);
  assert.equal(C.shortBarText(vWeek, NOW), today(weekOnly));
  const blocked = { week: 100, five: 10, fable: 50 };
  const vBlocked = view(blocked);
  assert.equal(C.shortBarText(vBlocked, NOW), `0% · 5h blocked · ${C.fmtClock(vBlocked.long.resetsAt, NOW)}`);
  assert.equal(C.shortBarText(vBlocked, NOW), today(blocked));
  const ahead = { week: 45, five: 40, fiveAt: NOW + 4.5 * HOUR, fable: 30 };
  assert.match(C.shortBarText(view(ahead), NOW), /^55% · 5h 60% · /, "ahead of the 5-hour clock keeps today's refill clock");
  assert.equal(C.shortBarText(view(ahead), NOW), today(ahead));
  assert.equal(C.shortBarText(view({ week: 20, five: 38, fable: 30 }), NOW), "80% · 5h 62%");
  assert.equal(C.lineLayout(view({ week: 45, five: 38, fable: 92 }), NOW, 200, () => 60).keep, true);
});

test("S1: a week at 15% left or less is a low limit, so its number never gives way", () => {
  const v = view({ week: 97, five: 38, fable: 92, stop: 90 }); // week 3%, Fable 8%
  const side = C.sidebarCands(v, NOW).map(textOf);
  assert.equal(side.at(-1), "3% · Fable 8% left");
  for (const t of side) assert.match(t, /^3%/, t);
  assert.deepEqual(plain(C.lineCands(v).map(textOf)), ["3% · Fable 8% left"], "W4: the week's group first");
  const three = view({ week: 97, five: 96, fable: 92, stop: 90 });
  for (const t of C.sidebarCands(three, NOW).map(textOf)) assert.match(t, /^3%/, t);
  assert.deepEqual(plain(C.lineCands(three).map(textOf)), ["3% · 5h 4% · Fable 8% left"]);
  const healthyWeek = view({ week: 45, five: 38, fable: 92, stop: 90 });
  assert.equal(C.sidebarCands(healthyWeek, NOW).map(textOf).at(-1), "Fable 8% left", "a healthy week still gives way last");
});

test("S2: with two low limits the refill time sits after the limit it belongs to, which goes last", () => {
  const fiveSooner = view({ week: 45, five: 96, fable: 92, stop: 90 });
  assert.equal(textOf(C.sidebarCands(fiveSooner, NOW)[0]), `55% left · Fable 8% left · 5h 4% · refills ${C.fmtClock(fiveSooner.short.resetsAt, NOW)}`);
  const fableSooner = view({ week: 45, five: 96, fiveAt: NOW + 4 * HOUR, fable: 92, fableAt: NOW + HOUR, stop: 90 });
  const cands = C.sidebarCands(fableSooner, NOW).map(textOf);
  assert.equal(cands[0], `55% left · 5h 4% · Fable 8% left · refills ${C.fmtClock(NOW + HOUR, NOW)}`);
  assert.equal(cands[3], `5h 4% · Fable 8% left · ${C.fmtClock(NOW + HOUR, NOW)}`);
  assert.equal(cands[5], "5h 4% · Fable 8% left");
});

test("S3: below a tank the needle crosses the Fable bar only when the two limits refill together", () => {
  const together = C.bGeometry(view({ week: 20, five: 30, fable: 30 }), 200, 17, "md");
  assert.equal(together.needleBelow.y2, 17);
  const apart = C.bGeometry(view({ week: 20, five: 30, fable: 30, fableAt: NOW + 3 * DAY + 3 * HOUR }), 200, 17, "md");
  assert.equal(apart.needleBelow, undefined);
  assert.ok(apart.tank && apart.fable, "the tank and the Fable bar are still drawn");
});

test("F3: the service logs a Fable reading that only lab-usage reports", () => {
  const code = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const from = code.indexOf("function logHistory(");
  const body = code.slice(from, code.indexOf("\nsetInterval(", from));
  const captured = [];
  const ctx = { historySample, SAMPLE_MAX_AGE_MS: 15 * MIN, history: { append: (x) => captured.push(...x) }, log: () => {} };
  vm.runInNewContext(`${body};this.run = logHistory;`, ctx);
  const raw = { now: NOW / 1000, claude: { age_min: 1, windows: [{ name: "week", used: 20, resets_at: (NOW + 3 * DAY) / 1000, mins: 10080 }], scoped: [{ model: "fable", used: 30 }], conserve: {} }, codex: null };
  ctx.run(labsFromView(usageView(raw, NOW)), NOW);
  const fable = captured.find((x) => x.s === "claude:scoped:fable");
  assert.deepEqual(plain(fable), { ts: NOW - MIN, s: "claude:scoped:fable", used: 30, resetsAt: NOW + 3 * DAY, lengthSec: 604800 });
  assert.ok(captured.some((x) => x.s === "claude:long"));
  assert.deepEqual(plain(parseSample(JSON.stringify(fable))), plain(fable), "the history file reads the series back");
  captured.length = 0;
  raw.claude.age_min = 30; // an old reading is not logged, for the week or for Fable
  ctx.run(labsFromView(usageView(raw, NOW)), NOW);
  assert.equal(captured.length, 0);
});

test("review round 2: an unknown per-model reset is never the same refill", () => {
  const v = view({ week: 20, serviceScoped: [{ model: "fable", usedPct: 30 }], serviceWeekAt: null });
  assert.equal(v.fable.resetsAt, null);
  assert.equal(C.resetsTogether(v.long.resetsAt, null), false);
  assert.equal(C.resetsTogether(null, null), false);
  const g = C.bGeometry(v, 200, 17, "md");
  assert.ok(g.needle.y2 < g.fable.track.y, "the needle stays on the week's bar");
  const tank = C.bGeometry(view({ week: 20, five: 30, serviceScoped: [{ model: "fable", usedPct: 30 }], serviceWeekAt: null }), 200, 17, "md");
  assert.equal(tank.needleBelow, undefined, "no continuation below the tank");
  assert.deepEqual(plain(C.fableLegend([v])), ["Strip: thick line = all models, thin line = Fable, both % used.", "Thin bar: Fable's own weekly limit."]);
  const same = view({ week: 20, fable: 30 });
  assert.equal(C.fableLegend([same])[1], "Thin bar: Fable's own weekly limit, same refill.");
  assert.equal(C.bGeometry(same, 200, 17, "md").needle.y2, 17);
});

test("review round 2: Fable out lists no candidate twice", () => {
  const out = view({ week: 45, five: 38, fable: 100 });
  const cands = C.sidebarCands(out, NOW).map(textOf);
  const fittedAll = [400, 300, 200, 150, 120, 100, 60].map((px) => fitted(out, px, measurer()));
  assert.ok(fittedAll.every((t) => t.includes("Fable out")));
  assert.equal(new Set(cands).size, cands.length - 1, "the candidate list still has the repeat; fitParts skips it");
});

// W1-W4: the four additions Andy confirmed on 13 Nov 2026. Widths are the ones measured at the
// app's font (500 11 px) for the 226 px sidebar: one-line column 84.4 px.
const W_PX = 84.4;
const W_WIDTHS = {
  "80% · 5h 62%": 76.5, "60% · Fable 38%": 91.4, "30% · Fable 38%": 91.4, "38% · Fable 38%": 91.4, "Fable 38%": 56.8, "60% · 5h 100%": 83.6, "30% · 5h 100%": 83.6,
  "Fable 8% left": 70.7, "3% · 5h 4%": 62.2, "3% · Fable 8% left": 98.1, "0% · 5h blocked": 86.7, "3% · Fable out": 81,
};
const wMeasure = (t) => W_WIDTHS[t] ?? String(t).length * 5.6;
const lineAt = (opts, px = W_PX) => C.lineLayout(view(opts), NOW, px, wMeasure);

test("W1: equal shown numbers go to the broader limit, in one-line mode and on the chip", () => {
  // Both low at 8%: the 5-hour window first, also when Fable's exact value is a little lower.
  assert.deepEqual(plain(C.lineGroups(view({ week: 45, five: 92, fable: 92, stop: 90 })).map(textOf)), ["5h 8%", "Fable 8% left"]);
  assert.deepEqual(plain(C.lineGroups(view({ week: 45, five: 91.6, fable: 92.4, stop: 90 })).map(textOf)), ["5h 8%", "Fable 8% left"]);
  // Strictly lower by the shown number: Fable first.
  assert.deepEqual(plain(C.lineGroups(view({ week: 45, five: 91, fable: 92, stop: 90 })).map(textOf)), ["Fable 8% left", "5h 9%"]);
  // Both at zero.
  assert.deepEqual(plain(C.lineGroups(view({ week: 45, five: 100, fable: 100 })).map(textOf)), ["5h 0%", "Fable out"]);
  assert.deepEqual(plain(C.lineGroups(view({ week: 100, five: 10, fable: 100 })).map(textOf)), ["0% · 5h blocked", "Fable out"], "5h blocked above Fable out");
  // Healthy: the second number is Fable's only when it is strictly lower as shown.
  assert.equal(textOf(C.lineCands(view({ week: 20, five: 38, fable: 38 }))[0]), "80% · 5h 62%");
  assert.equal(textOf(C.lineCands(view({ week: 20, five: 38, fable: 38.4 }))[0]), "80% · 5h 62%", "61.6 and 62 both show 62%");
  assert.equal(textOf(C.lineCands(view({ week: 20, five: 38, fable: 39 }))[0]), "80% · Fable 61%");
  // The chip.
  assert.equal(C.composerLabel(view({ week: 20, five: 38, fable: 38 }), NOW).main, "Claude 5h 62%", "5h and Fable tie: the 5-hour window");
  assert.equal(C.composerLabel(view({ week: 20, five: 38, fable: 38.4 }), NOW).main, "Claude 5h 62%");
  assert.equal(C.composerLabel(view({ week: 38, five: 20, fable: 38.3 }), NOW).main, "Claude 62%", "the week and Fable tie: the week");
  assert.equal(C.composerLabel(view({ week: 38, five: 38.4, fable: 38.4 }), NOW).main, "Claude 62%", "all three tie: the week");
  assert.equal(C.composerLabel(view({ week: 38, five: 20, fable: 39 }), NOW).main, "Claude Fable 61%");
  assert.equal(C.composerLabel(view({ week: 45, five: 38, fable: 100 }), NOW).main, "Claude 55%", "a per-model limit at zero still leaves the comparison");
});

test("W2: one-line mode, healthy, when the approved line does not fit with Fable second", () => {
  // Shown whenever it fits.
  assert.equal(lineAt({ week: 40, five: 0, fable: 62 }, 100).text, "60% · Fable 38%");
  // Fable's number is lower than the week's: the week's number gives way.
  const fableLowest = lineAt({ week: 40, five: 0, fable: 62 });
  assert.equal(fableLowest.text, "Fable 38%");
  assert.equal(fableLowest.keep, false);
  assert.equal(fableLowest.wrap, false);
  // The week is lower: today's line, with or without a 5-hour window.
  assert.equal(lineAt({ week: 70, five: 0, fable: 62 }).text, "30% · 5h 100%");
  assert.equal(lineAt({ week: 70, five: 0, fable: 62 }).text, C.shortBarText(view({ week: 70, five: 0 }), NOW));
  assert.equal(lineAt({ week: 70, fable: 62 }).text, "30%");
  assert.equal(lineAt({ week: 62, five: 0, fable: 62 }).text, "38% · 5h 100%", "equal numbers: the week's stays");
  // The 5-hour window is the tighter one: the approved line, one candidate.
  assert.deepEqual(plain(C.lineCands(view({ week: 40, five: 52, fable: 30 })).map(textOf)), ["60% · 5h 48%"]);
});

test("W4: one-line mode, the week low and Fable low: two groups, the week's first, two lines at most", () => {
  const three = lineAt({ week: 97, five: 96, fable: 92, stop: 90 });
  assert.equal(three.wrap, true);
  assert.deepEqual(plain(three.lines.map(textOf)), ["3% · 5h 4%", "Fable 8% left"]);
  assert.equal(three.keep, true);
  const two = lineAt({ week: 97, five: 38, fable: 92, stop: 90 });
  assert.deepEqual(plain(two.lines.map(textOf)), ["3%", "Fable 8% left"], "a healthy 5-hour window is not in the week's group");
  assert.deepEqual(plain(two.lines.flat().map((p) => p.low)), [false, true], "the week's number keeps its colour; Fable's follows the stop");
  // Fable lower than the low week: the week's line still comes first.
  assert.deepEqual(plain(lineAt({ week: 88, five: 38, fable: 95, stop: 90 }).lines.map(textOf)), ["12%", "Fable 5% left"]);
  // The two groups share one line when they fit.
  const out = lineAt({ week: 97, five: 38, fable: 100 });
  assert.equal(out.wrap, false);
  assert.equal(out.text, "3% · Fable out");
  assert.equal(out.lines, null);
  // The week used up.
  assert.deepEqual(plain(lineAt({ week: 100, five: 10, fable: 100 }).lines.map(textOf)), ["0% · 5h blocked", "Fable out"]);
  // A healthy week is unchanged: a low Fable leads and the week's number gives way.
  assert.deepEqual(plain(C.lineCands(view({ week: 45, five: 38, fable: 92, stop: 90 })).map(textOf)), ["Fable 8% left · 55%", "Fable 8% left"]);
  assert.equal(C.lineGroups(view({ week: 45, five: 38, fable: 92, stop: 90 })), null);
  assert.equal(C.lineGroups(view({ week: 20, five: 38, fable: 30 })), null);
});
