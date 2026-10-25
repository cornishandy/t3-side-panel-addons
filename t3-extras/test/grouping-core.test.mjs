// Pure activity rules. Labels stay inside what a database snapshot can prove.
import test from "node:test";
import assert from "node:assert/strict";
import { bucket, classifyThreads, parseTime } from "../grouping-core.mjs";

const NOW = Date.parse("2026-10-21T23:00:00.000Z");
const TZ = "America/New_York";
const CREATED = "2026-10-01T15:00:00.000Z";

function thread(id, extra = {}) {
  return {
    id, title: extra.title ?? id, projectId: extra.projectId ?? null,
    createdAt: extra.createdAt === undefined ? CREATED : extra.createdAt,
    settledOverride: extra.settledOverride ?? null, settledAt: extra.settledAt ?? null,
    snoozedUntil: extra.snoozedUntil ?? null, snoozedAt: extra.snoozedAt ?? null,
    pinnedAt: extra.pinnedAt ?? null, limitRunId: extra.limitRunId ?? null,
    runStamps: extra.runStamps ?? [], requestStamps: extra.requestStamps ?? [],
    updatedAt: extra.updatedAt,
  };
}
function run(status, extra = {}) {
  return {
    threadId: extra.threadId ?? "thread-a", runId: extra.runId ?? "run-1", ordinal: extra.ordinal ?? 1,
    status, queueHeld: extra.queueHeld ?? false, requestedAt: extra.requestedAt ?? null,
    completedAt: extra.completedAt ?? null, workStartedAt: extra.workStartedAt ?? null,
  };
}
function classify(partial = {}) {
  const id = partial.id ?? "thread-a";
  const result = classifyThreads({
    threads: partial.threads ?? [thread(id, partial.thread)],
    projects: partial.projects ?? [],
    runs: partial.runs ?? [],
    pending: partial.pending ?? [],
    plans: partial.plans ?? [],
    approvals: partial.approvals ?? [],
    links: partial.links ?? [],
    activeSub: partial.activeSub ?? [],
    unknownSub: partial.unknownSub ?? [],
    childLive: partial.childLive ?? [],
    secrets: partial.secrets ?? [],
    factsIncomplete: partial.factsIncomplete,
    incompleteIds: partial.incompleteIds,
    timing: partial.timing,
  }, partial.now ?? NOW, TZ);
  return { result, row: result.threads.find((item) => item.id === id) };
}
function forbid(row) {
  const text = JSON.stringify({ label: row.activityLabel, badges: row.badges, shelf: row.shelf });
  assert.doesNotMatch(text, /Ready|Idle|Finished|Needs you|Waiting on PR|Plan ready/);
  assert.match(row.detail, /not Ready, Idle or Finished|not the Working shelf|not the Waiting shelf|not a live callback|State unavailable/);
}

test("parseTime accepts real timestamps only", () => {
  assert.equal(parseTime("2026-10-21T23:00:00.000Z"), NOW);
  assert.equal(parseTime("yesterday"), null);
  assert.equal(parseTime(NOW), null);
});

test("rolling windows beat the local calendar, including midnight and DST", () => {
  assert.equal(bucket(NOW, NOW, TZ), "m15");
  assert.equal(bucket(NOW - 15 * 60 * 1000, NOW, TZ), "m15");
  assert.equal(bucket(NOW - 15 * 60 * 1000 - 1, NOW, TZ), "m60");
  assert.equal(bucket(NOW - 60 * 60 * 1000, NOW, TZ), "m60");
  assert.equal(bucket(NOW - 60 * 60 * 1000 - 1, NOW, TZ), "today");
  assert.equal(bucket(Date.parse("2026-10-21T16:00:00.000Z"), NOW, TZ), "today");
  assert.equal(bucket(Date.parse("2026-10-20T16:00:00.000Z"), NOW, TZ), "yesterday");
  assert.equal(bucket(Date.parse("2026-10-21T04:00:00.000Z"), NOW, TZ), "today");
  assert.equal(bucket(Date.parse("2026-10-21T03:59:59.999Z"), NOW, TZ), "yesterday");
  assert.equal(bucket(Date.parse("2026-10-18T23:00:00.000Z"), NOW, TZ), "week");
  assert.equal(bucket(Date.parse("2026-10-14T04:00:00.000Z"), NOW, TZ), "week");
  assert.equal(bucket(Date.parse("2026-10-14T03:59:59.999Z"), NOW, TZ), "older");
  assert.equal(bucket(Date.parse("2026-10-11T23:00:00.000Z"), NOW, TZ), "older");
  const justAfterMidnight = Date.parse("2026-10-22T04:20:00.000Z");
  assert.equal(bucket(Date.parse("2026-10-22T03:50:00.000Z"), justAfterMidnight, TZ), "m60");
  assert.equal(bucket(Date.parse("2026-10-22T03:00:00.000Z"), justAfterMidnight, TZ), "yesterday");
  assert.equal(bucket(NOW + 3 * 60 * 1000, NOW, TZ), "none");
  assert.equal(bucket(NOW + 60 * 1000, NOW, TZ), "m15");
  const springNoon = Date.parse("2026-03-08T16:00:00.000Z");
  assert.equal(bucket(Date.parse("2026-03-08T05:30:00.000Z"), springNoon, TZ), "today");
  assert.equal(bucket(Date.parse("2026-03-07T15:00:00.000Z"), springNoon, TZ), "yesterday");
  const fallAfternoon = Date.parse("2026-11-01T18:00:00.000Z");
  assert.equal(bucket(Date.parse("2026-11-01T04:30:00.000Z"), fallAfternoon, TZ), "today");
  assert.equal(bucket(Date.parse("2026-10-31T15:00:00.000Z"), fallAfternoon, TZ), "yesterday");
});

test("completed parent with a live child is child work, not finished", () => {
  const { row } = classify({
    id: "parent-1",
    runs: [run("completed", { threadId: "parent-1", completedAt: "2026-10-21T18:00:00.000Z" })],
    links: [{ threadId: "parent-1", childThreadId: "child-1" }],
    childLive: ["child-1"],
    thread: { runStamps: ["2026-10-21T18:00:00.000Z"] },
  });
  assert.equal(row.activity, "child");
  assert.equal(row.activityLabel, "Child work recorded");
  assert.equal(row.shelf, "main");
  forbid(row);
});

test("a held queued run is not a run in progress", () => {
  const only = classify({ runs: [run("queued", { queueHeld: true, ordinal: 4 })] });
  assert.equal(only.row.activity, "open");
  assert.deepEqual(only.row.badges, []);
  const newer = classify({
    runs: [run("completed", { ordinal: 1 }), run("queued", { queueHeld: true, ordinal: 2, runId: "held" })],
  });
  assert.equal(newer.row.activity, "open");
  assert.deepEqual(newer.row.badges, []);
});

test("a running thread keeps a nonblocking question as a badge", () => {
  const { row } = classify({
    runs: [run("running")],
    pending: [{ threadId: "thread-a", capability: "message", kind: "user_input" }],
  });
  assert.equal(row.activity, "running");
  assert.equal(row.activityLabel, "Run in progress");
  assert.deepEqual(row.badges, ["Recorded question"]);
});

test("a completed thread with a message request is a recorded question", () => {
  const { row } = classify({
    runs: [run("completed")],
    pending: [{ threadId: "thread-a", capability: "message", kind: "user_input" }],
  });
  assert.equal(row.activity, "questions");
  assert.deepEqual(row.badges, ["Recorded question"]);
  assert.match(row.detail, /not a live callback/);
});

test("not_resumable pending input is not a question", () => {
  const alone = classify({ pending: [{ threadId: "thread-a", capability: "not_resumable", kind: "user_input" }] });
  assert.equal(alone.row.activity, "open");
  assert.deepEqual(alone.row.badges, []);
  const beside = classify({
    runs: [run("running")],
    pending: [{ threadId: "thread-a", capability: "not_resumable", kind: "user_input" }],
  });
  assert.equal(beside.row.activity, "running");
  assert.deepEqual(beside.row.badges, []);
});

test("no run events fall back to creation, and updatedAt is ignored", () => {
  const { row } = classify({
    thread: { updatedAt: "2026-10-21T22:59:00.000Z", createdAt: CREATED, runStamps: [] },
  });
  assert.equal(row.activity, "open");
  assert.equal(row.activityLabel, "Other open threads");
  assert.equal(row.activitySource, "created");
  assert.equal(row.recentBucket, "older");
  assert.equal(row.activityAt, Date.parse(CREATED));
});

test("a waiting secret is metadata only and counts as a recorded question", () => {
  const { row, result } = classify({ secrets: ["thread-a"], thread: { title: "Secret stays out", secret: "SECRET_PAYLOAD" } });
  assert.equal(row.activity, "questions");
  assert.deepEqual(row.badges, ["Recorded secret request"]);
  assert.equal(JSON.stringify(result).includes("SECRET_PAYLOAD"), false);
});

test("an active todo list is not an approval; an active proposed plan is", () => {
  const todo = classify({ plans: [{ threadId: "thread-a", kind: "todo_list", status: "active" }] });
  assert.equal(todo.row.activity, "open");
  assert.deepEqual(todo.row.badges, []);
  const plan = classify({ plans: [{ threadId: "thread-a", kind: "proposed_plan", status: "active" }] });
  assert.equal(plan.row.activity, "questions");
  assert.deepEqual(plan.row.badges, ["Recorded proposed plan"]);
  const both = classify({
    runs: [run("running")],
    plans: [{ threadId: "thread-a", kind: "proposed_plan", status: "active" }],
  });
  assert.equal(both.row.activity, "questions");
  assert.deepEqual(both.row.badges, ["Recorded proposed plan", "Run recorded"]);
});

test("settledAt alone does not settle; only the override value settled does", () => {
  const active = classify({
    thread: { settledAt: "2020-01-01T00:00:00.000Z", settledOverride: "active" },
  });
  assert.equal(active.row.shelf, "main");
  assert.equal(active.row.badges.includes("Settled recorded"), false);
  const settled = classify({
    runs: [run("completed")],
    thread: { settledOverride: "settled", settledAt: "2020-01-01T00:00:00.000Z" },
  });
  assert.equal(settled.row.shelf, "settled");
  assert.equal(settled.row.activity, "open");
});

test("a linked pull request without a watch is not a waiting state", () => {
  const { row } = classify({ thread: { title: "Has a PR" } });
  assert.equal(row.activity, "open");
  assert.equal(JSON.stringify(row).includes("watch"), false);
  forbid(row);
});

test("a future snooze does not hide a recorded question or a newer failure", () => {
  const asking = classify({
    pending: [{ threadId: "thread-a", capability: "live", kind: "user_input" }],
    thread: { snoozedUntil: "2026-10-22T23:00:00.000Z", snoozedAt: "2026-10-20T00:00:00.000Z" },
  });
  assert.equal(asking.row.activity, "questions");
  assert.equal(asking.row.shelf, "main");
  assert.deepEqual(asking.row.badges, ["Recorded input or approval", "Snooze recorded"]);
  const failed = classify({
    runs: [run("failed", { completedAt: "2026-10-21T20:00:00.000Z" })],
    thread: { snoozedUntil: "2026-10-22T23:00:00.000Z", snoozedAt: "2026-10-20T00:00:00.000Z" },
  });
  assert.equal(failed.row.shelf, "main");
  assert.ok(failed.row.badges.includes("Latest run recorded as failed"));
  assert.ok(failed.row.badges.includes("Snooze recorded"));
  const quiet = classify({
    thread: { snoozedUntil: "2026-10-22T23:00:00.000Z" },
  });
  assert.equal(quiet.row.shelf, "snoozed");
});

test("a pin is a timestamp, and a settled thread with a live run stays visible", () => {
  const pin = classify({ thread: { pinnedAt: "2026-10-02T00:00:00.000Z" } });
  assert.equal(pin.row.shelf, "pinned");
  const junk = classify({ thread: { pinnedAt: "yes" } });
  assert.equal(junk.row.shelf, "main");
  const busy = classify({
    runs: [run("running")],
    thread: { settledOverride: "settled" },
  });
  assert.equal(busy.row.activity, "running");
  assert.equal(busy.row.shelf, "main");
  assert.ok(busy.row.badges.includes("Settled recorded"));
});

test("usage-limit failure stays when newer runs never started", () => {
  const kept = classify({
    thread: { limitRunId: "limit-run" },
    runs: [
      run("failed", { runId: "limit-run", ordinal: 1 }),
      run("cancelled", { runId: "newer", ordinal: 2, workStartedAt: null }),
    ],
  });
  assert.equal(kept.row.activity, "open");
  assert.deepEqual(kept.row.badges, ["Usage-limit failure recorded"]);
  const moved = classify({
    thread: { limitRunId: "limit-run" },
    runs: [
      run("failed", { runId: "limit-run", ordinal: 1 }),
      run("running", { runId: "newer", ordinal: 2 }),
    ],
  });
  assert.equal(moved.row.activity, "running");
  assert.equal(moved.row.badges.includes("Usage-limit failure recorded"), false);
});

test("an unknown value is unavailable, not a success", () => {
  const weird = classify({ runs: [run("mystery")] });
  assert.equal(weird.row.activity, "unknown");
  assert.equal(weird.row.activityLabel, "State unavailable");
  const request = classify({ pending: [{ threadId: "thread-a", capability: "nope", kind: "user_input" }] });
  assert.equal(request.row.activity, "unknown");
  const child = classify({ unknownSub: ["thread-a"] });
  assert.equal(child.row.activity, "unknown");
});

test("a non-held queued run is a badge, not a run in progress", () => {
  const { row } = classify({ runs: [run("queued", { queueHeld: false })] });
  assert.equal(row.activity, "open");
  assert.deepEqual(row.badges, ["Queued run recorded"]);
});

test("an open approval is a question; a future-only stamp is not recent", () => {
  const approval = classify({ approvals: [{ threadId: "thread-a", status: "pending" }] });
  assert.equal(approval.row.activity, "questions");
  assert.match(approval.row.detail, /snapshot/);
  const future = classify({
    thread: { createdAt: null, runStamps: ["2026-10-21T23:05:00.000Z"] },
  });
  assert.equal(future.row.activitySource, "none");
  assert.equal(future.row.recentBucket, "none");
});

test("project labels say when a record is missing, deleted, or duplicated", () => {
  const { result } = classify({
    threads: [
      thread("left", { projectId: "aaa11111-1111-4111-8111-111111111111" }),
      thread("right", { projectId: "bbb22222-2222-4222-8222-222222222222" }),
      thread("gone", { projectId: "proj-missing" }),
      thread("old", { projectId: "proj-deleted" }),
      thread("none"),
    ],
    projects: [
      { id: "aaa11111-1111-4111-8111-111111111111", title: "Shared", deleted: 0 },
      { id: "bbb22222-2222-4222-8222-222222222222", title: "Shared", deleted: 0 },
      { id: "proj-deleted", title: "Old Name", deleted: 1 },
    ],
  });
  const by = Object.fromEntries(result.threads.map((row) => [row.id, row.projectLabel]));
  assert.equal(by.left, "Shared · aaa11111");
  assert.equal(by.right, "Shared · bbb22222");
  assert.equal(by.gone, "Missing project record");
  assert.equal(by.old, "Old Name (deleted record)");
  assert.equal(by.none, "No project");
});

test("unsafe ids are omitted and a child cycle stays bounded", () => {
  const dropped = classifyThreads({
    threads: [thread("good-thread"), { id: "bad id", title: "nope" }],
  }, NOW, TZ);
  assert.equal(dropped.omittedUnsafeIds, 1);
  assert.deepEqual(dropped.threads.map((row) => row.id), ["good-thread"]);
  const cycle = classify({
    id: "cycle-parent",
    links: [
      { threadId: "cycle-parent", childThreadId: "cyc-a" },
      { threadId: "cyc-a", childThreadId: "cyc-b" },
      { threadId: "cyc-b", childThreadId: "cyc-a" },
    ],
  });
  assert.equal(cycle.row.activity, "open");
  const grand = classify({
    id: "grand-parent",
    links: [
      { threadId: "grand-parent", childThreadId: "mid" },
      { threadId: "mid", childThreadId: "grand" },
    ],
    childLive: ["grand"],
  });
  assert.equal(grand.row.activity, "child");
  const tooDeep = classify({
    id: "great-parent",
    links: [
      { threadId: "great-parent", childThreadId: "a" },
      { threadId: "a", childThreadId: "b" },
      { threadId: "b", childThreadId: "c" },
    ],
    childLive: ["c"],
  });
  assert.equal(tooDeep.row.activity, "open");
});

test("a future or corrupt maximum does not hide an older valid run event", () => {
  const both = classify({
    thread: { createdAt: CREATED, runStamps: ["2026-10-21T23:05:00.000Z", "2026-10-21T22:55:00.000Z"] },
  });
  assert.equal(both.row.activitySource, "run");
  assert.equal(both.row.recentBucket, "m15");
  assert.equal(both.row.activityAt, Date.parse("2026-10-21T22:55:00.000Z"));
  const corrupt = classify({
    thread: { createdAt: CREATED, runStamps: ["2026-10-21T99:99:99", Date.parse("2026-10-21T22:55:00.000Z")] },
  });
  assert.equal(corrupt.row.activitySource, "run");
  assert.equal(corrupt.row.recentBucket, "m15");
  const onlyFuture = classify({
    thread: { createdAt: CREATED, runStamps: ["2026-10-21T23:05:00.000Z"] },
  });
  assert.equal(onlyFuture.row.activitySource, "created");
  assert.equal(onlyFuture.row.recentBucket, "older");
});

test("the winning stamp keeps its own source", () => {
  const newerRequest = classify({
    thread: { createdAt: CREATED, runStamps: ["2026-10-21T22:00:00Z"], requestStamps: ["2026-10-21T22:55:00Z"] },
  });
  assert.equal(newerRequest.row.activitySource, "request");
  assert.equal(newerRequest.row.activityAt, Date.parse("2026-10-21T22:55:00Z"));
  assert.equal(newerRequest.row.recentBucket, "m15");
  const onlyFuture = classify({
    thread: { createdAt: CREATED, runStamps: ["2026-10-21T23:05:00Z"], requestStamps: ["2026-10-21T23:10:00Z"] },
  });
  assert.equal(onlyFuture.row.activitySource, "created");
  assert.equal(onlyFuture.row.recentBucket, "older");
});

test("an unfinished fact family is unknown only on the threads it did not finish", () => {
  const { result } = classify({
    threads: [thread("done-empty"), thread("partial"), thread("known"), thread("terminal-partial")],
    secrets: ["known"],
    approvals: [{ threadId: "terminal-partial", status: "completed" }],
    incompleteIds: { secrets: ["partial", "known"], approvals: ["terminal-partial"] },
  });
  const by = Object.fromEntries(result.threads.map((row) => [row.id, row]));
  assert.equal(by["done-empty"].activity, "open");
  assert.equal(by.partial.activity, "unknown");
  assert.equal(by.known.activity, "questions");
  assert.ok(by.known.badges.includes("Recorded secret request"));
  assert.equal(by["terminal-partial"].activity, "unknown");
  const settled = classify({
    thread: { settledOverride: "settled" },
    approvals: [{ threadId: "thread-a", status: "active" }],
  });
  assert.equal(settled.row.activity, "questions");
  assert.equal(settled.row.shelf, "main");
  assert.ok(settled.row.badges.includes("Settled recorded"));
  const unfinished = classify({
    thread: { settledOverride: "settled" },
    incompleteIds: { approvals: ["thread-a"] },
  });
  assert.equal(unfinished.row.activity, "unknown");
  assert.notEqual(unfinished.row.shelf, "settled");
});

test("a saturated fact cap is unknown, not an open thread with no blocker", () => {
  const dropped = classify({
    factsIncomplete: { approvals: true, pending: false, plans: false, liveRuns: false, child: false, secrets: false },
  });
  assert.equal(dropped.row.activity, "unknown");
  const kept = classify({
    approvals: [{ threadId: "thread-a", status: "pending" }],
    factsIncomplete: { approvals: true },
  });
  assert.equal(kept.row.activity, "questions");
  assert.ok(kept.row.badges.includes("Recorded approval request"));
});

test("a cross-family gap keeps a known approval and known child work", () => {
  const result = classifyThreads({
    threads: [thread("approval"), thread("child"), thread("run")],
    approvals: [{ threadId: "approval", status: "active" }],
    activeSub: ["child"],
    runs: [run("running", { threadId: "run" })],
    incompleteIds: { secrets: ["approval", "child", "run"] },
  }, NOW, TZ);
  const by = Object.fromEntries(result.threads.map((row) => [row.id, row]));
  assert.equal(by.approval.activity, "unknown");
  assert.ok(by.approval.badges.includes("Recorded approval request"));
  assert.equal(by.approval.badges.includes("Recorded secret request"), false);
  assert.equal(by.child.activity, "unknown");
  assert.ok(by.child.badges.includes("Child work recorded"));
  assert.equal(by.run.activity, "unknown");
  assert.ok(by.run.badges.includes("Run recorded"));
  const settled = classify({
    thread: { settledOverride: "settled", snoozedUntil: "2026-10-22T00:00:00.000Z" },
    approvals: [{ threadId: "thread-a", status: "active" }],
    incompleteIds: { secrets: ["thread-a"] },
  });
  assert.equal(settled.row.activity, "unknown");
  assert.equal(settled.row.shelf, "main");
  assert.ok(settled.row.badges.includes("Recorded approval request"));
  assert.ok(settled.row.badges.includes("Settled recorded"));
  assert.ok(settled.row.badges.includes("Snooze recorded"));
  const onlyChild = classify({ activeSub: ["thread-a"] });
  assert.equal(onlyChild.row.activity, "child");
  assert.equal(onlyChild.row.badges.includes("Child work recorded"), false);
});

test("unread run or request times are not created, Older, or a verified latest event", () => {
  const unread = classify({
    thread: { createdAt: CREATED, runStamps: [], requestStamps: [] },
    timing: { runStamps: "unread", requestStamps: "unread" },
  });
  assert.equal(unread.row.activitySource, "unavailable");
  assert.equal(unread.row.recentBucket, "unread");
  assert.notEqual(unread.row.activitySource, "created");
  assert.notEqual(unread.row.recentBucket, "older");
  const observed = classify({
    thread: { createdAt: CREATED, runStamps: ["2026-10-21T22:56:00.000Z"], requestStamps: [] },
    timing: { runStamps: "read", requestStamps: "unread" },
  });
  assert.equal(observed.row.activitySource, "observed");
  assert.equal(observed.row.activityAt, Date.parse("2026-10-21T22:56:00.000Z"));
  assert.equal(observed.row.recentBucket, "unread");
  assert.notEqual(observed.row.recentBucket, "m15");
  assert.notEqual(observed.row.activitySource, "run");
  const created = classify({
    thread: { createdAt: CREATED, runStamps: [], requestStamps: [] },
    timing: { runStamps: "read", requestStamps: "read" },
  });
  assert.equal(created.row.activitySource, "created");
  assert.equal(created.row.recentBucket, "older");
  const requestWins = classify({
    thread: { createdAt: CREATED, runStamps: ["2026-10-21T22:00:00.000Z"], requestStamps: ["2026-10-21T22:55:00.000Z"] },
    timing: { runStamps: "read", requestStamps: "read" },
  });
  assert.equal(requestWins.row.activitySource, "request");
  assert.equal(requestWins.row.activityAt, Date.parse("2026-10-21T22:55:00.000Z"));
  assert.equal(requestWins.row.recentBucket, "m15");
});
