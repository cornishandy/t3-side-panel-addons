// "About this font" (13 Nov 2026, design S′): the data, the records, the words and the eight new fonts.
// Pure parts of public/extras.js run in a VM; the browser parts are in font-details-browser.test.mjs.
// The shipped records (font-about.json) come from the writer's checked file; until they arrive the record
// checks run on the two-record fixture and the whole-catalog checks are reported as todo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { deriveTags, xRatioMedian, aboutRecords } from "../tools/fonts.mjs";
import { fontCatalogProjection, fontAboutProjection } from "../lib.mjs";
import { cmapOf } from "./helpers/font-cmap.mjs";

const SRC = new URL("..", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, SRC), "utf8");
const src = read("public/extras.js");
const sandbox = { window: { __T3X_TEST__: {} } };
vm.runInNewContext(src, sandbox);
const C = sandbox.window.__T3X_TEST__.core;
const plain = (v) => JSON.parse(JSON.stringify(v));
const fonts = JSON.parse(read("fonts.json"));
const F = fonts.families;
const BANNED = JSON.parse(read("tools/font-banned.json"));
const ADDRESS_HASHES = new Set(BANNED.addressHashes);
/** Address pieces in a text, found by hash so the repo never spells them out: every word and every pair of
 *  neighbouring words (letters and digits only, lower case) is hashed and looked up. */
function addressHashHits(text, hashes = ADDRESS_HASHES) {
  const words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean), out = [];
  for (let i = 0; i < words.length; i++) for (const n of [1, 2]) {
    if (i + n > words.length) continue;
    const h = createHash("sha256").update(words.slice(i, i + n).join(" ")).digest("hex");
    if (hashes.has(h)) out.push(`address piece #${BANNED.addressHashes.indexOf(h)}`);
  }
  return out;
}
const fixture = JSON.parse(read("test/fixtures/font-about.fixture.json"));
const shippedPath = new URL("font-about.json", SRC);
const shipped = fs.existsSync(shippedPath) ? JSON.parse(fs.readFileSync(shippedPath, "utf8")) : null;
const T = C.FONT_TEXT;
const fam = (name) => C.normalizeCatalog(fontCatalogProjection(fonts)).find((f) => f.name === name);
const NEW8 = ["Yomogi", "Iansui", "Yusei Magic", "LXGW Marker Gothic", "Gowun Dodum", "Kiwi Maru", "Zen Maru Gothic", "Tsukimi Rounded"];

// ---------------------------------------------------------------- the eight new fonts and the measurements

test("eight new fonts: four Handwritten, four in Rounded print, all print and new in list 2; the left-out fonts stay out", () => {
  assert.equal(fonts.listVersion, 2);
  assert.deepEqual(F.filter((f) => f.newIn === 2).map((f) => f.name), NEW8);
  assert.deepEqual(F.filter((f) => f.newIn === 2 && f.group === "hand").map((f) => f.name), ["Yomogi", "Iansui", "Yusei Magic", "LXGW Marker Gothic"]);
  assert.deepEqual(F.filter((f) => f.group === "round").map((f) => f.name), ["Gowun Dodum", "Kiwi Maru", "Zen Maru Gothic", "Tsukimi Rounded"]);
  for (const f of F.filter((x) => x.newIn)) assert.ok(f.style === "print" && !f.hard && !f.star && f.source === "google", f.name);
  assert.equal(F.find((f) => f.name === "Iansui").note, "a darker Klee One");
  for (const out of ["Poor Story", "Single Day", "Cute Font", "Stylish", "Zen Loop", "Hachi Maru Pop", "Huninn", "LXGW WenKai TC", "LXGW WenKai Mono TC"]) assert.ok(!F.some((f) => f.name === out), out);
  assert.match(fonts.styleSource, /newIn 2/);
  const files = new Map(fonts.files.map((x) => [x.file, x]));
  for (const f of F.filter((x) => x.newIn)) {
    assert.ok(files.get(f.file) && files.get(f.licence), f.name);
    assert.ok(files.get(f.licence).url.includes(`/google/fonts/${fonts.googleFontsCommit}/ofl/`), f.name);
  }
});

test("re-measuring kept the 51 existing families' size, narrow and tall; the 200% cap moved only Hi Melody, 150% to 155%", () => {
  const before = JSON.parse(read("test/fixtures/fonts-51-tags.json")).families;
  assert.equal(Object.keys(before).length, 51);
  for (const [name, [size, narrow, tall]] of Object.entries(before)) {
    const f = F.find((x) => x.name === name);
    assert.deepEqual([f.size, f.narrow, f.tall], [name === "Hi Melody" ? 155 : size, narrow, tall], name);
  }
  assert.equal(before["Hi Melody"][0], 150);
  assert.ok(F.filter((f) => f.newIn).every((f) => f.size <= 150), "the eight new fonts' defaults are the same under either cap");
});

test("measured fields: every family has xRatio and widthVsSystem; the median and the clamped sizes", () => {
  for (const f of F) {
    assert.ok(Number.isInteger(f.xRatio) && f.xRatio > 30 && f.xRatio < 100, `${f.name} ${f.xRatio}`);
    assert.ok(Number.isInteger(f.widthVsSystem) && Math.abs(f.widthVsSystem) < 80, `${f.name} ${f.widthVsSystem}`);
    assert.equal(typeof f.sizeClamped, "boolean", f.name);
  }
  assert.equal(fonts.xRatioMedian, xRatioMedian(F));
  assert.equal(fonts.xRatioMedian, 70);
  assert.deepEqual(F.filter((f) => f.sizeClamped).map((f) => f.name).sort(), ["Amatic SC", "Rock Salt", "Sedgwick Ave"], "only the 80% floor clamps now");
  assert.ok(F.filter((f) => f.sizeClamped).every((f) => f.size === 80));
  assert.deepEqual(F.filter((f) => f.smallCaps).map((f) => f.name), ["Amatic SC", "Patrick Hand SC"]);
  assert.equal(F.find((f) => f.name === "Yomogi").dashesTouch, true);
  assert.ok(F.find((f) => f.name === "Zen Kurenaido").oneWeight && F.find((f) => f.name === "Bradley Hand").oneWeight);
  assert.ok(!F.find((f) => f.name === "Caveat").oneWeight, "a weight axis is more than one weight");
});

test("deriveTags (pure): clamping, the lower-case ratio, the width against the system font, and medians without new families", () => {
  const fams = [
    { group: "hand", m: { w: 100, tall: 1, xh: 0.5, cap: 0.7 } },
    { group: "hand", m: { w: 200, tall: 2, xh: 0.25, cap: 0.7 } },
    { group: "hand", m: { w: 300, tall: 3, xh: 1, cap: 1.25 } },
    { group: "cond", m: { w: 200, tall: 2, xh: 0.2, cap: 0.7 } },
    { group: "hand", newIn: 2, m: { w: 10, tall: 9, xh: 0.5, cap: 0.71 } },
    { group: "hand", newIn: 2, m: { w: 11, tall: 9, xh: 0.5, cap: 0.71 } },
  ];
  deriveTags(fams, { xh: 0.5, w: 200 });
  assert.deepEqual(fams.slice(0, 4).map((f) => [f.narrow, f.tall, f.size, f.sizeClamped]), [[true, false, 100, false], [false, false, 200, false], [false, true, 80, true], [false, false, 200, true]], "80-200%; the new families leave the medians alone");
  assert.deepEqual(fams.map((f) => f.xRatio), [71, 36, 80, 29, 70, 70]);
  assert.deepEqual(fams.slice(0, 3).map((f) => f.widthVsSystem), [-50, 100, 20]);
  assert.equal(xRatioMedian(fams), 70);
  const old = [{ group: "hand", m: { w: 100, tall: 1, xh: 0.5, cap: 1 } }];
  deriveTags(old, 0.5);
  assert.equal(old[0].widthVsSystem, undefined, "a bare x-height still works, without the width comparison");
});

// ---------------------------------------------------------------- catalog, menus and "new"

test("the catalog carries listVersion, newIn, notes and the measured fields, never files' URLs", () => {
  const cat = fontCatalogProjection(fonts);
  assert.equal(cat.listVersion, 2);
  assert.equal(cat.xRatioMedian, 70);
  assert.equal(cat.families.length, 59);
  const ian = cat.families.find((f) => f.name === "Iansui");
  assert.deepEqual([ian.newIn, ian.note, ian.group], [2, "a darker Klee One", "hand"]);
  const zen = cat.families.find((f) => f.name === "Zen Kurenaido");
  assert.deepEqual([zen.newIn, zen.xRatio, zen.widthVsSystem, zen.sizeClamped, zen.oneWeight], [null, 59, 11, false, true]);
  assert.doesNotMatch(JSON.stringify(cat), /gstatic|sha256|githubusercontent/);
});

test("\"new\" shows only while a defined newIn equals a defined listVersion; an old catalog upgrades to none", () => {
  const cat = fontCatalogProjection(fonts);
  const now = C.normalizeCatalog(cat);
  assert.equal(now.listVersion, 2);
  assert.deepEqual(plain(now.filter((f) => f.isNew).map((f) => f.name)), NEW8);
  const next = C.normalizeCatalog({ ...cat, listVersion: 3 });
  assert.deepEqual(plain(next.filter((f) => f.isNew).map((f) => f.name)), [], "the next list change ends \"new\"");
  const old = C.normalizeCatalog({ families: cat.families });
  assert.equal(old.listVersion, null);
  assert.equal(old.filter((f) => f.isNew).length, 0, "a catalog without listVersion marks nothing new");
  const undef = C.normalizeCatalog({ listVersion: 2, families: [{ name: "Neucha", source: "google", group: "hand", style: "print" }] });
  assert.equal(undef.find((f) => f.name === "Neucha").isNew, false, "no newIn, not new");
  assert.equal(now.slice(0, 4).every((f) => f.source === "t3"), true, "T3's own fonts first");
});

test("menus: Rounded print after Handwritten; new first among the tags; Iansui's note", () => {
  const cat = C.normalizeCatalog(fontCatalogProjection(fonts));
  const groups = plain(C.fontOptions(cat, C.readSettings(null), "off", () => true));
  assert.deepEqual(groups.map((g) => g.label), ["T3 Code settings", "Handwritten", "Rounded print", "Condensed print"]);
  assert.deepEqual(plain(C.FONT_GROUPS).map(([g]) => g), ["t3", "hand", "round", "cond"]);
  const label = (n) => groups.flatMap((g) => g.options).find((o) => o.name === n).label;
  assert.equal(label("Iansui"), "Iansui · new, a darker Klee One");
  for (const n of ["Yomogi", "Yusei Magic", "LXGW Marker Gothic", "Gowun Dodum", "Kiwi Maru", "Zen Maru Gothic", "Tsukimi Rounded"]) assert.equal(label(n), `${n} · new`);
  assert.equal(label("Klee One"), "Klee One");
  assert.equal(label("T3 interface font"), "T3 interface font · follows T3's interface font", "T3's own notes unchanged");
  assert.ok(groups[2].options.every((o) => cat.find((f) => f.name === o.name).group === "round"));
});

// ---------------------------------------------------------------- records: content rules

const recordSets = [["fixture", fixture.records]];
if (shipped) recordSets.push(["shipped font-about.json", shipped.records]);
const strings = (r) => Object.entries(r).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => [k, x]) : []));
function wordProblems(text) {
  const out = [];
  for (const w of BANNED.words) if (new RegExp(`\\b${w}\\b`, "i").test(text)) out.push(w);
  for (const p of BANNED.phrases) if (text.toLowerCase().includes(p)) out.push(p);
  for (const p of BANNED.patterns) if (new RegExp(p, "i").test(text)) out.push(p);
  for (const a of BANNED.addresses) if (text.includes(a)) out.push(a);
  out.push(...addressHashHits(text));
  return out;
}

test("banned words match whole words only (one list, shared with the writer)", () => {
  assert.deepEqual(wordProblems("One-loop a and g, the way most people write them"), [], "\"them\" holds \"em\" but is not \"em\"");
  assert.deepEqual(wordProblems("about 1 em wide"), ["em"]);
  assert.deepEqual(wordProblems("Never mistaken"), ["never"]);
  assert.deepEqual(wordProblems("looks small at any size"), ["any size"]);
  assert.ok(wordProblems("226 glyphs").length && wordProblems("a 1/2 width").length && wordProblems("½").length && wordProblems("24 KB").length);
  // Address pieces by hash (the real pieces are never spelled out here): the mechanism on invented pieces, and the list's shape.
  const sha = (x) => createHash("sha256").update(x).digest("hex"), made = new Set([sha("lantern row"), sha("00000")]);
  assert.equal(addressHashHits("12 Lantern Row, Testville 00000", made).length, 2, "a two-word piece and a one-word piece");
  assert.deepEqual(addressHashHits("a lantern on the row", made), [], "only neighbouring words make a pair");
  assert.ok(BANNED.addressHashes.length === 5 && BANNED.addressHashes.every((x) => /^[0-9a-f]{64}$/.test(x)), "five SHA-256 hashes");
});

for (const [label, records] of recordSets) {
  test(`records (${label}): desc of 20 words or fewer, strips without digits, banned words, no addresses, the right fields`, () => {
    for (const [name, r] of Object.entries(records)) {
      assert.ok(F.some((f) => f.name === name), `${name} is a catalog family (exact name)`);
      assert.ok(r.desc.trim().split(/\s+/).length <= 20, `${name}: desc has ${r.desc.split(/\s+/).length} words`);
      assert.doesNotMatch(r.strip, /\d/, `${name}: strip has digits`);
      assert.ok(Array.isArray(r.apart) && r.apart.length >= 2 && r.apart.length <= 3, `${name}: 2-3 traits`);
      assert.ok(["Regular", "Light", "Thin", "Bold", "Medium", "SemiBold"].includes(r.weightLoaded), `${name}: weightLoaded ${r.weightLoaded}`);
      assert.equal(typeof r.copyLatinOnly, "boolean", name);
      assert.ok(Array.isArray(r.familyScripts), name);
      if (r.copyLatinOnly && r.familyScripts.length) assert.match(r.letters, /This copy is Latin only; the full font also has [^.]+\.$/, name);
      assert.equal("sources" in r, false, `${name}: sources never ship`);
      for (const [k, v] of strings(r)) assert.deepEqual(wordProblems(v), [], `${name}.${k}: ${v}`);
    }
  });
  test(`records (${label}): every strip character is in that family's file`, (t) => {
    const dirs = [process.env.T3X_FONTS_DIR, path.join(os.homedir(), ".local/share/t3-extras/fonts"), "/System/Library/Fonts", "/System/Library/Fonts/Supplemental"].filter(Boolean);
    const MAC_FILES = { Noteworthy: "Noteworthy.ttc", "Marker Felt": "MarkerFelt.ttc", "Chalkboard SE": "ChalkboardSE.ttc", "Bradley Hand": "Bradley Hand Bold.ttf", SignPainter: "SignPainter.ttc" };
    const missing = [];
    for (const [name, r] of Object.entries(records)) {
      const f = F.find((x) => x.name === name);
      const file = f.source === "mac" ? MAC_FILES[name] : f.file;
      const at = dirs.map((d) => path.join(d, file)).find((p) => fs.existsSync(p));
      if (!at) { missing.push(name); continue; }
      const cmap = cmapOf(at);
      for (const ch of [...r.strip.replace(/\s+/g, "")]) assert.ok(cmap.has(ch.codePointAt(0)), `${name}: "${ch}" is not in ${file}`);
    }
    if (missing.length) t.todo(`font files not found for ${missing.join(", ")} (set T3X_FONTS_DIR to the pinned files)`);
  });
}

test("every family has a record (the writer's checked file, through tools/fonts.mjs about)", (t) => {
  if (!shipped) return t.todo("font-about.json is not in the repo yet: the writer's checked records arrive later");
  assert.equal(shipped.listVersion, fonts.listVersion);
  const missing = F.filter((f) => !shipped.records[f.name]).map((f) => f.name);
  assert.deepEqual(missing, []);
  assert.ok(shipped.records.Yomogi.letters, "Yomogi's record");
});

test("no address or local path in the records, the catalog, or extras.js beyond the service's own address", () => {
  const texts = [JSON.stringify(fixture), JSON.stringify(fontCatalogProjection(fonts)), JSON.stringify(fontAboutProjection(fixture, fonts))];
  if (shipped) texts.push(JSON.stringify(shipped));
  for (const text of texts) for (const a of BANNED.addresses) assert.equal(text.includes(a), false, a);
  for (const text of texts) assert.deepEqual(addressHashHits(text), [], "no address piece (by hash)");
  assert.deepEqual(src.split("\n").flatMap((line, i) => (addressHashHits(line).length ? [i + 1] : [])), [], "extras.js: no address piece (by hash)");
  const hits = src.split("\n").map((line, i) => [i + 1, line]).filter(([, line]) => BANNED.addresses.some((a) => line.includes(a)));
  assert.deepEqual(hits.map(([, line]) => line.trim()), [
    "* The keeper's inline loader fetches this file from 127.0.0.1:8793 and inserts it inline.",
    'const BASE = "http://127.0.0.1:8793/";',
  ], "extras.js names only the add-on service's own loopback address");
  for (const v of Object.values(plain(T))) if (typeof v === "string") assert.deepEqual(wordProblems(v), [], v);
});

// ---------------------------------------------------------------- projections and the build tool

test("the service sends only public fields, for catalog families, as plain strings", () => {
  const evil = { listVersion: 2, records: {
    "Klee One": { ...fixture.records["Klee One"], sources: [{ claim: "x", source: "tech-mac.json:copyright" }], html: "<b>x</b>", desc: "A <b>bold</b> & plain \"desc\"." },
    "Not A Font": { desc: "nope" }, "Zen Kurenaido": "not an object",
  } };
  const p = fontAboutProjection(evil, fonts);
  assert.equal(p.listVersion, 2);
  assert.deepEqual(Object.keys(p.records), ["Klee One"]);
  assert.deepEqual(Object.keys(p.records["Klee One"]).sort(), ["apart", "background", "copyLatinOnly", "desc", "familyScripts", "letters", "madeShort", "strip", "weight", "weightLoaded"]);
  assert.equal(p.records["Klee One"].desc, "A <b>bold</b> & plain \"desc\".", "kept as text; the add-on sets it with textContent");
  assert.deepEqual(fontAboutProjection(null, fonts), { listVersion: null, records: {} });
});

test("the warning flag (10G′): apartWarn passes through the service as whole trait indexes; the card model marks it", () => {
  const p = fontAboutProjection({ listVersion: 2, records: { "Klee One": { ...fixture.records["Klee One"], apartWarn: [1, "0", -1, 1.5, 9, 1] }, "Zen Kurenaido": { ...fixture.records["Zen Kurenaido"], apartWarn: "1" } } }, fonts);
  assert.deepEqual(p.records["Klee One"].apartWarn, [1], "whole indexes into apart only, once each");
  assert.equal("apartWarn" in p.records["Zen Kurenaido"], false, "not a list: dropped");
  const m = about("Klee One", { ...kleeRec, apartWarn: [1] });
  assert.deepEqual(m.cardWarn, [1]);
  assert.deepEqual(about("Klee One", kleeRec).cardWarn, [], "no flag, no warning");
  assert.deepEqual(about("Klee One", { ...kleeRec, apart: ["a", "b", "c"], apartWarn: [2] }).cardWarn, [], "a third trait isn't on the card");
  // Sol, 14 Nov 2026: an empty trait before a warning doesn't move the warning onto another trait.
  const gap = fontAboutProjection({ listVersion: 2, records: { "Klee One": { ...fixture.records["Klee One"], apart: ["", "warns", "plain"], apartWarn: [1] } } }, fonts).records["Klee One"];
  assert.deepEqual([gap.apart, gap.apartWarn], [["warns", "plain"], [0]], "the service follows the warning past its filter");
  const raw = about("Klee One", { ...kleeRec, apart: ["", "warns", "plain"], apartWarn: [1] });
  assert.deepEqual([raw.card, raw.cardWarn], [["warns", "plain"], [0]], "so does the add-on, for a record it gets unfiltered");
  const f = F.find((x) => x.name === "Klee One");
  assert.equal(m.technicalFirst, `Lower case ${f.xRatio}% as tall as capitals (typical here: about ${fonts.xRatioMedian}%).`, "Technical's first sentence, for short windows");
  assert.ok(m.technical.startsWith(`${m.technicalFirst} `));
  assert.equal(about("Patrick Hand SC", zenRec).technicalFirst, `Lower-case letters appear as small capitals, ${F.find((x) => x.name === "Patrick Hand SC").xRatio}% as tall as capitals.`);
});

test("tools/fonts.mjs about: drops sources, keeps the catalog's names and the warning flag; Letters stays coverage only (8D)", () => {
  const writer = { "Yomogi": { strip: "a g", desc: "d", apart: ["x", "Its long dash runs right up to the next word", "y"], apartWarn: [1], madeShort: "m", background: "b", weight: "w", letters: "English letters. This copy is Latin only; the full font also has Japanese.", copyLatinOnly: true, familyScripts: ["Japanese"], weightLoaded: "Regular", dashNote: "An old dash note.", sources: [{ claim: "c", source: "s" }] },
    "Klee One": { strip: "a", desc: "d", dashNote: "unused", sources: [] }, "Unknown": { desc: "x" } };
  const out = aboutRecords(writer, fonts);
  assert.equal(out.listVersion, 2);
  assert.deepEqual(Object.keys(out.records).sort(), ["Klee One", "Yomogi"]);
  assert.equal(out.records.Yomogi.letters, "English letters. This copy is Latin only; the full font also has Japanese.", "no dash note in Letters");
  assert.deepEqual(out.records.Yomogi.apartWarn, [1]);
  assert.equal("sources" in out.records.Yomogi || "dashNote" in out.records.Yomogi, false);
  assert.equal("dashNote" in out.records["Klee One"], false);
});

test("8D and the flag in the shipped records: Yomogi's dash is trait 2 (on the card), its thin strokes trait 3; the two warnings", { skip: !shipped && "font-about.json not integrated" }, () => {
  const y = shipped.records.Yomogi, b = shipped.records["Barlow Condensed"];
  assert.deepEqual(y.apart, ["English letters take equal space, so i and l sit in wide gaps", "Its long dash runs right up to the next word", "Extra-thin, even strokes"]);
  assert.deepEqual(y.apartWarn, [1]);
  assert.doesNotMatch(y.letters, /dash runs/, "the Letters row is back to coverage only");
  assert.equal(y.letters, "Basic English letters, accents such as é, ñ and ü, curly quotes and dashes. This copy is Latin only; the full font also has Japanese, Cyrillic and Vietnamese.");
  assert.equal(b.apart[0], "Two hyphens in a row are drawn as one long dash");
  assert.deepEqual(b.apartWarn, [0]);
  const flagged = Object.entries(shipped.records).filter(([, r]) => r.apartWarn?.length).map(([n]) => n).sort();
  assert.deepEqual(flagged, ["Barlow Condensed", "Yomogi"], "today's warnings, marked in the records");
  for (const n of flagged) for (const i of shipped.records[n].apartWarn) assert.ok(i < 2 && i < shipped.records[n].apart.length, `${n}: a warning trait is on the card`);
  for (const f of F.filter((x) => x.dashesTouch)) assert.ok(shipped.records[f.name].apartWarn?.length, `${f.name}: dashes touch in T3, so its record warns`);
  const m = plain(C.fontAbout(fam("Yomogi"), y, { median: fonts.xRatioMedian, usage: [] }));
  assert.deepEqual([m.card, m.cardWarn], [y.apart.slice(0, 2), [1]], "the card shows the dash trait, marked as the warning");
});

// ---------------------------------------------------------------- the words: card, panel, special kinds, usage

const zenRec = fixture.records["Zen Kurenaido"], kleeRec = fixture.records["Klee One"];
const about = (name, rec, ctx = {}) => plain(C.fontAbout(fam(name), rec, { median: fonts.xRatioMedian, usage: [], ...ctx }));

test("the card's lines: Technical numbers are fonts.json's, Background is madeShort, two traits", () => {
  const m = about("Zen Kurenaido", zenRec, { usage: [{ label: "Replies", size: 130 }] });
  const f = F.find((x) => x.name === "Zen Kurenaido");
  assert.equal(m.kind, "font");
  assert.equal(m.technical, `Lower case ${f.xRatio}% as tall as capitals (typical here: about ${fonts.xRatioMedian}%). Regular weight; Latin letters only in this copy.`);
  assert.equal(m.background, zenRec.madeShort);
  assert.deepEqual(m.card, zenRec.apart.slice(0, 2));
  assert.equal(m.usage, "You use it for Replies, at 130%.");
  assert.deepEqual(m.panel.rows, [
    ["Lower case", `${f.xRatio}% of capital height; typical here is about ${fonts.xRatioMedian}%`],
    ["Width", `A sample sentence at the default size is about ${f.widthVsSystem}% wider than in T3's built-in system font at 100%`],
    ["Weight", zenRec.weight], ["Letters", zenRec.letters],
  ]);
  assert.equal(m.panel.using, `Default size here ${f.size}%, to bring its lower case close to the height of T3's built-in system font at 100%. Print: letters mostly stand apart. You use it for Replies, at 130%.`);
  assert.doesNotMatch(JSON.stringify(m), /Bold text shows/, "a Google family's bold is made up in T3, so never said");
  const noLatin = about("Zen Kurenaido", { ...zenRec, copyLatinOnly: false });
  assert.match(noLatin.technical, /\. Regular weight\.$/);
});

test("width row: wider, narrower, about as wide as", () => {
  assert.match(T.widthRow(12), /about 12% wider than in T3's built-in system font at 100%$/);
  assert.match(T.widthRow(-9), /about 9% narrower than in T3's built-in system font at 100%$/);
  assert.equal(T.widthRow(0), "A sample sentence at the default size is about as wide as in T3's built-in system font at 100%");
  const cav = about("Caveat Brush", { ...zenRec });
  assert.equal(F.find((f) => f.name === "Caveat Brush").widthVsSystem, 0);
  assert.equal(cav.panel.rows[1][1], T.widthSame);
});

test("special kinds: T3's own fonts, missing and present Mac fonts, small capitals, clamped sizes, hidden by the filter", () => {
  const cat = C.normalizeCatalog(fontCatalogProjection(fonts));
  const t3 = (name, now) => plain(C.fontAbout(cat.find((f) => f.name === name), null, { median: 70, usage: [{ label: "Replies", size: null }], now }));
  assert.equal(t3("T3 interface font", "Inter").sentence, "Follows T3's Settings → Appearance interface font (now: Inter). The size buttons don't apply.");
  assert.equal(t3("T3 composer font", "Georgia").sentence, "Follows T3's Settings → Appearance composer font (now: Georgia). The size buttons don't apply.");
  assert.equal(t3("T3 code font", "Menlo").sentence, "Follows T3's Settings → Appearance code font (now: Menlo). The size buttons don't apply.");
  assert.equal(t3("T3 interface font", C.firstFamily('-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif')).sentence, "Follows T3's Settings → Appearance interface font (now: the system font). The size buttons don't apply.");
  for (const alias of ["system-ui", "BlinkMacSystemFont", "ui-sans-serif", "ui-monospace"]) assert.equal(C.firstFamily(`${alias}, sans-serif`), "the system font", alias);
  assert.equal(C.firstFamily('"JetBrains Mono", monospace'), "JetBrains Mono");
  assert.equal(t3("T3 system font").sentence, "Uses T3's built-in system font. The size buttons don't apply.");
  assert.equal(t3("T3 system font").usage, "You use it for Replies.", "T3's own fonts: no size");
  assert.equal(t3("T3 code font", "Menlo").kind, "t3");
  const missing = plain(C.fontAbout(fam("Noteworthy"), null, { median: 70, native: false }));
  assert.deepEqual(missing, { kind: "missing", name: "Noteworthy", nameCss: null, sentence: "Not on this Mac; text would stay in T3's font." });
  const macRec = { ...zenRec, madeShort: "Comes with macOS; the file credits Someone, YEARS(1992, 1993, 2001).", copyLatinOnly: true };
  const mac = about("Bradley Hand", macRec, { native: true });
  assert.match(mac.technical, /\. Bold weight\.$|\. Regular weight\.$/, "a Mac font's Technical line has no Latin-only clause");
  assert.doesNotMatch(mac.technical, /Latin/);
  assert.equal(mac.background, "Comes with macOS; the file credits Someone, 1992, 1993 and 2001.");
  assert.match(mac.panel.using, /Bold text shows in the same weight\./, "a one-weight Mac family: T3 showed bold in the same weight");
  assert.doesNotMatch(about("Marker Felt", macRec, { native: true }).panel.using, /Bold text/, "Marker Felt has two weights");
  const sc = about("Patrick Hand SC", zenRec), psc = F.find((f) => f.name === "Patrick Hand SC");
  assert.equal(sc.technical, `Lower-case letters appear as small capitals, ${psc.xRatio}% as tall as capitals. Regular weight; Latin letters only in this copy.`);
  assert.deepEqual(sc.panel.rows[0], ["Lower case", `Small capitals, ${psc.xRatio}% of capital height`], "no typical comparison");
  assert.match(sc.panel.using, /^Default size here 110%, to bring its small capitals close to the lower-case height of T3's built-in system font at 100%\. /);
  assert.match(about("Amatic SC", zenRec).panel.using, /^Default size here 80%, the smallest size; its small capitals are still taller than the lower case of T3's built-in system font at 100%\. /);
  assert.match(about("Rock Salt", zenRec).panel.using, /^Default size here 80%, the smallest size; its lower case is still taller than the lower case of T3's built-in system font at 100%\. /);
  assert.match(about("Over the Rainbow", zenRec).panel.using, /^Default size here 80%, to bring its lower case close to/, "exactly 80% is a match, not the floor");
  assert.match(about("Hi Melody", zenRec).panel.using, /^Default size here 155%, to bring its lower case close to the height of T3's built-in system font at 100%\. /, "no top-limit sentence");
  assert.match(about("Kalam", zenRec).panel.using, / Semi-cursive: some letters join\. /);
  assert.match(about("Over the Rainbow", zenRec).panel.using, / Cursive: most letters join up\. /);
  assert.equal(about("Kalam", zenRec, { hidden: true }).hiddenLine, "Hidden by Print only; listed because it's your current choice.");
  assert.equal(about("Over the Rainbow", zenRec, { hidden: true }).hiddenLine, "Hidden until Print only and Show semi-cursive are both off; listed because it's your current choice.");
  assert.equal(about("Zen Kurenaido", zenRec).hiddenLine, null);
});

test("missing or incomplete records show nothing; record text is kept as given (rendered as text)", () => {
  assert.equal(C.fontAbout(fam("Zen Kurenaido"), null, { median: 70 }), null);
  assert.equal(C.fontAbout(fam("Zen Kurenaido"), { ...zenRec, weightLoaded: "" }, { median: 70 }), null);
  assert.equal(C.fontAbout(fam("Zen Kurenaido"), zenRec, { median: null }), null, "no catalog median, no card");
  assert.equal(C.fontAbout(null, zenRec, { median: 70 }), null);
  assert.equal(about("Klee One", { ...kleeRec, desc: "<img src=x onerror=alert(1)>" }).desc, "<img src=x onerror=alert(1)>");
});

test("usage sentences: none, one, two, three, more, mixed sizes, T3's own fonts", () => {
  const u = (labels, sizes, o) => C.usageSentence(labels.map((label, i) => ({ label, size: sizes?.[i] ?? 120 })), o);
  assert.equal(C.usageSentence([]), "Not used anywhere yet.");
  assert.equal(u(["Replies"]), "You use it for Replies, at 120%.");
  assert.equal(u(["Message composer", "Your sent prompts"]), "You use it for Message composer and Your sent prompts, at 120%.");
  assert.equal(u(["A", "B", "C"]), "You use it for A, B and C, at 120%.");
  assert.equal(u(["Replies", "Quotes", "Tables", "D", "E"], [130, 130, 130, 130, 130]), "You use it for Replies, Quotes, Tables and 2 more, at 130%.");
  assert.equal(u(["A", "B"], [120, 130]), "You use it for A at 120% and B at 130%.");
  assert.equal(u(["A", "B", "C"], [120, 130, 120]), "You use it for A at 120%, B at 130% and C at 120%.");
  assert.equal(u(["Replies", "Quotes", "Tables", "D", "E"], [130, 120, 110, 130, 130]), "You use it for Replies at 130%, Quotes at 120%, Tables at 110% and 2 more, sizes not listed.");
  assert.equal(u(["A", "B", "C", "D"], [120, 120, 120, 140]), "You use it for A at 120%, B at 120%, C at 120% and 1 more, sizes not listed.", "the shared size only when every area has it");
  // 9B: with semicolons, "; and" before the last area, at any count.
  assert.equal(u(["Reply headings, project & add-on labels", "Replies"]), "You use it for Reply headings, project & add-on labels; and Replies, at 120%.");
  assert.equal(u(["Replies", "Reply headings, project & add-on labels"], [100, 110]), "You use it for Replies at 100%; and Reply headings, project & add-on labels at 110%.", "Fable's case: two areas, one name with a comma");
  assert.equal(u(["Replies", "Reply headings, project & add-on labels", "Quotes in replies"]), "You use it for Replies; Reply headings, project & add-on labels; and Quotes in replies, at 120%.", "semicolons when a shown name has a comma");
  assert.equal(u(["A", "B", "C"], [120, 130, 120]), "You use it for A at 120%, B at 130% and C at 120%.", "no comma in a name: no semicolons and no comma before and");
  assert.equal(u(["Replies", "Reply headings, project & add-on labels", "Quotes in replies", "Tables in replies"]), "You use it for Replies; Reply headings, project & add-on labels; Quotes in replies; and 1 more, at 120%.", "1B: \"; and N more\" after semicolons");
  assert.equal(u(["Replies", "Reply headings, project & add-on labels", "Quotes in replies", "Tables in replies", "Code in replies"]), "You use it for Replies; Reply headings, project & add-on labels; Quotes in replies; and 2 more, at 120%.");
  assert.equal(u(["Replies", "Reply headings, project & add-on labels", "Quotes in replies", "Tables in replies", "Code in replies"], [120, 120, 110, 120, 120]), "You use it for Replies at 120%; Reply headings, project & add-on labels at 120%; Quotes in replies at 110%; and 2 more, sizes not listed.", "1B with mixed sizes");
  assert.equal(u(["Replies", "Quotes in replies", "Tables in replies", "Code in replies", "Reply headings, project & add-on labels"]), "You use it for Replies, Quotes in replies, Tables in replies and 2 more, at 120%.", "1B: a comma list keeps its plain \" and N more\" (the comma name isn't shown)");
  assert.equal(u(["A", "B"], [null, null], { noSize: true }), "You use it for A and B.");
  assert.equal(u(["A", "B", "C", "D"], [null, null, null, null], { noSize: true }), "You use it for A, B, C and 1 more.");
});

test("FONT_TEXT: the 14 Nov 2026 additions (7A, 10G′, 11C add-on)", () => {
  assert.equal(T.detailsNone, "No details for this font.");
  assert.equal(T.paneSwapHead("Replies"), "Replies · About the highlighted font");
  assert.equal(T.sizeCapNote(150, 200), "The font name above is drawn at 150%; the app uses 200%.");
});

test("FONT_TEXT holds Andy's confirmed wording (13 Nov 2026, 9:51 PM), nothing left pending", () => {
  assert.equal("PENDING" in T, false);
  assert.equal(T.lowerCaseLine(59, 70), "Lower case 59% as tall as capitals (typical here: about 70%).");
  assert.equal(T.lowerCaseRow(59, 70), "59% of capital height; typical here is about 70%");
  assert.equal(T.smallCapsLine(88), "Lower-case letters appear as small capitals, 88% as tall as capitals.");
  assert.equal(T.smallCapsRow(88), "Small capitals, 88% of capital height");
  assert.equal(T.defaultSize(120), "Default size here 120%, to bring its lower case close to the height of T3's built-in system font at 100%.");
  assert.equal(T.defaultSizeFloor(80), "Default size here 80%, the smallest size; its lower case is still taller than the lower case of T3's built-in system font at 100%.");
  assert.deepEqual(plain(T.style), { print: "Print: letters mostly stand apart.", partly: "Semi-cursive: some letters join.", joined: "Cursive: most letters join up." });
  assert.equal(T.detailsFailed, "Font details couldn't load.");
  assert.equal(C.creditText("the file credits Pat Snyder, YEARS(1992, 1993, 2001)."), "the file credits Pat Snyder, 1992, 1993 and 2001.");
  assert.deepEqual(plain(C.BOLD_SAME_CHECKED), { google: false, mac: true });
});

test("S3′ placement (pure): beside the panel, level with the row or slid up just enough to fit (1B), whole and clear, or nothing", () => {
  const panel = { left: 20, top: 200, right: 380, bottom: 900 };
  assert.deepEqual(plain(C.besideSpot({ w: 300, h: 360 }, panel, 490, [], { vw: 1512, vh: 945 })), { left: 392, top: 490 });
  assert.deepEqual(plain(C.besideSpot({ w: 300, h: 500 }, panel, 490, [], { vw: 1512, vh: 945 })), { left: 392, top: 433 }, "would run off the bottom: slid up to 12 px above the window's foot");
  assert.deepEqual(plain(C.besideSpot({ w: 300, h: 500 }, panel, 433, [], { vw: 1512, vh: 945 })), { left: 392, top: 433 }, "exactly fits: level with the row");
  assert.equal(C.besideSpot({ w: 300, h: 940 }, panel, 490, [], { vw: 1512, vh: 945 }), null, "taller than the window: none");
  assert.equal(C.besideSpot({ w: 300, h: 500 }, panel, 490, [{ left: 600, top: 440, right: 700, bottom: 460 }], { vw: 1512, vh: 945 }), null, "slid up, it would cover the area's text: none");
  assert.equal(C.besideSpot({ w: 300, h: 360 }, panel, 490, [{ left: 600, top: 600, right: 700, bottom: 620 }], { vw: 1512, vh: 945 }), null, "would cover the area's text");
  const right = { left: 1100, top: 100, right: 1460, bottom: 900 };
  assert.deepEqual(plain(C.besideSpot({ w: 300, h: 360 }, right, 300, [], { vw: 1512, vh: 945 })), { left: 788, top: 300 }, "left of a panel on the right");
  assert.equal(C.besideSpot({ w: 300, h: 360 }, { left: 0, top: 0, right: 640, bottom: 480 }, 10, [], { vw: 640, vh: 480 }), null, "no room either side");
});
