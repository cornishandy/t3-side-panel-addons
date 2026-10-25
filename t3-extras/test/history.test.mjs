// The usage history file: one writer, 10-minute spacing, 15 days, line and byte caps, atomic compaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HISTORY, historySample, parseSample, compactSamples, boundedSamples } from "../lib.mjs";
import { createHistory } from "../history.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-hist-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const w = (usedPct, resetsAt = NOW + 86_400_000) => ({ usedPct, resetsAt, lengthSec: 604_800 });

test("samples: known labs and roles only, numbers checked, overage kept", () => {
  assert.deepEqual(historySample("claude", "long", w(37.123), NOW), { ts: NOW, s: "claude:long", used: 37.12, resetsAt: NOW + 86_400_000, lengthSec: 604_800 });
  assert.equal(historySample("evil", "long", w(1), NOW), null);
  assert.equal(historySample("claude", "extra", w(1), NOW), null);
  assert.equal(historySample("claude", "long", w(null), NOW), null);
  assert.equal(historySample("claude", "long", w(Number.NaN), NOW), null);
  assert.equal(historySample("claude", "long", w(104), NOW).used, 104);
  assert.equal(parseSample('{"ts":1,"s":"codex:long","used":5}').s, "codex:long");
  assert.equal(parseSample("{oops"), null);
  assert.equal(parseSample(`{"ts":1,"s":"codex:long","used":5,"x":"${"a".repeat(300)}"}`), null, "over-long line refused");
});

test("compaction keeps 15 days and the caps, newest first", () => {
  const old = { ts: NOW - HISTORY.keepMs - 1, s: "claude:long", used: 1 };
  const future = { ts: NOW + 3_600_000, s: "claude:long", used: 1 };
  const many = Array.from({ length: HISTORY.maxLines + 50 }, (_, i) => ({ ts: NOW - i * 1000, s: "codex:long", used: 1 }));
  const out = compactSamples([old, future, ...many], NOW);
  assert.ok(out.length <= HISTORY.maxLines);
  assert.ok(!out.includes(old) && !out.includes(future));
  assert.equal(out.at(-1).ts, NOW, "the newest sample survives");
  const bytes = out.reduce((n, x) => n + JSON.stringify(x).length + 1, 0);
  assert.ok(bytes <= HISTORY.maxBytes);
  assert.equal(boundedSamples(many).length, HISTORY.maxReturn);
});

test("the writer spaces samples 10 min apart per series and ignores old or repeated readings", async () => {
  let now = NOW;
  const file = path.join(tmp, "a.jsonl");
  const h = createHistory(file, { now: () => now });
  await h.load();
  await h.append([historySample("claude", "long", w(10), NOW), historySample("claude", "short", w(20), NOW)]);
  await h.append([historySample("claude", "long", w(11), NOW + 5 * MIN)]); // too soon
  await h.append([historySample("claude", "long", w(11), NOW - MIN)]); // older than the last
  now = NOW + 10 * MIN;
  await h.append([historySample("claude", "long", w(12), NOW + 10 * MIN), historySample("claude", "long", w(13), NOW + 10 * MIN)]);
  const got = h.read().map((x) => [x.s, x.used]);
  assert.deepEqual(got, [["claude:long", 10], ["claude:short", 20], ["claude:long", 12]]);
  // A second process start reads the newest per series back and keeps the spacing.
  const h2 = createHistory(file, { now: () => now });
  await h2.load();
  await h2.append([historySample("claude", "long", w(14), NOW + 15 * MIN)]);
  assert.equal(h2.read().length, 3);
});

test("over a cap the file is compacted atomically (temp file + rename), never left half-written", async () => {
  const file = path.join(tmp, "b.jsonl");
  // A damaged file: a bad line, an expired line and too many lines.
  const lines = ['{"broken', JSON.stringify({ ts: NOW - HISTORY.keepMs - 5, s: "codex:long", used: 1 })];
  for (let i = 0; i < HISTORY.maxLines + 10; i++) lines.push(JSON.stringify({ ts: NOW - (HISTORY.maxLines + 10 - i) * 1000, s: "codex:long", used: i % 100 }));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const h = createHistory(file, { now: () => NOW });
  await h.load();
  const text = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.ok(text.length <= HISTORY.maxLines);
  assert.ok(text.every((l) => parseSample(l)), "only valid lines remain");
  assert.ok(fs.statSync(file).size <= HISTORY.maxBytes);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.includes(".tmp-")), [], "no temp file left behind");
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
});

test("startup reads only the tail of an oversized file", async () => {
  const file = path.join(tmp, "c.jsonl");
  const line = JSON.stringify({ ts: NOW - 1000, s: "grok:long", used: 50 });
  fs.writeFileSync(file, `${"x".repeat(HISTORY.maxBytes * 3)}\n${line}\n`);
  const h = createHistory(file, { now: () => NOW });
  await h.load();
  assert.deepEqual(h.read().map((x) => x.s), ["grok:long"]);
  assert.ok(fs.statSync(file).size < 1000, "compacted down to the valid tail");
});

test("storage errors never throw: unwritable folder, missing file", async () => {
  const ro = path.join(tmp, "ro");
  fs.mkdirSync(ro, { mode: 0o500 });
  const logs = [];
  const h = createHistory(path.join(ro, "h.jsonl"), { now: () => NOW, log: (m) => logs.push(m) });
  await h.load();
  await h.append([historySample("claude", "long", w(1), NOW)]);
  assert.deepEqual(h.read(), []);
  assert.equal(logs.length, 1, "one warning, then quiet");
  fs.chmodSync(ro, 0o700);
});

test("a failed compaction suspends appending: nothing crosses a cap until a compaction succeeds (Sol's case)", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "ro-parent-"));
  const file = path.join(dir, "h.jsonl");
  let now = NOW;
  const logs = [];
  // The file itself is writable but its folder isn't, so the temp file (and so compaction) fails.
  fs.writeFileSync(file, "\n".repeat(HISTORY.maxBytes + 1), { mode: 0o600 });
  fs.chmodSync(dir, 0o500);
  try {
    const h = createHistory(file, { now: () => now, log: (m) => logs.push(m) });
    await h.load();
    const size0 = fs.statSync(file).size;
    for (let i = 0; i < 12; i++) {
      now += HISTORY.everyMs;
      await h.append([historySample("codex", "long", w(i), now)]);
    }
    assert.equal(fs.statSync(file).size, size0, "the file never grew");
    assert.equal(h.stats().suspended, true);
    assert.equal(logs.length, 1, "logged once");
    // Once compaction can run again, appending resumes, under the caps.
    fs.chmodSync(dir, 0o700);
    now += HISTORY.everyMs;
    await h.append([historySample("codex", "long", w(50), now)]);
    assert.equal(h.stats().suspended, false);
    assert.ok(fs.statSync(file).size < 1000);
    assert.deepEqual(h.read().map((x) => x.used), [50]);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test("an append that would cross a cap compacts first, and only then writes", async () => {
  const file = path.join(tmp, "d.jsonl");
  const lines = [];
  for (let i = 0; i < HISTORY.maxLines; i++) lines.push(JSON.stringify({ ts: NOW - (HISTORY.maxLines - i) * 1000, s: "codex:long", used: 1 }));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const h = createHistory(file, { now: () => NOW });
  await h.load();
  await h.append([historySample("claude", "long", w(5), NOW)]);
  const n = fs.readFileSync(file, "utf8").trim().split("\n").length;
  assert.ok(n <= HISTORY.maxLines * 0.9 + 1, `compacted with room (${n} lines)`);
  assert.equal(h.read().at(-1).s, "claude:long");
});

