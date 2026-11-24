// Thread details float and lock (Andy, 24 Nov 2026): the pure parts of public/extras.js, run in a VM.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../public/extras.js", import.meta.url), "utf8");
const sandbox = { window: { __T3X_TEST__: {} } };
vm.runInNewContext(src, sandbox);
const C = sandbox.window.__T3X_TEST__.core;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("settings: float on and Locked by default; only known modes kept", () => {
  const d = C.readSettings(null);
  assert.equal(d.detailsFloat, true);
  assert.equal(d.detailsMode, "locked");
  assert.deepEqual(plain(C.DETAILS_MODES), ["locked", "auto"]);
  const s = C.readSettings(JSON.stringify({ detailsFloat: false, detailsMode: "auto" }));
  assert.equal(s.detailsFloat, false);
  assert.equal(s.detailsMode, "auto", "the saved choice is kept while float is off");
  for (const bad of [{ detailsFloat: "no", detailsMode: "hover" }, { detailsFloat: 0, detailsMode: null }, { detailsMode: ["auto"] }]) {
    const b = C.readSettings(JSON.stringify(bad));
    assert.equal(b.detailsFloat, true, JSON.stringify(bad));
    assert.equal(b.detailsMode, "locked", JSON.stringify(bad));
  }
});

test("root attributes: mode only while floating", () => {
  const on = C.rootAttrs(C.readSettings(JSON.stringify({ detailsMode: "auto" })));
  assert.equal(on["data-t3x-details-float"], "");
  assert.equal(on["data-t3x-details-mode"], "auto");
  const off = C.rootAttrs(C.readSettings(JSON.stringify({ detailsFloat: false, detailsMode: "auto" })));
  assert.equal(off["data-t3x-details-float"], null);
  assert.equal(off["data-t3x-details-mode"], null);
});

test("corridor: from the buttons' bottom edge to the card's top, across both", () => {
  const buttons = { left: 1147, right: 1203, top: 12, bottom: 40 };
  const card = { left: 988, right: 1268, top: 64, bottom: 231 };
  assert.deepEqual(plain(C.detailsCorridor(buttons, card)), { left: 988, right: 1268, top: 40, bottom: 64 });
  assert.equal(C.inRect(C.detailsCorridor(buttons, card), 1000, 50), true, "a slow diagonal crossing stays inside");
  assert.equal(C.inRect(C.detailsCorridor(buttons, card), 1000, 30), false, "the header row beside the buttons is outside");
  assert.equal(C.inRect(C.detailsCorridor(buttons, card), 900, 50), false);
  // A card left of the buttons still spans from its own left edge to the buttons' right edge.
  assert.deepEqual(plain(C.detailsCorridor(buttons, { left: 600, right: 880, top: 64, bottom: 200 })), { left: 600, right: 1203, top: 40, bottom: 64 });
  // A card that starts level with or above the buttons has no corridor.
  assert.equal(C.detailsCorridor(buttons, { ...card, top: 40 }), null);
  assert.equal(C.detailsCorridor(buttons, { ...card, top: 20 }), null);
  assert.equal(C.detailsCorridor(null, card), null);
  assert.equal(C.inRect(null, 1, 1), false);
});
