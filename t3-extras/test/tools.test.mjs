// Optional tools: absent, present, removed, then restored. Never binds port 8793.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-tools-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const RAW = {
  now: Date.now() / 1000,
  claude: { age_min: 1, windows: [{ name: "week", used: 10, resets_at: Date.now() / 1000 + 86400, mins: 10080 }] },
  codex: null,
  codex_error: null,
};

function copyServer(dir) {
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.mkdirSync(path.join(dir, "fonts"), { recursive: true });
  for (const file of ["server.mjs", "lib.mjs", "history.mjs", "burn.mjs", "burn-core.mjs", "burn-sql-worker.mjs", "fonts.json", "payload.mjs", "private-file.mjs"]) {
    fs.copyFileSync(path.join(SRC, file), path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, "public/extras.js"), "void 0;\n");
  fs.writeFileSync(path.join(dir, "public/extras.css"), "html{}\n");
}

function start(dir, port, env) {
  const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
    env: { ...process.env, ...env, T3X_PORT: String(port), T3X_HOME: path.join(tmp, "home"), T3X_STATEV2: path.join(tmp, "no-state.sqlite") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not listen: ${output.join("")}`)), 8000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${output.join("")}`));
    });
  });
  return { child, ready };
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, headers: { Host: `127.0.0.1:${port}`, Origin: "t3code://app" } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("lab-usage and handover go absent, present, removed, then restored", async () => {
  const dir = path.join(tmp, "cycle");
  copyServer(dir);
  const counter = path.join(tmp, "runs");
  const lab = path.join(tmp, "lab-usage");
  const handover = path.join(tmp, "handover");
  const state = path.join(tmp, "handover.json");
  fs.writeFileSync(state, JSON.stringify({
    version: 1, mode: "ask",
    chains: { "c0ffee00-0000-4000-8000-000000000002": { title: "Chain", file: "/tmp/handoff.md", owner: "c0ffee00-0000-4000-8000-000000000002", pending: null, history: [] } },
    threads: { "c0ffee00-0000-4000-8000-000000000002": { chain: "c0ffee00-0000-4000-8000-000000000002", predecessor: null } },
  }));
  fs.writeFileSync(path.join(tmp, "raw.json"), JSON.stringify(RAW));
  const script = `#!/bin/sh\necho ran >> ${JSON.stringify(counter)}\ncat ${JSON.stringify(path.join(tmp, "raw.json"))}\n`;
  const port = 19000 + Math.floor(Math.random() * 2000);
  assert.notEqual(port, 8793);
  const started = start(dir, port, {
    T3X_LAB_USAGE: lab,
    T3X_HANDOVER_BIN: handover,
    T3X_HANDOVER_STATE: state,
    T3X_ENV_ID_FILE: path.join(tmp, "env-id"),
  });
  await started.ready;
  try {
    const absent = JSON.parse((await get(port, "/state?thread=c0ffee00-0000-4000-8000-000000000002")).body);
    assert.deepEqual(absent.tools, { labUsage: false, handover: false });
    assert.deepEqual(absent.usage.labs, []);
    assert.equal(absent.usage.failedAt, null);
    assert.equal(absent.handover.chain, null, "no handover data without the handover tool");
    assert.equal(fs.existsSync(counter), false, "lab-usage was spawned while absent");

    fs.writeFileSync(lab, script, { mode: 0o755 });
    fs.writeFileSync(handover, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const present = JSON.parse((await get(port, "/state?fresh=1&thread=c0ffee00-0000-4000-8000-000000000002")).body);
    assert.deepEqual(present.tools, { labUsage: true, handover: true });
    assert.ok(present.usage.labs.some((labRow) => labRow.id === "claude"));
    assert.match(fs.readFileSync(counter, "utf8"), /ran/);
    assert.equal(present.handover.chain.file, "/tmp/handoff.md");

    fs.rmSync(lab);
    fs.rmSync(handover);
    const removed = JSON.parse((await get(port, "/state?fresh=1&thread=c0ffee00-0000-4000-8000-000000000002")).body);
    assert.deepEqual(removed.tools, { labUsage: false, handover: false });
    assert.deepEqual(removed.usage.labs, []);
    assert.equal(removed.usage.failedAt, null);
    assert.equal(removed.handover.chain, null, "no handover data once the tool is removed");
    const runs = fs.readFileSync(counter, "utf8");

    fs.writeFileSync(lab, script, { mode: 0o755 });
    fs.writeFileSync(handover, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const restored = JSON.parse((await get(port, "/state?fresh=1&thread=c0ffee00-0000-4000-8000-000000000002")).body);
    assert.deepEqual(restored.tools, { labUsage: true, handover: true });
    assert.ok(fs.readFileSync(counter, "utf8").length > runs.length);
  } finally {
    started.child.kill();
  }
});

test("diag does not follow a symlink and a real diag file is mode 0600", async () => {
  const dir = path.join(tmp, "diag");
  copyServer(dir);
  const target = path.join(tmp, "diag-target");
  fs.writeFileSync(target, "keep\n", { mode: 0o644 });
  fs.symlinkSync(target, path.join(dir, "diag.log"));
  const port = 21000 + Math.floor(Math.random() * 2000);
  assert.notEqual(port, 8793);
  const started = start(dir, port, { T3X_LAB_USAGE: path.join(tmp, "missing-lab"), T3X_HANDOVER_BIN: path.join(tmp, "missing-handover") });
  await started.ready;
  try {
    assert.equal((await get(port, "/diag?cards=1")).status, 204);
    assert.equal(fs.readFileSync(target, "utf8"), "keep\n");
    assert.equal(fs.lstatSync(target).mode & 0o777, 0o644);
    assert.equal(fs.lstatSync(path.join(dir, "diag.log")).isSymbolicLink(), true);
  } finally {
    started.child.kill();
  }
});
