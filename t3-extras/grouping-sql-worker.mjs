/**
 * Read-only snapshot of this Mac's v2 top-level threads.
 * Fixed SELECTs and json_extract keys only. The parent times the worker out.
 * Never writes, and never returns payloads, paths, prompts or secrets.
 *
 * History rows are visited in bounded index chunks. The secret and approval
 * filters run after that limit, in JavaScript. A checkpoint goes out after
 * each completed fact query, before the next query: run time, request time,
 * latest runs, live runs, limit runs, pending requests, plans, and child
 * links. Live-run absence waits until both the latest and live reads finish.
 * History checkpoints still go out after the live approval seed and each
 * finished chunk, before the next statement. A test stall only waits; it
 * does not publish.
 * Run-time and request-time reads are tracked apart. Until a read finishes,
 * that time stays unread. The partial live-node index is used only when its
 * definition is the expected status set, and it never proves that an active
 * or unknown approval is absent.
 */
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const bootedAt = Date.now();

const REQUIRED = {
  orchestration_v2_projection_threads: ["thread_id", "project_id", "title", "created_at", "archived_at", "deleted_at", "payload_json"],
  orchestration_v2_projection_runs: ["run_id", "thread_id", "ordinal", "status", "requested_at", "completed_at", "payload_json"],
  orchestration_v2_projection_runtime_requests: ["thread_id", "kind", "status", "created_at", "resolved_at", "payload_json"],
  orchestration_v2_projection_subagents: ["thread_id", "child_thread_id", "status"],
  orchestration_v2_projection_plans: ["thread_id", "kind", "status"],
  orchestration_v2_projection_turn_items: ["thread_id", "type", "status"],
  orchestration_v2_projection_nodes: ["thread_id", "kind", "status"],
  projection_projects: ["project_id", "title", "deleted_at"],
};

const ELIGIBLE = `archived_at IS NULL AND deleted_at IS NULL
  AND IFNULL(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.relationshipToParent') END, '') != 'subagent'`;
const LIVE = `('preparing','starting','running','waiting')`;
const ACTIVE_SUB = `('pending','running','waiting')`;
const KNOWN_SUB = `('pending','running','waiting','completed','cancelled','failed','interrupted')`;
const HELD = `(status = 'queued' AND COALESCE(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.queueHeld') END IN (1, 'true', '1'), 0))`;
const CHUNK = 400;
const FAMILIES = ["approvals", "pending", "plans", "liveRuns", "child", "secrets"];

function fail(id, error) {
  const code = error === "schema" || error === "budget" || error === "read" ? error : "read";
  parentPort.postMessage({ id, error: code });
}

parentPort.on("message", (message) => {
  const { id, file, cap, nowMs, ping, stall } = message ?? {};
  if (ping) {
    parentPort.postMessage({ id, ok: true, ping: true, bootMs: Date.now() - bootedAt });
    return;
  }
  let db = null;
  const started = Date.now();
  const timings = [];
  const timed = (name, fn) => {
    const at = Date.now();
    try {
      return fn();
    } finally {
      timings.push({ name, ms: Date.now() - at });
    }
  };
  const budget = () => !(Date.now() - started > 1500);
  let emitted = false;
  const publish = (body) => {
    emitted = true;
    parentPort.postMessage({ id, checkpoint: true, bootMs: Date.now() - bootedAt, ...body });
  };
  try {
    if (typeof file !== "string" || !file || file.includes("\0")) throw Object.assign(new Error("read"), { code: "read" });
    const limit = Math.max(1, Math.min(1000, Number(cap) || 1000));
    const nowValue = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const cutoff = nowValue + 120000;
    const url = pathToFileURL(file);
    url.search = "?mode=ro";
    db = timed("open", () => new DatabaseSync(url, { readOnly: true, timeout: 500 }));
    db.exec("PRAGMA query_only = ON");
    if (!budget()) throw Object.assign(new Error("budget"), { code: "budget" });
    if (!timed("schema", () => schemaOk(db))) throw Object.assign(new Error("schema"), { code: "schema" });
    const total = Number(timed("count", () => db.prepare(`SELECT COUNT(*) AS n FROM orchestration_v2_projection_threads WHERE ${ELIGIBLE}`).get().n)) || 0;
    if (!budget()) throw Object.assign(new Error("budget"), { code: "budget" });
    const ids = timed("ids", () => pickIds(db, total, limit));
    if (!budget()) throw Object.assign(new Error("budget"), { code: "budget" });
    const threads = ids.length ? timed("threads", () => threadRows(db, ids)) : [];
    const projects = ids.length ? timed("projects", () => projectRows(db, threads)) : [];
    const pack = (facts) => ({
      total,
      truncated: total > ids.length,
      threads,
      projects,
      timings,
      ...facts,
      scan: {
        ...facts.scan,
        approvalsLeft: facts.incompleteIds?.approvals?.length ?? 0,
        secretsLeft: facts.incompleteIds?.secrets?.length ?? 0,
      },
    });
    // Base index before any history walk. Unfinished families stay unknown.
    const state = ids.length ? openState(ids) : emptyFacts();
    publish(pack(state));
    const facts = ids.length
      ? factRows(db, ids, threads, state, budget, cutoff, timed, publish, pack, normalizeStall(stall))
      : state;
    parentPort.postMessage({ id, ok: true, bootMs: Date.now() - bootedAt, ...pack(facts) });
  } catch (error) {
    if (!emitted) fail(id, error?.code === "schema" || error?.code === "budget" ? error.code : "read");
    else fail(id, "read");
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
});

function schemaOk(db) {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const [table, columns] of Object.entries(REQUIRED)) {
    if (!names.has(table)) return false;
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    for (const column of columns) if (!have.has(column)) return false;
  }
  return true;
}

function pickIds(db, total, limit) {
  if (total <= limit) {
    return db.prepare(`SELECT thread_id AS id FROM orchestration_v2_projection_threads WHERE ${ELIGIBLE} ORDER BY created_at DESC, thread_id ASC LIMIT ?`).all(limit).map((row) => row.id);
  }
  const priority = db.prepare(`
    WITH eligible AS (
      SELECT thread_id FROM orchestration_v2_projection_threads WHERE ${ELIGIBLE}
    )
    SELECT e.thread_id AS id FROM eligible e
    WHERE e.thread_id IN (
      SELECT thread_id FROM orchestration_v2_projection_runs WHERE status IN ${LIVE}
      UNION
      SELECT thread_id FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending'
      UNION
      SELECT thread_id FROM orchestration_v2_projection_subagents WHERE status IN ${ACTIVE_SUB}
      UNION
      SELECT s.thread_id FROM orchestration_v2_projection_subagents s
      JOIN orchestration_v2_projection_runs r ON r.thread_id = s.child_thread_id
      WHERE r.status IN ${LIVE}
    )
    ORDER BY e.thread_id ASC
    LIMIT ?`).all(limit).map((row) => row.id);
  const room = limit - priority.length;
  if (room <= 0) return priority;
  const fill = db.prepare(`
    SELECT thread_id AS id FROM orchestration_v2_projection_threads
    WHERE ${ELIGIBLE} AND thread_id NOT IN (SELECT value FROM json_each(?))
    ORDER BY created_at DESC, thread_id ASC
    LIMIT ?`).all(JSON.stringify(priority), room).map((row) => row.id);
  return [...priority, ...fill];
}

// The time T3's sidebar prints as a row's age: the last user message's updatedAt, else the
// thread's updatedAt (T3: latestUserMessageAt ?? updatedAt). Optional: older schemas lack it.
const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
// Only with T3's own partial index (thread_id, updated_at WHERE role = 'user'): without it the
// lookup scans messages per thread and could time the whole snapshot out, so ageAt stays unknown.
function hasLatestUser(db) {
  if (!["thread_id", "role", "updated_at"].every((c) => hasColumn(db, "orchestration_v2_projection_messages", c))) return false;
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT m.updated_at FROM orchestration_v2_projection_messages m WHERE m.thread_id = ? AND m.role = 'user' ORDER BY m.updated_at DESC LIMIT 1`).all("x");
  return plan.some((row) => /USING (COVERING )?INDEX/.test(String(row.detail))) && !plan.some((row) => /TEMP B-TREE/.test(String(row.detail)));
}

function threadRows(db, ids) {
  const json = JSON.stringify(ids);
  const latestUser = hasLatestUser(db)
    ? `(SELECT m.updated_at FROM orchestration_v2_projection_messages m WHERE m.thread_id = t.thread_id AND m.role = 'user' ORDER BY m.updated_at DESC LIMIT 1)`
    : "NULL";
  return db.prepare(`
    SELECT thread_id AS id, project_id AS projectId, substr(title, 1, 180) AS title, created_at AS createdAt,
      ${hasColumn(db, "orchestration_v2_projection_threads", "updated_at") ? "updated_at" : "NULL"} AS updatedAt, ${latestUser} AS latestUserAt,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledOverride') END AS settledOverride,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledAt') END AS settledAt,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.snoozedUntil') END AS snoozedUntil,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.snoozedAt') END AS snoozedAt,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinnedAt') END AS pinnedAt,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.limitRecovery.runId') END AS limitRunId
    FROM orchestration_v2_projection_threads t
    WHERE thread_id IN (SELECT value FROM json_each(?))`).all(json);
}

function projectRows(db, threads) {
  const ids = [...new Set(threads.map((row) => row.projectId).filter((id) => typeof id === "string"))];
  if (!ids.length) return [];
  return db.prepare(`
    SELECT project_id AS id, substr(title, 1, 120) AS title, CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END AS deleted
    FROM projection_projects
    WHERE project_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
}

function emptyFacts() {
  return {
    runs: [], pending: [], plans: [], approvals: [], activeSub: [], unknownSub: [], secrets: [],
    runStamps: [], requestStamps: [], childLinksTruncated: false,
    factsIncomplete: emptyIncomplete(),
    incompleteIds: emptyIds(),
    timing: { runStamps: "unread", requestStamps: "unread" },
    scan: { chunk: CHUNK, secretsVisited: 0, approvalsVisited: 0, secretsMode: "none", approvalsMode: "none" },
  };
}

function emptyIncomplete() {
  return { approvals: false, pending: false, plans: false, liveRuns: false, child: false, secrets: false };
}

function emptyIds() {
  return { approvals: [], pending: [], plans: [], liveRuns: [], child: [], secrets: [] };
}

function openState(ids) {
  const facts = emptyFacts();
  const incompleteIds = {};
  for (const family of FAMILIES) incompleteIds[family] = ids.slice();
  facts.incompleteIds = incompleteIds;
  return facts;
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

function pause(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pauseStall(stall, family, chunks) {
  if (!stall || stall.family !== family) return;
  if ((family === "approvals" || family === "secrets") && chunks !== stall.afterChunks) return;
  pause(stall.ms);
}

function factRows(db, ids, threads, state, budget, cutoff, timed, publish, pack, stall) {
  const json = JSON.stringify(ids);
  const finishFamily = (family) => {
    state.incompleteIds[family] = [];
  };
  if (budget()) {
    pauseStall(stall, "runStamps");
    if (budget()) {
      state.runStamps = timed("runStamps", () => db.prepare(`
        SELECT thread_id AS threadId,
          ${validMax("requested_at")} AS requestedAt,
          ${validMax("completed_at")} AS completedAt,
          ${validMax("CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.startedAt') END")} AS startedAt,
          ${validMax("CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.workStartedAt') END")} AS workStartedAt
        FROM orchestration_v2_projection_runs
        WHERE thread_id IN (SELECT value FROM json_each(?))
        GROUP BY thread_id`).all(cutoff, cutoff, cutoff, cutoff, json));
      state.timing.runStamps = "read";
      publish(pack(state));
    }
  }
  if (budget()) {
    pauseStall(stall, "requestStamps");
    if (budget()) {
      state.requestStamps = timed("requestStamps", () => db.prepare(`
        SELECT thread_id AS threadId,
          ${validMax("created_at")} AS createdAt,
          ${validMax("resolved_at")} AS resolvedAt
        FROM orchestration_v2_projection_runtime_requests
        WHERE thread_id IN (SELECT value FROM json_each(?))
        GROUP BY thread_id`).all(cutoff, cutoff, json));
      state.timing.requestStamps = "read";
      publish(pack(state));
    }
  }
  const ranLatest = budget();
  const latestRuns = ranLatest ? timed("latestRuns", () => db.prepare(`
    SELECT threadId, runId, ordinal, status, requestedAt, completedAt, queueHeld, workStartedAt
    FROM (
      SELECT thread_id AS threadId, run_id AS runId, ordinal, status,
        requested_at AS requestedAt, completed_at AS completedAt,
        ${queueHeldSql()} AS queueHeld,
        CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.workStartedAt') END AS workStartedAt,
        ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY ordinal DESC) AS rn
      FROM orchestration_v2_projection_runs
      WHERE thread_id IN (SELECT value FROM json_each(?)) AND NOT ${HELD}
    ) WHERE rn = 1`).all(json)) : [];
  // Latest runs are known here. Live absence is not: a lower ordinal can still be live.
  if (ranLatest) {
    state.runs = dedupeRuns(latestRuns);
    publish(pack(state));
  }
  const ranLive = budget();
  const liveRuns = ranLive ? timed("liveRuns", () => db.prepare(`
    SELECT threadId, runId, ordinal, status, requestedAt, completedAt, queueHeld, workStartedAt
    FROM (
      SELECT thread_id AS threadId, run_id AS runId, ordinal, status,
        requested_at AS requestedAt, completed_at AS completedAt,
        ${queueHeldSql()} AS queueHeld,
        CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.workStartedAt') END AS workStartedAt,
        ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY ordinal DESC) AS rn
      FROM orchestration_v2_projection_runs
      WHERE status IN ${LIVE} AND thread_id IN (SELECT value FROM json_each(?))
    ) WHERE rn = 1
    LIMIT 2000`).all(json)) : [];
  if (ranLive) {
    state.runs = dedupeRuns([...latestRuns, ...liveRuns]);
    if (ranLatest) {
      if (liveRuns.length === 2000) state.factsIncomplete.liveRuns = true;
      finishFamily("liveRuns");
    }
    publish(pack(state));
  }
  const limitIds = [...new Set(threads.map((row) => row.limitRunId).filter((id) => typeof id === "string" && id.length > 0))];
  const ranLimit = budget();
  const limitRuns = ranLimit ? timed("limitRuns", () => limitIds.length ? db.prepare(`
    SELECT thread_id AS threadId, run_id AS runId, ordinal, status, requested_at AS requestedAt, completed_at AS completedAt,
      ${queueHeldSql()} AS queueHeld,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.workStartedAt') END AS workStartedAt
    FROM orchestration_v2_projection_runs
    WHERE run_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(limitIds)) : []) : [];
  if (ranLimit) {
    state.runs = dedupeRuns([...latestRuns, ...liveRuns, ...limitRuns]);
    publish(pack(state));
  }
  const pendingLoad = budget() ? timed("pending", () => loadPending(db, json)) : null;
  if (pendingLoad) {
    state.pending = pendingLoad.rows;
    state.factsIncomplete.pending = pendingLoad.saturated;
    if (!pendingLoad.saturated) finishFamily("pending");
    publish(pack(state));
  }
  const plansLoad = budget() ? timed("plans", () => loadPlans(db, json)) : null;
  if (plansLoad) {
    state.plans = plansLoad.rows;
    state.factsIncomplete.plans = plansLoad.saturated;
    if (!plansLoad.saturated) finishFamily("plans");
    publish(pack(state));
  }
  const childLoad = budget() ? timed("child", () => loadChild(db, json)) : null;
  if (childLoad) {
    state.activeSub = childLoad.activeSub;
    state.unknownSub = childLoad.unknownSub;
    state.childLinksTruncated = childLoad.saturated;
    state.factsIncomplete.child = childLoad.saturated;
    if (!childLoad.saturated) finishFamily("child");
    publish(pack(state));
  }
  if (budget()) timed("approvals", () => loadApprovals(db, ids, state, budget, publish, pack, stall));
  publish(pack(state));
  if (budget()) timed("secrets", () => loadSecrets(db, ids, state, budget, publish, pack, stall));
  return state;
}

function validMax(expr) {
  // Same shape core parseTime accepts: a T timestamp, with milliseconds and offsets kept.
  return `MAX(CASE WHEN typeof(${expr}) = 'text' AND ${expr} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*' AND unixepoch(${expr}, 'subsec') IS NOT NULL AND CAST(round(unixepoch(${expr}, 'subsec') * 1000) AS INTEGER) <= ? THEN CAST(round(unixepoch(${expr}, 'subsec') * 1000) AS INTEGER) END)`;
}

function queueHeldSql() {
  return `CASE WHEN CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.queueHeld') END IN (1, 'true', '1') THEN 1 ELSE 0 END`;
}

function loadPending(db, json) {
  const agg = db.prepare(`
    SELECT thread_id AS threadId,
      MAX(CASE WHEN cap = 'live' THEN 1 ELSE 0 END) AS blockingLive,
      MAX(CASE WHEN cap = 'message' THEN 1 ELSE 0 END) AS nonblocking,
      MAX(CASE WHEN cap IS NULL OR cap = '' OR cap NOT IN ('live', 'message', 'not_resumable') THEN 1 ELSE 0 END) AS unknownCap
    FROM (
      SELECT thread_id,
        CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.responseCapability.type') END AS cap
      FROM orchestration_v2_projection_runtime_requests
      WHERE status = 'pending' AND thread_id IN (SELECT value FROM json_each(?))
    )
    GROUP BY thread_id
    LIMIT 2000`).all(json);
  const rows = [];
  for (const row of agg) {
    if (row.blockingLive) rows.push({ threadId: row.threadId, kind: "user_input", status: "pending", capability: "live" });
    if (row.nonblocking) rows.push({ threadId: row.threadId, kind: "user_input", status: "pending", capability: "message" });
    if (row.unknownCap) rows.push({ threadId: row.threadId, kind: "user_input", status: "pending", capability: "" });
  }
  return { rows, saturated: agg.length === 2000 };
}

function loadPlans(db, json) {
  const agg = db.prepare(`
    SELECT thread_id AS threadId,
      MAX(CASE WHEN kind = 'proposed_plan' THEN 1 ELSE 0 END) AS proposed,
      MAX(CASE WHEN kind NOT IN ('proposed_plan', 'todo_list') THEN 1 ELSE 0 END) AS unknownPlan
    FROM orchestration_v2_projection_plans
    WHERE status = 'active' AND thread_id IN (SELECT value FROM json_each(?))
    GROUP BY thread_id
    LIMIT 2000`).all(json);
  const rows = [];
  for (const row of agg) {
    if (row.proposed) rows.push({ threadId: row.threadId, kind: "proposed_plan", status: "active" });
    if (row.unknownPlan) rows.push({ threadId: row.threadId, kind: "unknown", status: "active" });
  }
  return { rows, saturated: agg.length === 2000 };
}

function loadApprovals(db, ids, state, budget, publish, pack, stall) {
  const mode = approvalMode(db);
  state.scan.approvalsMode = mode.kind;
  const seed = mode.trustedLive && budget() ? seedLiveApprovals(db, JSON.stringify(ids)) : [];
  state.approvals = seed;
  publish(pack(state));
  let chunks = 0;
  const sorted = ids.slice().sort();
  const result = walkChunks(db, sorted, mode, budget, (count, incomplete, hits) => {
    state.scan.approvalsVisited += count;
    state.incompleteIds.approvals = [...incomplete];
    state.approvals = mergeApprovals(seed, hits, incomplete);
    chunks += 1;
    publish(pack(state));
    pauseStall(stall, "approvals", chunks);
  });
  state.incompleteIds.approvals = result.done ? [] : [...result.incomplete];
  state.approvals = result.done ? result.hits : mergeApprovals(seed, result.hits, result.incomplete);
}

function loadSecrets(db, ids, state, budget, publish, pack, stall) {
  const mode = secretMode(db);
  state.scan.secretsMode = mode.kind;
  let chunks = 0;
  const sorted = ids.slice().sort();
  const result = walkChunks(db, sorted, mode, budget, (count, incomplete, hits) => {
    state.scan.secretsVisited += count;
    state.incompleteIds.secrets = [...incomplete];
    state.secrets = [...new Set(hits)];
    chunks += 1;
    publish(pack(state));
    pauseStall(stall, "secrets", chunks);
  });
  state.incompleteIds.secrets = result.done ? [] : [...result.incomplete];
  state.secrets = [...new Set(result.hits)];
}

function seedLiveApprovals(db, json) {
  const sql = `
    SELECT thread_id AS threadId, status
    FROM orchestration_v2_projection_nodes INDEXED BY orchestration_v2_projection_nodes_live_idx
    WHERE status IN ('pending', 'starting', 'running', 'waiting')
      AND kind = 'approval_request'
      AND thread_id IN (SELECT value FROM json_each(?))
    LIMIT 2000`;
  if (!planSafe(db, sql, [json], { index: "orchestration_v2_projection_nodes_live_idx" })) return [];
  return db.prepare(sql).all(json).map((row) => ({ threadId: row.threadId, status: row.status ?? null }));
}

function mergeApprovals(seed, hits, incomplete) {
  const pending = new Set(incomplete);
  const rows = [];
  for (const row of seed) if (pending.has(row.threadId)) rows.push(row);
  for (const hit of hits) rows.push(hit);
  return rows;
}

function secretMode(db) {
  const table = "orchestration_v2_projection_turn_items";
  const index = findIndex(db, table, ["thread_id", "ordinal", "turn_item_id"]);
  const firstSql = `
    SELECT ordinal AS a, turn_item_id AS b, rowid AS rid, type, status
    FROM ${table}
    WHERE thread_id = ?
    ORDER BY ordinal, turn_item_id, rowid
    LIMIT ${CHUNK}`;
  const nextSql = `
    SELECT ordinal AS a, turn_item_id AS b, rowid AS rid, type, status
    FROM ${table}
    WHERE thread_id = ? AND (ordinal, turn_item_id, rowid) > (?, ?, ?)
    ORDER BY ordinal, turn_item_id, rowid
    LIMIT ${CHUNK}`;
  if (index
    && planSafe(db, firstSql, ["probe"], { index })
    && planSafe(db, nextSql, ["probe", 0, "x", 0], { index, ranged: true })) {
    return { kind: "turn-ordinal", width: 3, firstSql, nextSql, accept: acceptSecret };
  }
  return rowidMode(db, table, "type, status", acceptSecret, "secrets-rowid");
}

function approvalMode(db) {
  const table = "orchestration_v2_projection_nodes";
  const index = findIndex(db, table, ["thread_id", "run_id"]);
  const firstSql = `
    SELECT run_id AS a, rowid AS rid, kind, status
    FROM ${table}
    WHERE thread_id = ?
    ORDER BY run_id, rowid
    LIMIT ${CHUNK}`;
  const nextSql = `
    SELECT run_id AS a, rowid AS rid, kind, status
    FROM ${table}
    WHERE thread_id = ? AND (run_id, rowid) > (?, ?)
    ORDER BY run_id, rowid
    LIMIT ${CHUNK}`;
  const trustedLive = trustedLiveIndex(db);
  if (index
    && planSafe(db, firstSql, ["probe"], { index })
    && planSafe(db, nextSql, ["probe", "x", 0], { index, ranged: true })) {
    return { kind: "node-run", width: 2, firstSql, nextSql, accept: acceptApproval, trustedLive };
  }
  return { ...rowidMode(db, table, "kind, status", acceptApproval, "approvals-rowid"), trustedLive };
}

function rowidMode(db, table, columns, accept, kind) {
  const sql = `
    SELECT rowid AS rid, thread_id AS threadId, ${columns}
    FROM ${table}
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ${CHUNK}`;
  const safe = planSafe(db, sql, [0], { primary: true });
  return { kind: safe ? kind : "unindexed", width: 0, sql: safe ? sql : null, accept };
}

function walkChunks(db, threadIds, mode, budget, onChunk) {
  const incomplete = new Set(threadIds);
  const hits = [];
  if (!mode.sql && !mode.firstSql) return { done: false, incomplete, hits };
  if (mode.kind === "secrets-rowid" || mode.kind === "approvals-rowid") {
    const stmt = db.prepare(mode.sql);
    let rid = 0;
    while (budget()) {
      const rows = stmt.all(rid);
      for (const row of rows) {
        rid = row.rid;
        const hit = mode.accept(row, row.threadId);
        if (hit != null) hits.push(hit);
      }
      if (rows.length < CHUNK) incomplete.clear();
      onChunk(rows.length, incomplete, hits);
      if (rows.length < CHUNK) break;
      if (!budget()) break;
    }
    return { done: incomplete.size === 0, incomplete, hits };
  }
  const first = db.prepare(mode.firstSql);
  const next = db.prepare(mode.nextSql);
  for (const threadId of threadIds) {
    if (!budget()) break;
    let cursor = null;
    let done = false;
    while (budget()) {
      const rows = cursor == null
        ? first.all(threadId)
        : (mode.width === 3 ? next.all(threadId, cursor.a, cursor.b, cursor.rid) : next.all(threadId, cursor.a, cursor.rid));
      for (const row of rows) {
        const hit = mode.accept(row, threadId);
        if (hit != null) hits.push(hit);
      }
      const last = rows.at(-1);
      const short = rows.length < CHUNK;
      const blocked = !short && (last?.a == null || (mode.width === 3 && last?.b == null));
      if (short) {
        done = true;
        incomplete.delete(threadId);
      }
      onChunk(rows.length, incomplete, hits);
      if (done || blocked) break;
      cursor = last;
      if (!budget()) break;
    }
    if (!done) break;
  }
  return { done: incomplete.size === 0, incomplete, hits };
}

function findIndex(db, table, columns) {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table);
  for (const row of rows) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name || "") || typeof row.sql !== "string") continue;
    if (/\bwhere\b/i.test(row.sql)) continue;
    const compact = row.sql.replace(/\s+/g, " ");
    const match = compact.match(/on\s+[A-Za-z0-9_]+\s*\(([^)]*)\)/i);
    if (!match) continue;
    const cols = match[1].split(",").map((part) => part.trim().split(/\s+/)[0].replace(/["`[\]]/g, "").toLowerCase());
    if (columns.every((column, index) => cols[index] === column)) return row.name;
  }
  return null;
}

function trustedLiveIndex(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'orchestration_v2_projection_nodes_live_idx'").get();
  if (typeof row?.sql !== "string") return false;
  const compact = row.sql.replace(/\s+/g, " ").toLowerCase();
  if (!compact.includes("on orchestration_v2_projection_nodes (thread_id)") && !compact.includes("on orchestration_v2_projection_nodes(thread_id)")) return false;
  const where = compact.split(" where ")[1] || "";
  const literals = [...where.matchAll(/'([^']+)'/g)].map((item) => item[1]);
  const wanted = ["pending", "starting", "running", "waiting"];
  return literals.length === wanted.length && wanted.every((status) => literals.includes(status));
}

function planSafe(db, sql, params, expect) {
  let detail = "";
  try {
    detail = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join("\n");
  } catch {
    return false;
  }
  if (/TEMP B-TREE/i.test(detail)) return false;
  if (expect.primary && !/INTEGER PRIMARY KEY/i.test(detail)) return false;
  if (expect.index && !detail.includes(`USING INDEX ${expect.index}`) && !detail.includes(`USING COVERING INDEX ${expect.index}`)) return false;
  if (expect.ranged && !detail.includes(">")) return false;
  return true;
}

function acceptSecret(row, threadId) {
  if (row.type === "secret_request" && row.status === "waiting") return threadId;
  return null;
}

function acceptApproval(row, threadId) {
  if (row.kind !== "approval_request") return null;
  return { threadId, status: row.status ?? null };
}

function loadChild(db, json) {
  // One row per parent. Two levels, matching the classifier: a grandchild is visible, a great-grandchild is not.
  // Unknown wins. A global link LIMIT is not applied, so a later blocker cannot fall off the end of a raw list.
  const rows = db.prepare(`
    WITH parents AS (SELECT value AS id FROM json_each(?))
    SELECT p.id AS threadId,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents s
          WHERE s.thread_id = p.id AND IFNULL(s.status, '') NOT IN ${KNOWN_SUB}
        ) OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents s
          JOIN orchestration_v2_projection_subagents g ON g.thread_id = s.child_thread_id
          WHERE s.thread_id = p.id AND s.child_thread_id IS NOT NULL AND IFNULL(g.status, '') NOT IN ${KNOWN_SUB}
        ) THEN 'unknown'
        WHEN EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents s
          WHERE s.thread_id = p.id AND s.status IN ${ACTIVE_SUB}
        ) OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents s
          JOIN orchestration_v2_projection_subagents g ON g.thread_id = s.child_thread_id
          WHERE s.thread_id = p.id AND s.child_thread_id IS NOT NULL AND g.status IN ${ACTIVE_SUB}
        ) OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents s
          JOIN orchestration_v2_projection_runs r ON r.thread_id = s.child_thread_id
          WHERE s.thread_id = p.id AND s.child_thread_id IS NOT NULL AND r.status IN ${LIVE}
        ) OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents s
          JOIN orchestration_v2_projection_subagents g ON g.thread_id = s.child_thread_id
          JOIN orchestration_v2_projection_runs r ON r.thread_id = g.child_thread_id
          WHERE s.thread_id = p.id AND s.child_thread_id IS NOT NULL AND g.child_thread_id IS NOT NULL
            AND r.status IN ${LIVE}
        ) THEN 'active'
        ELSE 'none'
      END AS state
    FROM parents p
    LIMIT 3000`).all(json);
  const activeSub = [];
  const unknownSub = [];
  for (const row of rows) {
    if (row.state === "unknown") unknownSub.push(row.threadId);
    else if (row.state === "active") activeSub.push(row.threadId);
  }
  return { activeSub, unknownSub, saturated: rows.length === 3000 };
}

function dedupeRuns(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.threadId}\0${row.runId}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}
