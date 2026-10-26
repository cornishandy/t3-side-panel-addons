// Fresh defaults, interrupted retries, and node-path. The real home and launchd are not used.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-keeper-public-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

function prebuilt(root) {
  const app = path.join(root, "prebuilt.app");
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents/Resources"), { recursive: true });
  fs.copyFileSync(path.join(src, "reminders-helper/Info.plist"), path.join(app, "Contents/Info.plist"));
  const token = crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(src, "reminders-helper/main.swift")))
    .update(fs.readFileSync(path.join(src, "reminders.mjs")))
    .digest("hex");
  fs.writeFileSync(path.join(app, "Contents/Resources/native-generation"), `${token}\n`);
  fs.writeFileSync(path.join(app, "Contents/MacOS/T3 Restart Reminders"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return app;
}

function install(root, nodePath, extraEnv = {}) {
  const app = prebuilt(root);
  return spawnSync("/bin/bash", [path.join(src, "install.sh")], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      HOME: root,
      T3_KEEPER_INSTALL_ROOT: root,
      T3_KEEPER_STAGE_PARENT: root,
      T3_REMINDERS_SKIP_BUILD: "1",
      T3_REMINDERS_PREBUILT_APP: app,
      T3X_NODE: nodePath,
      ...extraEnv,
    },
  });
}

const homeOf = (root) => path.join(root, ".local/share/t3-sidebar-keeper");
const read = (file) => fs.readFileSync(file, "utf8");
const mode = (file) => fs.lstatSync(file).mode & 0o777;

test("a fresh install writes the personal defaults, then drops the marker", () => {
  const root = fs.mkdtempSync(path.join(scratch, "fresh-"));
  const nodePath = path.join(root, ".nvm", "node");
  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.symlinkSync(fs.realpathSync(process.execPath), nodePath);
  const result = install(root, nodePath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /version manager/);
  assert.match(result.stdout, new RegExp(nodePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const home = homeOf(root);
  assert.equal(mode(home), 0o700);
  assert.equal(read(path.join(home, "disabled.json")), "{\"disabled\":[\"rule\",\"fit\",\"titleGuide\"]}\n");
  assert.equal(read(path.join(home, "restart-reminders-disabled.json")), "{\"disabled\":true}\n");
  assert.equal(fs.existsSync(path.join(home, "defaults-pending")), false);
  assert.equal(read(path.join(home, "node-path")), `${nodePath}\n`);
  assert.equal(mode(path.join(home, "node-path")), 0o600);
  assert.notEqual(nodePath, fs.realpathSync(nodePath));
  const plist = JSON.parse(spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(root, "Library/LaunchAgents/com.cornishandy.t3-sidebar-keeper.plist")], { encoding: "utf8" }).stdout);
  assert.equal(plist.ProgramArguments[0], nodePath);
  assert.equal(plist.Label, "com.cornishandy.t3-sidebar-keeper");
});

test("an interrupted fresh install finishes defaults and does not replace a disabled.json", () => {
  const root = fs.mkdtempSync(path.join(scratch, "retry-"));
  const home = homeOf(root);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "defaults-pending"), "pending\n", { mode: 0o600 });
  fs.writeFileSync(path.join(home, "disabled.json"), "{\"disabled\":[\"extras\"]}\n", { mode: 0o600 });
  const result = install(root, process.execPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(path.join(home, "disabled.json")), "{\"disabled\":[\"extras\"]}\n");
  assert.equal(read(path.join(home, "restart-reminders-disabled.json")), "{\"disabled\":true}\n");
  assert.equal(fs.existsSync(path.join(home, "defaults-pending")), false);
});

test("a marker with both default files already written removes only the marker", () => {
  const root = fs.mkdtempSync(path.join(scratch, "both-"));
  const home = homeOf(root);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "defaults-pending"), "pending\n");
  fs.writeFileSync(path.join(home, "disabled.json"), "custom-disabled\n");
  fs.writeFileSync(path.join(home, "restart-reminders-disabled.json"), "custom-reminders\n");
  const result = install(root, process.execPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(path.join(home, "disabled.json")), "custom-disabled\n");
  assert.equal(read(path.join(home, "restart-reminders-disabled.json")), "custom-reminders\n");
  assert.equal(fs.existsSync(path.join(home, "defaults-pending")), false);
});

test("an existing keeper with no disabled.json gets no fresh defaults", () => {
  const root = fs.mkdtempSync(path.join(scratch, "owner-"));
  const home = homeOf(root);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "keeper.mjs"), "existing keeper\n");
  const result = install(root, process.execPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(home, "disabled.json")), false);
  assert.equal(fs.existsSync(path.join(home, "restart-reminders-disabled.json")), false);
  assert.equal(fs.existsSync(path.join(home, "defaults-pending")), false);
  assert.equal(read(path.join(home, "node-path")), `${process.execPath}\n`);
});

test("a marker alone still writes both default files", () => {
  const root = fs.mkdtempSync(path.join(scratch, "marker-"));
  const home = homeOf(root);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "defaults-pending"), "pending\n");
  const result = install(root, process.execPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(path.join(home, "disabled.json")), "{\"disabled\":[\"rule\",\"fit\",\"titleGuide\"]}\n");
  assert.equal(read(path.join(home, "restart-reminders-disabled.json")), "{\"disabled\":true}\n");
  assert.equal(fs.existsSync(path.join(home, "defaults-pending")), false);
});

for (const stage of ["replace", "bootstrap"]) {
  test(`a rollback after a failure at ${stage} restarts the job only with a regular 0600 keeper.log`, () => {
    const root = fs.mkdtempSync(path.join(scratch, `rollback-${stage}-`));
    assert.equal(install(root, process.execPath).status, 0);
    const home = homeOf(root);
    const target = path.join(root, "target.txt");
    fs.writeFileSync(target, "keep\n", { mode: 0o644 });
    fs.rmSync(path.join(home, "keeper.log"), { force: true });
    fs.symlinkSync(target, path.join(home, "keeper.log"));
    const failed = install(root, process.execPath, { T3_KEEPER_INSTALL_FAIL_AT: stage });
    assert.notEqual(failed.status, 0);
    const log = path.join(home, "keeper.log");
    assert.equal(fs.lstatSync(log).isSymbolicLink(), false);
    assert.equal(mode(log), 0o600);
    assert.equal(read(target), "keep\n");
    assert.equal(mode(target), 0o644);
    assert.match(read(path.join(root, "launchctl.log")), /bootstrap[^\n]*\n?$/);
  });
}
