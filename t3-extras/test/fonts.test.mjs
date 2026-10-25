// fonts.json: the one list behind both font pickers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { latinWoff2, deriveTags, slug } from "../tools/fonts.mjs";

const data = JSON.parse(fs.readFileSync(new URL("../fonts.json", import.meta.url), "utf8"));
const F = data.families;

test("51 families: 46 from Google Fonts, 5 built into macOS, names unique", () => {
  assert.equal(F.length, 51);
  assert.equal(F.filter((f) => f.source === "google").length, 46);
  assert.deepEqual(F.filter((f) => f.source === "mac").map((f) => f.name), ["Noteworthy", "Marker Felt", "Chalkboard SE", "Bradley Hand", "SignPainter"]);
  assert.equal(new Set(F.map((f) => f.name)).size, 51);
  assert.equal(F.filter((f) => f.group === "cond").length, 7);
});

test("Argon's style verdicts as data: 2 joined, 13 partly joined, the rest print; 8 stars, 8 hard to read", () => {
  const by = (style) => F.filter((f) => f.style === style).map((f) => f.name).sort();
  assert.deepEqual(by("joined"), ["Over the Rainbow", "SignPainter"]);
  assert.equal(by("partly").length, 13);
  assert.ok(by("partly").includes("Caveat") && by("partly").includes("Bradley Hand") && by("partly").includes("Kalam"));
  assert.equal(F.find((f) => f.name === "Noteworthy").style, "print", "coordinator override");
  assert.equal(F.filter((f) => f.star).length, 8);
  assert.equal(F.filter((f) => f.hard).length, 8);
  assert.ok(F.filter((f) => f.group === "cond").every((f) => f.style === "print"));
});

test("every Google family is pinned: a gstatic woff2 and its real licence, each with a sha256", () => {
  const files = new Map(data.files.map((x) => [x.file, x]));
  assert.match(data.googleFontsCommit, /^[0-9a-f]{40}$/);
  for (const f of F.filter((x) => x.source === "google")) {
    const font = files.get(f.file);
    const lic = files.get(f.licence);
    assert.ok(font && lic, f.name);
    assert.match(font.url, /^https:\/\/fonts\.gstatic\.com\/s\/[a-z0-9]+\/v\d+\/[A-Za-z0-9_-]+\.woff2$/, f.name);
    assert.ok(lic.url.startsWith(`https://raw.githubusercontent.com/google/fonts/${data.googleFontsCommit}/`), f.name);
    assert.match(f.licenceType, /^(OFL-1\.1|Apache-2\.0|UFL-1\.0)$/);
    for (const x of [font, lic]) assert.match(x.sha256, /^[0-9a-f]{64}$/);
    assert.match(f.file, /^[a-z0-9-]+-latin-400\.woff2$/);
  }
  assert.equal(F.find((f) => f.name === "Permanent Marker").licenceType, "Apache-2.0");
  for (const x of data.files) assert.match(x.file, /^[A-Za-z0-9._-]+$/, "install.sh's file-name rule");
});

test("measured: width, tallness, tags and a default size within 80-150%", () => {
  for (const f of F) {
    assert.ok(f.width > 100 && f.tallness > 0.5, f.name);
    assert.ok(f.size >= 80 && f.size <= 150 && f.size % 5 === 0, `${f.name} ${f.size}`);
  }
  const jah = F.find((f) => f.name === "Just Another Hand");
  assert.ok(jah.narrow && jah.tall);
  assert.ok(jah.size >= 120 && jah.size <= 135, "narrow hands need ~125-135%");
});

test("tool helpers: the latin block, tags and sizes", () => {
  const css = `/* cyrillic */ @font-face { src: url(https://fonts.gstatic.com/s/x/v1/cyr.woff2) format('woff2'); unicode-range: U+0400-045F; }
/* latin */ @font-face { src: url(https://fonts.gstatic.com/s/x/v1/lat.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }`;
  assert.equal(latinWoff2(css).url, "https://fonts.gstatic.com/s/x/v1/lat.woff2");
  const korean = `/* [119] */ @font-face { src: url(https://fonts.gstatic.com/s/k/v1/a.woff2); unicode-range: U+AC00-AC10; }
/* [120] */ @font-face { src: url(https://fonts.gstatic.com/s/k/v1/b.woff2); unicode-range: U+0020-007E; }`;
  assert.equal(latinWoff2(korean).url, "https://fonts.gstatic.com/s/k/v1/b.woff2");
  const fams = [{ group: "hand", m: { w: 100, tall: 1, xh: 0.5 } }, { group: "hand", m: { w: 200, tall: 2, xh: 0.25 } }, { group: "hand", m: { w: 300, tall: 3, xh: 1 } }];
  deriveTags(fams, 0.5);
  assert.deepEqual(fams.map((f) => [f.narrow, f.tall, f.size]), [[true, false, 100], [false, false, 150], [false, true, 80]]);
  assert.equal(slug("Patrick Hand SC"), "patrick-hand-sc");
});
