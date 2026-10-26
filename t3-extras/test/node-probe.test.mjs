// Node discovery's version rule and the sqlite probe the installers run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { versionOk, openProbeDb } from "../node-probe.mjs";

test("accepts Node 22.16, 24 and 26, and rejects 20, 22.15 and 23", () => {
  for (const version of ["22.16.0", "v22.16.1", "22.19.0", "24.0.0", "v24.11.0", "26.9.0"]) {
    assert.equal(versionOk(version), true, version);
  }
  for (const version of ["20.18.1", "v20.0.0", "22.15.0", "22.15.99", "23.11.0", "v23.0.1", "21.7.0", "not-a-version"]) {
    assert.equal(versionOk(version), false, version);
  }
});

test("the probe opens a file: URL with the workers' timeout, and a stand-in records that", () => {
  const file = path.join(os.tmpdir(), "t3x-probe-unused.sqlite");
  let seen;
  class Fake {
    constructor(url, options) { seen = { url, options }; }
    exec(sql) { seen.sql = sql; }
    close() { seen.closed = true; }
  }
  openProbeDb(Fake, file);
  assert.equal(seen.url.protocol, "file:");
  assert.equal(seen.url.search, "?mode=rwc");
  assert.equal(seen.url.href, `${pathToFileURL(file).href}?mode=rwc`);
  assert.deepEqual(seen.options, { timeout: 500 });
  assert.equal(seen.sql, "create table if not exists t3x_probe(x)");
  assert.equal(seen.closed, true);
});

test("the probe opens a real temp sqlite database", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-probe-real-"));
  try {
    const file = path.join(dir, "probe.sqlite");
    openProbeDb(DatabaseSync, file);
    assert.ok(fs.statSync(file).size > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
