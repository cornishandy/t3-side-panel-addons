/**
 * Pure rules for the sidebar index. Metadata only: no message bodies, paths or secrets.
 * Activity labels stay inside what a database snapshot can prove. They are not T3's
 * Working shelf, and they never mean Ready, Idle or Finished.
 */

const LIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);
const KNOWN_RUN = new Set([...LIVE_RUN, "queued", "completed", "failed", "interrupted", "cancelled", "idle"]);
const KNOWN_SUB = new Set(["pending", "running", "waiting", "completed", "cancelled", "failed", "interrupted"]);
const ACTIVE_SUB = new Set(["pending", "running", "waiting"]);
const TERMINAL = new Set(["completed", "cancelled", "failed", "interrupted", "expired", "resolved"]);
const OPEN_APPROVAL = new Set(["pending", "waiting", "running", "active"]);
const SKEW_MS = 2 * 60 * 1000;
const ACTIVITY_LABEL = {
  questions: "Questions & approvals",
  running: "Run in progress",
  child: "Child work recorded",
  open: "Other open threads",
  unknown: "State unavailable",
};

export function parseTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function safeId(value, max = 200) {
  return typeof value === "string" && new RegExp(`^[A-Za-z0-9:_-]{1,${max}}$`).test(value) ? value : null;
}

function cleanText(value, max) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...text];
  if (!chars.length) return null;
  if (chars.length > max) return `${chars.slice(0, max).join("")}…`;
  return text;
}

function flag(value) {
  return value === 1 || value === true || value === "1" || value === "true";
}

function parts(ms, timeZone) {
  const bag = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms))) bag[part.type] = part.value;
  let h = Number(bag.hour);
  if (h === 24) h = 0;
  return { y: Number(bag.year), m: Number(bag.month), d: Number(bag.day), h, mi: Number(bag.minute), s: Number(bag.second) };
}

function zoneOffset(ms, timeZone) {
  const p = parts(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - ms;
}

function zonedMidnight(y, m, d, timeZone) {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const off1 = zoneOffset(guess, timeZone);
  let instant = guess - off1;
  const off2 = zoneOffset(instant, timeZone);
  if (off2 !== off1) instant = guess - off2;
  return instant;
}

function addCivilDays(y, m, d, delta) {
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Non-overlapping buckets. Rolling 15 and 60 minutes win over the local calendar. */
export function bucket(ts, now, timeZone) {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return "none";
  if (ts > now + SKEW_MS) return "none";
  const age = now - ts;
  if (age <= 15 * 60 * 1000) return "m15";
  if (age <= 60 * 60 * 1000) return "m60";
  const today = parts(now, timeZone);
  if (ts >= zonedMidnight(today.y, today.m, today.d, timeZone)) return "today";
  const yest = addCivilDays(today.y, today.m, today.d, -1);
  if (ts >= zonedMidnight(yest.y, yest.m, yest.d, timeZone)) return "yesterday";
  const week = addCivilDays(today.y, today.m, today.d, -7);
  if (ts >= zonedMidnight(week.y, week.m, week.d, timeZone)) return "week";
  return "older";
}

function unstarted(run) {
  return run.status === "queued" || (run.status === "cancelled" && parseTime(run.workStartedAt) == null);
}

function pickLatest(thread, runs) {
  const nonheld = runs.filter((run) => !(run.status === "queued" && run.queueHeld));
  nonheld.sort((a, b) => b.ordinal - a.ordinal || (a.runId < b.runId ? -1 : 1));
  const latest = nonheld[0] ?? null;
  const limit = thread.limitRunId ? runs.find((run) => run.runId === thread.limitRunId) : null;
  if (limit && (limit.status === "failed" || limit.status === "interrupted")) {
    const newerReal = nonheld.some((run) => run.ordinal > limit.ordinal && !unstarted(run));
    if (!newerReal) return { run: limit, preserved: true };
  }
  return latest ? { run: latest, preserved: false } : null;
}

function childState(id, ctx) {
  if (ctx.unknownSub.has(id)) return "unknown";
  if (ctx.activeSub.has(id)) return true;
  const seen = new Set([id]);
  let frontier = ctx.children.get(id) ?? [];
  for (let depth = 0; depth < 2; depth++) {
    const next = [];
    for (const child of frontier) {
      if (!child || seen.has(child)) continue;
      seen.add(child);
      if (ctx.unknownSub.has(child)) return "unknown";
      if (ctx.activeSub.has(child) || ctx.childLive.has(child)) return true;
      for (const grand of ctx.children.get(child) ?? []) next.push(grand);
    }
    frontier = next;
  }
  return false;
}

function projectLabels(threads, projects) {
  const byId = new Map();
  for (const project of projects ?? []) {
    const id = safeId(project.id, 80);
    if (id) byId.set(id, project);
  }
  const used = new Map();
  const base = new Map();
  for (const thread of threads) {
    if (!thread.projectId || base.has(thread.projectId)) continue;
    const project = byId.get(thread.projectId);
    let label;
    if (!project) label = "Missing project record";
    else {
      const title = cleanText(project.title, 80);
      if (project.deleted) label = title ? `${title} (deleted record)` : "Deleted project record";
      else label = title || "Untitled project";
    }
    base.set(thread.projectId, label);
    used.set(label, (used.get(label) ?? 0) + 1);
  }
  const out = new Map();
  for (const [id, label] of base) {
    out.set(id, used.get(label) > 1 ? `${label} · ${id.slice(0, 8)}` : label);
  }
  return out;
}

function stampMs(stamp) {
  if (typeof stamp === "number" && Number.isFinite(stamp)) return stamp;
  return parseTime(stamp);
}

function timingOf(raw) {
  // Missing timing means an older caller already finished both reads.
  if (!raw || typeof raw !== "object") return { runStamps: "read", requestStamps: "read" };
  const flag = (value) => (value === "unread" ? "unread" : "read");
  return { runStamps: flag(raw.runStamps), requestStamps: flag(raw.requestStamps) };
}

function activityTime(thread, now, timing) {
  // The source belongs to the winning stamp. An older run must not label a newer request.
  // Creation is a fallback only after both time reads finished and neither had an event.
  const runRead = timing?.runStamps !== "unread";
  const requestRead = timing?.requestStamps !== "unread";
  let bestAt = null;
  let bestSource = null;
  const consider = (stamp, source) => {
    const ms = stampMs(stamp);
    if (ms == null || ms > now + SKEW_MS) return;
    if (bestAt == null || ms > bestAt) {
      bestAt = ms;
      bestSource = source;
    }
  };
  for (const stamp of thread.runStamps ?? []) consider(stamp, "run");
  for (const stamp of thread.requestStamps ?? []) consider(stamp, "request");
  if (!runRead || !requestRead) {
    if (bestAt != null) return { at: bestAt, source: "observed", bucket: "unread" };
    return { at: null, source: "unavailable", bucket: "unread" };
  }
  if (bestAt != null) return { at: bestAt, source: bestSource, bucket: null };
  const created = stampMs(thread.createdAt);
  if (created != null && created <= now + SKEW_MS) return { at: created, source: "created", bucket: null };
  return { at: null, source: "none", bucket: null };
}

/**
 * @param {object} raw worker facts. Thread rows are already the eligible top-level set.
 * `updatedAt` is ignored on purpose: it is metadata churn, not recent run activity.
 */
export function classifyThreads(raw, now, timeZone) {
  const projects = raw.projects ?? [];
  const runsByThread = new Map();
  for (const row of raw.runs ?? []) {
    const threadId = safeId(row.threadId);
    const runId = safeId(row.runId) ?? `ord:${row.ordinal}`;
    if (!threadId) continue;
    if (!runsByThread.has(threadId)) runsByThread.set(threadId, []);
    runsByThread.get(threadId).push({
      runId, ordinal: Number(row.ordinal) || 0, status: typeof row.status === "string" ? row.status : "",
      queueHeld: flag(row.queueHeld), requestedAt: row.requestedAt ?? null, completedAt: row.completedAt ?? null,
      workStartedAt: row.workStartedAt ?? null,
    });
  }
  const pendingByThread = new Map();
  for (const row of raw.pending ?? []) {
    const threadId = safeId(row.threadId);
    if (!threadId) continue;
    if (!pendingByThread.has(threadId)) pendingByThread.set(threadId, []);
    pendingByThread.get(threadId).push({
      capability: typeof row.capability === "string" ? row.capability : "",
      kind: typeof row.kind === "string" ? row.kind : "",
    });
  }
  const plansByThread = new Map();
  for (const row of raw.plans ?? []) {
    const threadId = safeId(row.threadId);
    if (!threadId) continue;
    if (!plansByThread.has(threadId)) plansByThread.set(threadId, []);
    plansByThread.get(threadId).push({ kind: row.kind, status: row.status });
  }
  const approvalsByThread = new Map();
  for (const row of raw.approvals ?? []) {
    const threadId = safeId(row.threadId);
    if (!threadId) continue;
    if (!approvalsByThread.has(threadId)) approvalsByThread.set(threadId, []);
    approvalsByThread.get(threadId).push(row);
  }
  const children = new Map();
  for (const row of raw.links ?? []) {
    const parent = safeId(row.threadId);
    const child = safeId(row.childThreadId);
    if (!parent || !child) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const activeSub = new Set((raw.activeSub ?? []).map((id) => safeId(id)).filter(Boolean));
  const unknownSub = new Set((raw.unknownSub ?? []).map((id) => safeId(id)).filter(Boolean));
  const childLive = new Set((raw.childLive ?? []).map((id) => safeId(id)).filter(Boolean));
  const secrets = new Set((raw.secrets ?? []).map((id) => safeId(id)).filter(Boolean));
  const ctx = { children, activeSub, unknownSub, childLive };
  const gaps = gapSets(raw);
  const timing = timingOf(raw.timing);
  const prepared = [];
  let omittedUnsafeIds = 0;
  for (const row of raw.threads ?? []) {
    const id = safeId(row.id);
    if (!id) {
      omittedUnsafeIds++;
      continue;
    }
    prepared.push({
      id,
      title: cleanText(row.title, 180) || "Untitled thread",
      projectId: safeId(row.projectId, 80),
      createdAt: row.createdAt ?? null,
      ageAt: row.latestUserAt ?? row.updatedAt ?? null,
      settledOverride: row.settledOverride ?? null,
      settledAt: row.settledAt ?? null,
      snoozedUntil: row.snoozedUntil ?? null,
      snoozedAt: row.snoozedAt ?? null,
      pinnedAt: row.pinnedAt ?? null,
      limitRunId: safeId(row.limitRunId),
      runStamps: row.runStamps ?? [],
      requestStamps: row.requestStamps ?? [],
    });
  }
  const labels = projectLabels(prepared, projects);
  const threads = prepared.map((thread) => classifyOne(thread, { runsByThread, pendingByThread, plansByThread, approvalsByThread, secrets, ctx, labels, gaps, timing }, now, timeZone));
  return { threads, omittedUnsafeIds };
}

const GAP_FAMILIES = ["approvals", "pending", "plans", "liveRuns", "child", "secrets"];

function gapSets(raw) {
  const inc = raw.factsIncomplete && typeof raw.factsIncomplete === "object" ? raw.factsIncomplete : {};
  const ids = raw.incompleteIds && typeof raw.incompleteIds === "object" ? raw.incompleteIds : {};
  const sets = {};
  for (const family of GAP_FAMILIES) {
    const list = Array.isArray(ids[family]) ? ids[family] : [];
    sets[family] = new Set(list.map((id) => safeId(id)).filter(Boolean));
  }
  return { inc, sets };
}

function gap(gaps, family, threadId, positive) {
  if (positive) return false;
  if (gaps.inc[family] === true) return true;
  return Boolean(gaps.sets[family]?.has(threadId));
}

function classifyOne(thread, bags, now, timeZone) {
  const unknown = [];
  const runs = bags.runsByThread.get(thread.id) ?? [];
  for (const run of runs) {
    if (run.status && !KNOWN_RUN.has(run.status)) unknown.push("run");
  }
  const live = runs.filter((run) => LIVE_RUN.has(run.status));
  const picked = pickLatest(thread, runs);
  let blocking = false;
  let nonblocking = false;
  let blockingLive = false;
  for (const req of bags.pendingByThread.get(thread.id) ?? []) {
    if (req.capability === "not_resumable") continue;
    if (req.capability === "message") {
      nonblocking = true;
      continue;
    }
    if (req.capability === "live") {
      blocking = true;
      blockingLive = true;
      continue;
    }
    if (req.capability) unknown.push("request");
    else unknown.push("request");
  }
  const secret = bags.secrets.has(thread.id);
  if (secret) blocking = true;
  let proposed = false;
  for (const plan of bags.plansByThread.get(thread.id) ?? []) {
    if (plan.status !== "active") continue;
    if (plan.kind === "todo_list") continue;
    if (plan.kind === "proposed_plan") {
      proposed = true;
      continue;
    }
    unknown.push("plan");
  }
  if (proposed) blocking = true;
  for (const approval of bags.approvalsByThread.get(thread.id) ?? []) {
    if (TERMINAL.has(approval.status)) continue;
    if (OPEN_APPROVAL.has(approval.status)) {
      blocking = true;
      continue;
    }
    unknown.push("approval");
  }
  const child = childState(thread.id, bags.ctx);
  if (child === "unknown" || bags.ctx.unknownSub.has(thread.id)) unknown.push("child");
  // A fact family that this thread did not finish is not evidence of absence.
  // A terminal approval alone does not prove a later open approval was absent.
  const gaps = bags.gaps || { inc: {}, sets: {} };
  const approvalRows = bags.approvalsByThread.get(thread.id) ?? [];
  const approvalPositive = approvalRows.some((approval) => approval.status == null || !TERMINAL.has(approval.status));
  if (gap(gaps, "pending", thread.id, (bags.pendingByThread.get(thread.id) ?? []).length > 0)) unknown.push("request");
  if (gap(gaps, "approvals", thread.id, approvalPositive)) unknown.push("approval");
  if (gap(gaps, "plans", thread.id, (bags.plansByThread.get(thread.id) ?? []).length > 0)) unknown.push("plan");
  if (gap(gaps, "secrets", thread.id, bags.secrets.has(thread.id))) unknown.push("request");
  if (gap(gaps, "liveRuns", thread.id, runs.some((run) => LIVE_RUN.has(run.status)))) unknown.push("run");
  if (gap(gaps, "child", thread.id, child === true || child === "unknown")) unknown.push("child");

  let activity;
  if (unknown.length) activity = "unknown";
  else if (blocking) activity = "questions";
  else if (live.length) activity = "running";
  else if (child === true) activity = "child";
  else if (nonblocking) activity = "questions";
  else activity = "open";

  const badges = [];
  if (blockingLive) badges.push("Recorded input or approval");
  if (nonblocking) badges.push("Recorded question");
  if (secret) badges.push("Recorded secret request");
  if (proposed) badges.push("Recorded proposed plan");
  if (approvalPositive) badges.push("Recorded approval request");
  if (child === true && activity !== "child") badges.push("Child work recorded");
  if (live.length && activity !== "running") badges.push("Run recorded");
  if (!live.length && picked && picked.run.status === "queued" && !picked.run.queueHeld) badges.push("Queued run recorded");
  if (picked?.preserved) badges.push("Usage-limit failure recorded");
  else if (picked?.run.status === "failed") badges.push("Latest run recorded as failed");
  else if (picked?.run.status === "interrupted") badges.push("Latest run recorded as interrupted");

  const attention = activity !== "open" || nonblocking || secret || proposed || approvalPositive || live.length || child === true;
  const until = parseTime(thread.snoozedUntil);
  const snoozedAt = parseTime(thread.snoozedAt);
  const recordedSnooze = until != null && until > now;
  const outcomeAt = picked ? (parseTime(picked.run.completedAt) ?? parseTime(picked.run.requestedAt)) : null;
  const failed = picked && (picked.run.status === "failed" || picked.run.status === "interrupted");
  const newFailure = Boolean(failed && (snoozedAt == null || (outcomeAt != null && outcomeAt > snoozedAt)));
  const effectiveSnooze = recordedSnooze && !attention && !newFailure && activity !== "unknown";
  const settled = thread.settledOverride === "settled";
  // A pin is a recorded timestamp. A value that does not parse is not a pin.
  const pinnedOk = parseTime(thread.pinnedAt) != null;
  let shelf = "main";
  if (effectiveSnooze) shelf = "snoozed";
  else if (settled && !attention && activity !== "unknown") shelf = "settled";
  else if (pinnedOk) shelf = "pinned";
  if (recordedSnooze && shelf !== "snoozed") badges.push("Snooze recorded");
  if (settled && shelf !== "settled") badges.push("Settled recorded");

  const when = activityTime(thread, now, bags.timing);
  const detail = {
    questions: "Recorded request in this database snapshot. A snapshot is not a live callback.",
    running: "Recorded run is preparing, starting, running or waiting. This is not the Working shelf.",
    child: "Child work recorded from a subagent status or child run, at most two levels. This is not the Waiting shelf.",
    open: "No recorded blocker in this snapshot. This is not Ready, Idle or Finished.",
    unknown: "State unavailable. A value was missing, conflicting or not one this index knows.",
  }[activity];

  return {
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    projectLabel: thread.projectId ? (bags.labels.get(thread.projectId) ?? "Missing project record") : "No project",
    createdAt: parseTime(thread.createdAt),
    activityAt: when.at,
    ageAt: parseTime(thread.ageAt), // what T3 prints as the row's age (latestUserMessageAt ?? updatedAt)
    activitySource: when.source,
    recentBucket: when.bucket ?? (when.at == null ? "none" : bucket(when.at, now, timeZone)),
    activity,
    activityLabel: ACTIVITY_LABEL[activity],
    badges,
    shelf,
    detail,
  };
}

export { ACTIVITY_LABEL, KNOWN_RUN, KNOWN_SUB };
