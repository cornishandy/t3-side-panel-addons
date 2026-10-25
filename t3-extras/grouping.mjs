/**
 * The sidebar index's I/O. One read-only worker, a 2s timeout, and a short single-flight cache.
 * The HTTP handler never takes a file path or a query from the request.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { classifyThreads } from "./grouping-core.mjs";

const RANK = { questions: 0, running: 1, child: 2, unknown: 3, open: 4 };

function factsCutShort(raw) {
  const flags = raw.factsIncomplete && typeof raw.factsIncomplete === "object" ? Object.values(raw.factsIncomplete) : [];
  const ids = raw.incompleteIds && typeof raw.incompleteIds === "object" ? Object.values(raw.incompleteIds) : [];
  return flags.some(Boolean) || ids.some((list) => Array.isArray(list) && list.length > 0);
}

function normalizeStall(stall) {
  if (!stall || typeof stall !== "object") return null;
  const families = ["approvals", "secrets", "runStamps", "requestStamps"];
  const family = families.includes(stall.family) ? stall.family : null;
  const afterChunks = Number(stall.afterChunks);
  const ms = Number(stall.ms);
  if (!family || !Number.isFinite(ms) || ms < 0 || ms > 8000) return null;
  if (family === "runStamps" || family === "requestStamps") return { family, afterChunks: 0, ms };
  if (!Number.isInteger(afterChunks) || afterChunks < 1 || afterChunks > 100000) return null;
  return { family, afterChunks, ms };
}

function questionsUnread(raw) {
  const flags = raw.factsIncomplete && typeof raw.factsIncomplete === "object" ? raw.factsIncomplete : {};
  const ids = raw.incompleteIds && typeof raw.incompleteIds === "object" ? raw.incompleteIds : {};
  for (const family of ["approvals", "pending", "plans", "secrets"]) {
    if (flags[family] === true) return true;
    if (Array.isArray(ids[family]) && ids[family].length > 0) return true;
  }
  return false;
}

export function createGrouping(opts = {}) {
  const home = opts.home ?? os.homedir();
  const statev2 = opts.statev2 ?? path.join(home, ".t3/userdata/statev2.sqlite");
  const envIdFile = opts.envIdFile ?? path.join(home, ".t3/userdata/environment-id");
  const cap = Math.max(1, Math.min(1000, Number(opts.cap) || 1000));
  const timeoutMs = opts.timeoutMs ?? 2000;
  const cacheMs = opts.cacheMs ?? 15_000;
  const failCacheMs = opts.failCacheMs ?? 5_000;
  const maxBytes = opts.maxBytes ?? 700_000;
  const workerUrl = opts.workerUrl ?? new URL("./grouping-sql-worker.mjs", import.meta.url);
  const now = opts.now ?? (() => Date.now());
  const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let worker = null;
  let reqId = 0;
  let reads = 0;
  const waiting = new Map();
  let cache = { at: 0, value: null };
  let flight = null;
  const stallFor = typeof opts.stall === "function" ? opts.stall : () => opts.stall ?? null;

  function localEnvironmentId() {
    try {
      const id = fs.readFileSync(envIdFile, "utf8").trim();
      return /^[A-Za-z0-9:_-]{1,100}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }
  function fail(reason) {
    return {
      ok: false, unavailable: true, reason, asOf: now(), localEnvironmentId: localEnvironmentId(),
      source: "v2", coverage: null, threads: null,
    };
  }
  function getWorker() {
    if (worker) return worker;
    const child = new Worker(workerUrl);
    child.unref();
    child.on("message", (message) => {
      const wait = waiting.get(message?.id);
      if (!wait) return;
      wait(message);
    });
    child.on("error", () => {});
    child.on("exit", () => {
      // A replacement worker may already own the next request. Don't fail it.
      if (worker !== child) return;
      worker = null;
      for (const wait of waiting.values()) wait({ error: "read" });
      waiting.clear();
    });
    worker = child;
    return child;
  }
  function query() {
    reads++;
    const id = ++reqId;
    return new Promise((resolve) => {
      let checkpoint = null;
      let settled = false;
      const finish = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiting.delete(id);
        resolve(message);
      };
      const timer = setTimeout(() => {
        waiting.delete(id);
        const current = worker;
        worker = null;
        current?.terminate();
        finish(checkpoint?.threads ? { ...checkpoint, ok: true, partial: true } : { error: "timeout" });
      }, timeoutMs);
      waiting.set(id, (message) => {
        if (message?.checkpoint && !message.ok && !message.error) {
          checkpoint = message;
          return;
        }
        if (message?.error && checkpoint?.threads) {
          finish({ ...checkpoint, ok: true, partial: true });
          return;
        }
        finish(message);
      });
      try {
        getWorker().postMessage({ id, file: statev2, cap, nowMs: now(), stall: normalizeStall(stallFor()) });
      } catch {
        finish({ error: "read" });
      }
    });
  }
  function present(raw) {
    const asOf = now();
    const runStamps = new Map((raw.runStamps ?? []).map((row) => [row.threadId, [row.requestedAt, row.completedAt, row.startedAt, row.workStartedAt]]));
    const requestStamps = new Map((raw.requestStamps ?? []).map((row) => [row.threadId, [row.createdAt, row.resolvedAt]]));
    const threads = (raw.threads ?? []).map((thread) => ({
      ...thread,
      runStamps: runStamps.get(thread.id) ?? [],
      requestStamps: requestStamps.get(thread.id) ?? [],
    }));
    const classified = classifyThreads({ ...raw, threads }, asOf, timeZone);
    classified.threads.sort((a, b) => (RANK[a.activity] ?? 9) - (RANK[b.activity] ?? 9) || (a.shelf === "main" ? 0 : 1) - (b.shelf === "main" ? 0 : 1) || (a.id < b.id ? -1 : 1));
    let body = {
      ok: true, unavailable: false, reason: null, asOf, localEnvironmentId: localEnvironmentId(), source: "v2",
      coverage: {
        eligible: Number(raw.total) || 0,
        returned: classified.threads.length,
        truncated: Boolean(raw.truncated) || classified.omittedUnsafeIds > 0,
        cap,
        omittedUnsafeIds: classified.omittedUnsafeIds,
        childLinksTruncated: Boolean(raw.childLinksTruncated),
        factsIncomplete: factsCutShort(raw),
        questionsUnread: questionsUnread(raw),
      },
      threads: classified.threads,
    };
    let json = JSON.stringify(body);
    while (body.threads.length && Buffer.byteLength(json) > maxBytes) {
      body.threads.pop();
      body = { ...body, threads: body.threads, coverage: { ...body.coverage, returned: body.threads.length, truncated: true } };
      json = JSON.stringify(body);
    }
    if (Buffer.byteLength(json) > maxBytes) return fail("budget");
    if (opts.profile && raw.timings) body.timings = raw.timings;
    if (opts.profile && raw.bootMs != null) body.bootMs = raw.bootMs;
    if (opts.profile && raw.scan) body.scan = raw.scan;
    return body;
  }
  function snapshot() {
    const age = Date.now() - cache.at;
    if (cache.value && age < (cache.value.ok ? cacheMs : failCacheMs)) return Promise.resolve(cache.value);
    if (flight) return flight;
    flight = query().then((raw) => {
      const value = raw?.ok ? present(raw) : fail(raw?.error || "read");
      cache = { at: Date.now(), value };
      return value;
    }).finally(() => {
      flight = null;
    });
    return flight;
  }
  function dispose() {
    worker?.terminate();
    worker = null;
  }
  return { snapshot, dispose, stats: () => ({ reads }) };
}
