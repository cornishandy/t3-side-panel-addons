#!/opt/homebrew/bin/node
/**
 * Restart reminders for the T3 sidebar keeper.
 *
 * Owns reminders.json, its journal, and its own lock. The keeper calls the
 * journal around an app.asar replacement; the 30s LaunchAgent calls
 * schedulerTick. Notification actions call the CLI. This file never quits or
 * restarts T3, never listens on a port, and never posts by itself while a
 * caller holds the lock and the native helper calls back in.
 *
 * A prepared journal is not a reminder. A reminder exists only after the
 * installed archive matches the intended clone. Snooze and the repeat
 * interval belong to the user, not to one archive generation.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const INTERVAL_MIN_MINUTES = 5;
export const INTERVAL_MAX_MINUTES = 1440;
export const SNOOZE_MIN_MINUTES = 1;
export const SNOOZE_MAX_MINUTES = 43200;
export const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_SNOOZE_MS = 3 * 60 * 60 * 1000;
const POST_TIMEOUT_MS = 20000;

export const COPY = {
  restartTitle: "Restart T3 Code",
  restartBody: "An update re-applied your T3 patches. Quit T3 Code (⌘Q) and reopen it when you're ready.",
  closedTitle: "Open T3 Code",
  closedBody: "Your T3 patches are ready. Open T3 Code to load them.",
  statusRestart: "Restart needed. Quit T3 Code (⌘Q) and reopen it. This app never restarts it for you.",
  statusClosed: "T3 Code is closed. Open it to load the updated patches.",
  statusNone: "No restart needed. Reminders start again if an update needs one.",
  saveFailed: "Couldn't save that change. Try again.",
  stale: "That reminder was out of date, so nothing changed.",
  dismissNote: "Closing a notification doesn't snooze it.",
};

const KEEPER_ARGS = new Set([
  "--reminders",
  "--snooze",
  "--resume-reminders",
  "--remind-every",
  "--reminder-controls",
  "--reminder-setup",
  "--reminder-action",
]);

export function isKeeperArg(arg) {
  return KEEPER_ARGS.has(arg);
}

export function keeperHome() {
  return process.env.T3_KEEPER_HOME || path.join(os.homedir(), ".local/share/t3-sidebar-keeper");
}

// A user preference, outside the installer's code rollback set. Nightly app
// updates, reinstalls, snooze expiry, and Resume must never turn this back on.
export function restartRemindersDisabled(home = keeperHome()) {
  return fs.existsSync(path.join(home, "restart-reminders-disabled.json"));
}

export function pathsFor(home, namespace = "production") {
  if (namespace === "diagnostic") {
    return {
      namespace,
      state: path.join(home, "reminders-diagnostic.json"),
      lock: path.join(home, "reminder-diagnostic.lock"),
      journal: null,
    };
  }
  if (namespace !== "production") {
    const error = new Error("namespace is not production or diagnostic");
    error.code = "namespace";
    throw error;
  }
  return {
    namespace,
    state: path.join(home, "reminders.json"),
    lock: path.join(home, "reminder.lock"),
    journal: path.join(home, "reminder-journal.json"),
  };
}

/** ino + size + birthtime, not device: APFS can renumber the device across a Mac restart. */
export function sameArchive(a, b) {
  return Boolean(a && b) && a.ino === b.ino && a.size === b.size && a.birthtimeMs === b.birthtimeMs;
}

export function generationId(build, identity) {
  const safe = String(build ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  return `g-${safe}-${identity.ino}-${Math.round(Number(identity.birthtimeMs))}-${identity.size}`;
}

export function freshState() {
  return {
    schema: 1,
    config: { intervalMs: DEFAULT_INTERVAL_MS, snoozeMs: DEFAULT_SNOOZE_MS },
    snoozeUntil: null,
    pending: null,
    lastSubmittedAt: null,
    lastSubmission: null,
    forceDue: false,
    lastDeniedAt: null,
    reservation: null,
    legacy: { status: "unevaluated", detail: null },
    updatedAt: null,
  };
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isSafeInt(n) {
  return Number.isSafeInteger(n);
}

function validateState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("corrupt", "corrupt reminder state");
  if (data.schema !== 1) throw fail("corrupt", "corrupt reminder state");
  const intervalMs = data.config?.intervalMs;
  const snoozeMs = data.config?.snoozeMs;
  if (!isSafeInt(intervalMs) || !isSafeInt(snoozeMs)) throw fail("corrupt", "corrupt reminder state");
  if (intervalMs < INTERVAL_MIN_MINUTES * 60000 || intervalMs > INTERVAL_MAX_MINUTES * 60000) throw fail("corrupt", "corrupt reminder state");
  if (intervalMs % 60000 !== 0 || snoozeMs % 60000 !== 0) throw fail("corrupt", "corrupt reminder state");
  if (snoozeMs < SNOOZE_MIN_MINUTES * 60000 || snoozeMs > SNOOZE_MAX_MINUTES * 60000) throw fail("corrupt", "corrupt reminder state");
  if (data.snoozeUntil !== null && typeof data.snoozeUntil !== "string") throw fail("corrupt", "corrupt reminder state");
  if (data.snoozeUntil !== null && !Number.isFinite(Date.parse(data.snoozeUntil))) throw fail("corrupt", "corrupt reminder state");
  if (data.pending !== null && (typeof data.pending !== "object" || Array.isArray(data.pending))) throw fail("corrupt", "corrupt reminder state");
  if (data.pending) {
    if (typeof data.pending.generation !== "string" || !/^(g-|test-)[A-Za-z0-9._-]+$/.test(data.pending.generation) || data.pending.generation.length > 240) throw fail("corrupt", "corrupt reminder state");
    if (!Array.isArray(data.pending.reasons) || !data.pending.reasons.every(reason => typeof reason === "string" && reason.length > 0)) throw fail("corrupt", "corrupt reminder state");
    if (!isSafeInt(data.pending.boundaryUs) || data.pending.boundaryUs <= 0) throw fail("corrupt", "corrupt reminder state");
    if (!["published", "recovery"].includes(data.pending.boundarySource)) throw fail("corrupt", "corrupt reminder state");
    const archive = data.pending.archive;
    if (!(archive === null && data.pending.generation.startsWith("test-"))
      && (!archive || !isSafeInt(archive.ino) || archive.ino <= 0 || !isSafeInt(archive.size) || archive.size < 0 || !Number.isFinite(archive.birthtimeMs) || archive.birthtimeMs <= 0)) throw fail("corrupt", "corrupt reminder state");
  }
  for (const field of ["lastSubmittedAt", "lastDeniedAt", "updatedAt"]) {
    if (data[field] !== null && (typeof data[field] !== "string" || !Number.isFinite(Date.parse(data[field])))) throw fail("corrupt", "corrupt reminder state");
  }
  if (data.lastSubmission !== null && (!data.lastSubmission || typeof data.lastSubmission.accepted !== "boolean" || typeof data.lastSubmission.at !== "string" || !Number.isFinite(Date.parse(data.lastSubmission.at)))) throw fail("corrupt", "corrupt reminder state");
  if (typeof data.forceDue !== "boolean") throw fail("corrupt", "corrupt reminder state");
  if (data.reservation !== null && (typeof data.reservation !== "object" || typeof data.reservation.id !== "string")) {
    throw fail("corrupt", "corrupt reminder state");
  }
  return {
    schema: 1,
    config: { intervalMs, snoozeMs },
    snoozeUntil: data.snoozeUntil ?? null,
    pending: data.pending ? {
      generation: data.pending.generation,
      build: data.pending.build ?? null,
      reasons: data.pending.reasons.map(String),
      boundaryUs: data.pending.boundaryUs,
      boundarySource: data.pending.boundarySource === "recovery" ? "recovery" : "published",
      boundaryNote: typeof data.pending.boundaryNote === "string" ? data.pending.boundaryNote : null,
      archive: data.pending.archive ?? null,
      prePatchMains: Array.isArray(data.pending.prePatchMains) ? data.pending.prePatchMains : [],
      createdAt: data.pending.createdAt ?? null,
    } : null,
    lastSubmittedAt: typeof data.lastSubmittedAt === "string" ? data.lastSubmittedAt : null,
    lastSubmission: data.lastSubmission ?? null,
    forceDue: data.forceDue,
    lastDeniedAt: typeof data.lastDeniedAt === "string" ? data.lastDeniedAt : null,
    reservation: data.reservation ? { id: data.reservation.id, generation: data.reservation.generation ?? null } : null,
    legacy: {
      status: typeof data.legacy?.status === "string" ? data.legacy.status : "unevaluated",
      detail: data.legacy?.detail ?? null,
    },
    updatedAt: data.updatedAt ?? null,
  };
}

export function readStateFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { state: freshState(), missing: true };
    throw fail("unreadable", "unreadable reminder state");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw fail("corrupt", "corrupt reminder state");
  }
  try {
    return { state: validateState(data), missing: false };
  } catch (error) {
    if (error.code === "corrupt") throw error;
    throw fail("corrupt", "corrupt reminder state");
  }
}

function beforeStateRename(tmp, file) {
  if (process.env.T3_REMINDERS_TEST_HOOKS === "1" && typeof globalThis.__reminderBeforeStateRename === "function") {
    globalThis.__reminderBeforeStateRename(tmp, file);
  }
}

export function writeDurable(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const buf = Buffer.from(text, "utf8");
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) throw fail("io", "short write to reminder state");
      off += n;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const back = fs.readFileSync(tmp);
  if (!back.equals(buf)) {
    fs.rmSync(tmp, { force: true });
    throw fail("io", "reminder state was not written completely");
  }
  beforeStateRename(tmp, file);
  fs.renameSync(tmp, file);
  const dfd = fs.openSync(dir, "r");
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}

function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  writeDurable(file, state);
}

function procBirthPath() {
  if (process.env.T3_PROC_BIRTH && fs.existsSync(process.env.T3_PROC_BIRTH)) return process.env.T3_PROC_BIRTH;
  const sibling = path.join(path.dirname(fileURLToPath(import.meta.url)), "proc-birth");
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

function readProcBirth(pid) {
  const bin = procBirthPath();
  if (!bin) return null;
  try {
    const out = execFileSync(bin, [String(pid)], { encoding: "utf8", timeout: 2000 });
    const line = out.trim().split("\n")[0] ?? "";
    const [id, startUs, precise, ...exeParts] = line.split("\t");
    if (Number(id) !== Number(pid)) return null;
    return {
      startUs: Number(startUs),
      precise: precise === "1" && Number.isSafeInteger(Number(startUs)) && Number(startUs) > 0,
      exe: exeParts.join("\t"),
    };
  } catch {
    return null;
  }
}

function psLstart(pid) {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
}

function processIdentity(pid) {
  const birth = readProcBirth(pid);
  const lstart = psLstart(pid);
  let lstartUs = null;
  if (lstart) {
    const ms = Date.parse(lstart);
    if (Number.isFinite(ms)) lstartUs = ms * 1000;
  }
  return {
    startUs: birth?.precise ? birth.startUs : lstartUs,
    precise: Boolean(birth?.precise),
    exe: birth?.exe || "",
    lstart,
  };
}

/** BSD flock belongs to this open descriptor, including across the short lockf
 * subprocess. Keep the inode permanently: unlink/reclaim races cannot occur. A
 * killed owner releases its kernel lock without stale-owner bookkeeping. */
export function acquireKernelLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, "a+", 0o600);
  const run = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
    stdio: ["ignore", "pipe", "pipe", fd], timeout: 5000,
  });
  if (run.status === 0) return { fd, file };
  fs.closeSync(fd);
  if (run.status === 75) return null;
  throw fail("lock-error", `kernel lock failed (${run.error?.code ?? run.status})`);
}

export function acquireReminderLock(home, namespace = "production") {
  // New name avoids mistaking a pre-release mkdir lock for a kernel-lock inode.
  return acquireKernelLock(`${pathsFor(home, namespace).lock}.flock`);
}

export function releaseReminderLock(held) {
  if (held) fs.closeSync(held.fd);
}

export function withCodeLease(home, fn) {
  const marker = path.join(home, "install-in-progress.json");
  if (fs.existsSync(marker)) throw fail("busy", "The reminder helper is updating. Try again.");
  let held = null;
  // Controls may launch just before the keeper's `open` command returns and
  // releases its lease. A small bounded retry handles that ordinary overlap.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (fs.existsSync(marker)) throw fail("busy", "The reminder helper is updating. Try again.");
    held = acquireKernelLock(path.join(home, "code.flock"));
    if (held) break;
    if (attempt < 19) sleepMs(100);
  }
  if (!held) throw fail("busy", COPY.saveFailed);
  try {
    if (fs.existsSync(marker)) throw fail("busy", "The reminder helper is updating. Try again.");
    return fn();
  } finally { releaseReminderLock(held); }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withReminderLock(home, namespace, fn, { attempts = 1, waitMs = 100 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const held = acquireReminderLock(home, namespace);
    if (!held) {
      last = { busy: true };
      if (i + 1 < attempts) sleepMs(waitMs);
      continue;
    }
    try {
      return { busy: false, value: fn() };
    } finally {
      releaseReminderLock(held);
    }
  }
  return last ?? { busy: true };
}

export function parseDuration(input, kind) {
  const min = kind === "interval" ? INTERVAL_MIN_MINUTES : SNOOZE_MIN_MINUTES;
  const max = kind === "interval" ? INTERVAL_MAX_MINUTES : SNOOZE_MAX_MINUTES;
  const message = `Enter a whole number from ${min} to ${max}.`;
  const raw = String(input ?? "").trim().toLowerCase();
  const match = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/.exec(raw);
  if (!match) {
    const error = fail("invalid-duration", message);
    error.range = { min, max };
    throw error;
  }
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || String(n) !== String(Number(match[1]))) {
    const error = fail("invalid-duration", message);
    error.range = { min, max };
    throw error;
  }
  const unit = match[2] || "m";
  const minutes = unit.startsWith("h") ? n * 60 : n;
  if (minutes < min || minutes > max) {
    const error = fail("invalid-duration", message);
    error.range = { min, max };
    throw error;
  }
  return minutes * 60 * 1000;
}

export function formatSnoozeAction(ms) {
  const minutes = ms / 60000;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "Snooze 1 Hour" : `Snooze ${hours} Hours`;
  }
  return `Snooze ${minutes} min`;
}

export function formatIntervalPhrase(ms) {
  const minutes = ms / 60000;
  if (minutes === 60) return "1 hour";
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} min`;
}

export function formatWhen(iso, nowMs, locale = undefined) {
  const date = new Date(iso);
  const now = new Date(nowMs);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date);
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return time;
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
  return `${weekday} ${time}`;
}

export function isStrictlyAfter(startUs, precise, boundaryUs) {
  if (!Number.isFinite(startUs) || !Number.isFinite(boundaryUs)) return false;
  if (precise) return startUs > boundaryUs;
  return Math.floor(startUs / 1e6) > Math.floor(boundaryUs / 1e6);
}

export function isStrictlyBefore(startUs, precise, boundaryUs) {
  if (!Number.isFinite(startUs) || !Number.isFinite(boundaryUs)) return false;
  if (precise) return startUs < boundaryUs;
  return Math.floor(startUs / 1e6) < Math.floor(boundaryUs / 1e6);
}

export function classifyProcess(proc, appPath) {
  const exe = String(proc.exe || "");
  const args = String(proc.args || "");
  const mac = `${path.join(appPath, "Contents", "MacOS")}${path.sep}`;
  if (!exe.startsWith(mac) || !args.trim()) return "unknown";
  if (args.includes("--type=")) return "helper";
  if (args.includes("apps/server/") || /(?:^|\s)--(?:bootstrap-fd|require|eval|input-type)(?:[=\s]|$)/.test(args)) return "backend";
  // T3 also invokes positional script workers through this executable. Only
  // the positively observed bare primary invocation proves a desktop main;
  // an unfamiliar argument shape must retain pending status.
  return args.trim() === exe ? "desktop-main" : "unknown";
}

function isAppProcess(proc, appPath) {
  const blob = `${proc.exe || ""}\n${proc.args || ""}`;
  return blob.includes(appPath);
}

function startPreciseOf(proc) {
  if (proc.startPrecise !== undefined) return proc.startPrecise;
  return proc.precise;
}

export function evaluateCompletion(pending, observation) {
  if (!pending) return { complete: false, reason: "no-pending" };
  if (!observation || observation.evidence !== "ok") return { complete: false, reason: "evidence-unavailable" };
  if (!sameArchive(pending.archive, observation.archive)) return { complete: false, reason: "archive-mismatch" };
  const processes = observation.processes ?? [];
  const desktop = processes.filter((proc) => classifyProcess(proc, observation.appPath) === "desktop-main");
  if (desktop.length === 0) return { complete: false, reason: "no-desktop-main" };
  const after = [];
  const notAfter = [];
  for (const proc of desktop) {
    const precise = startPreciseOf(proc);
    if (!Number.isFinite(proc.startUs) || precise == null) {
      notAfter.push(proc);
      continue;
    }
    if (isStrictlyAfter(proc.startUs, Boolean(precise), pending.boundaryUs)) after.push(proc);
    else notAfter.push(proc);
  }
  if (notAfter.length > 0) {
    const clearlyBefore = notAfter.some((proc) => {
      const precise = startPreciseOf(proc);
      return Number.isFinite(proc.startUs) && precise != null && isStrictlyBefore(proc.startUs, Boolean(precise), pending.boundaryUs);
    });
    return { complete: false, reason: clearlyBefore ? "old-main-survives" : "ambiguous-start" };
  }
  const openers = new Set((observation.openers ?? [])
    .filter((row) => row.ino === observation.archive.ino && row.dev === observation.archive.dev)
    .map((row) => row.pid));
  const opened = after.filter((proc) => openers.has(proc.pid));
  if (opened.length === 0) return { complete: false, reason: "archive-not-open" };
  for (const old of pending.prePatchMains ?? []) {
    const still = processes.find((proc) => proc.pid === old.pid && Number(proc.startUs) === Number(old.startUs));
    if (still && classifyProcess(still, observation.appPath) === "desktop-main") {
      return { complete: false, reason: "old-main-survives" };
    }
  }
  return { complete: true, reason: "complete", pid: opened[0].pid };
}

export function appClosed(observation) {
  if (!observation || observation.evidence !== "ok") return false;
  return !(observation.processes ?? []).some((proc) => isAppProcess(proc, observation.appPath));
}

export function evaluateDue(state, nowMs) {
  if (!state.pending) return { due: false, reason: "nothing-pending" };
  let snoozeExpired = false;
  if (typeof state.snoozeUntil === "string") {
    const until = Date.parse(state.snoozeUntil);
    if (Number.isFinite(until) && nowMs < until) return { due: false, reason: "snoozed" };
    snoozeExpired = Number.isFinite(until) && nowMs >= until;
  }
  // A denied submission is an attempted delivery, including a generation's
  // first forced reminder. Do not spawn the helper on every 30-second tick.
  if (state.lastDeniedAt) {
    const denied = Date.parse(state.lastDeniedAt);
    if (Number.isFinite(denied) && nowMs < denied + state.config.intervalMs) return { due: false, reason: "denied-backoff" };
  }
  if (snoozeExpired) return { due: true, reason: "snooze-expired" };
  if (state.forceDue) return { due: true, reason: "resume" };
  if (!state.lastSubmittedAt) {
    return { due: true, reason: "immediate" };
  }
  const last = Date.parse(state.lastSubmittedAt);
  if (!Number.isFinite(last)) return { due: true, reason: "immediate" };
  if (nowMs >= last + state.config.intervalMs) return { due: true, reason: "interval" };
  return { due: false, reason: "waiting" };
}

export function notificationCopy(phase, intervalMs) {
  const next = `Next reminder in ${formatIntervalPhrase(intervalMs)}.`;
  if (phase === "t3-closed") return { title: COPY.closedTitle, body: `${COPY.closedBody} ${next}` };
  return { title: COPY.restartTitle, body: `${COPY.restartBody} ${next}` };
}

function statusText(phase, state, nowMs, locale) {
  if (phase === "t3-closed") return COPY.statusClosed;
  if (phase === "nothing-pending") return COPY.statusNone;
  if (phase === "snoozed") return `Snoozed until ${formatWhen(state.snoozeUntil, nowMs, locale)}`;
  return COPY.statusRestart;
}

function phaseOf(state, nowMs, observation) {
  if (!state.pending) return "nothing-pending";
  if (typeof state.snoozeUntil === "string" && nowMs < Date.parse(state.snoozeUntil)) return "snoozed";
  if (appClosed(observation)) return "t3-closed";
  return "restart-needed";
}

function presentation(state, nowMs, observation, locale) {
  const phase = phaseOf(state, nowMs, observation);
  const note = notificationCopy(phase === "nothing-pending" ? "restart-needed" : phase, state.config.intervalMs);
  return {
    phase,
    statusText: statusText(phase, state, nowMs, locale),
    title: note.title,
    body: note.body,
    snoozeActionTitle: formatSnoozeAction(state.config.snoozeMs),
    intervalPhrase: formatIntervalPhrase(state.config.intervalMs),
    dismissNote: COPY.dismissNote,
  };
}

function boundaryNowUs(nowMs) {
  // The next millisecond, in microseconds. A process already running in this
  // millisecond is not strictly after publication. ps seconds stay coarser.
  return (nowMs + 1) * 1000;
}

function readJournal(file) {
  if (!file) return { missing: true, journal: null };
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return { missing: true, journal: null };
    throw fail("unreadable", "unreadable reminder journal");
  }
  try {
    const journal = JSON.parse(text);
    if (!journal || journal.schema !== 1 || !journal.intended) throw fail("corrupt", "corrupt reminder journal");
    return { missing: false, journal };
  } catch (error) {
    if (error.code === "corrupt") throw error;
    throw fail("corrupt", "corrupt reminder journal");
  }
}

function pendingFrom({ build, identity, reasons, boundaryUs, boundarySource, prePatchMains, nowMs }) {
  return {
    generation: generationId(build, identity),
    build,
    reasons,
    boundaryUs,
    boundarySource,
    boundaryNote: boundarySource === "recovery"
      ? "The archive replacement was committed, but its publication time was not saved. Completion waits for a main that starts after this recovery check."
      : null,
    archive: identity,
    prePatchMains: prePatchMains ?? [],
    createdAt: new Date(nowMs).toISOString(),
  };
}

function reasonsFor(startupReasons, uiChanged, live) {
  const reasons = [...(startupReasons ?? [])];
  if (uiChanged && live !== "updated") {
    if (!reasons.includes("ui-live")) reasons.push("ui-live");
  }
  return reasons;
}

function applyRequirement(state, next, nowMs) {
  const previous = state.pending?.generation ?? null;
  if (previous !== next.generation) {
    state.forceDue = true;
    state.reservation = null;
  }
  if (previous === next.generation && state.pending) next.createdAt = state.pending.createdAt;
  state.pending = next;
  state.legacy = { status: "journal", detail: next.boundarySource };
  return state;
}

function reconcileReplacement(state, actual, build, nowMs) {
  if (!state.pending || !actual || typeof build !== "string" || !build
    || (sameArchive(state.pending.archive, actual) && state.pending.build === build)) return false;
  // An update can already contain every patch, so no keeper commit need occur.
  // First observation is a conservative recovery boundary, never proof that a
  // main already running on this replacement loaded the required startup code.
  const next = pendingFrom({ build, identity: actual, reasons: [...state.pending.reasons],
    boundaryUs: boundaryNowUs(nowMs), boundarySource: "recovery", prePatchMains: [], nowMs });
  next.boundaryNote = "A replacement archive/build was observed without a saved publication time. Completion waits for a desktop main starting after this observation and opening this target.";
  applyRequirement(state, next, nowMs);
  state.legacy = { status: "journal", detail: "replacement-observed" };
  return true;
}

export function reconcileJournal({ home, actual, build, nowMs = Date.now() }) {
  const paths = pathsFor(home, "production");
  const result = withReminderLock(home, "production", () => reconcileInside(paths, actual, build, nowMs), { attempts: 20, waitMs: 50 });
  if (result.busy) throw fail("busy", "reminder journal lock busy");
  return result.value;
}

function capturePrePatch(appPath) {
  try {
    const observation = systemObservation({ appPath, asarPath: null, listOpeners: false });
    const mains = (observation.processes ?? [])
      .filter((proc) => classifyProcess(proc, appPath) === "desktop-main")
      .map((proc) => ({ pid: proc.pid, startUs: proc.startUs, precise: proc.startPrecise, exe: proc.exe }));
    return { prePatchMains: mains, prePatchEvidence: observation.evidence };
  } catch {
    return { prePatchMains: [], prePatchEvidence: "unavailable" };
  }
}

export function notePrepared({ home, appPath, build, intended, startupReasons, uiChanged }) {
  const paths = pathsFor(home, "production");
  const captured = appPath ? capturePrePatch(appPath) : { prePatchMains: [], prePatchEvidence: "unavailable" };
  const result = withReminderLock(home, "production", () => {
    const existing = readJournal(paths.journal);
    if (!existing.missing && existing.journal.phase !== "finalized" && existing.journal.phase !== "discarded"
      && sameArchive(existing.journal.intended, intended)) {
      return { wrote: false, reason: "already-prepared" };
    }
    const { state } = readStateFile(paths.state);
    const carriedReasons = state.pending?.build === build ? state.pending.reasons : [];
    const journal = {
      schema: 1,
      carriedReasons,
      phase: "prepared",
      build,
      intended,
      startupReasons: startupReasons ?? [],
      uiChanged: Boolean(uiChanged),
      live: null,
      prePatchMains: captured.prePatchMains,
      prePatchEvidence: captured.prePatchEvidence,
      preparedAt: new Date().toISOString(),
      committedAt: null,
      committedAtUs: null,
    };
    writeDurable(paths.journal, journal);
    return { wrote: true };
  }, { attempts: 20, waitMs: 50 });
  if (result.busy) throw fail("busy", "reminder journal lock busy");
  return result.value;
}

export function noteCommitted({ home, intended, nowMs = Date.now() }) {
  const paths = pathsFor(home, "production");
  const boundaryUs = boundaryNowUs(nowMs);
  const result = withReminderLock(home, "production", () => {
    const existing = readJournal(paths.journal);
    if (existing.missing || !sameArchive(existing.journal.intended, intended)) {
      throw fail("journal", "prepared journal does not match the committed archive");
    }
    const journal = existing.journal;
    journal.phase = "committed";
    journal.committedAt = new Date(nowMs).toISOString();
    journal.committedAtUs = boundaryUs;
    writeDurable(paths.journal, journal);
    return boundaryUs;
  }, { attempts: 20, waitMs: 50 });
  if (result.busy) throw fail("busy", "reminder journal lock busy");
  return result.value;
}

export function noteFinalized({ home, build, intended, live, startupReasons, uiChanged, boundaryUs = null, nowMs = Date.now() }) {
  const paths = pathsFor(home, "production");
  const result = withReminderLock(home, "production", () => {
    const existing = readJournal(paths.journal);
    const journal = existing.missing ? null : existing.journal;
    const publishedUs = isSafeInt(boundaryUs) ? boundaryUs : (isSafeInt(journal?.committedAtUs) ? journal.committedAtUs : null);
    const reasons = reasonsFor(startupReasons ?? journal?.startupReasons ?? [], Boolean(uiChanged), live);
    const { state } = readStateFile(paths.state);
    const sameBuildPending = state.pending && state.pending.build === build;
    const preserve = reasons.length === 0 && uiChanged && live === "updated" && sameBuildPending;
    const supersede = state.pending && state.pending.build !== build && reasons.length === 0;
    if (supersede) {
      state.pending = null;
      state.forceDue = false;
      state.reservation = null;
      state.legacy = { status: "journal", detail: "build-superseded" };
    } else if (reasons.length > 0 || preserve) {
      const carried = preserve ? [...state.pending.reasons] : reasons;
      if (!preserve && sameBuildPending) {
        for (const reason of state.pending.reasons) if (!carried.includes(reason)) carried.push(reason);
      }
      const next = pendingFrom({
        build,
        identity: intended,
        reasons: carried,
        boundaryUs: publishedUs ?? boundaryNowUs(nowMs),
        boundarySource: publishedUs ? "published" : "recovery",
        prePatchMains: journal?.prePatchMains ?? [],
        nowMs,
      });
      applyRequirement(state, next, nowMs);
    } else {
      state.legacy = { status: "journal", detail: "no-restart-reason" };
    }
    saveState(paths.state, state);
    const stored = journal ?? {
      schema: 1,
      intended,
      build,
      startupReasons: startupReasons ?? [],
      uiChanged: Boolean(uiChanged),
    };
    stored.phase = "finalized";
    stored.live = live;
    stored.generation = state.pending?.generation ?? null;
    stored.finalizedAt = new Date(nowMs).toISOString();
    writeDurable(paths.journal, stored);
    return { generation: state.pending?.generation ?? null, reasons: state.pending?.reasons ?? [] };
  }, { attempts: 20, waitMs: 50 });
  if (result.busy) throw fail("busy", "reminder journal lock busy");
  return result.value;
}

function startupReasonsFromKeeper(keeper) {
  const results = keeper?.results ?? {};
  const reasons = [];
  if (results.rule?.state === "patched") reasons.push("rule");
  if (results.fit?.state === "patched") reasons.push("fit");
  if (results.firstClick?.state === "patched") reasons.push("firstClick");
  return reasons;
}

export function adoptLegacy({ state, keeper, actual, observation, nowMs }) {
  if (state.pending || state.legacy?.status !== "unevaluated") return { state, adopted: false };
  if (!keeper) {
    state.legacy = { status: "none", detail: "no-keeper-state" };
    return { state, adopted: false };
  }
  if (keeper.status === "restored") {
    state.legacy = { status: "none", detail: "restored" };
    return { state, adopted: false };
  }
  const reasons = startupReasonsFromKeeper(keeper);
  if (reasons.length === 0) {
    const anyPatched = Object.values(keeper.results ?? {}).some((row) => row?.state === "patched");
    state.legacy = { status: "unknown", detail: anyPatched ? "ui-only" : "no-startup-evidence" };
    return { state, adopted: false };
  }
  if (!keeper.produced?.identity || !sameArchive(keeper.produced.identity, actual)) {
    state.legacy = { status: "unknown", detail: "archive-mismatch" };
    return { state, adopted: false };
  }
  const patchedMs = Date.parse(keeper.lastPatchedAt ?? "");
  if (!Number.isFinite(patchedMs)) {
    state.legacy = { status: "unknown", detail: "no-patch-time" };
    return { state, adopted: false };
  }
  if (!observation || observation.evidence !== "ok") {
    state.legacy = { status: "unknown", detail: "process-evidence-unavailable" };
    return { state, adopted: false };
  }
  const boundaryUs = patchedMs * 1000;
  // Legacy bookkeeping happens after archive publication. A main born merely
  // before lastPatchedAt could already have loaded the new file. Only a main
  // predating the output clone's creation is positive unresolved evidence.
  // Creation is used only for this conservative *before* proof, never as a
  // publication boundary that could prove completion.
  const cloneCreatedMs = Number(actual.birthtimeMs);
  if (!Number.isFinite(cloneCreatedMs) || cloneCreatedMs <= 0) {
    state.legacy = { status: "unknown", detail: "no-clone-creation-evidence" };
    return { state, adopted: false };
  }
  const definitelyBeforeUs = Math.min(patchedMs, cloneCreatedMs) * 1000;
  const desktop = (observation.processes ?? []).filter((proc) => classifyProcess(proc, observation.appPath) === "desktop-main");
  const before = [];
  let ambiguous = false;
  let after = 0;
  for (const proc of desktop) {
    const precise = proc.startPrecise !== undefined ? proc.startPrecise : proc.precise;
    if (!Number.isFinite(proc.startUs) || precise == null) {
      ambiguous = true;
      continue;
    }
    if (isStrictlyBefore(proc.startUs, Boolean(precise), definitelyBeforeUs)) before.push(proc);
    else if (isStrictlyAfter(proc.startUs, Boolean(precise), boundaryUs)) after += 1;
    else ambiguous = true;
  }
  if (before.length === 0) {
    state.legacy = {
      status: ambiguous || after === 0 ? "unknown" : "none",
      detail: ambiguous ? "ambiguous-start" : (after > 0 ? "already-restarted" : "no-unresolved-main"),
    };
    return { state, adopted: false };
  }
  state.pending = pendingFrom({
    build: keeper.build ?? null,
    identity: actual,
    reasons,
    boundaryUs,
    boundarySource: "published",
    prePatchMains: before.map((proc) => ({ pid: proc.pid, startUs: proc.startUs, precise: proc.startPrecise ?? proc.precise })),
    nowMs,
  });
  state.pending.boundaryNote = "Seeded from the keeper's last startup patch because a desktop main from before that patch is still running.";
  state.legacy = { status: "seeded", detail: "unresolved-main" };
  state.forceDue = true;
  return { state, adopted: true, reasons };
}

function systemObservation({ appPath, asarPath, listOpeners = true }) {
  if (process.env.T3_REMINDERS_PROCESS_FIXTURE) {
    const fixture = JSON.parse(fs.readFileSync(process.env.T3_REMINDERS_PROCESS_FIXTURE, "utf8"));
    return {
      evidence: fixture.evidence ?? "ok",
      appPath: fixture.appPath ?? appPath,
      processes: fixture.processes ?? [],
      openers: fixture.openers ?? [],
      archive: fixture.archive ?? null,
    };
  }
  const processes = [];
  try {
    const out = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const space = trimmed.indexOf(" ");
      if (space < 0) continue;
      const pid = Number(trimmed.slice(0, space));
      const args = trimmed.slice(space + 1);
      if (!Number.isInteger(pid)) continue;
      if (appPath && !args.includes(appPath)) continue;
      const ident = processIdentity(pid);
      processes.push({
        pid,
        args,
        exe: ident.exe,
        startUs: ident.startUs,
        startPrecise: ident.precise,
        precise: ident.precise,
      });
    }
  } catch {
    return { evidence: "unavailable", appPath, processes: [], openers: [], archive: null };
  }
  let archive = null;
  if (asarPath && fs.existsSync(asarPath)) {
    try {
      const st = fs.statSync(asarPath);
      archive = { dev: st.dev, ino: st.ino, size: st.size, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs };
    } catch {
      return { evidence: "unavailable", appPath, processes, openers: [], archive: null };
    }
  }
  const openers = [];
  if (listOpeners && asarPath && fs.existsSync(asarPath)) {
    try {
      const out = execFileSync("/usr/sbin/lsof", ["-nP", "-F", "pDi", "--", asarPath], { encoding: "utf8", timeout: 4000 });
      let pid = null;
      let dev = null;
      for (const line of out.split("\n")) {
        const tag = line[0];
        const value = line.slice(1);
        if (tag === "p") { pid = Number(value); dev = null; }
        else if (tag === "D") dev = Number.parseInt(value, 16);
        else if (tag === "i" && pid && archive && Number(value) === archive.ino && dev === archive.dev) openers.push({ pid, dev, ino: Number(value) });
      }
    } catch (error) {
      // lsof exits 1 when nothing has the file open. Any other failure is unknown evidence.
      if (error.status !== 1) return { evidence: "unavailable", appPath, processes, openers: [], archive };
    }
  }
  const identified = processes.filter((proc) => proc.exe);
  if (appPath && processes.length > 0 && identified.length !== processes.length) {
    return { evidence: "unavailable", appPath, processes, openers, archive };
  }
  return { evidence: "ok", appPath, processes, openers, archive };
}

export function defaultPost(payload, home) {
  if (restartRemindersDisabled(home)) return { accepted: false, suppressed: true, error: "disabled" };
  if (process.env.T3_KEEPER_QUIET) return { accepted: false, suppressed: true, error: "suppressed" };
  if (process.env.T3_REMINDERS_FAKE_POST) {
    fs.appendFileSync(process.env.T3_REMINDERS_FAKE_POST, `${JSON.stringify(payload)}\n`);
    return { accepted: true, fake: true };
  }
  const bin = path.join(home, "T3 Restart Reminders.app", "Contents", "MacOS", "T3 Restart Reminders");
  if (!fs.existsSync(bin)) return { accepted: false, error: "helper-missing" };
  const run = spawnSync(bin, ["--mode", "post"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: POST_TIMEOUT_MS,
  });
  if (run.error || run.status !== 0) return { accepted: false, error: run.error?.code || `helper-exit-${run.status}` };
  try {
    const parsed = JSON.parse(run.stdout);
    return {
      accepted: parsed.accepted === true,
      denied: parsed.denied === true,
      authorization: parsed.authorization ?? null,
      error: parsed.error ?? null,
    };
  } catch {
    return { accepted: false, error: "malformed-helper-output" };
  }
}

export function clearNative(home, generation, namespace = "production") {
  if (!generation || (namespace === "diagnostic" && !generation.startsWith("test-"))) return { ok: false, error: "generation" };
  const bin = path.join(home, "T3 Restart Reminders.app", "Contents", "MacOS", "T3 Restart Reminders");
  if (!fs.existsSync(bin)) return { ok: false, error: "helper-missing" };
  const run = spawnSync(bin, ["--mode", "clear", "--namespace", namespace, "--generation", generation], { encoding: "utf8", timeout: 10000 });
  try { return run.status === 0 ? JSON.parse(run.stdout) : { ok: false, error: "clear-failed" }; } catch { return { ok: false, error: "clear-failed" }; }
}

function buildPayload(state, observation, nowMs) {
  const phase = phaseOf(state, nowMs, observation);
  const note = notificationCopy(phase === "t3-closed" ? "t3-closed" : "restart-needed", state.config.intervalMs);
  return {
    title: note.title,
    body: note.body,
    snoozeActionTitle: formatSnoozeAction(state.config.snoozeMs),
    capturedSnoozeMs: state.config.snoozeMs,
    generation: state.pending.generation,
    namespace: "production",
    phase,
    intervalMs: state.config.intervalMs,
  };
}

function waitForPauseFile() {
  const file = process.env.T3_REMINDERS_PAUSE_FILE;
  if (!file) return;
  fs.writeFileSync(file, "paused");
  const deadline = Date.now() + 10000;
  while (fs.existsSync(file)) {
    if (Date.now() > deadline) throw fail("pause", "reminder pause timed out");
    sleepMs(50);
  }
}

export function schedulerTick(opts = {}) {
  const home = opts.home ?? keeperHome();
  if (restartRemindersDisabled(home)) return { ok: true, submitted: false, reason: "disabled" };
  const nowMs = opts.nowMs ?? Date.now();
  const appPath = opts.appPath || process.env.T3_APP_PATH || "/Applications/T3 Code (Nightly).app";
  const asarPath = opts.asarPath || process.env.T3_ASAR_PATH || path.join(appPath, "Contents/Resources/app.asar");
  const paths = pathsFor(home, "production");
  let actual = opts.actual ?? null;
  if (!actual && fs.existsSync(asarPath)) {
    const st = fs.statSync(asarPath);
    actual = { dev: st.dev, ino: st.ino, size: st.size, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs };
  }
  const observation = opts.observation ?? systemObservation({ appPath, asarPath });
  if (actual && !observation.archive) observation.archive = actual;
  const first = withReminderLock(home, "production", () => {
    if (actual) {
      // Recovery is in this same critical section so a snooze cannot land between it and the due decision.
      const recovered = reconcileInside(paths, actual, opts.build ?? null, nowMs);
      const { state } = readStateFile(paths.state);
      if (!state.pending && state.legacy.status === "unevaluated") {
        let keeper = null;
        const keeperFile = opts.keeperStatePath || path.join(home, "state.json");
        try { keeper = JSON.parse(fs.readFileSync(keeperFile, "utf8")); } catch { keeper = null; }
        const adopted = adoptLegacy({ state, keeper, actual, observation, nowMs });
        if (adopted.adopted || state.legacy.status !== "unevaluated") saveState(paths.state, adopted.state);
      }
      void recovered;
    }
    const { state } = readStateFile(paths.state);
    if (reconcileReplacement(state, actual, opts.build, nowMs)) saveState(paths.state, state);
    if (state.pending && actual && observation.evidence === "ok") {
      const verdict = evaluateCompletion(state.pending, { ...observation, archive: actual, appPath });
      if (verdict.complete) {
        clearNative(home, state.pending.generation);
        state.pending = null;
        state.forceDue = false;
        state.reservation = null;
        state.legacy = { status: "none", detail: "restarted" };
        saveState(paths.state, state);
      }
    }
    const fresh = readStateFile(paths.state).state;
    const decision = evaluateDue(fresh, nowMs);
    if (!decision.due) return { submit: false, decision, presentation: presentation(fresh, nowMs, observation) };
    fresh.reservation = { id: crypto.randomBytes(8).toString("hex"), generation: fresh.pending.generation };
    saveState(paths.state, fresh);
    return { submit: true, reservation: fresh.reservation, decision };
  }, { attempts: 5, waitMs: 50 });
  if (first.busy) return { ok: false, error: "busy", submitted: false };
  if (!first.value.submit) return { ok: true, submitted: false, ...first.value };
  waitForPauseFile();
  if (opts.pauseBeforeSubmit) opts.pauseBeforeSubmit();
  const second = withReminderLock(home, "production", () => {
    const { state } = readStateFile(paths.state);
    if (!state.reservation || state.reservation.id !== first.value.reservation.id) {
      return { submitted: false, reason: "reservation-cleared" };
    }
    if (state.pending?.generation !== first.value.reservation.generation) {
      state.reservation = null;
      saveState(paths.state, state);
      return { submitted: false, reason: "stale-generation" };
    }
    const decision = evaluateDue(state, nowMs);
    if (!decision.due) {
      state.reservation = null;
      saveState(paths.state, state);
      return { submitted: false, reason: decision.reason };
    }
    const payload = buildPayload(state, observation, nowMs);
    let result;
    try {
      result = (opts.post ?? ((body) => defaultPost(body, home)))(payload);
    } catch (error) {
      state.reservation = null;
      saveState(paths.state, state);
      throw error;
    }
    if (result.accepted === true) {
      state.lastSubmittedAt = new Date(nowMs).toISOString();
      state.forceDue = false;
      if (state.snoozeUntil && Date.parse(state.snoozeUntil) <= nowMs) state.snoozeUntil = null;
      state.lastDeniedAt = null;
      state.lastSubmission = {
        at: state.lastSubmittedAt,
        accepted: true,
        generation: payload.generation,
        capturedSnoozeMs: payload.capturedSnoozeMs,
        snoozeActionTitle: payload.snoozeActionTitle,
        phase: payload.phase,
      };
      state.reservation = null;
      saveState(paths.state, state);
      return { submitted: true, payload, result };
    }
    state.lastSubmission = {
      at: new Date(nowMs).toISOString(),
      accepted: false,
      error: result.error ?? null,
      denied: result.denied === true,
      generation: payload.generation,
    };
    if (result.denied === true) state.lastDeniedAt = new Date(nowMs).toISOString();
    state.reservation = null;
    saveState(paths.state, state);
    return { submitted: false, reason: result.denied ? "denied" : (result.error || "not-accepted"), result };
  }, { attempts: 5, waitMs: 50 });
  if (second.busy) return { ok: false, error: "busy", submitted: false };
  return { ok: true, ...second.value };
}

function reconcileInside(paths, actual, build, nowMs) {
  const loaded = readJournal(paths.journal);
  if (loaded.missing) return { recovered: false };
  const journal = loaded.journal;
  if (journal.phase === "finalized" || journal.phase === "discarded") return { recovered: false };
  const { state } = readStateFile(paths.state);
  if (!sameArchive(journal.intended, actual)) {
    journal.phase = "discarded";
    journal.discardedBecause = "installed archive does not match the prepared clone";
    writeDurable(paths.journal, journal);
    return { recovered: false, reason: "not-published" };
  }
  const generation = generationId(journal.build ?? build, journal.intended);
  if (state.pending && (state.pending.generation === generation || sameArchive(state.pending.archive, journal.intended))) {
    journal.phase = "finalized";
    journal.generation = state.pending.generation;
    writeDurable(paths.journal, journal);
    return { recovered: false, reason: "already-recorded" };
  }
  const reasons = [...new Set([...reasonsFor(journal.startupReasons ?? [], Boolean(journal.uiChanged), journal.live ?? null), ...(journal.carriedReasons ?? [])])];
  if (reasons.length === 0) {
    journal.phase = "finalized";
    writeDurable(paths.journal, journal);
    state.legacy = { status: "journal", detail: "no-restart-reason" };
    saveState(paths.state, state);
    return { recovered: false, reason: "no-restart-reason" };
  }
  const boundaryUs = isSafeInt(journal.committedAtUs) ? journal.committedAtUs : boundaryNowUs(nowMs);
  const next = pendingFrom({
    build: journal.build ?? build,
    identity: journal.intended,
    reasons,
    boundaryUs,
    boundarySource: isSafeInt(journal.committedAtUs) ? "published" : "recovery",
    prePatchMains: journal.prePatchMains ?? [],
    nowMs,
  });
  applyRequirement(state, next, nowMs);
  saveState(paths.state, state);
  journal.phase = "finalized";
  journal.generation = next.generation;
  writeDurable(paths.journal, journal);
  return { recovered: true, generation: next.generation, boundarySource: next.boundarySource, reasons };
}

function publicView(state, nowMs, observation, locale) {
  const decision = evaluateDue(state, nowMs);
  return {
    ok: true,
    phase: phaseOf(state, nowMs, observation),
    due: decision.due,
    dueReason: decision.reason,
    snoozeUntil: state.snoozeUntil,
    config: state.config,
    pending: state.pending,
    legacy: state.legacy,
    lastSubmittedAt: state.lastSubmittedAt,
    lastSubmission: state.lastSubmission,
    presentation: presentation(state, nowMs, observation, locale),
  };
}

export function reminderStatus(opts = {}) {
  const home = opts.home ?? keeperHome();
  const namespace = opts.namespace ?? "production";
  const nowMs = opts.nowMs ?? Date.now();
  const paths = pathsFor(home, namespace);
  const { state } = readStateFile(paths.state);
  if (restartRemindersDisabled(home)) {
    const view = publicView(state, nowMs, { evidence: "unavailable", processes: [] }, opts.locale);
    return { ...view, enabled: false, phase: "disabled", due: false, dueReason: "disabled", pending: null,
      presentation: { ...view.presentation, phase: "disabled", statusText: "App restart reminders are off.", title: "", body: "", dismissNote: "" } };
  }
  const appPath = opts.appPath || process.env.T3_APP_PATH || "/Applications/T3 Code (Nightly).app";
  const asarPath = opts.asarPath || process.env.T3_ASAR_PATH || path.join(appPath, "Contents/Resources/app.asar");
  const observation = opts.observation ?? (opts.observe === false
    ? { evidence: "unavailable", appPath, processes: [], openers: [], archive: null }
    : systemObservation({ appPath, asarPath }));
  return publicView(state, nowMs, observation, opts.locale);
}

export function mutate(opts, fn) {
  const home = opts.home ?? keeperHome();
  const namespace = opts.namespace ?? "production";
  const nowMs = opts.nowMs ?? Date.now();
  const paths = pathsFor(home, namespace);
  const result = withReminderLock(home, namespace, () => {
    const { state } = readStateFile(paths.state);
    if (opts.generation != null && (state.pending?.generation ?? "__none__") !== opts.generation) throw fail("stale", COPY.stale);
    const outcome = fn(state, nowMs) ?? {};
    if (outcome.write !== false) saveState(paths.state, state);
    return { state, durable: outcome.write !== false, ...outcome, view: publicView(state, nowMs, opts.observation ?? { evidence: "unavailable", processes: [], appPath: opts.appPath }, opts.locale) };
  }, { attempts: opts.attempts ?? 20, waitMs: opts.waitMs ?? 100 });
  if (result.busy) {
    const error = fail("busy", COPY.saveFailed);
    throw error;
  }
  return result.value;
}

export function snoozeFor(opts) {
  const ms = opts.ms ?? parseDuration(opts.duration, "snooze");
  if (!isSafeInt(ms) || ms < SNOOZE_MIN_MINUTES * 60000 || ms > SNOOZE_MAX_MINUTES * 60000 || ms % 60000 !== 0) {
    throw fail("invalid-duration", `Enter a whole number from ${SNOOZE_MIN_MINUTES} to ${SNOOZE_MAX_MINUTES}.`);
  }
  return mutate(opts, (state, nowMs) => {
    state.snoozeUntil = new Date(nowMs + ms).toISOString();
    state.config.snoozeMs = ms;
    state.reservation = null;
    state.forceDue = false;
    return { appliedMs: ms };
  });
}

export function resumeReminders(opts = {}) {
  return mutate(opts, (state) => {
    state.snoozeUntil = null;
    state.reservation = null;
    state.forceDue = Boolean(state.pending);
    state.lastDeniedAt = null; // Explicit Resume can retry after permission changes.
    return { write: true };
  });
}

export function setReminderInterval(opts) {
  const ms = opts.ms ?? parseDuration(opts.duration, "interval");
  if (!isSafeInt(ms) || ms % 60000 !== 0 || ms < INTERVAL_MIN_MINUTES * 60000 || ms > INTERVAL_MAX_MINUTES * 60000) throw fail("invalid-duration", "Invalid reminder interval.");
  return mutate(opts, (state) => {
    state.config.intervalMs = ms;
    return { appliedMs: ms };
  });
}

export function clearPending(opts = {}) {
  return mutate(opts, (state) => {
    state.pending = null;
    state.forceDue = false;
    state.reservation = null;
    state.legacy = { status: "none", detail: opts.reason ?? "cleared" };
  });
}

/** Drop a pending restart after --restore. Snooze and the repeat interval stay. */
export function noteRestored({ home, actual }) {
  const root = home ?? keeperHome();
  const paths = pathsFor(root, "production");
  const result = withReminderLock(root, "production", () => {
    const { state } = readStateFile(paths.state);
    state.pending = null;
    state.forceDue = false;
    state.reservation = null;
    state.legacy = { status: "none", detail: "restored" };
    saveState(paths.state, state);
    const loaded = readJournal(paths.journal);
    if (!loaded.missing && actual && !sameArchive(loaded.journal.intended, actual)) {
      loaded.journal.phase = "discarded";
      loaded.journal.discardedBecause = "restore";
      writeDurable(paths.journal, loaded.journal);
    }
    return { snoozeUntil: state.snoozeUntil };
  }, { attempts: 20, waitMs: 50 });
  if (result.busy) throw fail("busy", COPY.saveFailed);
  return result.value;
}

export function applyAction(opts) {
  const namespace = opts.namespace ?? "production";
  const generation = String(opts.generation ?? "");
  if (namespace === "diagnostic" && !generation.startsWith("test-")) {
    throw fail("diagnostic-rejected", "diagnostic actions require a test- generation");
  }
  if (opts.action === "dismiss") {
    return mutate({ ...opts, namespace }, (state) => ({ write: false, action: "dismiss", unchanged: true }));
  }
  if (opts.action === "controls") {
    return mutate({ ...opts, namespace, generation: undefined }, (state) => ({
      write: false,
      action: "controls",
      stale: Boolean(generation) && state.pending?.generation !== generation,
    }));
  }
  if (opts.action !== "snooze") throw fail("invalid-action", "unknown reminder action");
  return mutate({ ...opts, namespace }, (state, nowMs) => {
    if (!state.pending || state.pending.generation !== generation) {
      const error = fail("stale", COPY.stale);
      error.stale = true;
      throw error;
    }
    const ms = Number(opts.capturedSnoozeMs);
    if (!isSafeInt(ms) || ms < SNOOZE_MIN_MINUTES * 60000 || ms > SNOOZE_MAX_MINUTES * 60000 || ms % 60000 !== 0) {
      throw fail("invalid-duration", `Enter a whole number from ${SNOOZE_MIN_MINUTES} to ${SNOOZE_MAX_MINUTES}.`);
    }
    state.snoozeUntil = new Date(nowMs + ms).toISOString();
    state.reservation = null;
    state.forceDue = false;
    return { appliedMs: ms, generation };
  });
}

function printResult(payload, code) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return code;
}

function errorPayload(error) {
  return {
    ok: false,
    error: error.code || "error",
    message: error.code === "busy" ? COPY.saveFailed : (error.code === "stale" ? COPY.stale : error.message),
    stale: error.code === "stale" || error.stale === true,
  };
}

function rejectStatePathArgs(argv) {
  const banned = ["--state", "--state-file", "--state-path", "--file", "--home", "--journal"];
  if (argv.some((arg) => banned.includes(arg) || arg.startsWith("--state=") || arg.startsWith("--file="))) {
    const error = fail("state-path", "state paths are not accepted");
    throw error;
  }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  return argv[index + 1] ?? null;
}

export function runArgv(argv, opts = {}) {
  rejectStatePathArgs(argv);
  const home = opts.home ?? keeperHome();
  const namespace = optionValue(argv, "--namespace") ?? "production";
  if (namespace !== "production" && namespace !== "diagnostic") throw fail("namespace", "namespace is not production or diagnostic");
  const nowMs = opts.nowMs ?? Date.now();
  const base = { home, namespace, nowMs, generation: optionValue(argv, "--generation") };
  const command = argv[2];
  if (restartRemindersDisabled(home) && command !== "--reminders" && !command?.endsWith("cleanup")) {
    return printResult({ ok: true, disabled: true, unchanged: true, message: "App restart reminders are off." }, 0);
  }
  if (command === "--diagnostic-create") {
    const generation = optionValue(argv, "--generation") ?? "";
    if (namespace !== "diagnostic" || !/^test-[A-Za-z0-9._-]+$/.test(generation)) throw fail("diagnostic-rejected", "Use diagnostic namespace and a test- generation.");
    const out = mutate({ home, namespace, nowMs }, (state) => {
      if (state.pending) throw fail("diagnostic-exists", "Clean up the existing diagnostic generation first.");
      state.pending = { generation, build: "diagnostic", reasons: ["diagnostic"], boundaryUs: nowMs * 1000, boundarySource: "published", archive: null, prePatchMains: [], createdAt: new Date(nowMs).toISOString() };
      state.forceDue = true;
    });
    return printResult(out.view, 0);
  }
  if (command === "--diagnostic-post" || command === "--diagnostic-cleanup") {
    if (namespace !== "diagnostic" || !base.generation?.startsWith("test-")) throw fail("diagnostic-rejected", "Use diagnostic namespace and a test- generation.");
    const out = withReminderLock(home, namespace, () => {
      const { state } = readStateFile(pathsFor(home, namespace).state);
      if (state.pending?.generation !== base.generation) throw fail("stale", COPY.stale);
      if (command === "--diagnostic-post") {
        const payload = { ...buildPayload(state, null, nowMs), namespace, title: "TEST — T3 Restart Reminders", body: "Diagnostic reminder. Snooze changes only the test record." };
        const overlap = optionValue(argv, "--overlap-seconds");
        if (overlap !== null) {
          if (!/^(?:[1-9]|10)$/.test(overlap)) throw fail("diagnostic-rejected", "Diagnostic overlap must be 1..10 seconds.");
          payload.diagnosticHoldSeconds = Number(overlap);
        }
        const posted = defaultPost(payload, home);
        if (!posted.accepted) throw fail("not-posted", posted.error ?? "Notifications are not authorized.");
        return { ok: true, accepted: true, generation: base.generation };
      }
      const cleared = clearNative(home, base.generation, namespace);
      if (!cleared.ok) throw fail("clear-failed", "Diagnostic notification was not cleared; test record retained.");
      const overlapFile = path.join(home, "reminder-diagnostic-overlap.json");
      if (fs.existsSync(overlapFile)) {
        const overlap = JSON.parse(fs.readFileSync(overlapFile, "utf8"));
        if (overlap.generation === base.generation) fs.unlinkSync(overlapFile);
      }
      fs.unlinkSync(pathsFor(home, namespace).state);
      const dfd = fs.openSync(home, "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
      return { ok: true, cleaned: base.generation };
    }, { attempts: 20, waitMs: 50 });
    if (out.busy) throw fail("busy", COPY.saveFailed);
    return printResult(out.value, 0);
  }
  if (command === "--reminders") {
    const view = reminderStatus({
      ...base,
      observation: opts.observation,
      observe: namespace === "diagnostic" ? false : opts.observe !== false,
    });
    return printResult(view, 0);
  }
  if (command === "--snooze") {
    const out = snoozeFor({ ...base, duration: argv[3] });
    return printResult({ ok: true, durable: true, snoozeUntil: out.state.snoozeUntil, appliedMs: out.appliedMs, ...out.view, ok: true }, 0);
  }
  if (command === "--resume-reminders") {
    const out = resumeReminders(base);
    return printResult({ ok: true, durable: true, ...out.view }, 0);
  }
  if (command === "--remind-every") {
    const out = setReminderInterval({ ...base, duration: argv[3] });
    return printResult({ ok: true, durable: true, appliedMs: out.appliedMs, ...out.view }, 0);
  }
  if (command === "--reminder-action") {
    const out = applyAction({
      ...base,
      action: argv[3],
      generation: optionValue(argv, "--generation"),
      capturedSnoozeMs: Number(optionValue(argv, "--captured-ms")),
    });
    return printResult({
      ok: true,
      durable: out.durable,
      action: argv[3],
      snoozeUntil: out.state.snoozeUntil,
      appliedMs: out.appliedMs ?? null,
      stale: out.stale === true,
      unchanged: out.unchanged === true,
      generation: out.state.pending?.generation ?? null,
    }, 0);
  }
  if (command === "--reminder-controls" || command === "--reminder-setup") {
    const app = path.join(home, "T3 Restart Reminders.app");
    const bin = path.join(app, "Contents", "MacOS", "T3 Restart Reminders");
    if (!fs.existsSync(bin)) return printResult({ ok: false, error: "helper-missing", message: "The reminder helper is not installed yet." }, 1);
    if (command === "--reminder-controls") {
      const run = spawnSync("/usr/bin/open", [app], { encoding: "utf8" });
      if (run.status !== 0) return printResult({ ok: false, error: "open-failed" }, 1);
      return printResult({ ok: true, opened: "controls" }, 0);
    }
    const run = spawnSync(bin, ["--mode", "setup"], { encoding: "utf8" });
    return printResult({ ok: run.status === 0, status: run.status }, run.status === 0 ? 0 : 1);
  }
  return printResult({ ok: false, error: "usage", message: "use --reminders | --snooze <duration> | --resume-reminders | --remind-every <duration> | --reminder-controls | --reminder-setup" }, 64);
}

export function runFromKeeperArgv(argv) {
  try {
    return runArgv(argv);
  } catch (error) {
    const code = error.code === "busy" ? 75 : (error.code === "stale" ? 2 : (error.code === "usage" ? 64 : 1));
    return printResult(errorPayload(error), code);
  }
}

function main() {
  let code = 1;
  try {
    code = withCodeLease(keeperHome(), () => runArgv(process.argv));
  } catch (error) {
    code = error.code === "busy" ? 75 : (error.code === "stale" ? 2 : 1);
    printResult(errorPayload(error), code);
  }
  process.exit(code);
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
