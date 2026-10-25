#!/opt/homebrew/bin/node
/**
 * t3-extras: a small read-only service for Andy's T3 Code (Nightly) add-ons.
 * Listens on 127.0.0.1:8793 only (never the tailnet). The keeper's inline loader in T3's
 * index.html fetches /extras.js and /extras.css from here.
 *
 *   GET /extras.js, /extras.css     the add-ons (inserted inline by the loader)
 *   GET /grouping                   this Mac's top-level thread index (metadata only)
 *   GET /version                    changes whenever those files change (reload on focus)
 *   GET /fonts/<file>               bundled fonts and their licences, allowlisted names only
 *   GET /font-catalog               the font pickers' list (fonts.json, public fields only)
 *   GET /state?thread=<id>[&fresh=1] usage snapshot + the thread's handover chain
 *   GET /history[?since=<ms>]       bounded usage history samples (usage-history.jsonl)
 *   GET /burn                       per-thread burn tiers (no titles, text or paths)
 *   GET /diag?...                   opt-in debug counts (localStorage t3x:diag); no user content
 *
 * Usage numbers come only from `lab-usage --json --read-only` (no lock, no reset, nothing saved).
 * Handover data is read from ~/.local/share/handover/state.json; it is never written.
 * Every fresh lab-usage reading may add one history sample per lab/window (at most every 10 min).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PORT, guard, usageView, labsFromView, historySample, chainView, diagEntry } from "./lib.mjs";
import { createHistory } from "./history.mjs";
import { createBurn } from "./burn.mjs";

const DIR = process.env.T3X_DIR || path.dirname(fileURLToPath(import.meta.url));
const LISTEN_PORT = Number(process.env.T3X_PORT || PORT);
const LAB_USAGE = process.env.T3X_LAB_USAGE || path.join(os.homedir(), ".claude/bin/lab-usage");
const HANDOVER_STATE = process.env.T3X_HANDOVER_STATE || path.join(os.homedir(), ".local/share/handover/state.json");
// T3's id for this Mac's environment: the add-ons offer handover only for threads that run here.
const ENV_ID_FILE = process.env.T3X_ENV_ID_FILE || path.join(os.homedir(), ".t3/userdata/environment-id");
const DIAG_LOG = path.join(DIR, "diag.log");
const FONTS = JSON.parse(fs.readFileSync(path.join(DIR, "fonts.json"), "utf8"));
const FONT_FILES = new Set(FONTS.files.map((f) => f.file));
// The pickers' list: names, verdicts and measurements; never URLs or hashes.
const FONT_CATALOG = JSON.stringify({
  families: (FONTS.families ?? []).map((f) => ({
    name: f.name, source: f.source, group: f.group, style: f.style, star: Boolean(f.star), hard: Boolean(f.hard),
    file: FONT_FILES.has(f.file) ? f.file : null, local: Array.isArray(f.local) ? f.local : null,
    width: f.width ?? null, tallness: f.tallness ?? null, narrow: Boolean(f.narrow), tall: Boolean(f.tall), size: f.size ?? 100,
  })),
});
const HISTORY_FILE = process.env.T3X_HISTORY || path.join(DIR, "usage-history.jsonl");
const history = createHistory(HISTORY_FILE, { log });
const SAMPLE_MAX_AGE_MS = 15 * 60_000; // only fresh readings go into the history

// ---------- burn-rate tells: ticks every 30 s while T3 asks for them ----------
const burn = createBurn({ log, home: process.env.T3X_HOME || undefined, statev2: process.env.T3X_STATEV2 || undefined });
const BURN_EVERY_MS = Number(process.env.T3X_BURN_EVERY_MS || 30_000);
let burnAskedAt = 0;
let burnTicking = null;
function burnTick() {
  burnTicking ??= burn.tick().catch(() => {}).finally(() => {
    burnTicking = null;
  });
  return burnTicking;
}
setInterval(() => {
  if (Date.now() - burnAskedAt < ACTIVE_FOR_MS) burnTick();
}, BURN_EVERY_MS).unref();

const USAGE_EVERY_MS = Number(process.env.T3X_USAGE_EVERY_MS || 180_000); // Codex is read every 3 min while T3 polls
const FRESH_FLOOR_MS = 30_000; // a popover may ask for a fresh read, at most every 30 s
const ACTIVE_FOR_MS = 5 * 60_000; // T3 counts as open for 5 min after its last /state poll

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

// ---------- static files ----------

function readOptionalPublic(name) {
  const file = path.join(DIR, "public", name);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}
function readPublic() {
  // Grouping is concatenated only when its files are installed. A copy of this server without
  // them (the service test) keeps serving extras.js and extras.css unchanged.
  const js = fs.readFileSync(path.join(DIR, "public/extras.js"));
  const css = fs.readFileSync(path.join(DIR, "public/extras.css"));
  const groupJs = readOptionalPublic("grouping.js");
  const groupCss = readOptionalPublic("grouping.css");
  const jsOut = groupJs ? Buffer.concat([js, Buffer.from("\n;\n"), groupJs]) : js;
  const cssOut = groupCss ? Buffer.concat([css, Buffer.from("\n"), groupCss]) : css;
  return { js: jsOut, css: cssOut, version: crypto.createHash("sha256").update(jsOut).update(cssOut).digest("hex").slice(0, 16) };
}
let files = readPublic();
let filesCheckedAt = Date.now();
function currentFiles() {
  // Picked up without a restart (cheap: two small files, at most once a second).
  if (Date.now() - filesCheckedAt > 1000) {
    filesCheckedAt = Date.now();
    try {
      files = readPublic();
    } catch (error) {
      log(`public files unreadable: ${error.message}`);
    }
  }
  return files;
}

// ---------- usage (lab-usage --json --read-only), single-flight ----------

let usage = { fetchedAt: null, view: null, error: null };
let inflight = null;
let lastActive = 0;

function refreshUsage() {
  if (inflight) return inflight;
  inflight = new Promise((resolve) => {
    execFile(LAB_USAGE, ["--json", "--read-only"], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const fetchedAt = Date.now();
      try {
        const view = usageView(JSON.parse(stdout), fetchedAt);
        view.labs = labsFromView(view);
        usage = { fetchedAt, view, error: null };
        logHistory(view.labs, fetchedAt);
      } catch {
        // Keep the last good numbers (they carry their own age); report the failure.
        usage = { ...usage, error: `lab-usage failed${error?.code ? ` (exit ${error.code})` : ""}`, failedAt: fetchedAt };
      }
      inflight = null;
      resolve();
    });
  });
  return inflight;
}

/** One sample per live lab/window, timed by when the lab measured it (not when we asked). */
function logHistory(labs, at) {
  try {
    const samples = [];
    for (const lab of labs) {
      for (const w of lab.windows) {
        const ts = w.fetchedAt;
        if (!w.live || typeof ts !== "number" || at - ts > SAMPLE_MAX_AGE_MS) continue;
        samples.push(historySample(lab.id, w.role, w, ts));
      }
    }
    history.append(samples.filter(Boolean));
  } catch (error) {
    log(`history skipped: ${error.message}`);
  }
}

setInterval(() => {
  if (Date.now() - lastActive < ACTIVE_FOR_MS && Date.now() - (usage.fetchedAt ?? 0) >= USAGE_EVERY_MS) refreshUsage();
}, 15_000).unref();

async function usageFor(fresh) {
  const age = Date.now() - (usage.fetchedAt ?? 0);
  if (!usage.view || (fresh && age >= FRESH_FLOOR_MS)) {
    await Promise.race([refreshUsage(), new Promise((r) => setTimeout(r, 15_000))]);
  }
  return { ...(usage.view ?? { fetchedAt: null, claude: { ok: false }, codex: { ok: false }, labs: [] }), error: usage.error, failedAt: usage.failedAt ?? null };
}

// ---------- handover (read only) ----------

let handover = { mtimeMs: -1, state: null };
function handoverState() {
  try {
    const st = fs.statSync(HANDOVER_STATE);
    if (st.mtimeMs !== handover.mtimeMs) handover = { mtimeMs: st.mtimeMs, state: JSON.parse(fs.readFileSync(HANDOVER_STATE, "utf8")) };
  } catch {
    handover = { mtimeMs: -1, state: null };
  }
  return handover.state;
}

function localEnvironmentId() {
  try {
    const id = fs.readFileSync(ENV_ID_FILE, "utf8").trim();
    return /^[A-Za-z0-9:_-]{1,100}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Loaded on the first /grouping request, and only when grouping.mjs sits beside this file.
// The request never chooses a file, a query, or a cap.
let groupingLoad;
function groupingSnapshot() {
  if (!groupingLoad) {
    groupingLoad = (async () => {
      const file = path.join(DIR, "grouping.mjs");
      if (!fs.existsSync(file)) return null;
      const mod = await import(pathToFileURL(file).href);
      const cap = Math.max(1, Math.min(1000, Number(process.env.T3X_GROUP_CAP) || 1000));
      return mod.createGrouping({
        home: process.env.T3X_HOME || undefined,
        statev2: process.env.T3X_STATEV2 || undefined,
        envIdFile: ENV_ID_FILE,
        cap,
        timeoutMs: Number(process.env.T3X_GROUP_TIMEOUT_MS || 2000),
      });
    })();
  }
  return groupingLoad.then((api) => {
    if (!api) {
      return {
        ok: false, unavailable: true, reason: "missing", asOf: Date.now(),
        localEnvironmentId: localEnvironmentId(), source: "v2", coverage: null, threads: null,
      };
    }
    return api.snapshot();
  });
}
function groupingFailure() {
  return {
    ok: false, unavailable: true, reason: "read", asOf: Date.now(),
    localEnvironmentId: localEnvironmentId(), source: "v2", coverage: null, threads: null,
  };
}

// ---------- diag (opt-in, bounded) ----------

function writeDiag(entry) {
  if (!Object.keys(entry).length) return;
  try {
    if (fs.statSync(DIAG_LOG).size > 256 * 1024) fs.renameSync(DIAG_LOG, `${DIAG_LOG}.1`);
  } catch {}
  fs.appendFileSync(DIAG_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

// ---------- http ----------

// Each distinct Origin is logged once (the value only), so the allowlist can be checked.
const seenOrigins = new Set();
function noteOrigin(origin, allowed) {
  const key = typeof origin === "string" ? origin.slice(0, 80) : "(none)";
  if (seenOrigins.has(key) || seenOrigins.size > 50) return;
  seenOrigins.add(key);
  log(`origin ${JSON.stringify(key)} ${allowed ? "allowed" : typeof origin === "string" ? "refused" : "no CORS header sent"}`);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}

export function handler(req, res) {
  const g = guard(req.headers, LISTEN_PORT);
  if (!g.hostOk) return send(res, 421, "wrong host");
  const cors = g.allowOrigin
    ? { "Access-Control-Allow-Origin": g.allowOrigin, "Access-Control-Allow-Private-Network": "true", Vary: "Origin" }
    : { Vary: "Origin" };
  noteOrigin(req.headers.origin, g.allowOrigin);
  // Every request must come from T3's own page (its loader's fetch() always sends Origin), so
  // nothing here, /state above all, answers an Origin-less navigation or another app's page.
  if (!g.allowOrigin) return send(res, 403, g.hasOrigin ? "origin not allowed" : "only for T3", cors);
  if (req.method === "OPTIONS") {
    return send(res, 204, "", { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "600" });
  }
  if (req.method !== "GET") return send(res, 405, "read only", cors);
  const url = new URL(req.url, `http://127.0.0.1:${LISTEN_PORT}`);
  const p = url.pathname;
  if (p === "/extras.js") return send(res, 200, currentFiles().js, { ...cors, "Content-Type": "text/javascript; charset=utf-8" });
  if (p === "/extras.css") return send(res, 200, currentFiles().css, { ...cors, "Content-Type": "text/css; charset=utf-8" });
  if (p === "/version") return send(res, 200, currentFiles().version, { ...cors, "Content-Type": "text/plain" });
  if (p === "/grouping") {
    return groupingSnapshot().then((body) => {
      if (!res.headersSent) send(res, 200, JSON.stringify(body), { ...cors, "Content-Type": "application/json" });
    }, () => {
      if (!res.headersSent) send(res, 200, JSON.stringify(groupingFailure()), { ...cors, "Content-Type": "application/json" });
    });
  }
  if (p === "/burn") {
    const first = burnAskedAt === 0;
    burnAskedAt = Date.now();
    const answer = () => send(res, 200, JSON.stringify(burn.snapshot()), { ...cors, "Content-Type": "application/json" });
    return first ? Promise.race([burnTick(), new Promise((r) => setTimeout(r, 3_000))]).then(answer, answer) : answer();
  }
  if (p === "/font-catalog") return send(res, 200, FONT_CATALOG, { ...cors, "Content-Type": "application/json" });
  if (p === "/history") {
    const since = Number(url.searchParams.get("since"));
    return send(res, 200, JSON.stringify({ now: Date.now(), samples: history.read(Number.isFinite(since) ? since : 0) }), { ...cors, "Content-Type": "application/json" });
  }
  if (p.startsWith("/fonts/")) {
    const name = p.slice("/fonts/".length);
    if (!FONT_FILES.has(name)) return send(res, 404, "not found", cors);
    try {
      return send(res, 200, fs.readFileSync(path.join(DIR, "fonts", name)), { ...cors, "Content-Type": name.endsWith(".woff2") ? "font/woff2" : "text/plain; charset=utf-8", "Cache-Control": "max-age=86400" });
    } catch {
      return send(res, 404, "not installed", cors);
    }
  }
  if (p === "/state") {
    lastActive = Date.now();
    const fresh = url.searchParams.get("fresh") === "1";
    return usageFor(fresh).then((u) => {
      const st = handoverState();
      const thread = url.searchParams.get("thread");
      send(res, 200, JSON.stringify({
        now: Date.now(),
        localEnvironmentId: localEnvironmentId(),
        usage: u,
        handover: { mode: typeof st?.mode === "string" ? st.mode : null, chain: thread ? chainView(st, thread) : null },
      }), { ...cors, "Content-Type": "application/json" });
    }, () => send(res, 500, "error", cors));
  }
  if (p === "/diag") {
    writeDiag(diagEntry(url.searchParams));
    return send(res, 204, "", cors);
  }
  return send(res, 404, "not found", cors);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const server = http.createServer((req, res) => {
    try {
      handler(req, res);
    } catch (error) {
      log(`error: ${error.message}`);
      if (!res.headersSent) send(res, 500, "error");
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  history.load();
  setInterval(() => history.compact(), 6 * 3600_000).unref();
  setTimeout(() => burn.recalibrate(), 5_000).unref(); // then every 6 h
  setInterval(() => burn.recalibrate(), 6 * 3600_000).unref();
  server.listen(LISTEN_PORT, "127.0.0.1", () => log(`t3-extras listening on 127.0.0.1:${LISTEN_PORT}`));
  server.on("error", (error) => {
    log(`listen failed: ${error.message}`);
    process.exit(1);
  });
}
