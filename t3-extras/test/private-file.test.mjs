// History and diag files are opened with O_NOFOLLOW and forced to 0600, including a file that was 0644.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { historySample } from "../lib.mjs";
import { createHistory } from "../history.mjs";
import { openPrivate, WRITE_APPEND } from "../private-file.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-private-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const NOW = 1_800_000_000_000;
const mode = (file) => fs.lstatSync(file).mode & 0o777;
const sample = historySample("claude", "long", { usedPct: 10, resetsAt: NOW + 86_400_000, lengthSec: 604_800 }, NOW);

test("append forces an existing 0644 history file to 0600", async () => {
  const file = path.join(tmp, "wide.jsonl");
  fs.writeFileSync(file, "", { mode: 0o644 });
  assert.equal(mode(file), 0o644);
  const history = createHistory(file, { now: () => NOW });
  await history.load();
  await history.append([sample]);
  await history.idle();
  assert.equal(mode(file), 0o600);
  assert.match(fs.readFileSync(file, "utf8"), /claude:long/);
});

test("a symlink is not followed: the target's mode and bytes stay as they were", async () => {
  const target = path.join(tmp, "target.jsonl");
  fs.writeFileSync(target, "keep-me\n", { mode: 0o644 });
  const link = path.join(tmp, "linked.jsonl");
  fs.symlinkSync(target, link);
  const history = createHistory(link, { now: () => NOW });
  await history.append([sample]);
  await history.idle();
  assert.equal(fs.readFileSync(target, "utf8"), "keep-me\n");
  assert.equal(mode(target), 0o644);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.deepEqual(history.read(), []);
  assert.throws(() => openPrivate(link, WRITE_APPEND));
  assert.equal(fs.readFileSync(target, "utf8"), "keep-me\n");
  assert.equal(mode(target), 0o644);
});
