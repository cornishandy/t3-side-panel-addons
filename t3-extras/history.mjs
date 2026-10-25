/**
 * The usage history file (~/.local/share/t3-extras/usage-history.jsonl): one JSON line per sample,
 * {ts, s: "<lab>:<long|short>", used, resetsAt, lengthSec}. Kept bounded:
 *  - one writer (this service; every write goes through one queue);
 *  - at most one sample per lab/window per 10 min;
 *  - 15 days, plus global line and byte caps (HISTORY in lib.mjs);
 *  - startup and reads look at no more than the last ~maxBytes of the file;
 *  - compaction writes one temp file, fsyncs it and renames it over the old one (atomic);
 *  - an append that would cross a cap waits for a successful compaction; while compaction fails,
 *    appending is suspended (samples are dropped, not queued) and retried at most every 10 min.
 * Storage errors are logged once and swallowed: they never break /state.
 */
import fs from "node:fs";
import path from "node:path";
import { HISTORY, parseSample, compactSamples, boundedSamples } from "./lib.mjs";

const READ_LIMIT = Math.round(HISTORY.maxBytes * 1.2);

/** The last READ_LIMIT bytes of the file as samples (a cut first line is skipped). */
function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return { samples: [], size: 0, lines: 0 };
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, READ_LIMIT);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString("utf8");
    if (size > len) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n").filter(Boolean);
    return { samples: lines.map(parseSample).filter(Boolean), size, lines: lines.length, truncated: size > len };
  } finally {
    fs.closeSync(fd);
  }
}

export function createHistory(file, { now = () => Date.now(), log = () => {} } = {}) {
  const last = new Map(); // series -> ts of its newest sample
  let lines = 0;
  let bytes = 0;
  let queue = Promise.resolve();
  let cache = null; // { key, samples }
  let suspended = false; // compaction failed: no appends until one succeeds
  let lastTry = -Infinity;
  const warned = new Set();
  const warn = (kind, error) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    log(`history ${kind} failed: ${error?.message ?? error}`);
  };
  const serial = (fn) => (queue = queue.then(fn).catch((error) => warn("write", error)));

  function compactNow() {
    const { samples } = readTail(file);
    const kept = compactSamples(samples, now());
    const body = kept.map((x) => JSON.stringify(x)).join("\n") + (kept.length ? "\n" : "");
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    lines = kept.length;
    bytes = Buffer.byteLength(body);
    last.clear();
    for (const x of kept) last.set(x.s, Math.max(last.get(x.s) ?? 0, x.ts));
    cache = null;
  }

  /** Compacts; on failure suspends appending (logged once) until a later compaction succeeds. */
  function tryCompact() {
    lastTry = now();
    try {
      compactNow();
      suspended = false;
      return true;
    } catch (error) {
      suspended = true;
      warn("compaction", error);
      return false;
    }
  }

  /** Startup: bounded read; compact at once if the file is over a cap, old, or damaged. */
  function load() {
    return serial(() => {
      const t = readTail(file);
      lines = t.lines;
      bytes = t.size;
      for (const x of t.samples) last.set(x.s, Math.max(last.get(x.s) ?? 0, x.ts));
      const stale = t.samples.length && t.samples[0].ts < now() - HISTORY.keepMs;
      if (t.truncated || t.lines > HISTORY.maxLines || t.size > HISTORY.maxBytes || t.samples.length < t.lines || stale) tryCompact();
    });
  }

  /** Queue samples [{ts, s, used, resetsAt, lengthSec}]; each is kept only if its series is due. */
  function append(samples) {
    return serial(() => {
      if (suspended && (now() - lastTry < HISTORY.everyMs || !tryCompact())) return;
      const due = [];
      const next = new Map(); // series -> ts, applied only once the lines are written
      for (const x of samples) {
        if (!x) continue;
        const prev = next.get(x.s) ?? last.get(x.s) ?? 0;
        if (x.ts <= prev || x.ts - prev < HISTORY.everyMs || x.ts > now() + 60_000) continue;
        const line = JSON.stringify(x);
        if (line.length > HISTORY.maxLineBytes) continue;
        due.push(line);
        next.set(x.s, x.ts);
      }
      if (!due.length) return;
      const text = `${due.join("\n")}\n`;
      // Crossing a cap needs a successful compaction first; otherwise nothing is written.
      if ((lines + due.length > HISTORY.maxLines || bytes + Buffer.byteLength(text) > HISTORY.maxBytes) && !tryCompact()) return;
      if (lines + due.length > HISTORY.maxLines || bytes + Buffer.byteLength(text) > HISTORY.maxBytes) return;
      fs.appendFileSync(file, text, { mode: 0o600 });
      lines += due.length;
      bytes += Buffer.byteLength(text);
      for (const [k, ts] of next) last.set(k, Math.max(last.get(k) ?? 0, ts));
      cache = null;
    });
  }

  /** Bounded samples since `since` (ms). Never throws: a broken file reads as empty. */
  function read(since = 0) {
    try {
      const st = fs.statSync(file);
      const key = `${st.mtimeMs}:${st.size}`;
      if (cache?.key !== key) cache = { key, samples: readTail(file).samples.sort((a, b) => a.ts - b.ts) };
      return boundedSamples(cache.samples, Math.max(since, now() - HISTORY.keepMs));
    } catch (error) {
      if (error.code !== "ENOENT") warn("read", error);
      return [];
    }
  }

  return { load, append, read, compact: () => serial(tryCompact), idle: () => queue, stats: () => ({ lines, bytes, series: last.size, suspended }) };
}
