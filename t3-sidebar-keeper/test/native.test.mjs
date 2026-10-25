// Headless native fixtures validate acknowledgments and fixed routing. These
// do not claim that macOS delivered a real notification action; parent tests it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import * as R from '../reminders.mjs';
import { forgetApps, registeredUnder, LSREGISTER } from './launch-services.mjs';
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(process.env.HOME, 'Library/Caches/t3-restart-reminders/test-runs');
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, 'native-'));
const bin = path.join(root, 'T3 Restart Reminders.app/Contents/MacOS/T3 Restart Reminders');
const script = path.join(root, 'reminders.mjs');
const env = { ...process.env, HOME: root, T3_KEEPER_HOME: '/this-override-must-be-ignored' };
const invoke = (args, input = '') => spawnSync(bin, args, { encoding: 'utf8', env, input, timeout: 10000 });
const verdict = (status, obj, kind = 'snooze') => invoke(['--mode', 'classify-cli-result'], JSON.stringify({ status, stdout: typeof obj === 'string' ? obj : JSON.stringify(obj), kind }));
before(() => {
  const build = spawnSync('/bin/bash', [path.join(src, 'reminders-helper/build.sh'), root], { encoding: 'utf8', env, timeout: 180000 });
  assert.equal(build.status, 0, build.stdout + build.stderr);
});
after(() => { forgetApps(root); fs.rmSync(root, { recursive: true, force: true }); });
test('build unregisters a copy that macOS had registered at its output path', (t) => {
  const out = fs.mkdtempSync(path.join(scratch, 'native-register-'));
  t.after(() => { forgetApps(out); fs.rmSync(out, { recursive: true, force: true }); });
  const app = path.join(out, 'T3 Restart Reminders.app');
  fs.cpSync(path.join(root, 'T3 Restart Reminders.app'), app, { recursive: true });
  assert.equal(spawnSync(LSREGISTER, ['-f', app]).status, 0);
  assert.deepEqual(registeredUnder(out), [app], 'fixture must start registered');
  const build = spawnSync('/bin/bash', [path.join(src, 'reminders-helper/build.sh'), out], { encoding: 'utf8', env, timeout: 180000 });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  assert.deepEqual(registeredUnder(out), []);
});
test('packaged native helper distinguishes durable success, busy, stale, errors, malformed and zero-exit non-durable output', () => {
  const valid = { ok: true, durable: true, snoozeUntil: new Date().toISOString(), appliedMs: 10800000 };
  let out = verdict(0, valid); assert.equal(out.status, 0, out.stderr); assert.equal(JSON.parse(out.stdout).success, true);
  for (const [status, obj, reason] of [
    [75, { ok: false, error: 'busy' }, 'busy'], [2, { ok: false, error: 'stale' }, 'stale'],
    [1, valid, 'cli-status'], [0, { ok: true }, 'not-durable'], [0, 'garbage', 'malformed'],
    [0, { ...valid, snoozeUntil: 'bad' }, 'malformed'], [0, { ...valid, appliedMs: 0 }, 'malformed'],
  ]) { out = verdict(status, obj); assert.notEqual(out.status, 0); assert.equal(JSON.parse(out.stdout).reason, reason); }
});
test('post dry-run never invokes Node or asks permission; authorization status never requests it', () => {
  let out = invoke(['--mode', 'post', '--dry-run'], '{}'); assert.equal(out.status, 0, out.stderr);
  let obj = JSON.parse(out.stdout); assert.equal(obj.nodeInvoked, false); assert.equal(obj.requested, false); assert.equal(obj.posted, false);
  out = invoke(['--mode', 'auth-status']); assert.equal(out.status, 0, out.stderr); obj = JSON.parse(out.stdout);
  assert.equal(obj.ok, true); assert.equal(obj.requested, false); assert.equal(obj.nodeInvoked, false); assert.equal(typeof obj.authorization, 'string');
});
test('cold-safe diagnostic action routes to fixed bundle sibling without inherited home override', () => {
  const realScript = fs.readFileSync(path.join(src, 'reminders.mjs')); fs.writeFileSync(script, realScript);
  const node = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, HOME: root, T3_KEEPER_HOME: root }, timeout: 10000 });
  let out = node(['--diagnostic-create', '--namespace', 'diagnostic', '--generation', 'test-native']); assert.equal(out.status, 0, out.stderr);
  const production = Buffer.from('production state must stay byte-identical'); fs.writeFileSync(path.join(root, 'reminders.json'), production);
  out = invoke(['--mode', 'deliver-action', '--action', 'snooze', '--namespace', 'diagnostic', '--generation', 'test-native', '--captured-ms', '10800000']);
  assert.equal(out.status, 0, out.stderr); assert.equal(JSON.parse(out.stdout).success, true);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'reminders-diagnostic.json'))).snoozeUntil);
  assert.deepEqual(fs.readFileSync(path.join(root, 'reminders.json')), production);
  out = invoke(['--mode', 'deliver-action', '--action', 'snooze', '--namespace', 'diagnostic', '--generation', 'test-stale', '--captured-ms', '10800000']);
  assert.equal(out.status, 2); assert.match(fs.readFileSync(path.join(root, 'reminder-helper.log'), 'utf8'), /stale/);
});
test('native action failure and timeout remain explicit and log only in the fake home bundle folder', () => {
  fs.writeFileSync(script, 'console.log(JSON.stringify({ok:true}));');
  let out = invoke(['--mode', 'deliver-action', '--action', 'snooze', '--namespace', 'diagnostic', '--generation', 'test-native', '--captured-ms', '10800000']);
  assert.notEqual(out.status, 0); assert.equal(JSON.parse(out.stdout).reason, 'not-durable');
  fs.writeFileSync(script, 'setInterval(()=>{},1000);');
  out = invoke(['--mode', 'deliver-action', '--action', 'snooze', '--namespace', 'diagnostic', '--generation', 'test-native', '--captured-ms', '10800000', '--timeout-seconds', '0.1']);
  assert.notEqual(out.status, 0); assert.equal(JSON.parse(out.stdout).error, 'timeout');
  out = invoke(['--mode', 'deliver-action', '--action', 'snooze', '--namespace', 'diagnostic', '--generation', 'test-native', '--captured-ms', '10800000', '--state', '/arbitrary']);
  assert.notEqual(out.status, 0); assert.equal(JSON.parse(out.stdout).error, 'state-path');
  assert.match(fs.readFileSync(path.join(root, 'reminder-helper.log'), 'utf8'), /timeout/);
});


test('packaged nonmutating lifecycle exits cold, preserves a warm window/other action, then exits idle', () => {
  for (const branch of ['dismiss', 'invalid', 'unknown']) {
    for (const keep of [[], ['--probe-window'], ['--probe-in-flight']]) {
      const out = invoke(['--mode', 'lifecycle-probe', '--namespace', 'diagnostic', '--generation', 'test-lifecycle', '--probe-branch', branch, ...keep]);
      assert.equal(out.status, 0, out.stderr);
      const lines = out.stdout.trim().split('\n').map(JSON.parse);
      assert.equal(lines[0].completionCalled, true); assert.equal(lines[0].nodeInvoked, false);
      assert.equal(lines[0].keptAlive, keep.length > 0);
      if (keep.length) assert.equal(lines[1].preservedWindowOrAction, true);
    }
  }
});
test('actual packaged entry rejects maintenance, exclusive native barrier, and a different embedded code generation', () => {
  const file = path.join(root, 'native.flock'); const held = R.acquireKernelLock(file);
  try { const out = invoke(['--mode', 'auth-status']); assert.equal(out.status, 75); assert.equal(JSON.parse(out.stdout).error, 'busy'); }
  finally { R.releaseReminderLock(held); }
  const marker = path.join(root, 'install-in-progress.json'); fs.writeFileSync(marker, '{}');
  fs.renameSync(script, script + '.missing');
  let out = invoke(['--mode', 'auth-status']); assert.equal(out.status, 75); assert.equal(JSON.parse(out.stdout).nodeInvoked, false);
  fs.renameSync(script + '.missing', script); fs.unlinkSync(marker);
  const tokenFile = path.join(root, 'T3 Restart Reminders.app/Contents/Resources/native-generation');
  const token = fs.readFileSync(tokenFile); fs.writeFileSync(tokenFile, 'a different installed code generation');
  out = invoke(['--mode', 'auth-status']); assert.equal(out.status, 75); fs.writeFileSync(tokenFile, token);
});
async function until(fn) { const end = Date.now() + 10000; while (!fn()) { if (Date.now() > end) throw new Error('native fixture timed out'); await new Promise(r => setTimeout(r, 10)); } }
function nativeInstallFixture(t) {
  const froot = fs.mkdtempSync(path.join(scratch, 'native-install-')); t.after(() => { forgetApps(froot); fs.rmSync(froot, { recursive: true, force: true }); });
  const home = path.join(froot, '.local/share/t3-sidebar-keeper'); fs.mkdirSync(home, { recursive: true });
  const app = path.join(home, 'T3 Restart Reminders.app'); fs.cpSync(path.join(root, 'T3 Restart Reminders.app'), app, { recursive: true });
  for (const item of ['keeper.mjs', 'reminders.mjs']) fs.copyFileSync(path.join(src, item), path.join(home, item));
  fs.cpSync(path.join(src, 'vendor'), path.join(home, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(home, 'reminders.json'), 'user-owned mutable policy');
  const plist = path.join(froot, 'Library/LaunchAgents/com.cornishandy.t3-sidebar-keeper.plist'); fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>old</string></dict></plist>');
  return { froot, home, app, exe: path.join(app, 'Contents/MacOS/T3 Restart Reminders'), env: { ...process.env, HOME: froot, T3_KEEPER_INSTALL_ROOT: froot, T3_KEEPER_STAGE_PARENT: froot, T3_REMINDERS_SKIP_BUILD: '1', T3_REMINDERS_PREBUILT_APP: path.join(root, 'T3 Restart Reminders.app'), T3_REMINDERS_PREBUILT_PROC: path.join(root, 'proc-birth') } };
}
function installChild(f, args = [], extra = {}) {
  const proc = spawn('/bin/bash', [path.join(src, 'install.sh'), ...args], { env: { ...f.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; proc.stdout.on('data', c => { output += c; }); proc.stderr.on('data', c => { output += c; });
  return { proc, done: new Promise((resolve, reject) => { proc.on('error', reject); proc.on('exit', code => resolve({ code, output })); }) };
}
test('actual packaged helper cannot enter after installer quiescence during update or code rollback', async t => {
  const f = nativeInstallFixture(t);
  let backup;
  for (const args of [[], 'rollback']) {
    const flag = path.join(f.froot, 'paused');
    const job = installChild(f, args === 'rollback' ? ['--rollback', backup] : args, { T3_KEEPER_INSTALL_PAUSE_AT: 'replace', T3_KEEPER_INSTALL_PAUSE_FLAG: flag });
    await until(() => fs.existsSync(flag));
    const entrant = spawnSync(f.exe, ['--mode', 'lifecycle-probe', '--namespace', 'diagnostic', '--generation', 'test-late', '--probe-in-flight'], { encoding: 'utf8', env: f.env, timeout: 5000 });
    assert.equal(entrant.status, 75, entrant.stderr); assert.equal(JSON.parse(entrant.stdout).error, 'busy');
    fs.unlinkSync(flag); const result = await job.done; assert.equal(result.code, 0, result.output);
    const record = JSON.parse(result.output.split('\n').find(line => line.startsWith('{'))); backup = record.rollback;
    assert.equal(fs.readFileSync(path.join(f.home, 'reminders.json'), 'utf8'), 'user-owned mutable policy');
  }
});
test('installer drains an admitted native lifetime lease before replacing code', async t => {
  const f = nativeInstallFixture(t); const start = Date.now();
  const helper = spawn(f.exe, ['--mode', 'lifecycle-probe', '--namespace', 'diagnostic', '--generation', 'test-drain', '--probe-in-flight', '--probe-hold-seconds', '2'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; helper.stdout.on('data', c => { output += c; });
  const done = new Promise(resolve => helper.on('exit', (code, signal) => resolve({ code, signal })));
  await until(() => output.includes('completionCalled'));
  const job = installChild(f); const result = await job.done; const finished = await done;
  assert.equal(result.code, 0, result.output); assert.equal(finished.code, 0); assert.equal(finished.signal, null);
  assert.ok(Date.now() - start >= 1800, 'installer must wait for the admitted in-flight lifetime');
  assert.equal(fs.readFileSync(path.join(f.home, 'reminders.json'), 'utf8'), 'user-owned mutable policy');
});
