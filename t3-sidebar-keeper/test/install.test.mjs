import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import * as R from '../reminders.mjs';
import { forgetApps } from './launch-services.mjs';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(process.env.HOME, 'Library/Caches/t3-restart-reminders/test-runs');
fs.mkdirSync(scratch, { recursive: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, 'install-'));
  t.after(() => { forgetApps(root); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, '.local/share/t3-sidebar-keeper');
  const plist = path.join(root, 'Library/LaunchAgents/com.cornishandy.t3-sidebar-keeper.plist');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(path.join(home, 'keeper.mjs'), 'console.log("old keeper");\n');
  fs.mkdirSync(path.join(home, 'vendor')); fs.writeFileSync(path.join(home, 'vendor/sentinel'), 'original');
  fs.writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>old</string></dict></plist>');
  for (const name of ['reminders.json', 'state.json', 'disabled.json']) fs.writeFileSync(path.join(home, name), `user-owned ${name}`);
  fs.mkdirSync(path.join(home, 'backups')); fs.writeFileSync(path.join(home, 'backups/sentinel'), 'original archive backup');
  const app = path.join(root, 'prebuilt.app'); fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.copyFileSync(path.join(src, 'reminders-helper/Info.plist'), path.join(app, 'Contents/Info.plist'));
  fs.mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Resources/native-generation'), crypto.createHash('sha256').update(fs.readFileSync(path.join(src, 'reminders-helper/main.swift'))).update(fs.readFileSync(path.join(src, 'reminders.mjs'))).digest('hex') + '\n');
  fs.writeFileSync(path.join(app, 'Contents/MacOS/T3 Restart Reminders'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, HOME: root, T3_KEEPER_INSTALL_ROOT: root, T3_KEEPER_STAGE_PARENT: root, T3_REMINDERS_SKIP_BUILD: '1', T3_REMINDERS_PREBUILT_APP: app };
  return { root, home, plist, app, env };
}
const install = (f, extra = {}, args = []) => spawnSync('/bin/bash', [path.join(src, 'install.sh'), ...args], { encoding: 'utf8', env: { ...f.env, ...extra }, timeout: 45000 });
const old = f => {
  assert.equal(fs.readFileSync(path.join(f.home, 'keeper.mjs'), 'utf8'), 'console.log("old keeper");\n');
  assert.equal(fs.readFileSync(path.join(f.home, 'vendor/sentinel'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(f.home, 'reminders.mjs')), false);
};
const mutable = f => {
  for (const name of ['reminders.json', 'state.json', 'disabled.json']) assert.equal(fs.readFileSync(path.join(f.home, name), 'utf8'), `user-owned ${name}`);
  assert.equal(fs.readFileSync(path.join(f.home, 'backups/sentinel'), 'utf8'), 'original archive backup');
};
const logs = f => fs.existsSync(path.join(f.root, 'launchctl.log')) ? fs.readFileSync(path.join(f.root, 'launchctl.log'), 'utf8') : '';
async function until(fn) { const end = Date.now() + 10000; while (!fn()) { if (Date.now() > end) throw new Error('fixture timed out'); await new Promise(r => setTimeout(r, 10)); } }
function child(f, extra = {}) {
  const proc = spawn('/bin/bash', [path.join(src, 'install.sh')], { env: { ...f.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; proc.stdout.on('data', c => { output += c; }); proc.stderr.on('data', c => { output += c; });
  return { proc, done: new Promise((resolve, reject) => { proc.on('error', reject); proc.on('exit', (code, signal) => resolve({ code, signal, output })); }) };
}

for (const boundary of ['stage', 'validate', 'quiesce', 'replace-1', 'replace-2', 'replace-3', 'replace-4', 'replace-5', 'replace', 'plist', 'bootstrap']) {
  test(`installer failure at ${boundary} restores compatible code and keeps mutable state`, t => {
    const f = fixture(t); const result = install(f, { T3_KEEPER_INSTALL_FAIL_AT: boundary });
    assert.notEqual(result.status, 0, result.stdout + result.stderr); old(f); mutable(f);
    assert.equal(fs.existsSync(path.join(f.home, 'install-in-progress.json')), false);
    if (['stage', 'validate'].includes(boundary)) assert.equal(logs(f), '', 'staging must precede scheduler quiescence');
    else assert.match(logs(f), /bootout.*\nbootstrap/s);
  });
}
test('successful install retains runnable rollback; explicit rollback never restores user data', t => {
  const f = fixture(t); let result = install(f); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.home, 'keeper.mjs'), 'utf8'), fs.readFileSync(path.join(src, 'keeper.mjs'), 'utf8')); mutable(f);
  const backups = fs.readdirSync(path.join(f.home, 'install-rollback')); assert.equal(backups.length, 1);
  const backup = path.join(f.home, 'install-rollback', backups[0]);
  assert.equal(fs.existsSync(path.join(backup, 'reminders.json')), false, 'mutable state must never enter a code rollback');
  fs.writeFileSync(path.join(f.home, 'reminders.json'), 'snooze accepted after installation');
  result = install(f, {}, ['--rollback', backup]); assert.equal(result.status, 0, result.stderr);
  old(f); assert.equal(fs.readFileSync(path.join(f.home, 'reminders.json'), 'utf8'), 'snooze accepted after installation');
});
test('manual keeper during installation fails busy before importing a missing sibling', async t => {
  const f = fixture(t); let result = install(f); assert.equal(result.status, 0, result.stderr);
  const flag = path.join(f.root, 'paused'); const job = child(f, { T3_KEEPER_INSTALL_PAUSE_AT: 'replace', T3_KEEPER_INSTALL_PAUSE_FLAG: flag });
  await until(() => fs.existsSync(flag));
  fs.renameSync(path.join(f.home, 'reminders.mjs'), path.join(f.home, 'temporarily-missing'));
  const cmd = spawnSync(process.execPath, [path.join(f.home, 'keeper.mjs'), '--snooze', '3h'], { encoding: 'utf8', env: { ...f.env, T3_KEEPER_HOME: f.home } });
  assert.equal(cmd.status, 75); assert.equal(JSON.parse(cmd.stdout).error, 'busy');
  fs.renameSync(path.join(f.home, 'temporarily-missing'), path.join(f.home, 'reminders.mjs'));
  fs.unlinkSync(flag); const done = await job.done; assert.equal(done.code, 0, done.output);
});
test('installer waits for an in-flight old command and preserves its acknowledged snooze', async t => {
  const f = fixture(t); const lease = R.acquireKernelLock(path.join(f.home, 'code.flock'));
  const job = child(f); await until(() => fs.existsSync(path.join(f.home, 'install-in-progress.json')));
  await new Promise(r => setTimeout(r, 100)); old(f);
  fs.writeFileSync(path.join(f.home, 'reminders.json'), 'in-flight durable snooze');
  R.releaseReminderLock(lease);
  const done = await job.done; assert.equal(done.code, 0, done.output);
  assert.equal(fs.readFileSync(path.join(f.home, 'reminders.json'), 'utf8'), 'in-flight durable snooze');
});
test('unanticipated filesystem error after replacement also restores old code', async t => {
  const f = fixture(t); const flag = path.join(f.root, 'paused');
  const job = child(f, { T3_KEEPER_INSTALL_PAUSE_AT: 'replace', T3_KEEPER_INSTALL_PAUSE_FLAG: flag });
  await until(() => fs.existsSync(flag));
  const stage = fs.readdirSync(f.root).find(n => n.startsWith('t3-keeper-stage.'));
  fs.rmSync(path.join(f.root, stage, 'vendor'), { recursive: true });
  fs.unlinkSync(flag); const done = await job.done; assert.notEqual(done.code, 0, done.output); old(f); mutable(f);
});
test('interrupted replacing marker recovers old code; complete marker retains accepted code', t => {
  for (const phase of ['quiescing', 'replacing', 'complete']) {
    const f = fixture(t); const backup = path.join(f.home, 'install-rollback', 'interrupted');
    fs.mkdirSync(path.join(backup, 'vendor'), { recursive: true });
    fs.copyFileSync(path.join(f.home, 'keeper.mjs'), path.join(backup, 'keeper.mjs'));
    fs.copyFileSync(path.join(f.home, 'vendor/sentinel'), path.join(backup, 'vendor/sentinel'));
    fs.copyFileSync(f.plist, path.join(backup, 'old.plist'));
    fs.writeFileSync(path.join(f.home, 'keeper.mjs'), 'console.log("accepted new code");\n');
    R.writeDurable(path.join(f.home, 'install-in-progress.json'), { phase, backup });
    const result = install(f, { T3_KEEPER_INSTALL_FAIL_AT: 'quiesce' }); assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(f.home, 'keeper.mjs'), 'utf8'), phase === 'replacing' ? 'console.log("old keeper");\n' : 'console.log("accepted new code");\n');
    mutable(f);
  }
});
