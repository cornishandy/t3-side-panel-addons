// T3's IndexedDB reader and the font switch under timeouts and teardown (Sol's round-2 cases, as
// regressions). The two sections of public/extras.js run alone against mocks: no real database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../public/extras.js", import.meta.url), "utf8");
const section = (a, b) => {
  const i = src.indexOf(a);
  assert.ok(i >= 0, a);
  const j = src.indexOf(b, i);
  assert.ok(j > i, b);
  return src.slice(i, j);
};
const T3 = section("  const T3_DB =", "\n  // ---------- usage history:");
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function harness(extra = {}) {
  const ctx = { disposed: false, lastState: { localEnvironmentId: "local-env" }, setTimeout: (f) => ((ctx.fire = f), 1), clearTimeout() {}, Date, Error, guarded: (_w, f) => f, render() {}, projectT3Config: (x) => x, ...extra };
  vm.createContext(ctx);
  vm.runInContext(T3, ctx);
  return ctx;
}
function fakeDb() {
  const db = { closed: 0, tx: { aborted: 0, abort() { this.aborted++; }, objectStore: () => ({ get: () => (db.get = {}) }) } };
  db.objectStoreNames = { contains: () => true };
  db.transaction = (_s, mode) => (assert.equal(mode, "readonly"), db.tx);
  db.close = () => db.closed++;
  return db;
}

test("a timed-out read aborts its transaction and closes its connection", async () => {
  let req;
  const ctx = harness({ indexedDB: { open: (...a) => (assert.equal(a.length, 1, "never a version"), (req = {})) } });
  const p = vm.runInContext('t3Get("local-env")', ctx).catch((e) => e.message);
  const db = fakeDb();
  req.result = db;
  req.onsuccess();
  ctx.fire();
  assert.equal(await p, "timeout");
  assert.equal(db.tx.aborted, 1);
  assert.equal(db.closed, 1);
  // A late answer after the timeout does nothing more.
  db.get.result = "late";
  db.get.onsuccess?.();
  assert.equal(db.closed, 1);
});

test("versionchange (a T3 upgrade) and teardown also abort and close", async () => {
  let req;
  const ctx = harness({ indexedDB: { open: () => (req = {}) } });
  const p1 = vm.runInContext('t3Get("local-env")', ctx).catch((e) => e.message);
  const db1 = fakeDb();
  req.result = db1;
  req.onsuccess();
  db1.onversionchange();
  assert.equal(await p1, "versionchange");
  assert.deepEqual([db1.tx.aborted, db1.closed], [1, 1]);
  const p2 = vm.runInContext('t3Get("local-env")', ctx).catch((e) => e.message);
  const db2 = fakeDb();
  req.result = db2;
  req.onsuccess();
  vm.runInContext("for (const stop of [...t3Pending]) stop()", ctx); // what teardown runs
  assert.equal(await p2, "stopped");
  assert.deepEqual([db2.tx.aborted, db2.closed], [1, 1]);
  // An open that completes after teardown is closed at once.
  const p3 = vm.runInContext('t3Get("local-env")', ctx).catch((e) => e.message);
  ctx.disposed = true;
  const db3 = fakeDb();
  req.result = db3;
  req.onsuccess();
  assert.equal(await p3, "late");
  assert.equal(db3.closed, 1);
});

test("a databases() answer that arrives after teardown never opens T3's database", async () => {
  let release;
  let opens = 0;
  const ctx = harness({ indexedDB: { databases: () => new Promise((r) => (release = r)), open: () => (opens++, {}) } });
  vm.runInContext("readT3Cache()", ctx);
  ctx.disposed = true;
  release([{ name: "t3code:connection-runtime" }]);
  await tick();
  assert.equal(opens, 0);
});

test("a late font failure can't switch off a newer copy's font", async () => {
  const apply = section("  function applyFonts() {", "\n  // ---------- add-ons panel");
  let reject;
  const p = new Promise((_r, j) => (reject = j));
  const attrs = new Set(["data-t3x-fh"]);
  const ctx = { ROLE: { head: { attr: "data-t3x-fh" } }, applyRole: () => p, D: { documentElement: { removeAttribute: (a) => attrs.delete(a) } }, disposed: true };
  vm.createContext(ctx);
  vm.runInContext(`${apply}; applyFonts();`, ctx);
  reject(new Error("late"));
  await tick();
  assert.equal(attrs.has("data-t3x-fh"), true);
  // applyRole itself checks disposal and its token before touching the switch.
  const role = section("  async function applyRole(role) {", "\n  async function applyRoleNow(");
  assert.match(role, /if \(!disposed && token === roleTokens\[role\]\) \{[^}]*D\.documentElement\.removeAttribute/);
});
