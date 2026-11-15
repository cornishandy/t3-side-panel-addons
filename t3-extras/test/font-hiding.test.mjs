// Font hiding, stacked Width, the screen-readability block and Story (14 Nov 2026).
// Pure parts only. Layout of the ✦ Hide control is checked in the headless shots.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fontCatalogProjection, fontAboutProjection } from "../lib.mjs";
import { aboutRecords } from "../tools/fonts.mjs";

const src = fs.readFileSync(new URL("../public/extras.js", import.meta.url), "utf8");
const sandbox = { window: { __T3X_TEST__: {} } };
vm.runInNewContext(src, sandbox);
const C = sandbox.window.__T3X_TEST__.core;
const plain = (v) => JSON.parse(JSON.stringify(v));
const fonts = JSON.parse(fs.readFileSync(new URL("../fonts.json", import.meta.url), "utf8"));
const F = fonts.families;
const catalog = F;
const fam = (name) => C.normalizeCatalog(fontCatalogProjection(fonts)).find((f) => f.name === name);
const names = (groups) => groups.flatMap((g) => g.options).map((o) => o.name);
const NEW12 = ["Chiron GoRound TC", "Mochiy Pop One", "Stick", "Darumadrop One", "Short Stack", "Itim", "Mali", "Comic Relief", "Crafty Girls", "Swanky and Moo Moo", "Fuzzy Bubbles", "Delius"];
const UI = fonts.measuredWith.uiWidth;

test("hiding is saved beside the filters, off and empty until set", () => {
  const d = C.readSettings(null);
  assert.equal(d.showHidden, false);
  assert.deepEqual(plain(d.hiddenFonts), []);
  const s = C.readSettings(JSON.stringify({ showHidden: true, hiddenFonts: ["Klee One", "Klee One", "<b>", "off", "Not A Font Name That Is Way Too Long To Keep"] }));
  assert.equal(s.showHidden, true);
  assert.deepEqual(plain(s.hiddenFonts), ["Klee One"]);
  assert.deepEqual(plain(C.readSettings("{}").hiddenFonts), []);
});

test("a hidden font leaves every list, stays when it is the current choice, and returns with Show hidden", () => {
  const base = C.readSettings(null);
  const hidden = { ...base, hiddenFonts: ["Klee One"] };
  const print = names(C.fontOptions(catalog, hidden, "off"));
  assert.equal(print.includes("Klee One"), false);
  assert.equal(print.length, 71 - 13 - 2 - 1);
  const kept = C.fontOptions(catalog, hidden, "Klee One").flatMap((g) => g.options).find((o) => o.name === "Klee One");
  assert.equal(kept.userHidden, true);
  assert.equal(kept.hidden, false);
  assert.match(kept.label, / · hidden by you$/);
  assert.doesNotMatch(kept.label, /Hide|Unhide|hidden by the filter/);
  const shown = names(C.fontOptions(catalog, { ...hidden, showHidden: true }, "off"));
  assert.equal(shown.includes("Klee One"), true);
  assert.equal(shown.length, 71 - 13 - 2);
  // Show hidden does not override Print only.
  const both = { ...base, hiddenFonts: ["Caveat"], showHidden: true };
  assert.equal(names(C.fontOptions(catalog, both, "off")).includes("Caveat"), false);
  const current = C.fontOptions(catalog, { ...base, hiddenFonts: ["Caveat"] }, "Caveat").flatMap((g) => g.options).find((o) => o.name === "Caveat");
  assert.equal(current.userHidden, true);
  assert.equal(current.hidden, true);
  assert.match(current.label, /hidden by the filter and by you$/);
  assert.doesNotMatch(current.label, /Hide|Unhide/);
});

test("‹ › and the list length skip a hidden font, unless it is the current choice", () => {
  const base = C.readSettings(null);
  const hidden = { ...base, hiddenFonts: ["Klee One"] };
  const seen = new Set();
  let cur = C.fontNeighbor(catalog, hidden, "off", 1);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    cur = C.fontNeighbor(catalog, hidden, cur, 1);
  }
  assert.equal(seen.has("Klee One"), false);
  assert.equal(seen.size, 71 - 13 - 2 - 1);
  const back = { ...hidden, showHidden: true };
  assert.equal(names(C.fontOptions(catalog, back, "off")).includes("Klee One"), true);
  const staying = names(C.fontOptions(catalog, hidden, "Klee One"));
  assert.equal(staying.includes("Klee One"), true);
  assert.equal(staying.length, 71 - 13 - 2);
});

test("Width lines use the unrounded ratio, merge equal sizes, and name a third size", () => {
  const g = fam("Gowun Dodum");
  assert.deepEqual(plain(C.widthLines(g, { uiWidth: UI, areaSize: 110, areaLabel: "Replies" })), {
    intro: "A sample sentence, against T3's system font at 100%, is about:",
    lines: ["4% narrower at its Default 95%", "1% wider at 100%", "11% wider at your 110% (Replies)"],
  });
  const patrick = fam("Patrick Hand SC");
  assert.deepEqual(plain(C.widthLines(patrick, { uiWidth: UI, areaSize: 110, areaLabel: "Thread titles" }).lines), ["5% narrower at its Default 110%", "13% narrower at 100%"]);
  const same = { name: "Sample", width: UI, size: 100 };
  assert.deepEqual(plain(C.widthLines(same, { uiWidth: UI, areaSize: 100, areaLabel: "Replies" }).lines), ["the same width at 100% (Default)"]);
  assert.deepEqual(plain(C.widthLines({ width: UI, size: 100 }, { uiWidth: UI, areaSize: 110, areaLabel: "Replies" }).lines), ["the same width at 100% (Default)", "10% wider at your 110% (Replies)"]);
  assert.deepEqual(plain(C.widthLines({ width: UI, size: 95 }, { uiWidth: UI, areaSize: 100, areaLabel: "Replies" }).lines), ["5% narrower at its Default 95%", "the same width at your 100% (Replies)"]);
});

test("the screen block rounds the score, switches the sentence, and adds the tagged line", () => {
  const block = (name, areaSize) => C.screenBlock(fam(name), { areaSize });
  assert.equal(block("Iansui", 110).score, 110);
  assert.equal(block("Gowun Dodum", 110).score, 98);
  assert.equal(block("Yusei Magic", 100).score, 103);
  assert.equal(block("Patrick Hand SC", 110).score, 84);
  assert.equal(block("Amatic SC", 80).score, 37);
  assert.equal(block("Rock Salt", 80).score, 81);
  const g = block("Gowun Dodum", 110);
  assert.match(g.band, /in the same range as T3's font \(100\) in this test/);
  assert.match(g.conditions, /Default 95%.*not your 110%/);
  assert.equal(g.cardLine, "Screen readability test (experimental, at its Default): 98, in the same range as T3's font (100).");
  assert.match(g.method, /0\.94×/);
  assert.match(g.method, /1\.01×/);
  assert.equal(g.hardNote, null);
  const p = block("Patrick Hand SC", 110);
  assert.match(p.band, /below T3's font \(100\) in this test/);
  assert.doesNotMatch(p.conditions, /not your/);
  assert.equal(p.cardLine, "Screen readability test (experimental, at its Default): 84, below T3's font (100).");
  const a = block("Amatic SC", 80);
  assert.match(a.band, /well below/);
  assert.equal(a.hardNote, "The menu's “hard to read small” mark is from a look at the letters, separate from this test.");
  assert.equal(a.cardLine, "Screen readability test (experimental, at its Default): 37, well below T3's font (100).");
  assert.equal(C.screenBlock({ name: "X", size: 100 }), null);
});

test("Story keeps the rows, escapes nothing itself, and links only https text that occurs", () => {
  const sources = "From Google Fonts' description, the font's GitHub page and Luc Devroye's type pages. Not found in them: why it was made, where it's used.";
  const rec = {
    story: [
      { row: "How it was made", text: "Version 2.0 (2020) redrew the Latin letters and completed all 11,172 modern Hangeul syllables, adding 8,822." },
      { row: "Based on", text: "A renamed, revised version of Gowun Hangeul-dodum, first released in 2010." },
      { row: "Design ideas", text: "Google calls it a humanist sans-serif." },
      { row: "Made for", text: "<img src=x onerror=alert(1)>" },
    ],
    storySources: {
      text: sources,
      links: [
        { text: "Google Fonts' description", url: "https://fonts.google.com/specimen/Gowun+Dodum" },
        { text: "the font's GitHub page", url: "https://github.com/google/fonts" },
        { text: "Luc Devroye's type pages", url: "http://example.invalid/not-https" },
        { text: "not in the sentence", url: "https://example.invalid/missing" },
        { text: "Google Fonts", url: "https://example.invalid/nested" },
      ],
    },
  };
  const story = C.storyBlock(rec);
  assert.equal(story.rows[3].text, "<img src=x onerror=alert(1)>");
  assert.deepEqual(plain(story.sources.links.map((l) => l.text)), ["Google Fonts' description", "the font's GitHub page"]);
  assert.equal(story.sources.links[0].url.startsWith("https://"), true);
  assert.equal(C.storyBlock({ story: rec.story }).sources, null, "rows and no sources line: the line is omitted");
  assert.equal(C.storyBlock({ story: [] }), null);
  const long = C.storyBlock({ story: Array.from({ length: 10 }, (_, i) => ({ row: `R${i}`, text: `T${i}` })) });
  assert.equal(long.rows.length, 8);
});

test("projections pass screen, uiWidth, story and storySources, and drop a non-https link", () => {
  const cat = fontCatalogProjection(fonts);
  assert.equal(cat.uiWidth, UI);
  assert.equal(cat.families.filter((f) => f.screen && Number.isFinite(f.screen.score)).length, 71);
  const story = [{ row: "Made for", text: "Korean text." }];
  const p = fontAboutProjection({
    listVersion: 3,
    records: { "Gowun Dodum": { story, storySources: { text: "From the page.", links: [{ text: "the page", url: "https://fonts.google.com/" }, { text: "the page", url: "javascript:alert(1)" }] } } },
  }, fonts);
  assert.deepEqual(p.records["Gowun Dodum"].story, story);
  assert.deepEqual(p.records["Gowun Dodum"].storySources.links, [{ text: "the page", url: "https://fonts.google.com/" }]);
  const kept = aboutRecords({ "Gowun Dodum": { desc: "d", story, storySources: { text: "From the page.", links: [] }, sources: [{ claim: "secret" }] } }, fonts);
  assert.deepEqual(kept.records["Gowun Dodum"].story, story);
  assert.equal("sources" in kept.records["Gowun Dodum"], false);
  assert.equal(kept.listVersion, 3);
});

test("the twelve new families are list 3, print, and carry a screen score", () => {
  assert.deepEqual(F.filter((f) => f.newIn === 3).map((f) => f.name), NEW12);
  const sizes = { "Chiron GoRound TC": 105, "Mochiy Pop One": 90, Stick: 100, "Darumadrop One": 110, "Short Stack": 95, Itim: 120, Mali: 100, "Comic Relief": 95, "Crafty Girls": 100, "Swanky and Moo Moo": 150, "Fuzzy Bubbles": 95, Delius: 100 };
  const groups = { "Chiron GoRound TC": "round", "Mochiy Pop One": "round", Stick: "round", "Darumadrop One": "round", "Short Stack": "hand", Itim: "hand", Mali: "hand", "Comic Relief": "hand", "Crafty Girls": "hand", "Swanky and Moo Moo": "hand", "Fuzzy Bubbles": "hand", Delius: "hand" };
  for (const f of F.filter((x) => x.newIn === 3)) {
    assert.equal(f.group, groups[f.name], f.name);
    assert.equal(f.style, "print", f.name);
    assert.equal(f.star, false, f.name);
    assert.equal(f.hard, false, f.name);
    assert.equal(f.size, sizes[f.name], f.name);
    assert.ok(f.screen && Number.isFinite(f.screen.score) && Number.isFinite(f.screen.letters) && Number.isFinite(f.screen.reading), f.name);
  }
  assert.deepEqual(F.filter((f) => f.hard).map((f) => f.name).sort(), ["Amatic SC", "Give You Glory", "Just Another Hand", "Loved by the King", "Over the Rainbow", "Permanent Marker", "Rock Salt"]);
});

test("G1: 0% says the same width, and his size says your unless it merges with the Default", () => {
  const lines = (width, size, areaSize) => plain(C.widthLines({ width, size }, { uiWidth: UI, areaSize, areaLabel: "Replies" }).lines);
  const wider = UI * 1.05;
  assert.deepEqual(lines(wider, 100, 110), ["5% wider at 100% (Default)", "16% wider at your 110% (Replies)"]);
  assert.deepEqual(lines(UI * 96 / 95, 95, 100), ["4% narrower at its Default 95%", "1% wider at your 100% (Replies)"]);
  assert.deepEqual(plain(C.widthLines(fam("Gowun Dodum"), { uiWidth: UI, areaSize: 110, areaLabel: "Replies" }).lines), ["4% narrower at its Default 95%", "1% wider at 100%", "11% wider at your 110% (Replies)"]);
  const merged = plain(C.widthLines(fam("Patrick Hand SC"), { uiWidth: UI, areaSize: 110, areaLabel: "Thread titles" }).lines);
  assert.deepEqual(merged, ["5% narrower at its Default 110%", "13% narrower at 100%"]);
  assert.equal(merged.some((l) => l.includes("your")), false);
});

test("G2: a sources list has no bare based on, design ideas or made for item", () => {
  const about = JSON.parse(fs.readFileSync(new URL("../font-about.json", import.meta.url), "utf8"));
  const bare = new Set(["based on", "design ideas", "made for"]);
  let lists = 0;
  for (const [name, rec] of Object.entries(about.records)) {
    const text = rec.storySources?.text;
    if (typeof text !== "string") continue;
    const at = text.indexOf("Not found in them: ");
    if (at < 0) continue;
    lists++;
    let list = text.slice(at + "Not found in them: ".length);
    assert.equal(list.endsWith("."), true, name);
    list = list.slice(0, -1);
    for (const item of list.split(", ")) assert.equal(bare.has(item), false, `${name}: ${item}`);
  }
  assert.ok(lists >= 69);
  assert.equal(about.records["Coming Soon"].storySources.text.endsWith("Not found in them: why it was made, how it was made, its design ideas, where it's used, what it was made for."), true);
});

test("G3: Story with only a sources line keeps the line; rows without one omit it; neither is no section", () => {
  const soon = JSON.parse(fs.readFileSync(new URL("../font-about.json", import.meta.url), "utf8")).records["Coming Soon"];
  const only = C.storyBlock(soon);
  assert.deepEqual(only.rows, []);
  assert.match(only.sources.text, /Not found in them: /);
  assert.ok(only.sources.links.every((l) => l.url.startsWith("https://")));
  const rows = C.storyBlock({ story: [{ row: "Made for", text: "Korean text." }] });
  assert.equal(rows.sources, null);
  assert.equal(rows.rows.length, 1);
  assert.equal(C.storyBlock({ story: [] }), null);
  assert.equal(C.storyBlock({ story: [], storySources: { text: "", links: [] } }), null);
});

test("G4: the score is tried after Technical and before Background, and a miss restores Technical", () => {
  const snap = (fits) => plain(C.fitSwapKeep({ traits: true, score: true, hidden: true }, fits));
  const rejectScore = (st) => !st.score;
  assert.deepEqual(snap(rejectScore), { strip: true, traits: "all", tech: "whole", score: false, bg: true, hidden: true });
  const calls = [];
  const shorten = (st) => {
    calls.push({ ...st });
    if (st.tech === "whole" || st.score) return false;
    return true;
  };
  assert.deepEqual(snap(shorten), { strip: true, traits: "all", tech: "first", score: false, bg: true, hidden: false });
  assert.equal(calls.some((c) => c.score && c.tech !== "first"), false);
  assert.deepEqual(snap((st) => st.strip === false), { strip: false, traits: "warn", tech: "off", score: false, bg: false, hidden: false });
  assert.equal(C.fitSwapKeep({ traits: true, score: true, hidden: false }, () => false), null);
});

test("Q3: Background (the credit) is tried once every trait shows, when Technical shows or at least one ordinary trait is on screen", () => {
  // Technical whole and first both miss, the score misses, the credit fits.
  const roomy = (st) => !(st.tech === "whole" || st.tech === "first") && !st.score;
  const keep = (opts, fits = roomy) => plain(C.fitSwapKeep({ traits: true, score: true, hidden: false, ...opts }, fits));
  // (a) every trait fits: the credit shows although Technical is off.
  assert.deepEqual(keep({ ordinary: true }), { strip: true, traits: "all", tech: "off", score: false, bg: true, hidden: false });
  // (b) the ordinary traits were dropped (only warnings stay): the credit is not back-filled.
  assert.deepEqual(keep({ ordinary: true }, (st) => roomy(st) && st.traits !== "all"), { strip: true, traits: "warn", tech: "off", score: false, bg: false, hidden: false });
  // (c) every trait shows, but the card has no ordinary trait (warnings only): the credit stays off with Technical.
  assert.deepEqual(keep({ ordinary: false }), { strip: true, traits: "all", tech: "off", score: false, bg: false, hidden: false });
  assert.deepEqual(keep({}), { strip: true, traits: "all", tech: "off", score: false, bg: false, hidden: false }, "ordinary absent is false");
  // (d) Technical whole fits: unchanged, whatever opts.ordinary says.
  for (const ordinary of [true, false]) assert.deepEqual(keep({ ordinary }, () => true), { strip: true, traits: "all", tech: "whole", score: true, bg: true, hidden: false });
  assert.deepEqual(keep({ ordinary: false }, (st) => st.tech !== "whole" && !st.score), { strip: true, traits: "all", tech: "first", score: false, bg: true, hidden: false });
});

test("G5: the About foot's three hidden notes, and the unchanged note when it is not hidden", () => {
  const base = C.readSettings(null);
  const foot = (name, extra, native) => plain(C.hideFootCopy(fam(name), { ...base, ...extra }, native));
  assert.deepEqual(foot("Patrick Hand SC", {}), { button: "Hide this font", note: "Hides it from every font list; Show hidden brings it back." });
  assert.deepEqual(foot("Patrick Hand SC", { hiddenFonts: ["Patrick Hand SC"] }), { button: "Unhide this font", note: "Hidden by you; Unhide puts it back in every font list." });
  assert.deepEqual(foot("Caveat", { hiddenFonts: ["Caveat"] }), { button: "Unhide this font", note: "Hidden by you and by Print only; Unhide undoes only your part." });
  assert.deepEqual(foot("SignPainter", { hiddenFonts: ["SignPainter"] }), { button: "Unhide this font", note: "Hidden by you and by the filter; Unhide leaves it hidden until Print only and Show semi-cursive are both off." });
});

test("G6: one hidden mark for the filter, for you, and for both; Unhide on both leaves the filter", () => {
  assert.equal(C.fontMenuMark(true, false), " · hidden by the filter");
  assert.equal(C.fontMenuMark(false, true), " · hidden by you");
  assert.equal(C.fontMenuMark(true, true), " · hidden by the filter and by you");
  assert.equal(C.fontMenuMark(false, false), "");
  assert.equal(C.fontMenuMarkAfterPill(true, false), " · hidden by the filter");
  const base = C.readSettings(null);
  const label = (name, settings, current) => C.fontOptions(catalog, settings, current).flatMap((g) => g.options).find((o) => o.name === name).label;
  assert.match(label("SignPainter", base, "SignPainter"), / · narrow, tall, cursive, on your Mac · hidden by the filter$/);
  assert.match(label("Klee One", { ...base, hiddenFonts: ["Klee One"] }, "Klee One"), / · hidden by you$/);
  assert.match(label("Caveat", { ...base, hiddenFonts: ["Caveat"] }, "Caveat"), / ★ · narrow, tall, semi-cursive · hidden by the filter and by you$/);
  for (const l of [label("SignPainter", base, "SignPainter"), label("Klee One", { ...base, hiddenFonts: ["Klee One"] }, "Klee One"), label("Caveat", { ...base, hiddenFonts: ["Caveat"] }, "Caveat")]) {
    assert.doesNotMatch(l, /Hide|Unhide/);
  }
});

test("G7: a hideable font can take the failed or no-details foot; T3 and a missing Mac font cannot", () => {
  const base = C.readSettings(null);
  for (const name of ["Dekko", "Zen Kurenaido"]) assert.deepEqual(plain(C.hideFootCopy(fam(name), base)).button, "Hide this font");
  assert.equal(C.hideFootCopy(fam("T3 interface font"), base), null);
  assert.equal(C.hideFootCopy(fam("Noteworthy"), base, false), null);
  assert.equal(C.FONT_TEXT.detailsNone, "No details for this font.");
  assert.equal(C.FONT_TEXT.detailsFailed, "Font details couldn't load.");
});

test("G8: the three re-measured screen scores keep their Defaults", () => {
  const expect = {
    "Darumadrop One": { size: 110, screen: { score: 103.8, letters: 1.07, reading: 1.006 } },
    Itim: { size: 120, screen: { score: 115, letters: 1.164, reading: 1.175 } },
    "Swanky and Moo Moo": { size: 150, screen: { score: 102, letters: 1.274, reading: 0.904 } },
  };
  for (const [name, want] of Object.entries(expect)) {
    const f = F.find((x) => x.name === name);
    assert.equal(f.size, want.size, name);
    assert.deepEqual(f.screen, want.screen, name);
  }
});

test("G9: eight list-3 families are Handwritten; four stay Rounded print", () => {
  const hand = ["Short Stack", "Itim", "Mali", "Comic Relief", "Crafty Girls", "Swanky and Moo Moo", "Fuzzy Bubbles", "Delius"];
  const round = ["Chiron GoRound TC", "Mochiy Pop One", "Stick", "Darumadrop One"];
  for (const name of hand) assert.equal(F.find((f) => f.name === name).group, "hand", name);
  for (const name of round) assert.equal(F.find((f) => f.name === name).group, "round", name);
  assert.equal(F.find((f) => f.name === "Just Another Hand").group, "hand");
});
