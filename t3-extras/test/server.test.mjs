// Run: node --test test/   (starts the service on a spare loopback port with a fake lab-usage)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { guard, usageView, labsFromView, chainView, normId, diagEntry } from "../lib.mjs";

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-test-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------- pure helpers ----------

test("host guard accepts loopback names on the service port only", () => {
  assert.equal(guard({ host: "127.0.0.1:8793" }).hostOk, true);
  assert.equal(guard({ host: "localhost:8793" }).hostOk, true);
  for (const host of ["evil.example:8793", "127.0.0.1", "127.0.0.1:80", "my-mac.your-tailnet.ts.net:8793", "", undefined]) {
    assert.equal(guard({ host }).hostOk, false, String(host));
  }
});

test("CORS echoes only T3's own origins, nothing broader", () => {
  assert.equal(guard({ host: "127.0.0.1:8793", origin: "t3code://app" }).allowOrigin, "t3code://app");
  assert.equal(guard({ host: "127.0.0.1:8793", origin: "t3code-dev://app" }).allowOrigin, "t3code-dev://app");
  for (const origin of ["null", "http://127.0.0.1:3773", "https://evil.example", "t3code://app.evil", "t3code://APP"]) {
    assert.equal(guard({ host: "127.0.0.1:8793", origin }).allowOrigin, null, origin);
  }
});

test("thread ids match with or without the mcp: prefix (read side only)", () => {
  assert.equal(normId("mcp:a06b79b7-d73a"), "a06b79b7-d73a");
  assert.equal(normId("a06b79b7-d73a"), "a06b79b7-d73a");
  assert.equal(normId(undefined), "");
});

const STATE = {
  version: 1,
  mode: "ask",
  chains: {
    "dcd3273e-870d-4000-8000-000000000001": {
      title: "Wrap side-panel thread titles", file: "/x/HANDOFF-dcd3273e.md", owner: "mcp:a06b79b7-0000-4000-8000-000000000002", pending: null,
      history: [{ at: "2026-10-19T17:43:00Z", from: "dcd3273e-870d-4000-8000-000000000001", to: "mcp:a06b79b7-0000-4000-8000-000000000002" }],
    },
    "mcp:806769b1-0000-4000-8000-000000000003": { title: "Solo", file: "/x/HANDOFF-806769b1.md", owner: "mcp:806769b1-0000-4000-8000-000000000003", pending: null },
  },
  threads: {
    "dcd3273e-870d-4000-8000-000000000001": { chain: "dcd3273e-870d-4000-8000-000000000001", predecessor: null },
    "mcp:a06b79b7-0000-4000-8000-000000000002": { chain: "dcd3273e-870d-4000-8000-000000000001", predecessor: "dcd3273e-870d-4000-8000-000000000001" },
    "mcp:806769b1-0000-4000-8000-000000000003": { chain: "mcp:806769b1-0000-4000-8000-000000000003", predecessor: null },
  },
};

test("chain position comes from the history; bare and mcp: ids are the same thread", () => {
  const second = chainView(STATE, "a06b79b7-0000-4000-8000-000000000002");
  assert.equal(second.position, 2);
  assert.equal(second.length, 2);
  assert.equal(second.short, "dcd3273e");
  assert.equal(second.current, true);
  assert.deepEqual(second.history, [{ at: "2026-10-19T17:43:00Z", from: "dcd3273e", to: "a06b79b7" }]);
  assert.deepEqual(chainView(STATE, "mcp:a06b79b7-0000-4000-8000-000000000002"), second);
  const first = chainView(STATE, "mcp:dcd3273e-870d-4000-8000-000000000001");
  assert.equal(first.position, 1);
  assert.equal(first.current, false);
  const solo = chainView(STATE, "806769b1-0000-4000-8000-000000000003");
  assert.equal(solo.position, 1);
  assert.equal(solo.length, 1);
  assert.equal(chainView(STATE, "ffffffff-0000-4000-8000-000000000009"), null);
  assert.equal(chainView({}, "x"), null);
  assert.equal(chainView(null, "x"), null);
});

const RAW = {
  now: 1792447000,
  claude: {
    age_min: 4,
    windows: [{ name: "5-hour", used: 21, resets_at: 1792457999, projection: 50.2 }, { name: "week", used: 18, resets_at: 1792961999, projection: 120.5 }],
    scoped: [{ model: "fable", used: 12 }],
    conserve: { tier: 0, tier_name: "T0 normal", today: { share: 9.8, spent: 9.0, used_up: false }, stops: [] },
  },
  codex: {
    windows: [{ name: "weekly", used: 36, resets_at: 1792886837, projection: 131.6 }],
    resets: [{ expires_at: 1793000000 }], available: 3, at_risk: [], allowed: true, reached: null, plan: "pro",
    challenge: { level: "L1", day: 15 }, gate: { action: "GO", reason: "64% left" },
  },
  codex_error: null,
};

test("usage view: REMAINING per named window, unknown stays null, never 0", () => {
  const v = usageView(RAW, 1792447000000);
  assert.deepEqual(v.claude.windows.map((w) => [w.id, w.name, w.leftPct]), [["c5h", "Claude 5-hour", 79], ["cwk", "Claude week", 82]]);
  assert.equal(v.claude.tier, "T0");
  assert.equal(v.claude.dataAt, 1792447000000 - 4 * 60000);
  assert.deepEqual(v.codex.windows.map((w) => [w.id, w.name, w.leftPct]), [["xwk", "Codex week", 64]]);
  assert.deepEqual(v.codex.gate, { action: "GO", reason: "64% left" });
  assert.equal(v.codex.resetsAvailable, 3);
  const unknown = usageView({ now: 1, claude: { windows: [{ name: "5-hour", used: null }] }, codex: null, codex_error: "boom" }, 1000);
  assert.equal(unknown.claude.windows[0].leftPct, null);
  assert.equal(unknown.claude.windows[0].usedPct, null);
  assert.equal(unknown.codex.ok, false);
});

test("generic labs from lab-usage: long/short roles, lengths, projection kept with its time and reading", () => {
  const raw = { ...RAW, claude: { ...RAW.claude, windows: RAW.claude.windows.map((w, i) => ({ ...w, mins: i ? 10080 : 300 })) },
    codex: { ...RAW.codex, windows: [{ ...RAW.codex.windows[0], mins: 10080 }] } };
  const labs = labsFromView(usageView(raw, 1792447000000));
  assert.deepEqual(labs.map((l) => l.id), ["claude", "codex"]);
  const [c, x] = labs;
  assert.deepEqual(c.windows.map((w) => [w.role, w.kind, w.lengthSec]), [["short", "session", 18000], ["long", "weekly", 604800]]);
  assert.equal(c.windows[1].projection, 120.5);
  assert.equal(c.windows[1].projectionAt, 1792447000000, "lab-usage's own clock");
  assert.equal(c.windows[1].projectionUsed, 18);
  assert.equal(c.verdict.tier, "T0");
  assert.equal(x.verdict.gate.action, "GO");
  assert.equal(x.windows[0].role, "long");
  assert.equal(c.colour, "#d97757");
  // Past the limit: the overage is kept for the text; remaining never goes below 0.
  const over = usageView({ ...RAW, claude: { ...RAW.claude, windows: [{ name: "week", used: 104, resets_at: 1792961999 }] } }, 1792447000000);
  assert.equal(over.claude.windows[0].usedPct, 104);
  assert.equal(over.claude.windows[0].leftPct, 0);
  // A stale Codex read is a lab that isn't live; an unreadable one is left out.
  assert.equal(labsFromView(usageView({ ...RAW, codex: { ...RAW.codex, stale_since: "2026-10-19T10:00:00Z" } }, 1792447000000))[1].live, false);
  assert.deepEqual(labsFromView(usageView({ now: 1, codex_error: "x" }, 1000)), []);
});

test("a stale Codex read never shows a gate verdict or reset counts", () => {
  const v = usageView({ ...RAW, codex: { ...RAW.codex, stale_since: "2026-10-19T10:00:00Z" } }, 1792447000000);
  assert.equal(v.codex.live, false);
  assert.equal(v.codex.gate, null);
  assert.equal(v.codex.resetsAvailable, null);
  assert.equal(v.codex.dataAt, Date.parse("2026-10-19T10:00:00Z"));
});

test("diag keeps only allowlisted keys with valid values: counts, flags, fixed words", () => {
  const out = diagEntry(new URLSearchParams({
    cards: "4", route: "thread", local: "true", "f.header": "on", cardH: "89|68", marker: "bar", usageAgeS: "none",
    title: "PrivateTitle", path: "/fixture/private.md", count: "2", "f.other": "on", errors: "-1", chain: "yes", v: "diag2", curW: "600px",
  }));
  assert.deepEqual(out, { cards: "4", route: "thread", local: "true", "f.header": "on", cardH: "89|68", marker: "bar", usageAgeS: "none" });
  assert.deepEqual(diagEntry(new URLSearchParams("cards=1&cards=2")), { cards: "1" });
  assert.deepEqual(diagEntry(new URLSearchParams("fh=false&fb=true&fm=true&fm=yes")), { fh: "false", fb: "true", fm: "true" });
});

// ---------- the running service ----------

let child;
let port;
before(async () => {
  const dir = path.join(tmp, "install");
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.mkdirSync(path.join(dir, "fonts"));
  for (const f of ["server.mjs", "lib.mjs", "history.mjs", "burn.mjs", "burn-core.mjs", "burn-sql-worker.mjs", "fonts.json"]) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  fs.mkdirSync(path.join(tmp, "home"));
  fs.writeFileSync(path.join(dir, "public/extras.js"), "void 0;");
  fs.writeFileSync(path.join(dir, "public/extras.css"), "html{}");
  fs.writeFileSync(path.join(dir, "fonts", "kalam-latin-400.woff2"), "FAKEFONT");
  fs.writeFileSync(path.join(dir, "fonts", "secret.txt"), "nope");
  const counter = path.join(tmp, "lab-usage-runs");
  const fake = path.join(tmp, "lab-usage");
  fs.writeFileSync(fake, `#!/bin/sh\n[ "$1 $2" = "--json --read-only" ] || exit 9\necho run >> ${JSON.stringify(counter)}\ncat ${JSON.stringify(path.join(tmp, "raw.json"))}\n`, { mode: 0o755 });
  // Dated now, so the service treats it as a fresh reading and logs it to the history.
  fs.writeFileSync(path.join(tmp, "raw.json"), JSON.stringify({ ...RAW, now: Date.now() / 1000 }));
  fs.writeFileSync(path.join(tmp, "handover.json"), JSON.stringify(STATE));
  fs.writeFileSync(path.join(tmp, "env-id"), "11111111-2222-4333-8444-555555555555\n");
  port = 18000 + Math.floor(Math.random() * 2000);
  child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
    env: { ...process.env, T3X_PORT: String(port), T3X_LAB_USAGE: fake, T3X_HANDOVER_STATE: path.join(tmp, "handover.json"), T3X_ENV_ID_FILE: path.join(tmp, "env-id"), T3X_HOME: path.join(tmp, "home"), T3X_STATEV2: path.join(tmp, "home", "no-statev2.sqlite") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("listening") && resolve());
    child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
});
after(() => child?.kill());

function get(p, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the service listens on 127.0.0.1 only", async () => {
  const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal);
  for (const i of ifaces) {
    await assert.rejects(new Promise((resolve, reject) => {
      const req = http.get({ host: i.address, port, path: "/version", timeout: 1000 }, resolve);
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
    }), `reachable on ${i.address}`);
  }
});

test("every endpoint refuses a request without T3's Origin", async () => {
  for (const p of ["/state?thread=a06b79b7-0000-4000-8000-000000000002", "/extras.js", "/extras.css", "/version", "/fonts/kalam-latin-400.woff2", "/diag?cards=1"]) {
    const r = await get(p, { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" });
    assert.equal(r.status, 403, p);
    assert.doesNotMatch(r.body, /Wrap side-panel|HANDOFF/, p);
  }
});

test("wrong Host is refused (DNS rebinding), and so is a foreign Origin", async () => {
  // The test server runs on a spare port, so the allowed Host is that port; the real one is 8793.
  assert.equal((await get("/version", { Host: `evil.example:${port}` })).status, 421);
  assert.equal((await get("/extras.js", { Origin: "https://evil.example" })).status, 403);
});

test("T3's origin gets CORS + private-network headers; OPTIONS answers; writes are refused", async () => {
  const r = await get("/extras.css", { Origin: "t3code://app" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["access-control-allow-origin"], "t3code://app");
  assert.equal(r.headers["access-control-allow-private-network"], "true");
  assert.match(r.headers.vary, /Origin/);
  const pre = await get("/state", { Origin: "t3code://app", "Access-Control-Request-Private-Network": "true" }, "OPTIONS");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-methods"], "GET");
  assert.equal((await get("/state", { Origin: "t3code://app" }, "POST")).status, 405);
  assert.equal((await get("/state", { Origin: "t3code://app" }, "PUT")).status, 405);
});

test("fonts are served from the allowlist only", async () => {
  const t3 = { Origin: "t3code://app" };
  assert.equal((await get("/fonts/kalam-latin-400.woff2", t3)).body, "FAKEFONT");
  assert.equal((await get("/fonts/secret.txt", t3)).status, 404);
  assert.equal((await get("/fonts/..%2fserver.mjs", t3)).status, 404);
  assert.equal((await get("/fonts/../server.mjs", t3)).status, 404);
});

test("/state: one shared usage snapshot, chain by bare or mcp: id, local environment id", async () => {
  const a = JSON.parse((await get("/state?thread=a06b79b7-0000-4000-8000-000000000002", { Origin: "t3code://app" })).body);
  assert.equal(a.usage.claude.tier, "T0");
  assert.equal(a.usage.codex.gate.action, "GO");
  assert.equal(a.handover.mode, "ask");
  assert.equal(a.handover.chain.position, 2);
  assert.equal(a.localEnvironmentId, "11111111-2222-4333-8444-555555555555");
  const b = JSON.parse((await get("/state?thread=" + encodeURIComponent("mcp:a06b79b7-0000-4000-8000-000000000002"), { Origin: "t3code://app" })).body);
  assert.deepEqual(b.handover.chain, a.handover.chain);
  assert.equal(b.usage.fetchedAt, a.usage.fetchedAt, "usage should come from one cached snapshot");
});

test("lab-usage runs single-flight with a 30 s floor, and only with --json --read-only", async () => {
  const runs = () => fs.readFileSync(path.join(tmp, "lab-usage-runs"), "utf8").trim().split("\n").length;
  const before = runs();
  await Promise.all([1, 2, 3, 4].map(() => get("/state?fresh=1", { Origin: "t3code://app" })));
  assert.equal(runs(), before, "a fresh read within 30 s must reuse the snapshot");
  // A request without T3's origin is refused before it can ask for a fresh read.
  assert.equal((await get("/state?fresh=1")).status, 403);
  assert.equal(runs(), before);
});

test("/state logs fresh readings to the history; /history is bounded and only for T3", async () => {
  assert.equal((await get("/history")).status, 403);
  assert.equal((await get("/history", { Origin: "https://evil.example" })).status, 403);
  const h = JSON.parse((await get("/history", { Origin: "t3code://app" })).body);
  assert.ok(Array.isArray(h.samples));
  assert.deepEqual(h.samples.map((x) => x.s).sort(), ["claude:long", "claude:short", "codex:long"]);
  assert.ok(h.samples.every((x) => Date.now() - x.ts < 15 * 60_000));
  const file = fs.readFileSync(path.join(tmp, "install", "usage-history.jsonl"), "utf8").trim().split("\n");
  assert.equal(file.length, 3, "one line per lab/window; repeated /state reads add nothing within 10 min");
  assert.equal((await get("/usage-history.jsonl", { Origin: "t3code://app" })).status, 404, "the file itself is never served");
});

test("/burn is only for T3's page, and answers with tiers and thresholds only", async () => {
  assert.equal((await get("/burn")).status, 403);
  assert.equal((await get("/burn", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await get("/burn", { Origin: "t3code://app" }, "POST")).status, 405);
  const r = await get("/burn", { Origin: "t3code://app" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["access-control-allow-origin"], "t3code://app");
  const j = JSON.parse(r.body);
  assert.deepEqual(Object.keys(j).sort(), ["generatedAt", "ok", "threads", "thresholds"]);
  assert.equal(j.ok, false, "no statev2 in the fixture home: unknown, nothing shown");
  assert.deepEqual(j.threads, {});
  assert.doesNotMatch(r.body, /\/(Users|home|tmp)\//, "no paths");
});

test("/font-catalog lists the families without URLs or hashes", async () => {
  assert.equal((await get("/font-catalog")).status, 403);
  const r = await get("/font-catalog", { Origin: "t3code://app" });
  const cat = JSON.parse(r.body);
  assert.equal(cat.families.length, 51);
  assert.doesNotMatch(r.body, /gstatic|sha256|githubusercontent/);
  assert.ok(cat.families.find((f) => f.name === "Noteworthy").local.length);
});

test("diag is refused unless it comes from T3, and stores no free text", async () => {
  assert.equal((await get("/diag?cards=1")).status, 403);
  assert.equal((await get("/diag?cards=2&title=" + encodeURIComponent("SecretThreadTitle"), { Origin: "t3code://app" })).status, 204);
  const log = fs.readFileSync(path.join(tmp, "install", "diag.log"), "utf8");
  assert.match(log, /"cards":"2"/);
  assert.doesNotMatch(log, /Secret/);
});
