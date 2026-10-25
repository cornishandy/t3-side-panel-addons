// The sidebar script's pure helpers, without a document so it does not mount.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { classifyThreads } from "../grouping-core.mjs";

const source = fs.readFileSync(new URL("../public/grouping.js", import.meta.url), "utf8");
const store = new Map();
const context = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  },
  t3xGroupingExpose: true,
};
vm.createContext(context);
vm.runInContext(source, context);
const api = context.t3xGrouping;
const plain = (value) => JSON.parse(JSON.stringify(value));

function row(extra) {
  return {
    id: "thread-a", title: "Alpha", projectId: null, projectLabel: "No project",
    createdAt: 1, activityAt: 1, activitySource: "run", recentBucket: "m15",
    activity: "open", activityLabel: "Other open threads", badges: [], shelf: "main", detail: "",
    ...extra,
  };
}

test("the script does not boot without a document", () => {
  assert.equal(context.document, undefined);
  assert.equal(typeof api.present, "function");
  assert.equal(api.readSettings().mode, "native");
});

test("settings fall back when the stored value is junk", () => {
  store.set("t3x:grouping:v1", "{");
  assert.deepEqual(plain(api.readSettings()), { mode: "native", sort: "recent", collapsed: {} });
  store.set("t3x:grouping:v1", JSON.stringify({ v: 1, mode: "project", sort: "title", collapsed: { settled: false } }));
  assert.equal(api.readSettings().mode, "project");
  assert.equal(api.readSettings().sort, "title");
});

test("sort is local and stable", () => {
  const threads = [
    row({ id: "b", title: "Bravo", activityAt: 10, createdAt: 1 }),
    row({ id: "a", title: "Alpha", activityAt: 50, createdAt: 9 }),
  ];
  assert.deepEqual(plain(api.sortThreads(threads, "title").map((item) => item.id)), ["a", "b"]);
  assert.deepEqual(plain(api.sortThreads(threads, "recent").map((item) => item.id)), ["a", "b"]);
  assert.deepEqual(plain(api.sortThreads(threads, "created").map((item) => item.id)), ["a", "b"]);
  const flipped = [
    row({ id: "b", title: "Bravo", activityAt: 50, createdAt: 9 }),
    row({ id: "a", title: "Alpha", activityAt: 10, createdAt: 1 }),
  ];
  assert.deepEqual(plain(api.sortThreads(flipped, "recent").map((item) => item.id)), ["b", "a"]);
  assert.deepEqual(plain(api.sortThreads(flipped, "created").map((item) => item.id)), ["b", "a"]);
  assert.deepEqual(plain(api.sortThreads(flipped, "title").map((item) => item.id)), ["a", "b"]);
});

test("activity keeps an empty questions group; other empty groups stay hidden", () => {
  const groups = api.present([
    row({ id: "run", activity: "running", shelf: "main" }),
    row({ id: "zzz", shelf: "snoozed" }),
    row({ id: "set", shelf: "settled" }),
  ], "activity", "title");
  assert.equal(groups[0].id, "questions");
  assert.equal(groups[0].threads.length, 0);
  assert.equal(groups.some((group) => group.id === "running"), true);
  assert.equal(groups.some((group) => group.id === "child"), false);
  assert.equal(groups.at(-2).id, "snoozed");
  assert.equal(groups.at(-1).id, "settled");
});

test("empty questions copy admits a known approval outside the group and an unfinished read", () => {
  const honest = "No questions or approvals in this group.";
  const snapshotWide = "No recorded questions or approvals in this snapshot.";
  assert.equal(source.includes(snapshotWide), false);
  assert.equal(api.questionsEmptyText([
    row({ id: "run", activity: "running" }),
  ], { questionsUnread: false }), honest);
  assert.notEqual(honest, snapshotWide);
  const outside = api.questionsEmptyText([
    row({ id: "ap", activity: "unknown", badges: ["Recorded approval request", "Settled recorded"] }),
  ], { questionsUnread: false });
  assert.match(outside, /not proof there are none/);
  assert.notEqual(outside, honest);
  const unread = api.questionsEmptyText([
    row({ id: "quiet", activity: "open", badges: [] }),
  ], { questionsUnread: true });
  assert.match(unread, /unfinished read/);
  assert.notEqual(unread, honest);
  const pinned = [
    row({ id: "pin", title: "Pinned approval", shelf: "pinned", activity: "questions", activityLabel: "Questions & approvals", badges: ["Recorded approval request"] }),
  ];
  const groups = api.present(pinned, "activity", "recent");
  assert.equal(groups.find((group) => group.id === "pinned").threads.length, 1);
  assert.equal(groups.find((group) => group.id === "questions").threads.length, 0);
  const pinnedCopy = api.questionsEmptyText(pinned, { questionsUnread: false });
  assert.match(pinnedCopy, /another row/);
  assert.notEqual(pinnedCopy, honest);
  assert.equal(api.questionsEmptyText([
    row({ id: "q", activity: "questions", shelf: "main", badges: ["Recorded question"] }),
  ], { questionsUnread: false }), honest);
  assert.notEqual(pinnedCopy, snapshotWide);
  assert.notEqual(outside, snapshotWide);
  assert.notEqual(unread, snapshotWide);
});

test("a finished read of an unknown request or plan stays unknown and the empty line stays in this group", () => {
  const group = "No questions or approvals in this group.";
  const absent = "No recorded questions or approvals in this snapshot.";
  const long = "No questions or approvals in this group. A known request can sit on another row, and an unfinished read is not proof there are none.";
  const now = Date.parse("2026-10-22T04:00:00Z");
  const cover = {
    timing: { runStamps: "read", requestStamps: "read" },
    factsIncomplete: {},
    incompleteIds: {},
  };
  function finished(extra) {
    return classifyThreads({
      threads: [{ id: "question-x", title: "Recorded input" }],
      ...cover,
      ...extra,
    }, now, "UTC").threads;
  }
  const cases = [
    { name: "missing capability", pending: [{ threadId: "question-x", kind: "user_input", status: "pending", capability: "" }] },
    { name: "unrecognized capability", pending: [{ threadId: "question-x", kind: "user_input", status: "pending", capability: "nope" }] },
    { name: "unknown plan", plans: [{ threadId: "question-x", kind: "mystery", status: "active" }] },
    { name: "worker unknown plan", plans: [{ threadId: "question-x", kind: "unknown", status: "active" }] },
  ];
  for (const item of cases) {
    const rows = finished({ pending: item.pending, plans: item.plans });
    assert.equal(rows[0].activity, "unknown", item.name);
    assert.equal(rows[0].activityLabel, "State unavailable", item.name);
    assert.deepEqual(rows[0].badges, [], item.name);
    const groups = api.present(rows, "activity", "recent");
    assert.equal(groups.find((entry) => entry.id === "questions").threads.length, 0, item.name);
    assert.equal(groups.find((entry) => entry.id === "unknown").threads.length, 1, item.name);
    const copy = api.questionsEmptyText(rows, { questionsUnread: false });
    assert.equal(copy, group, item.name);
    assert.notEqual(copy, absent, item.name);
    assert.notEqual(copy, long, item.name);
  }
  const skipped = finished({
    pending: [{ threadId: "question-x", kind: "user_input", status: "pending", capability: "not_resumable" }],
  });
  assert.equal(skipped[0].activity, "open");
  assert.deepEqual(skipped[0].badges, []);
  assert.equal(api.present(skipped, "activity", "recent").find((entry) => entry.id === "questions").threads.length, 0);
  assert.equal(api.questionsEmptyText(skipped, { questionsUnread: false }), group);
});

test("timing unknown is its own recent group, not Older", () => {
  const groups = api.present([
    row({ id: "old", recentBucket: "older", activityAt: 1, activitySource: "created" }),
    row({ id: "wait", recentBucket: "unread", activitySource: "unavailable", activityAt: null }),
    row({ id: "seen", recentBucket: "unread", activitySource: "observed", activityAt: 50 }),
  ], "recent", "recent");
  const unread = groups.find((group) => group.id === "unread");
  const older = groups.find((group) => group.id === "older");
  assert.equal(unread.long, "Timing unavailable");
  assert.equal(unread.short, "Timing unknown");
  assert.deepEqual(plain(unread.threads.map((thread) => thread.id)), ["seen", "wait"]);
  assert.deepEqual(plain(older.threads.map((thread) => thread.id)), ["old"]);
});

test("age text does not call unread timing created or a verified event", () => {
  assert.equal(api.ageText(row({ activitySource: "unavailable", activityAt: null }), 100000), "timing unavailable");
  assert.equal(api.ageText(row({ activitySource: "observed", activityAt: 100000 }), 100000 + 5 * 60000), "observed 5 min ago");
  assert.equal(api.ageText(row({ activitySource: "created", activityAt: 100000 }), 100000 + 5 * 60000), "created 5 min ago");
  assert.equal(api.ageText(row({ activitySource: "none", activityAt: null }), 100000), "no recorded run activity");
});

test("project groups put an empty project last", () => {
  const groups = api.present([
    row({ id: "n", projectId: null, projectLabel: "No project", shelf: "main" }),
    row({ id: "b", projectId: "beta", projectLabel: "Beta", shelf: "main" }),
    row({ id: "a", projectId: "alpha", projectLabel: "Alpha", shelf: "main" }),
  ], "project", "title");
  assert.deepEqual(plain(groups.map((group) => group.long)), ["Alpha", "Beta", "No project"]);
});

test("identity fails closed", () => {
  const local = [{ env: "localenv01", threadId: "thread-a", compact: false }];
  assert.equal(api.identityOk("localenv01", local, { kind: "home" }), true);
  assert.equal(api.identityOk("localenv01", [{ env: "otherenv01", threadId: "thread-a", compact: false }], { kind: "thread", environmentId: "localenv01", threadId: "thread-a" }), false);
  assert.equal(api.identityOk("localenv01", [{ env: null, threadId: null, compact: true }], { kind: "home" }), false);
  assert.equal(api.identityOk("localenv01", [{ env: null, threadId: null, compact: true }], { kind: "thread", environmentId: "localenv01", threadId: "thread-a" }), true);
  assert.equal(api.identityOk("localenv01", [], { kind: "settings" }), false);
  assert.equal(api.identityOk("", local, { kind: "home" }), false);
  assert.equal(api.normId("mcp:localenv01"), "localenv01");
});

test("routes and thread items split the way the sidebar stores them", () => {
  assert.deepEqual(plain(api.parseRoute("#/localenv01/thread-a")), { kind: "thread", environmentId: "localenv01", threadId: "thread-a" });
  assert.equal(api.parseRoute("#/settings/labs").kind, "other");
  assert.equal(api.parseRoute("#/draft/abc").kind, "draft");
  assert.deepEqual(plain(api.parseThreadItem("localenv01:thread:with:colons")), { env: "localenv01", threadId: "thread:with:colons" });
  assert.equal(api.parseThreadItem("true"), null);
  const rows = api.scanRows({
    querySelectorAll() {
      return [
        { getAttribute: () => "localenv01:thread-a" },
        { getAttribute: () => "true" },
      ];
    },
  });
  assert.equal(rows[0].env, "localenv01");
  assert.equal(rows[1].compact, true);
});
