// Read-only snapshot, caps, and the loopback origin guard.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGrouping } from "../grouping.mjs";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const NOW = Date.parse("2026-10-21T23:00:00.000Z");
const TZ = "America/New_York";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-group-"));
const fixture = path.join(tmp, "state.sqlite");
const envFile = path.join(tmp, "env-id");
fs.writeFileSync(envFile, "localenv01\n");

const SCHEMA = `
CREATE TABLE orchestration_v2_projection_threads (
  thread_id TEXT, project_id TEXT, title TEXT, created_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_runs (
  run_id TEXT, thread_id TEXT, ordinal INTEGER, status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests (
  thread_id TEXT, kind TEXT, status TEXT, created_at TEXT, resolved_at TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_subagents (
  thread_id TEXT, child_thread_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_plans (
  thread_id TEXT, kind TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_turn_items (
  thread_id TEXT, type TEXT, status TEXT, payload_json TEXT);
CREATE TABLE orchestration_v2_projection_nodes (
  thread_id TEXT, kind TEXT, status TEXT);
CREATE TABLE projection_projects (
  project_id TEXT, title TEXT, deleted_at TEXT, workspace_root TEXT);
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}
function payload(extra = {}) {
  const { limitRunId, ...rest } = extra;
  return JSON.stringify({
    prompt: "SECRET_PROMPT_TEXT", steps: "SECRET_STEPS",
    limitRecovery: { requestId: "SECRET_REQUEST_ID", runId: limitRunId ?? null },
    pr: { title: "SECRET_PR_TITLE", watch: "SECRET_WATCH" },
    workspace_root: "/tmp/SECRET_PATH", updatedAt: "2026-10-21T22:50:00.000Z",
    ...rest,
  });
}
function buildFixture(file) {
  const db = openDb(file);
  const eligible = [];
  const ins = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const add = (row) => {
    let raw = row.raw;
    if (raw == null) {
      const extra = { ...(row.extra ?? {}) };
      if (row.lineage) extra.lineage = { relationshipToParent: row.lineage };
      raw = payload(extra);
    }
    if (!row.archived && !row.deleted && row.lineage !== "subagent") eligible.push(row.id);
    ins.run(row.id, row.projectId ?? null, row.title ?? row.id, row.created ?? "2026-10-01T15:00:00.000Z", row.archived ?? null, row.deleted ?? null, raw);
  };
  const run = db.prepare(`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, status, requested_at, completed_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const addRun = (threadId, row) => run.run(row.runId, threadId, row.ordinal ?? 1, row.status, row.requested ?? "2026-10-21T18:00:00.000Z", row.completed ?? null, JSON.stringify(row.payload ?? {}));
  const req = db.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests
    (thread_id, kind, status, created_at, resolved_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)`);
  const addReq = (threadId, capability) => req.run(threadId, "user_input", "pending", "2026-10-21T18:30:00.000Z", null, JSON.stringify({ responseCapability: { type: capability } }));
  db.prepare(`INSERT INTO projection_projects (project_id, title, deleted_at, workspace_root) VALUES (?, ?, ?, ?)`).run("proj-live", "Alpha", null, "/tmp/SECRET_PATH");
  db.prepare(`INSERT INTO projection_projects (project_id, title, deleted_at, workspace_root) VALUES (?, ?, ?, ?)`).run("proj-del", "Old Name", "2026-01-01T00:00:00.000Z", "/tmp/SECRET_PATH");
  db.prepare(`INSERT INTO projection_projects (project_id, title, deleted_at, workspace_root) VALUES (?, ?, ?, ?)`).run("aaa11111-1111-4111-8111-111111111111", "Shared", null, "/tmp/SECRET_PATH");
  db.prepare(`INSERT INTO projection_projects (project_id, title, deleted_at, workspace_root) VALUES (?, ?, ?, ?)`).run("bbb22222-2222-4222-8222-222222222222", "Shared", null, "/tmp/SECRET_PATH");

  add({ id: "parent-livech" });
  add({ id: "child-livech", lineage: "subagent" });
  addRun("parent-livech", { runId: "p-done", status: "completed", completed: "2026-10-21T18:00:00.000Z" });
  addRun("child-livech", { runId: "c-live", status: "running" });
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("parent-livech", "child-livech", "running");

  add({ id: "held-parent" });
  addRun("held-parent", { runId: "h1", status: "completed", ordinal: 1, completed: "2026-10-20T18:00:00.000Z" });
  addRun("held-parent", { runId: "h2", status: "queued", ordinal: 2, payload: { queueHeld: 1 } });
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("held-parent", "held-child", "completed");
  addRun("held-child", { runId: "hc", status: "queued", payload: { queueHeld: 1 } });

  add({ id: "run-message" });
  addRun("run-message", { runId: "rm", status: "running" });
  addReq("run-message", "message");
  add({ id: "done-message" });
  addRun("done-message", { runId: "dm", status: "completed", completed: "2026-10-21T17:00:00.000Z" });
  addReq("done-message", "message");
  add({ id: "not-resume" });
  addReq("not-resume", "not_resumable");
  add({ id: "no-session" });
  add({ id: "secret-thread" });
  db.prepare(`INSERT INTO orchestration_v2_projection_turn_items (thread_id, type, status, payload_json) VALUES (?, ?, ?, ?)`).run("secret-thread", "secret_request", "waiting", JSON.stringify({ secret: "SECRET_PAYLOAD" }));
  add({ id: "todo-thread" });
  db.prepare(`INSERT INTO orchestration_v2_projection_plans (thread_id, kind, status) VALUES (?, ?, ?)`).run("todo-thread", "todo_list", "active");
  add({ id: "plan-thread" });
  db.prepare(`INSERT INTO orchestration_v2_projection_plans (thread_id, kind, status) VALUES (?, ?, ?)`).run("plan-thread", "proposed_plan", "active");
  add({ id: "run-plan" });
  addRun("run-plan", { runId: "rp", status: "running" });
  db.prepare(`INSERT INTO orchestration_v2_projection_plans (thread_id, kind, status) VALUES (?, ?, ?)`).run("run-plan", "proposed_plan", "active");
  add({ id: "stale-settled", extra: { settledAt: "2020-01-01T00:00:00.000Z", settledOverride: "active" } });
  add({ id: "truly-settled", extra: { settledAt: "2020-01-01T00:00:00.000Z", settledOverride: "settled" } });
  addRun("truly-settled", { runId: "ts", status: "completed", completed: "2026-10-01T00:00:00.000Z" });
  add({ id: "pr-thread" });
  add({ id: "snooze-input", extra: { snoozedUntil: "2026-10-22T23:00:00.000Z", snoozedAt: "2026-10-20T00:00:00.000Z" } });
  addReq("snooze-input", "live");
  add({ id: "snooze-fail", extra: { snoozedUntil: "2026-10-22T23:00:00.000Z", snoozedAt: "2026-10-20T00:00:00.000Z" } });
  addRun("snooze-fail", { runId: "sf", status: "failed", completed: "2026-10-21T20:00:00.000Z" });
  add({ id: "wake-thread" });
  add({ id: "bad-json", raw: "{" });
  add({ id: "deleted-proj", projectId: "proj-del" });
  add({ id: "missing-proj", projectId: "proj-missing" });
  add({ id: "cycle-parent" });
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("cycle-parent", "cyc-a", "completed");
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("cyc-a", "cyc-b", "completed");
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("cyc-b", "cyc-a", "completed");
  add({ id: "limit-thread", extra: { limitRunId: "limit-run-1" } });
  addRun("limit-thread", { runId: "limit-run-1", status: "failed", ordinal: 1, completed: "2026-10-21T12:00:00.000Z" });
  addRun("limit-thread", { runId: "limit-new", status: "cancelled", ordinal: 2, payload: {} });
  add({ id: "unknown-run" });
  addRun("unknown-run", { runId: "ur", status: "mystery" });
  add({ id: "pinned-thread", extra: { pinnedAt: "2026-10-02T00:00:00.000Z" } });
  add({ id: "queued-open" });
  addRun("queued-open", { runId: "qo", status: "queued", payload: {} });
  add({ id: "dup-left", projectId: "aaa11111-1111-4111-8111-111111111111" });
  add({ id: "dup-right", projectId: "bbb22222-2222-4222-8222-222222222222" });
  add({ id: "fork-thread", lineage: "fork" });
  add({ id: "approval-thread" });
  db.prepare(`INSERT INTO orchestration_v2_projection_nodes (thread_id, kind, status) VALUES (?, ?, ?)`).run("approval-thread", "approval_request", "pending");
  add({ id: "grand-parent" });
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("grand-parent", "gm-mid", "completed");
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("gm-mid", "gm-grand", "completed");
  addRun("gm-grand", { runId: "gg", status: "running" });
  add({ id: "great-parent" });
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("great-parent", "g-mid", "completed");
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("g-mid", "g-grand", "completed");
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("g-grand", "g-great", "completed");
  addRun("g-great", { runId: "gt", status: "running" });
  add({ id: "unknown-parent" });
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES (?, ?, ?)`).run("unknown-parent", "unk-child", "banana");
  add({ id: "archived-one", archived: "2026-01-01T00:00:00.000Z" });
  add({ id: "deleted-one", deleted: "2026-01-01T00:00:00.000Z" });
  db.close();
  return eligible;
}

const eligibleIds = buildFixture(fixture);

function reader(extra = {}) {
  return createGrouping({
    statev2: fixture, envIdFile: envFile, home: tmp, now: () => NOW, timeZone: TZ,
    cacheMs: 0, failCacheMs: 0, timeoutMs: 2000, ...extra,
  });
}
function byId(snapshot, id) {
  return snapshot.threads.find((row) => row.id === id);
}

test("frozen add-on bytes and the footer paragraph stay put", () => {
  // Preserve the independently authorized footer emphasis. (Whole-file hashes of extras.js/.css were
  // dropped 25 Oct 2026: every approved change since the font baseline broke them.)
  const locked = JSON.parse(fs.readFileSync(new URL("./font-protected.json", import.meta.url), "utf8"));
  const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(SRC, file))).digest("hex");
  assert.equal(sha("test/footer-css.test.mjs"), locked["test/footer-css.test.mjs"]);
  const css = fs.readFileSync(path.join(SRC, "public/extras.css"), "utf8");
  const block = css.slice(css.indexOf("/* ---------- reply footer card"));
  assert.equal(crypto.createHash("sha256").update(block).digest("hex"), locked.footerCssBlock);
  const readme = fs.readFileSync(path.join(SRC, "README.md"), "utf8");
  const start = readme.indexOf("**Reply footer card.**");
  const paragraph = readme.slice(start, readme.indexOf("\n\n", start));
  assert.equal(crypto.createHash("sha256").update(paragraph).digest("hex"), locked.footerReadmeParagraph);
  const install = fs.readFileSync(path.join(SRC, "install.sh"), "utf8");
  for (const name of ["grouping.mjs", "grouping-core.mjs", "grouping-sql-worker.mjs"]) {
    assert.equal(install.includes(`"$SRC/${name}"`), true, name);
  }
  // The sidebar view chooser is not installed (Andy, 25 Oct 2026): its client files are removed.
  assert.match(install, /^rm -f "\$HOME_DIR\/public\/grouping\.js" "\$HOME_DIR\/public\/grouping\.css"$/m);
  assert.equal(install.includes('"$SRC/public/grouping.js"'), false);
});

test("the worker's SQL is parameterized, read-only, and capped", () => {
  const src = fs.readFileSync(path.join(SRC, "grouping-sql-worker.mjs"), "utf8");
  assert.match(src, /PRAGMA query_only = ON/);
  assert.match(src, /json_each\(\?\)/);
  assert.match(src, /LIMIT 2000/);
  assert.match(src, /LIMIT 3000/);
  assert.match(src, /> 1500/);
  assert.match(src, /checkpoint: true/);
  assert.match(src, /row\.type === "secret_request" && row\.status === "waiting"/);
  assert.match(src, /\(ordinal, turn_item_id, rowid\) > \(\?, \?, \?\)/);
  assert.doesNotMatch(src, /SELECT\s+payload_json/i);
  const selects = [...src.matchAll(/`([^`]*)`/gs)].map((match) => match[1]).filter((sql) => /select/i.test(sql));
  for (const sql of selects) assert.equal(/secret_request/i.test(sql), false);
  assert.doesNotMatch(src, /workspace_root/);
  assert.doesNotMatch(src, /\$\{(?:ids|thread)/);
  const url = pathToFileURL(fixture);
  url.search = "?mode=ro";
  const db = new DatabaseSync(url, { readOnly: true, timeout: 500 });
  db.exec("PRAGMA query_only = ON");
  assert.throws(() => db.exec("CREATE TABLE hack (x)"));
  db.close();
});

test("a fixture database classifies the recorded states and drops secrets", async () => {
  const api = reader();
  try {
    const snapshot = await api.snapshot();
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    assert.equal(snapshot.localEnvironmentId, "localenv01");
    assert.equal(snapshot.source, "v2");
    assert.equal(snapshot.coverage.eligible, eligibleIds.length);
    assert.equal(snapshot.coverage.returned, eligibleIds.length);
    assert.equal(snapshot.coverage.truncated, false);
    assert.deepEqual(snapshot.threads.map((row) => row.id).sort(), [...eligibleIds].sort());
    const text = JSON.stringify(snapshot);
    for (const secret of ["SECRET_PROMPT_TEXT", "SECRET_STEPS", "SECRET_REQUEST_ID", "SECRET_PR_TITLE", "SECRET_WATCH", "SECRET_PAYLOAD", "SECRET_PATH", "workspace_root"]) {
      assert.equal(text.includes(secret), false, secret);
    }
    const parent = byId(snapshot, "parent-livech");
    assert.equal(parent.activity, "child");
    assert.equal(parent.activityLabel, "Child work recorded");
    assert.equal(byId(snapshot, "held-parent").activity, "open");
    assert.equal(byId(snapshot, "held-parent").badges.includes("Queued run recorded"), false);
    const running = byId(snapshot, "run-message");
    assert.equal(running.activity, "running");
    assert.ok(running.badges.includes("Recorded question"));
    assert.equal(byId(snapshot, "done-message").activity, "questions");
    assert.equal(byId(snapshot, "not-resume").activity, "open");
    assert.equal(byId(snapshot, "not-resume").badges.includes("Recorded question"), false);
    const quiet = byId(snapshot, "no-session");
    assert.equal(quiet.activitySource, "created");
    assert.equal(quiet.recentBucket, "older");
    assert.equal(byId(snapshot, "wake-thread").activitySource, "created");
    assert.equal(byId(snapshot, "wake-thread").recentBucket, "older");
    assert.equal(byId(snapshot, "secret-thread").activity, "questions");
    assert.ok(byId(snapshot, "secret-thread").badges.includes("Recorded secret request"));
    assert.equal(byId(snapshot, "todo-thread").activity, "open");
    assert.equal(byId(snapshot, "plan-thread").activity, "questions");
    assert.equal(byId(snapshot, "run-plan").activity, "questions");
    assert.ok(byId(snapshot, "run-plan").badges.includes("Run recorded"));
    assert.equal(byId(snapshot, "stale-settled").shelf, "main");
    assert.equal(byId(snapshot, "truly-settled").shelf, "settled");
    assert.equal(byId(snapshot, "pr-thread").activity, "open");
    assert.equal(byId(snapshot, "snooze-input").shelf, "main");
    assert.equal(byId(snapshot, "snooze-input").activity, "questions");
    assert.equal(byId(snapshot, "snooze-fail").shelf, "main");
    assert.equal(byId(snapshot, "bad-json").activity, "open");
    assert.equal(byId(snapshot, "deleted-proj").projectLabel, "Old Name (deleted record)");
    assert.equal(byId(snapshot, "missing-proj").projectLabel, "Missing project record");
    assert.equal(byId(snapshot, "dup-left").projectLabel, "Shared · aaa11111");
    assert.equal(byId(snapshot, "dup-right").projectLabel, "Shared · bbb22222");
    assert.equal(byId(snapshot, "cycle-parent").activity, "open");
    assert.deepEqual(byId(snapshot, "limit-thread").badges, ["Usage-limit failure recorded"]);
    assert.equal(byId(snapshot, "unknown-run").activity, "unknown");
    assert.equal(byId(snapshot, "pinned-thread").shelf, "pinned");
    assert.ok(byId(snapshot, "queued-open").badges.includes("Queued run recorded"));
    assert.equal(byId(snapshot, "queued-open").activity, "open");
    assert.equal(byId(snapshot, "fork-thread").activity, "open");
    assert.equal(byId(snapshot, "approval-thread").activity, "questions");
    assert.equal(byId(snapshot, "grand-parent").activity, "child");
    assert.equal(byId(snapshot, "great-parent").activity, "open");
    assert.equal(byId(snapshot, "unknown-parent").activity, "unknown");
    assert.equal(snapshot.threads.some((row) => row.id === "child-livech"), false);
    assert.equal(snapshot.threads.some((row) => row.id === "archived-one"), false);
    const labels = JSON.stringify(snapshot.threads.map((row) => ({ label: row.activityLabel, badges: row.badges })));
    assert.doesNotMatch(labels, /Ready to resume|Idle|Finished|Needs you/);
  } finally {
    api.dispose();
  }
});

test("one read serves overlapping callers", async () => {
  const api = reader({ cacheMs: 30_000 });
  try {
    const [a, b] = await Promise.all([api.snapshot(), api.snapshot()]);
    assert.equal(a.ok, true);
    assert.equal(b, a);
    assert.equal(api.stats().reads, 1);
    await api.snapshot();
    assert.equal(api.stats().reads, 1);
  } finally {
    api.dispose();
  }
});

test("the cap keeps priority threads and says when the list is cut", async () => {
  const file = path.join(tmp, "cap.sqlite");
  const db = openDb(file);
  const ins = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json) VALUES (?, ?, ?, ?, NULL, NULL, '{}')`);
  ins.run("old-running", null, "Old", "2026-01-01T00:00:00.000Z");
  ins.run("mid-idle", null, "Mid", "2026-06-01T00:00:00.000Z");
  ins.run("new-idle", null, "New", "2026-10-01T00:00:00.000Z");
  db.prepare(`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, status, requested_at, completed_at, payload_json) VALUES ('r', 'old-running', 1, 'running', '2026-10-21T18:00:00.000Z', NULL, '{}')`).run();
  db.close();
  const api = createGrouping({ statev2: file, envIdFile: envFile, cap: 2, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0 });
  try {
    const snapshot = await api.snapshot();
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    assert.equal(snapshot.coverage.eligible, 3);
    assert.equal(snapshot.coverage.returned, 2);
    assert.equal(snapshot.coverage.truncated, true);
    assert.equal(snapshot.coverage.cap, 2);
    const ids = snapshot.threads.map((row) => row.id);
    assert.equal(ids.includes("old-running"), true);
    assert.equal(ids.includes("mid-idle"), false);
  } finally {
    api.dispose();
  }
});

test("a missing database, a foreign schema, and a stuck worker fail closed", async () => {
  const missing = reader({ statev2: path.join(tmp, "nope.sqlite"), cacheMs: 0, failCacheMs: 0 });
  const gone = await missing.snapshot();
  missing.dispose();
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, "read");
  assert.equal(gone.threads, null);
  const emptyFile = path.join(tmp, "empty.sqlite");
  const emptyDb = new DatabaseSync(emptyFile);
  emptyDb.exec("CREATE TABLE nope (id INTEGER)");
  emptyDb.close();
  const schema = reader({ statev2: emptyFile });
  const bad = await schema.snapshot();
  schema.dispose();
  assert.equal(bad.reason, "schema");
  const hang = path.join(tmp, "hang.mjs");
  fs.writeFileSync(hang, `import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => {});\n`);
  const slow = reader({ workerUrl: pathToFileURL(hang), timeoutMs: 400, failCacheMs: 0 });
  const started = Date.now();
  const timed = await slow.snapshot();
  slow.dispose();
  assert.equal(timed.reason, "timeout");
  assert.ok(Date.now() - started < 3000);
});

test("the byte cap trims, then refuses a body that still does not fit", async () => {
  const worker = path.join(tmp, "fat.mjs");
  fs.writeFileSync(worker, `import { parentPort } from "node:worker_threads";
parentPort.on("message", ({ id }) => {
  const threads = [];
  for (let i = 0; i < 6; i++) threads.push({ id: "thread-" + i + "-aaaa", title: "T".repeat(80), projectId: null, createdAt: "2026-10-21T20:00:00.000Z" });
  parentPort.postMessage({ id, ok: true, total: 6, truncated: false, threads, projects: [], runs: [], pending: [], plans: [], approvals: [], links: [], activeSub: [], unknownSub: [], childLive: [], secrets: [], runStamps: [], requestStamps: [], childLinksTruncated: false });
});
`);
  const opts = { workerUrl: pathToFileURL(worker), statev2: fixture, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0 };
  const tiny = createGrouping({ ...opts, maxBytes: 1 });
  const refused = await tiny.snapshot();
  tiny.dispose();
  assert.equal(refused.reason, "budget");
  const mid = createGrouping({ ...opts, maxBytes: 1600 });
  const trimmed = await mid.snapshot();
  mid.dispose();
  assert.equal(trimmed.ok, true, JSON.stringify(trimmed));
  assert.equal(trimmed.coverage.truncated, true);
  assert.ok(trimmed.threads.length >= 1 && trimmed.threads.length < 6);
  const wide = createGrouping({ ...opts, maxBytes: 200000 });
  const all = await wide.snapshot();
  wide.dispose();
  assert.equal(all.threads.length, 6);
  assert.equal(all.coverage.truncated, false);
});

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
function spawnServer(dir, port, extraEnv) {
  const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
    env: {
      ...process.env, T3X_PORT: String(port), T3X_DIR: dir, T3X_HOME: path.join(tmp, "home"),
      T3X_STATEV2: fixture, T3X_ENV_ID_FILE: envFile, T3X_BURN_EVERY_MS: "999999999",
      T3X_LAB_USAGE: path.join(tmp, "lab-usage"), ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => String(chunk).includes("listening") && resolve());
    child.on("exit", (code) => reject(new Error(`server exited ${code}: ${output.join("")}`)));
  });
  return { child, ready, output };
}
function get(port, pathname, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
function copyServer(dir, { grouping }) {
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  for (const file of ["server.mjs", "lib.mjs", "history.mjs", "burn.mjs", "burn-core.mjs", "burn-sql-worker.mjs", "fonts.json"]) {
    fs.copyFileSync(path.join(SRC, file), path.join(dir, file));
  }
  if (grouping) {
    for (const file of ["grouping.mjs", "grouping-core.mjs", "grouping-sql-worker.mjs"]) fs.copyFileSync(path.join(SRC, file), path.join(dir, file));
    fs.copyFileSync(path.join(SRC, "public/grouping.js"), path.join(dir, "public/grouping.js"));
    fs.copyFileSync(path.join(SRC, "public/grouping.css"), path.join(dir, "public/grouping.css"));
    fs.copyFileSync(path.join(SRC, "public/extras.js"), path.join(dir, "public/extras.js"));
    fs.copyFileSync(path.join(SRC, "public/extras.css"), path.join(dir, "public/extras.css"));
  } else {
    fs.writeFileSync(path.join(dir, "public/extras.js"), "void 0;");
    fs.writeFileSync(path.join(dir, "public/extras.css"), "html{}");
  }
}

test("the service guards origin and serves the index without a caller-chosen file", async () => {
  const dir = path.join(tmp, "with-grouping");
  copyServer(dir, { grouping: true });
  const port = await freePort();
  const started = spawnServer(dir, port, {});
  await started.ready;
  try {
    assert.equal((await get(port, "/grouping")).status, 403);
    assert.equal((await get(port, "/grouping", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await get(port, "/grouping", { Host: `evil.example:${port}`, Origin: "t3code://app" })).status, 421);
    assert.equal((await get(port, "/grouping", { Origin: "t3code://app" }, "POST")).status, 405);
    const ok = await get(port, "/grouping", { Origin: "t3code://app" });
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.ok, true);
    assert.equal(byId(body, "parent-livech").activityLabel, "Child work recorded");
    assert.equal(ok.body.includes("SECRET_PROMPT_TEXT"), false);
    const weird = await get(port, "/grouping?file=/etc/passwd", { Origin: "t3code-dev://app" });
    const again = JSON.parse(weird.body);
    assert.deepEqual(again.threads.map((row) => row.id), body.threads.map((row) => row.id));
    assert.equal(weird.body.includes("/etc/passwd"), false);
    const js = await get(port, "/extras.js", { Origin: "t3code://app" });
    const extras = fs.readFileSync(path.join(SRC, "public/extras.js"), "utf8");
    assert.equal(js.body.startsWith(extras), true);
    assert.equal(js.body.includes("/* t3-extras grouping */"), true);
    const css = await get(port, "/extras.css", { Origin: "t3code://app" });
    assert.equal(css.body.startsWith(fs.readFileSync(path.join(SRC, "public/extras.css"), "utf8")), true);
    assert.equal(css.body.includes("data-t3x-grouping"), true);
  } finally {
    started.child.kill("SIGTERM");
  }
});

test("future and corrupt maxima do not hide an older valid run event", async () => {
  const file = path.join(tmp, "time.sqlite");
  const db = openDb(file);
  db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json)
    VALUES ('time-thread', NULL, 'Time', '2026-10-01T15:00:00.000Z', NULL, NULL, '{}')`).run();
  const run = db.prepare(`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, status, requested_at, completed_at, payload_json) VALUES (?, 'time-thread', ?, 'completed', ?, NULL, '{}')`);
  run.run("future", 2, "2026-10-21T23:05:00.000Z");
  run.run("valid", 1, "2026-10-21T22:55:00.000Z");
  run.run("corrupt", 3, "2026-10-21T99:99:99");
  run.run("lexical", 4, "9999-12-31T23:59:59.000Z");
  db.close();
  const api = createGrouping({ statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0 });
  try {
    const snapshot = await api.snapshot();
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    const row = byId(snapshot, "time-thread");
    assert.equal(row.activitySource, "run");
    assert.equal(row.recentBucket, "m15");
    assert.equal(row.activityAt, Date.parse("2026-10-21T22:55:00.000Z"));
  } finally {
    api.dispose();
  }
});

test("501 approvals and 2001 requests are not dropped by a raw row cap", async () => {
  const file = path.join(tmp, "caps.sqlite");
  const db = openDb(file);
  const thread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json) VALUES (?, NULL, ?, '2026-10-01T15:00:00.000Z', NULL, NULL, '{}')`);
  const approval = db.prepare(`INSERT INTO orchestration_v2_projection_nodes (thread_id, kind, status) VALUES (?, 'approval_request', 'pending')`);
  for (let i = 0; i < 501; i++) {
    const id = `cap-${String(i).padStart(4, "0")}`;
    thread.run(id, id);
    approval.run(id);
  }
  thread.run("req-a", "Requests");
  thread.run("req-b", "Live request");
  const req = db.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests
    (thread_id, kind, status, created_at, resolved_at, payload_json) VALUES (?, 'user_input', 'pending', '2026-10-21T22:00:00.000Z', NULL, ?)`);
  for (let i = 0; i < 2001; i++) req.run("req-a", JSON.stringify({ responseCapability: { type: "message" } }));
  req.run("req-b", JSON.stringify({ responseCapability: { type: "live" } }));
  db.close();
  const api = createGrouping({ statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0 });
  try {
    const snapshot = await api.snapshot();
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot.reason));
    assert.equal(snapshot.coverage.eligible, 503);
    assert.equal(snapshot.coverage.truncated, false);
    assert.equal(snapshot.coverage.factsIncomplete, false);
    const missed = snapshot.threads.filter((row) => row.id.startsWith("cap-") && row.activity !== "questions");
    assert.equal(missed.length, 0);
    const live = byId(snapshot, "req-b");
    assert.equal(live.activity, "questions");
    assert.ok(live.badges.includes("Recorded input or approval"));
    assert.equal(byId(snapshot, "req-a").activity, "questions");
  } finally {
    api.dispose();
  }
});

test("a wide node table stays inside the deadline when the live index exists", async () => {
  const file = path.join(tmp, "history.sqlite");
  const db = openDb(file);
  db.exec("ALTER TABLE orchestration_v2_projection_nodes ADD COLUMN payload_json TEXT");
  db.exec(`CREATE INDEX orchestration_v2_projection_nodes_live_idx
    ON orchestration_v2_projection_nodes(thread_id)
    WHERE status IN ('pending', 'starting', 'running', 'waiting')`);
  const thread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json) VALUES (?, NULL, ?, '2026-10-01T15:00:00.000Z', NULL, NULL, '{}')`);
  const ids = [];
  for (let i = 0; i < 40; i++) {
    const id = `hist-${String(i).padStart(3, "0")}`;
    ids.push(id);
    thread.run(id, id);
  }
  const node = db.prepare(`INSERT INTO orchestration_v2_projection_nodes (thread_id, kind, status, payload_json) VALUES (?, 'tool_call', 'completed', ?)`);
  const fat = JSON.stringify({ blob: "x".repeat(1800) });
  const pending = db.prepare(`INSERT INTO orchestration_v2_projection_nodes (thread_id, kind, status, payload_json) VALUES (?, 'approval_request', 'pending', '{}')`);
  db.exec("BEGIN");
  for (let i = 0; i < 8000; i++) node.run(ids[i % ids.length], fat);
  for (const id of ids) pending.run(id);
  db.exec("COMMIT");
  const json = JSON.stringify(ids);
  const legacyStarted = performance.now();
  db.prepare(`SELECT thread_id AS threadId FROM orchestration_v2_projection_nodes
    WHERE kind = 'approval_request' AND status NOT IN ('completed','cancelled','failed','interrupted')
      AND thread_id IN (SELECT value FROM json_each(?))
    LIMIT 500`).all(json);
  const legacyMs = performance.now() - legacyStarted;
  const indexedStarted = performance.now();
  const indexed = db.prepare(`SELECT thread_id AS threadId FROM orchestration_v2_projection_nodes
    INDEXED BY orchestration_v2_projection_nodes_live_idx
    WHERE status IN ('pending','starting','running','waiting') AND kind = 'approval_request'
      AND thread_id IN (SELECT value FROM json_each(?))`).all(json);
  const indexedMs = performance.now() - indexedStarted;
  db.close();
  assert.equal(indexed.length, 40);
  assert.ok(indexedMs < legacyMs, `indexed ${indexedMs.toFixed(1)}ms legacy ${legacyMs.toFixed(1)}ms`);
  const api = createGrouping({ statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0, profile: true });
  const started = Date.now();
  try {
    const snapshot = await api.snapshot();
    const elapsed = Date.now() - started;
    assert.equal(snapshot.ok, true, JSON.stringify({ reason: snapshot.reason, elapsed, timings: snapshot.timings }));
    assert.ok(elapsed < 2000, `snapshot ${elapsed}ms`);
    assert.equal(snapshot.threads.every((row) => row.activity === "questions"), true);
    assert.equal(snapshot.coverage.factsIncomplete, false);
    fs.writeFileSync(path.join(os.homedir(), "Library/Caches/t3-sidebar-groups/evidence-history.json"), JSON.stringify({ legacyMs, indexedMs, elapsed, timings: snapshot.timings, bootMs: snapshot.bootMs }));
  } finally {
    api.dispose();
  }
});

test("a server copy without the grouping files still serves extras and an unavailable index", async () => {
  const dir = path.join(tmp, "without-grouping");
  copyServer(dir, { grouping: false });
  const port = await freePort();
  const started = spawnServer(dir, port, { T3X_STATEV2: path.join(tmp, "nope.sqlite") });
  await started.ready;
  try {
    const js = await get(port, "/extras.js", { Origin: "t3code://app" });
    assert.equal(js.body, "void 0;");
    const index = await get(port, "/grouping", { Origin: "t3code://app" });
    assert.equal(index.status, 200);
    const body = JSON.parse(index.body);
    assert.equal(body.ok, false);
    assert.equal(body.reason, "missing");
    assert.equal(body.threads, null);
  } finally {
    started.child.kill("SIGTERM");
  }
});

function signature(snapshot) {
  return Object.fromEntries(snapshot.threads.map((row) => [row.id, {
    activity: row.activity,
    shelf: row.shelf,
    settled: row.badges.includes("Settled recorded"),
  }]));
}

function buildApprovalFixture(file, indexSql) {
  const db = openDb(file);
  const thread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json) VALUES (?, NULL, ?, '2026-10-01T15:00:00.000Z', NULL, NULL, ?)`);
  const node = db.prepare(`INSERT INTO orchestration_v2_projection_nodes (thread_id, kind, status) VALUES (?, 'approval_request', ?)`);
  const cases = [
    ["ap-active", "active", "{}"],
    ["ap-mystery", "mystery", "{}"],
    ["ap-null", null, "{}"],
    ["ap-starting", "starting", "{}"],
    ["ap-pending", "pending", "{}"],
    ["ap-waiting", "waiting", "{}"],
    ["ap-running", "running", "{}"],
    ["ap-done", "completed", "{}"],
    ["ap-settled-active", "active", JSON.stringify({ settledOverride: "settled" })],
    ["ap-settled-mystery", "mystery", JSON.stringify({ settledOverride: "settled" })],
    ["ap-settled-done", "completed", JSON.stringify({ settledOverride: "settled" })],
  ];
  for (const [id, status, payload] of cases) {
    thread.run(id, id, payload);
    node.run(id, status);
  }
  if (indexSql) db.exec(indexSql);
  db.close();
}

test("approval classification matches with and without the live partial index", async () => {
  const plain = path.join(tmp, "approval-plain.sqlite");
  const indexed = path.join(tmp, "approval-indexed.sqlite");
  const liveIndex = `CREATE INDEX orchestration_v2_projection_nodes_live_idx
    ON orchestration_v2_projection_nodes(thread_id)
    WHERE status IN ('pending', 'starting', 'running', 'waiting')`;
  buildApprovalFixture(plain);
  buildApprovalFixture(indexed, liveIndex);
  const read = async (file) => {
    const api = createGrouping({ statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0 });
    try {
      return await api.snapshot();
    } finally {
      api.dispose();
    }
  };
  const without = await read(plain);
  const withIndex = await read(indexed);
  assert.equal(without.ok, true, JSON.stringify(without.reason));
  assert.equal(withIndex.ok, true, JSON.stringify(withIndex.reason));
  assert.equal(without.coverage.factsIncomplete, false);
  assert.equal(withIndex.coverage.factsIncomplete, false);
  assert.deepEqual(signature(withIndex), signature(without));
  const row = (snapshot, id) => byId(snapshot, id);
  assert.equal(row(without, "ap-active").activity, "questions");
  assert.equal(row(without, "ap-mystery").activity, "unknown");
  assert.equal(row(without, "ap-null").activity, "unknown");
  assert.equal(row(without, "ap-starting").activity, "unknown");
  assert.equal(row(without, "ap-pending").activity, "questions");
  assert.equal(row(without, "ap-waiting").activity, "questions");
  assert.equal(row(without, "ap-running").activity, "questions");
  assert.equal(row(without, "ap-done").activity, "open");
  assert.equal(row(without, "ap-settled-active").shelf, "main");
  assert.equal(row(without, "ap-settled-active").activity, "questions");
  assert.equal(row(without, "ap-settled-mystery").activity, "unknown");
  assert.notEqual(row(without, "ap-settled-mystery").shelf, "settled");
  assert.equal(row(without, "ap-settled-done").shelf, "settled");
});

test("a narrower live index does not prove an active approval is absent", async () => {
  const file = path.join(tmp, "approval-narrow.sqlite");
  buildApprovalFixture(file, `CREATE INDEX orchestration_v2_projection_nodes_live_idx
    ON orchestration_v2_projection_nodes(thread_id)
    WHERE status = 'pending'`);
  const api = createGrouping({ statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0, profile: true });
  try {
    const snapshot = await api.snapshot();
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot.reason));
    assert.equal(byId(snapshot, "ap-active").activity, "questions");
    assert.notEqual(byId(snapshot, "ap-active").activity, "open");
    assert.equal(snapshot.coverage.factsIncomplete, false);
    assert.equal(snapshot.scan.approvalsMode === "unindexed", false);
  } finally {
    api.dispose();
  }
});

test("a newer request wins the timestamp, and milliseconds stay intact", async () => {
  const file = path.join(tmp, "stamp-source.sqlite");
  const db = openDb(file);
  const thread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json)
    VALUES (?, NULL, ?, '2026-10-01T15:00:00.000Z', NULL, NULL, '{}')`);
  const run = db.prepare(`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, status, requested_at, completed_at, payload_json) VALUES (?, ?, 1, 'completed', ?, NULL, '{}')`);
  const req = db.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests
    (thread_id, kind, status, created_at, resolved_at, payload_json) VALUES (?, 'user_input', 'resolved', ?, NULL, '{}')`);
  thread.run("src-request", "Request wins");
  run.run("src-run", "src-request", "2026-10-21T22:00:00.100Z");
  req.run("src-request", "2026-10-21T22:55:00.600Z");
  thread.run("src-offset", "Offset");
  run.run("off-run", "src-offset", "2026-10-21T21:00:00.000Z");
  req.run("src-offset", "2026-10-21T18:55:00.250-04:00");
  thread.run("src-edge", "Inside skew");
  run.run("edge-run", "src-edge", "2026-10-21T23:01:59.500Z");
  thread.run("src-over", "Past skew");
  run.run("over-new", "src-over", "2026-10-21T23:02:00.001Z");
  run.run("over-old", "src-over", "2026-10-21T22:00:00.000Z");
  thread.run("src-space", "Space form");
  run.run("space-run", "src-space", "2026-10-21 22:59:00");
  db.close();
  const api = createGrouping({ statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0 });
  try {
    const snapshot = await api.snapshot();
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot.reason));
    const request = byId(snapshot, "src-request");
    assert.equal(request.activitySource, "request");
    assert.equal(request.activityAt, Date.parse("2026-10-21T22:55:00.600Z"));
    const offset = byId(snapshot, "src-offset");
    assert.equal(offset.activitySource, "request");
    assert.equal(offset.activityAt, Date.parse("2026-10-21T18:55:00.250-04:00"));
    const edge = byId(snapshot, "src-edge");
    assert.equal(edge.activitySource, "run");
    assert.equal(edge.activityAt, Date.parse("2026-10-21T23:01:59.500Z"));
    const over = byId(snapshot, "src-over");
    assert.equal(over.activitySource, "run");
    assert.equal(over.activityAt, Date.parse("2026-10-21T22:00:00.000Z"));
    const space = byId(snapshot, "src-space");
    assert.equal(space.activitySource, "created");
    assert.equal(space.activityAt, Date.parse("2026-10-01T15:00:00.000Z"));
  } finally {
    api.dispose();
  }
});

test("a late chunk returns the checkpoint before 2s and does not call an unfinished thread open", async () => {
  const file = path.join(tmp, "late-chunk.sqlite");
  const db = openDb(file);
  db.exec("ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN ordinal INTEGER");
  db.exec("ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN turn_item_id TEXT");
  db.exec(`CREATE INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id)`);
  db.prepare(`INSERT INTO projection_projects (project_id, title, deleted_at, workspace_root) VALUES ('proj-large', 'Large', NULL, '/tmp/SECRET_PATH')`).run();
  const thread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json)
    VALUES (?, 'proj-large', ?, '2026-10-01T15:00:00.000Z', NULL, NULL, '{}')`);
  const item = db.prepare(`INSERT INTO orchestration_v2_projection_turn_items
    (thread_id, type, status, payload_json, ordinal, turn_item_id) VALUES (?, ?, ?, ?, ?, ?)`);
  const fat = JSON.stringify({ blob: `SECRET_PAYLOAD_BLOB${"x".repeat(1500)}` });
  for (const id of ["a-empty", "b-quiet", "c-positive", "d-partial", "e-later", "f-noise"]) thread.run(id, id);
  item.run("b-quiet", "note", "done", fat, 0, "b-0");
  item.run("b-quiet", "note", "done", fat, 1, "b-1");
  item.run("c-positive", "secret_request", "waiting", fat, 0, "c-0");
  db.exec("BEGIN");
  for (let i = 0; i < 800; i++) {
    const secret = i === 700;
    item.run("d-partial", secret ? "secret_request" : "note", secret ? "waiting" : "done", fat, i, `d-${i}`);
  }
  item.run("e-later", "secret_request", "waiting", fat, 0, "e-0");
  for (let i = 0; i < 2500; i++) item.run("f-noise", "note", "done", fat, i, `f-${i}`);
  db.exec("COMMIT");
  db.close();
  let stall = { family: "secrets", afterChunks: 4, ms: 5000 };
  const api = createGrouping({
    statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0,
    timeoutMs: 2000, profile: true, stall: () => {
      const current = stall;
      stall = null;
      return current;
    },
  });
  const started = Date.now();
  try {
    const partial = await api.snapshot();
    const elapsed = Date.now() - started;
    assert.equal(partial.ok, true, JSON.stringify({ reason: partial.reason, elapsed }));
    assert.ok(elapsed < 3500, `checkpoint ${elapsed}ms`);
    assert.ok(elapsed >= 1500, `returned too early ${elapsed}ms`);
    assert.equal(partial.scan.secretsMode, "turn-ordinal");
    assert.equal(partial.scan.secretsVisited, 3 + partial.scan.chunk);
    assert.equal(partial.coverage.factsIncomplete, true);
    assert.equal(byId(partial, "a-empty").activity, "open");
    assert.equal(byId(partial, "b-quiet").activity, "open");
    assert.equal(byId(partial, "c-positive").activity, "questions");
    assert.ok(byId(partial, "c-positive").badges.includes("Recorded secret request"));
    assert.equal(byId(partial, "d-partial").activity, "unknown");
    assert.notEqual(byId(partial, "d-partial").activity, "open");
    assert.equal(byId(partial, "e-later").activity, "unknown");
    assert.equal(byId(partial, "a-empty").projectLabel, "Large");
    assert.equal(byId(partial, "a-empty").activitySource, "created");
    assert.equal(byId(partial, "a-empty").recentBucket, "older");
    assert.equal(JSON.stringify(partial).includes("SECRET_PAYLOAD_BLOB"), false);
    assert.equal(JSON.stringify(partial).includes("SECRET_PATH"), false);
    const fullApi = createGrouping({
      statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0, timeoutMs: 20000, profile: true,
    });
    try {
      const coldStarted = Date.now();
      const cold = await fullApi.snapshot();
      const coldMs = Date.now() - coldStarted;
      const warmStarted = Date.now();
      const warm = await fullApi.snapshot();
      const warmMs = Date.now() - warmStarted;
      assert.equal(cold.ok && warm.ok, true, JSON.stringify({ cold: cold.reason, warm: warm.reason, coldMs, warmMs }));
      assert.equal(cold.coverage.factsIncomplete, false);
      assert.equal(warm.coverage.factsIncomplete, false);
      assert.equal(byId(cold, "d-partial").activity, "questions");
      assert.equal(byId(cold, "e-later").activity, "questions");
      assert.equal(byId(cold, "a-empty").activity, "open");
      assert.equal(byId(cold, "f-noise").activity, "open");
      assert.equal(cold.scan.secretsVisited, 2 + 1 + 800 + 1 + 2500);
      assert.equal(JSON.stringify(cold).includes("SECRET_PAYLOAD_BLOB"), false);
      fs.writeFileSync(path.join(os.homedir(), "Library/Caches/t3-sidebar-groups/evidence-fix-grok-2-history.json"), JSON.stringify({
        checkpointMs: elapsed, secretsVisited: partial.scan.secretsVisited, chunk: partial.scan.chunk, coldMs, warmMs,
        coldVisited: cold.scan.secretsVisited, warmVisited: warm.scan.secretsVisited,
      }));
    } finally {
      fullApi.dispose();
    }
  } finally {
    api.dispose();
  }
});

test("a stale worker callback cannot replace the checkpoint or the next read", async () => {
  const workerFile = path.join(tmp, "stall-worker.mjs");
  const base = {
    total: 1, truncated: false, projects: [{ id: "proj-a", title: "Alpha", deleted: 0 }],
    runs: [], pending: [], plans: [], approvals: [], activeSub: [], unknownSub: [], secrets: [],
    runStamps: [], requestStamps: [], childLinksTruncated: false,
    factsIncomplete: { approvals: false, pending: false, plans: false, liveRuns: false, child: false, secrets: false },
  };
  const thread = (id) => ({
    id, title: id, projectId: "proj-a", createdAt: "2026-10-01T15:00:00.000Z",
    settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, pinnedAt: null, limitRunId: null,
  });
  fs.writeFileSync(workerFile, `import { parentPort } from "node:worker_threads";
const base = ${JSON.stringify(base)};
const thread = (id) => (${JSON.stringify(thread("x")).replace('"x"', "id")});
parentPort.on("message", (message) => {
  if (message.stall) {
    parentPort.postMessage({ id: message.id, checkpoint: true, ...base, threads: [thread("kept-thread")],
      incompleteIds: { approvals: [], pending: [], plans: [], liveRuns: [], child: [], secrets: ["kept-thread"] } });
    setTimeout(() => {
      parentPort.postMessage({ id: message.id, ok: true, ...base, threads: [thread("poison-thread")],
        incompleteIds: { approvals: [], pending: [], plans: [], liveRuns: [], child: [], secrets: [] } });
    }, 4000);
    return;
  }
  parentPort.postMessage({ id: message.id, ok: true, ...base, threads: [thread("clean-thread")],
    incompleteIds: { approvals: [], pending: [], plans: [], liveRuns: [], child: [], secrets: [] } });
});
`);
  let once = true;
  const api = createGrouping({
    statev2: fixture, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0,
    timeoutMs: 2000, workerUrl: pathToFileURL(workerFile),
    stall: () => {
      if (!once) return null;
      once = false;
      return { family: "secrets", afterChunks: 1, ms: 5000 };
    },
  });
  const started = Date.now();
  try {
    const first = await api.snapshot();
    const elapsed = Date.now() - started;
    assert.equal(first.ok, true, JSON.stringify(first.reason));
    assert.ok(elapsed >= 1500 && elapsed < 3000, `protocol ${elapsed}ms`);
    assert.equal(byId(first, "kept-thread").activity, "unknown");
    assert.equal(byId(first, "kept-thread").projectLabel, "Alpha");
    assert.equal(byId(first, "poison-thread"), undefined);
    const second = await api.snapshot();
    assert.equal(second.ok, true, JSON.stringify(second.reason));
    assert.equal(byId(second, "clean-thread").activity, "open");
    assert.equal(byId(second, "poison-thread"), undefined);
    assert.equal(byId(second, "kept-thread"), undefined);
  } finally {
    api.dispose();
  }
});

function latencyWorker(name, pauseLine) {
  const original = fs.readFileSync(path.join(SRC, "grouping-sql-worker.mjs"), "utf8");
  const token = "      const rows = cursor == null\n";
  assert.equal(original.includes(token), true);
  assert.equal(original.split(token).length, 2);
  const patched = original.replace(token, `      ${pauseLine}\n${token}`);
  assert.equal(patched.split("postMessage").length, original.split("postMessage").length);
  assert.equal(patched.includes("reviewWitness"), false);
  const file = path.join(tmp, name);
  fs.writeFileSync(file, patched);
  return file;
}

test("a slow later secret page keeps the production checkpoint without a test publication", async () => {
  const file = path.join(tmp, "latency-secrets.sqlite");
  const db = openDb(file);
  db.exec("ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN ordinal INTEGER");
  db.exec("ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN turn_item_id TEXT");
  db.exec(`CREATE INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id)`);
  db.prepare(`INSERT INTO projection_projects (project_id, title, deleted_at, workspace_root) VALUES ('proj-lat', 'Latency', NULL, '/tmp/SECRET_PATH')`).run();
  const thread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json)
    VALUES (?, 'proj-lat', ?, '2026-10-01T15:00:00.000Z', NULL, NULL, '{}')`);
  const item = db.prepare(`INSERT INTO orchestration_v2_projection_turn_items
    (thread_id, type, status, payload_json, ordinal, turn_item_id) VALUES (?, ?, ?, '{}', ?, ?)`);
  for (const id of ["a-empty", "b-positive", "c-partial", "d-later"]) thread.run(id, id);
  item.run("b-positive", "secret_request", "waiting", 0, "b-0");
  for (let i = 0; i < 1000; i++) item.run("c-partial", "note", "done", i, `c-${i}`);
  item.run("d-later", "secret_request", "waiting", 0, "d-0");
  db.close();
  const api = createGrouping({
    statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0,
    timeoutMs: 2000, profile: true, workerUrl: pathToFileURL(latencyWorker("latency-secret-worker.mjs", 'if (threadId === "c-partial" && cursor != null) pause(5000);')),
  });
  const started = Date.now();
  try {
    const partial = await api.snapshot();
    const elapsed = Date.now() - started;
    assert.equal(partial.ok, true, JSON.stringify({ reason: partial.reason, elapsed }));
    assert.ok(elapsed >= 1500 && elapsed < 3500, `secret checkpoint ${elapsed}ms`);
    assert.equal(partial.scan.secretsMode, "turn-ordinal");
    assert.equal(partial.coverage.factsIncomplete, true);
    assert.equal(partial.coverage.questionsUnread, true);
    assert.equal(byId(partial, "a-empty").activity, "open");
    assert.equal(byId(partial, "a-empty").projectLabel, "Latency");
    assert.equal(byId(partial, "b-positive").activity, "questions");
    assert.ok(byId(partial, "b-positive").badges.includes("Recorded secret request"));
    assert.equal(byId(partial, "c-partial").activity, "unknown");
    assert.notEqual(byId(partial, "c-partial").activity, "open");
    assert.equal(byId(partial, "d-later").activity, "unknown");
    assert.equal(byId(partial, "d-later").badges.includes("Recorded secret request"), false);
    assert.equal(JSON.stringify(partial).includes("SECRET_PATH"), false);
  } finally {
    api.dispose();
  }
});

test("a slow later approval page keeps the live seed after the empty thread is enumerated", async () => {
  const file = path.join(tmp, "latency-approvals.sqlite");
  const db = openDb(file);
  db.exec("ALTER TABLE orchestration_v2_projection_nodes ADD COLUMN run_id TEXT");
  db.exec("CREATE INDEX nodes_thread_run_idx ON orchestration_v2_projection_nodes(thread_id, run_id)");
  db.exec(`CREATE INDEX orchestration_v2_projection_nodes_live_idx
    ON orchestration_v2_projection_nodes(thread_id)
    WHERE status IN ('pending', 'starting', 'running', 'waiting')`);
  db.prepare(`INSERT INTO projection_projects (project_id, title, deleted_at, workspace_root) VALUES ('proj-lat', 'Latency', NULL, '/tmp/SECRET_PATH')`).run();
  const thread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json)
    VALUES (?, 'proj-lat', ?, '2026-10-01T15:00:00.000Z', NULL, NULL, '{}')`);
  const node = db.prepare(`INSERT INTO orchestration_v2_projection_nodes (thread_id, kind, status, run_id) VALUES (?, ?, ?, ?)`);
  for (const id of ["a-empty", "b-seed", "c-bulk", "d-later"]) thread.run(id, id);
  node.run("b-seed", "approval_request", "waiting", "seed");
  for (let i = 0; i < 500; i++) node.run("c-bulk", "tool_call", "completed", `n${String(i).padStart(4, "0")}`);
  node.run("d-later", "approval_request", "active", "later");
  db.close();
  const api = createGrouping({
    statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0,
    timeoutMs: 2000, profile: true, workerUrl: pathToFileURL(latencyWorker("latency-approval-worker.mjs", 'if (threadId === "c-bulk" && cursor != null) pause(5000);')),
  });
  const started = Date.now();
  try {
    const partial = await api.snapshot();
    const elapsed = Date.now() - started;
    assert.equal(partial.ok, true, JSON.stringify({ reason: partial.reason, elapsed, mode: partial.scan?.approvalsMode }));
    assert.ok(elapsed >= 1500 && elapsed < 3500, `approval checkpoint ${elapsed}ms`);
    assert.equal(partial.scan.approvalsMode, "node-run");
    assert.equal(partial.scan.approvalsLeft, 2);
    assert.equal(partial.scan.secretsLeft, 4);
    assert.equal(partial.coverage.factsIncomplete, true);
    assert.equal(partial.coverage.questionsUnread, true);
    // Secret rows are still unread, so the enumerated empty thread stays unknown. Its approval walk is finished.
    assert.equal(byId(partial, "a-empty").activity, "unknown");
    assert.equal(byId(partial, "a-empty").badges.includes("Recorded approval request"), false);
    assert.equal(byId(partial, "b-seed").activity, "unknown");
    assert.ok(byId(partial, "b-seed").badges.includes("Recorded approval request"));
    assert.equal(byId(partial, "c-bulk").activity, "unknown");
    assert.equal(byId(partial, "d-later").activity, "unknown");
    assert.equal(byId(partial, "d-later").badges.includes("Recorded approval request"), false);
    assert.equal(JSON.stringify(partial).includes("SECRET_PATH"), false);
  } finally {
    api.dispose();
  }
});

function stampFixture(file, withRequest) {
  const db = openDb(file);
  db.prepare(`INSERT INTO projection_projects (project_id, title, deleted_at, workspace_root) VALUES ('proj-lat', 'Latency', NULL, '/tmp/SECRET_PATH')`).run();
  db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json)
    VALUES ('stamp-run', 'proj-lat', 'Stamp run', '2026-10-01T15:00:00.000Z', NULL, NULL, '{}')`).run();
  db.prepare(`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, status, requested_at, completed_at, payload_json)
    VALUES ('r1', 'stamp-run', 1, 'completed', '2026-10-21T22:00:00.000Z', '2026-10-21T22:56:00.000Z', '{}')`).run();
  if (withRequest) {
    db.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests
      (thread_id, kind, status, created_at, resolved_at, payload_json)
      VALUES ('stamp-run', 'user_input', 'resolved', '2026-10-21T22:59:00.000Z', NULL, '{}')`).run();
  }
  db.close();
}

test("a stalled run-time read does not become created or Older", async () => {
  const file = path.join(tmp, "stall-run-stamp.sqlite");
  stampFixture(file, false);
  const api = createGrouping({
    statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0,
    timeoutMs: 2000, profile: true, stall: () => ({ family: "runStamps", ms: 5000 }),
  });
  const started = Date.now();
  try {
    const partial = await api.snapshot();
    const elapsed = Date.now() - started;
    assert.equal(partial.ok, true, JSON.stringify({ reason: partial.reason, elapsed }));
    assert.ok(elapsed >= 1500 && elapsed < 3500, `run timing ${elapsed}ms`);
    const row = byId(partial, "stamp-run");
    assert.equal(row.projectLabel, "Latency");
    assert.equal(row.activitySource, "unavailable");
    assert.equal(row.recentBucket, "unread");
    assert.notEqual(row.activitySource, "created");
    assert.notEqual(row.recentBucket, "older");
    assert.notEqual(row.activityAt, Date.parse("2026-10-01T15:00:00.000Z"));
  } finally {
    api.dispose();
  }
});

test("a stalled request-time read stays observed and is not a verified latest event", async () => {
  const file = path.join(tmp, "stall-request-stamp.sqlite");
  stampFixture(file, true);
  const api = createGrouping({
    statev2: file, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0,
    timeoutMs: 2000, profile: true, stall: () => ({ family: "requestStamps", ms: 5000 }),
  });
  const started = Date.now();
  try {
    const partial = await api.snapshot();
    const elapsed = Date.now() - started;
    assert.equal(partial.ok, true, JSON.stringify({ reason: partial.reason, elapsed }));
    assert.ok(elapsed >= 1500 && elapsed < 3500, `request timing ${elapsed}ms`);
    const row = byId(partial, "stamp-run");
    assert.equal(row.projectLabel, "Latency");
    assert.equal(row.activitySource, "observed");
    assert.equal(row.activityAt, Date.parse("2026-10-21T22:56:00.000Z"));
    assert.equal(row.recentBucket, "unread");
    assert.notEqual(row.activitySource, "request");
    assert.notEqual(row.activitySource, "run");
    assert.notEqual(row.activitySource, "created");
    assert.notEqual(row.recentBucket, "m15");
    assert.notEqual(row.recentBucket, "older");
    assert.notEqual(row.activityAt, Date.parse("2026-10-21T22:59:00.000Z"));
  } finally {
    api.dispose();
  }
});

function phaseWorker(name, token) {
  const original = fs.readFileSync(path.join(SRC, "grouping-sql-worker.mjs"), "utf8");
  assert.equal(original.split(token).length, 2, token);
  const patched = original.replace(token, `  pause(5000);\n${token}`);
  assert.equal(patched.split("postMessage").length, original.split("postMessage").length);
  assert.equal(patched.includes("reviewWitness"), false);
  const file = path.join(tmp, name);
  fs.writeFileSync(file, patched);
  return file;
}

function phaseThreads(db, ids) {
  const thread = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json)
    VALUES (?, 'proj-lat', ?, '2026-10-01T15:00:00.000Z', NULL, NULL, '{}')`);
  for (const id of ids) thread.run(id, id);
}

function phaseDb(file) {
  const db = openDb(file);
  db.prepare(`INSERT INTO projection_projects (project_id, title, deleted_at, workspace_root) VALUES ('proj-lat', 'Latency', NULL, '/tmp/SECRET_PATH')`).run();
  return db;
}

function readCheckpoints(workerFile, dbFile) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(workerFile));
    const checkpoints = [];
    const timer = setTimeout(() => {
      worker.terminate().then(() => resolve(checkpoints), reject);
    }, 2200);
    worker.on("message", (message) => {
      if (message?.checkpoint) checkpoints.push(message);
    });
    worker.on("error", (error) => {
      clearTimeout(timer);
      worker.terminate();
      reject(error);
    });
    worker.postMessage({ id: 1, file: dbFile, cap: 1000, nowMs: NOW });
  });
}

async function phaseSnapshot(workerFile, dbFile) {
  const api = createGrouping({
    statev2: dbFile, envIdFile: envFile, now: () => NOW, timeZone: TZ, cacheMs: 0, failCacheMs: 0,
    timeoutMs: 2000, profile: true, workerUrl: pathToFileURL(workerFile),
  });
  const started = Date.now();
  try {
    const partial = await api.snapshot();
    return { partial, elapsed: Date.now() - started };
  } finally {
    api.dispose();
  }
}

test("a slow later live-run query keeps the latest run and does not clear live absence", async () => {
  const file = path.join(tmp, "latency-live-run.sqlite");
  const db = phaseDb(file);
  phaseThreads(db, ["b-run", "quiet", "older-live"]);
  const run = db.prepare(`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, status, requested_at, completed_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, '{}')`);
  run.run("b1", "b-run", 1, "running", "2026-10-21T22:50:00.000Z", null);
  run.run("o2", "older-live", 2, "completed", "2026-10-21T22:30:00.000Z", "2026-10-21T22:40:00.000Z");
  run.run("o1", "older-live", 1, "running", "2026-10-21T22:10:00.000Z", null);
  db.close();
  const workerFile = phaseWorker("latency-live-run-worker.mjs", "  const ranLive = budget();\n");
  const [checkpoints, snap] = await Promise.all([
    readCheckpoints(workerFile, file),
    phaseSnapshot(workerFile, file),
  ]);
  const last = checkpoints.at(-1);
  assert.ok(last, "no checkpoint before the live query");
  assert.equal(last.runs.some((row) => row.threadId === "b-run" && row.status === "running"), true);
  assert.equal(last.runs.some((row) => row.threadId === "older-live" && row.status === "running"), false);
  assert.equal(last.incompleteIds.liveRuns.includes("quiet"), true);
  assert.equal(last.incompleteIds.liveRuns.includes("older-live"), true);
  assert.equal(last.factsIncomplete.liveRuns, false);
  assert.equal(last.incompleteIds.pending.includes("b-run"), true);
  const { partial, elapsed } = snap;
  assert.equal(partial.ok, true, JSON.stringify({ reason: partial.reason, elapsed }));
  assert.ok(elapsed >= 1500 && elapsed < 3500, `run boundary ${elapsed}ms`);
  assert.equal(partial.coverage.factsIncomplete, true);
  assert.equal(partial.coverage.questionsUnread, true);
  assert.equal(byId(partial, "b-run").activity, "unknown");
  assert.equal(byId(partial, "b-run").badges.includes("Run recorded"), true);
  assert.equal(byId(partial, "quiet").activity, "unknown");
  assert.equal(byId(partial, "quiet").badges.includes("Run recorded"), false);
  assert.notEqual(byId(partial, "quiet").activity, "open");
  assert.equal(byId(partial, "older-live").activity, "unknown");
  assert.equal(byId(partial, "older-live").badges.includes("Run recorded"), false);
  assert.equal(JSON.stringify(partial).includes("SECRET_PATH"), false);
});

test("a slow plan query keeps the pending request and the earlier run", async () => {
  const file = path.join(tmp, "latency-pending-plan.sqlite");
  const db = phaseDb(file);
  phaseThreads(db, ["b-ask", "b-run", "quiet"]);
  db.prepare(`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, status, requested_at, completed_at, payload_json)
    VALUES ('b1', 'b-run', 1, 'running', '2026-10-21T22:50:00.000Z', NULL, '{}')`).run();
  db.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests
    (thread_id, kind, status, created_at, resolved_at, payload_json)
    VALUES ('b-ask', 'user_input', 'pending', '2026-10-21T22:55:00.000Z', NULL, ?)`).run(JSON.stringify({ responseCapability: { type: "live" } }));
  db.close();
  const workerFile = phaseWorker("latency-pending-plan-worker.mjs", "  const plansLoad = budget() ? timed(\"plans\", () => loadPlans(db, json)) : null;\n");
  const [checkpoints, snap] = await Promise.all([
    readCheckpoints(workerFile, file),
    phaseSnapshot(workerFile, file),
  ]);
  const last = checkpoints.at(-1);
  assert.ok(last, "no checkpoint before the plan query");
  assert.equal(last.pending.some((row) => row.threadId === "b-ask" && row.capability === "live"), true);
  assert.equal(last.runs.some((row) => row.threadId === "b-run" && row.status === "running"), true);
  assert.deepEqual(last.incompleteIds.pending, []);
  assert.equal(last.plans.length, 0);
  assert.equal(last.incompleteIds.plans.includes("quiet"), true);
  const { partial, elapsed } = snap;
  assert.equal(partial.ok, true, JSON.stringify({ reason: partial.reason, elapsed }));
  assert.ok(elapsed >= 1500 && elapsed < 3500, `pending boundary ${elapsed}ms`);
  assert.equal(partial.coverage.factsIncomplete, true);
  assert.equal(partial.coverage.questionsUnread, true);
  assert.equal(byId(partial, "b-ask").activity, "unknown");
  assert.equal(byId(partial, "b-ask").badges.includes("Recorded input or approval"), true);
  assert.equal(byId(partial, "b-run").activity, "unknown");
  assert.equal(byId(partial, "b-run").badges.includes("Run recorded"), true);
  assert.equal(byId(partial, "quiet").activity, "unknown");
  assert.equal(byId(partial, "quiet").badges.includes("Recorded input or approval"), false);
  assert.notEqual(byId(partial, "quiet").activity, "open");
  assert.equal(JSON.stringify(partial).includes("SECRET_PATH"), false);
});

test("a slow child query keeps the plan and the pending request", async () => {
  const file = path.join(tmp, "latency-plan-child.sqlite");
  const db = phaseDb(file);
  phaseThreads(db, ["b-plan", "b-ask", "quiet"]);
  db.prepare(`INSERT INTO orchestration_v2_projection_plans (thread_id, kind, status) VALUES ('b-plan', 'proposed_plan', 'active')`).run();
  db.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests
    (thread_id, kind, status, created_at, resolved_at, payload_json)
    VALUES ('b-ask', 'user_input', 'pending', '2026-10-21T22:55:00.000Z', NULL, ?)`).run(JSON.stringify({ responseCapability: { type: "live" } }));
  db.close();
  const workerFile = phaseWorker("latency-plan-child-worker.mjs", "  const childLoad = budget() ? timed(\"child\", () => loadChild(db, json)) : null;\n");
  const [checkpoints, snap] = await Promise.all([
    readCheckpoints(workerFile, file),
    phaseSnapshot(workerFile, file),
  ]);
  const last = checkpoints.at(-1);
  assert.ok(last, "no checkpoint before the child query");
  assert.equal(last.plans.some((row) => row.threadId === "b-plan" && row.kind === "proposed_plan"), true);
  assert.equal(last.pending.some((row) => row.threadId === "b-ask" && row.capability === "live"), true);
  assert.deepEqual(last.incompleteIds.plans, []);
  assert.deepEqual(last.incompleteIds.pending, []);
  assert.equal(last.activeSub.includes("b-plan"), false);
  assert.equal(last.incompleteIds.child.includes("quiet"), true);
  const { partial, elapsed } = snap;
  assert.equal(partial.ok, true, JSON.stringify({ reason: partial.reason, elapsed }));
  assert.ok(elapsed >= 1500 && elapsed < 3500, `plan boundary ${elapsed}ms`);
  assert.equal(partial.coverage.factsIncomplete, true);
  assert.equal(partial.coverage.questionsUnread, true);
  assert.equal(byId(partial, "b-plan").activity, "unknown");
  assert.equal(byId(partial, "b-plan").badges.includes("Recorded proposed plan"), true);
  assert.equal(byId(partial, "b-ask").activity, "unknown");
  assert.equal(byId(partial, "b-ask").badges.includes("Recorded input or approval"), true);
  assert.equal(byId(partial, "quiet").activity, "unknown");
  assert.equal(byId(partial, "quiet").badges.includes("Recorded proposed plan"), false);
  assert.notEqual(byId(partial, "quiet").activity, "open");
  assert.equal(JSON.stringify(partial).includes("SECRET_PATH"), false);
});

test("a slow approval query keeps the recorded child and does not invent the later approval", async () => {
  const file = path.join(tmp, "latency-child-approval.sqlite");
  const db = phaseDb(file);
  phaseThreads(db, ["b-child", "quiet", "d-later"]);
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, status) VALUES ('b-child', 'b-child-sub', 'running')`).run();
  db.prepare(`INSERT INTO orchestration_v2_projection_nodes (thread_id, kind, status) VALUES ('d-later', 'approval_request', 'pending')`).run();
  db.close();
  const workerFile = phaseWorker("latency-child-approval-worker.mjs", "  if (budget()) timed(\"approvals\", () => loadApprovals(db, ids, state, budget, publish, pack, stall));\n");
  const [checkpoints, snap] = await Promise.all([
    readCheckpoints(workerFile, file),
    phaseSnapshot(workerFile, file),
  ]);
  const last = checkpoints.at(-1);
  assert.ok(last, "no checkpoint before the approval query");
  assert.equal(last.activeSub.includes("b-child"), true);
  assert.deepEqual(last.incompleteIds.child, []);
  assert.equal(last.approvals.length, 0);
  assert.equal(last.incompleteIds.approvals.includes("d-later"), true);
  assert.equal(last.incompleteIds.approvals.includes("quiet"), true);
  const { partial, elapsed } = snap;
  assert.equal(partial.ok, true, JSON.stringify({ reason: partial.reason, elapsed }));
  assert.ok(elapsed >= 1500 && elapsed < 3500, `child boundary ${elapsed}ms`);
  assert.equal(partial.coverage.factsIncomplete, true);
  assert.equal(partial.coverage.questionsUnread, true);
  assert.equal(byId(partial, "b-child").activity, "unknown");
  assert.equal(byId(partial, "b-child").badges.includes("Child work recorded"), true);
  assert.equal(byId(partial, "d-later").activity, "unknown");
  assert.equal(byId(partial, "d-later").badges.includes("Recorded approval request"), false);
  assert.equal(byId(partial, "quiet").activity, "unknown");
  assert.equal(byId(partial, "quiet").badges.includes("Child work recorded"), false);
  assert.notEqual(byId(partial, "quiet").activity, "open");
  assert.equal(JSON.stringify(partial).includes("SECRET_PATH"), false);
});

test("a finished read of a missing or unknown response stays unknown and the empty line stays in this group", async () => {
  const file = path.join(tmp, "unknown-capability.sqlite");
  const db = openDb(file);
  const add = db.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, created_at, archived_at, deleted_at, payload_json) VALUES (?, NULL, ?, '2026-10-01T15:00:00.000Z', NULL, NULL, ?)`);
  const body = payload();
  add.run("missing-cap", "Missing capability", body);
  add.run("unknown-cap", "Unknown capability", body);
  add.run("not-resume-cap", "Not resumable", body);
  add.run("unknown-plan", "Unknown plan", body);
  add.run("quiet-open", "Quiet open", body);
  const req = db.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests
    (thread_id, kind, status, created_at, resolved_at, payload_json) VALUES (?, 'user_input', 'pending', '2026-10-21T18:30:00.000Z', NULL, ?)`);
  req.run("missing-cap", "{}");
  req.run("unknown-cap", JSON.stringify({ responseCapability: { type: "nope" } }));
  req.run("not-resume-cap", JSON.stringify({ responseCapability: { type: "not_resumable" } }));
  db.prepare(`INSERT INTO orchestration_v2_projection_plans (thread_id, kind, status) VALUES ('unknown-plan', 'mystery', 'active')`).run();
  db.close();
  const raw = await new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(path.join(SRC, "grouping-sql-worker.mjs")));
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("worker timeout"));
    }, 4000);
    worker.on("message", (message) => {
      if (message?.checkpoint) return;
      clearTimeout(timer);
      worker.terminate();
      if (message?.ok) resolve(message);
      else reject(new Error(message?.error || "read"));
    });
    worker.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.postMessage({ id: 1, file, cap: 1000, nowMs: NOW });
  });
  const pendingOf = (id) => raw.pending.filter((row) => row.threadId === id);
  assert.deepEqual(pendingOf("missing-cap"), [{ threadId: "missing-cap", kind: "user_input", status: "pending", capability: "" }]);
  assert.deepEqual(pendingOf("unknown-cap"), [{ threadId: "unknown-cap", kind: "user_input", status: "pending", capability: "" }]);
  assert.deepEqual(pendingOf("not-resume-cap"), []);
  assert.deepEqual(raw.plans.filter((row) => row.threadId === "unknown-plan"), [{ threadId: "unknown-plan", kind: "unknown", status: "active" }]);
  assert.equal(raw.factsIncomplete.pending, false);
  assert.equal(raw.factsIncomplete.plans, false);
  assert.deepEqual(raw.incompleteIds.pending, []);
  assert.deepEqual(raw.incompleteIds.plans, []);
  assert.equal(raw.timing.runStamps, "read");
  assert.equal(raw.timing.requestStamps, "read");
  const api = createGrouping({
    statev2: file, envIdFile: envFile, home: tmp, now: () => NOW, timeZone: TZ,
    cacheMs: 0, failCacheMs: 0, timeoutMs: 2000,
  });
  try {
    const snapshot = await api.snapshot();
    assert.equal(snapshot.ok, true, JSON.stringify({ reason: snapshot.reason }));
    assert.equal(snapshot.coverage.questionsUnread, false);
    assert.equal(snapshot.coverage.factsIncomplete, false);
    for (const id of ["missing-cap", "unknown-cap", "unknown-plan"]) {
      const row = byId(snapshot, id);
      assert.equal(row.activity, "unknown", id);
      assert.equal(row.activityLabel, "State unavailable", id);
      assert.deepEqual(row.badges, [], id);
    }
    assert.equal(byId(snapshot, "not-resume-cap").activity, "open");
    assert.deepEqual(byId(snapshot, "not-resume-cap").badges, []);
    assert.equal(byId(snapshot, "quiet-open").activity, "open");
    assert.deepEqual(byId(snapshot, "quiet-open").badges, []);
    const context = {
      localStorage: { getItem: () => null, setItem: () => {} },
      t3xGroupingExpose: true,
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(SRC, "public/grouping.js"), "utf8"), context);
    const client = context.t3xGrouping;
    const groups = client.present(snapshot.threads, "activity", "recent");
    assert.equal(groups.find((entry) => entry.id === "questions").threads.length, 0);
    assert.deepEqual(groups.find((entry) => entry.id === "unknown").threads.map((row) => row.id).sort(), ["missing-cap", "unknown-cap", "unknown-plan"]);
    const copy = client.questionsEmptyText(snapshot.threads, snapshot.coverage);
    assert.equal(copy, "No questions or approvals in this group.");
    assert.notEqual(copy, "No recorded questions or approvals in this snapshot.");
    assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
  } finally {
    api.dispose();
  }
});
