/**
 * Accept Node 22.16+ on the 22 line, or 24+. The probe opens a temp sqlite
 * database with a file: URL and a timeout, the same shape the workers use.
 * Run this file with the candidate binary: `node node-probe.mjs`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function versionOk(version) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version).trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major === 22) return minor >= 16;
  return major >= 24;
}

/** Opens `file` the way the workers open sqlite: a file: URL plus timeout. */
export function openProbeDb(DatabaseSync, file) {
  const url = pathToFileURL(file);
  url.search = "?mode=rwc";
  if (url.protocol !== "file:") throw new Error("sqlite probe needs a file: URL");
  const db = new DatabaseSync(url, { timeout: 500 });
  try {
    db.exec("create table if not exists t3x_probe(x)");
  } finally {
    db.close();
  }
}

const isMain = process.argv[1]
  && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  if (!versionOk(process.versions.node)) {
    console.error(`need Node 22.16+ or 24+ (this one is ${process.versions.node})`);
    process.exit(1);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-node-probe-"));
  try {
    openProbeDb(DatabaseSync, path.join(dir, "probe.sqlite"));
  } catch (error) {
    console.error(`sqlite probe failed: ${error.message}`);
    process.exit(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
