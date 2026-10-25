import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import * as R from '../reminders.mjs';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(process.env.HOME, 'Library/Caches/t3-restart-reminders/test-runs');
fs.mkdirSync(scratch, { recursive: true });
const now = 1800000000000;
const app = '/fixture/T3 Code.app';
const exe = `${app}/Contents/MacOS/T3 Code`;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(scratch, 'reminder-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'app.asar'); fs.writeFileSync(file, 'fixture archive');
  const st = fs.statSync(file);
  const archive = { dev: st.dev, ino: st.ino, size: st.size, birthtimeMs: st.birthtimeMs };
  return { home, file, archive, state: path.join(home, 'reminders.json') };
}
function published(f, { build = 'one', archive = f.archive, reasons = ['firstClick'], uiChanged = false, live = 'updated', at = now } = {}) {
  R.notePrepared({ home: f.home, build, intended: archive, startupReasons: reasons, uiChanged });
  const boundaryUs = R.noteCommitted({ home: f.home, intended: archive, nowMs: at });
  return R.noteFinalized({ home: f.home, build, intended: archive, startupReasons: reasons, uiChanged, live, boundaryUs, nowMs: at });
}
function observation(archive, processes = [], evidence = 'ok') {
  return { evidence, appPath: app, archive, processes, openers: processes.map(p => ({ pid: p.pid, ino: archive.ino, dev: archive.dev })) };
}
const main = (pid, startUs, extra = {}) => ({ pid, startUs, startPrecise: true, exe, args: exe, ...extra });
function tick(f, at = now, more = {}) {
  return R.schedulerTick({ home: f.home, nowMs: at, appPath: app, asarPath: f.file, actual: f.archive, observation: observation(f.archive), post: () => ({ accepted: true }), ...more });
}
const load = f => R.readStateFile(f.state).state;
function cli(f, args, extra = {}) {
  return spawnSync(process.execPath, [path.join(src, 'keeper.mjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: f.home, T3_KEEPER_HOME: f.home, T3_ASAR_PATH: f.file, T3_APP_PATH: app, T3_KEEPER_QUIET: '1', ...extra }, timeout: 10000,
  });
}
function worker(f, script, args = []) {
  const file = path.join(f.home, `worker-${crypto.randomBytes(5).toString('hex')}.mjs`);
  fs.writeFileSync(file, `import fs from 'node:fs'; import * as R from ${JSON.stringify(new URL('../reminders.mjs', import.meta.url).href)};\n${script}`);
  const proc = spawn(process.execPath, [file, f.home, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; proc.stderr.on('data', c => { output += c; });
  const done = new Promise((resolve, reject) => { proc.on('error', reject); proc.on('exit', (code, signal) => resolve({ code, signal, output })); });
  return { proc, done };
}
async function until(fn) {
  const end = Date.now() + 10000;
  while (!fn()) { if (Date.now() > end) throw new Error('fixture timed out'); await new Promise(r => setTimeout(r, 10)); }
}

test('immediate first alert; repeated 30s ticks and wake submit only one due alert', t => {
  const f = fixture(t); published(f);
  assert.equal(tick(f).submitted, true);
  for (let i = 1; i < 30; i++) assert.equal(tick(f, now + i * 30000).submitted, false);
  assert.equal(tick(f, now + 900000).submitted, true);
  assert.equal(tick(f, now + 10 * 900000).submitted, true);
  assert.equal(tick(f, now + 10 * 900000).submitted, false);
});

test('permanent opt-out survives future builds, expiry and resume without posting', t => {
  const f = fixture(t); published(f);
  R.writeDurable(path.join(f.home, 'restart-reminders-disabled.json'), { disabled: true });
  let posts = 0;
  const post = () => { posts++; return { accepted: true }; };
  assert.equal(tick(f, now, { post }).reason, 'disabled');
  R.resumeReminders({ home: f.home, nowMs: now + 1 });
  published(f, { build: 'next-nightly', archive: { ...f.archive, ino: f.archive.ino + 1 } });
  assert.equal(tick(f, now + 365 * 86400000, { post }).reason, 'disabled');
  assert.equal(posts, 0);
  const view = R.reminderStatus({ home: f.home, observe: false });
  assert.equal(view.enabled, false);
  assert.equal(view.pending, null);
  assert.equal(view.due, false);
  assert.equal(view.presentation.title, '');
  assert.equal(R.defaultPost({}, f.home).error, 'disabled');
  const resumed = cli(f, ['--resume-reminders']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).disabled, true);
  assert.equal(R.restartRemindersDisabled(f.home), true);
});
test('dismiss is unchanged; snooze exact expiry persists and resume forces one tick', t => {
  const f = fixture(t); published(f); tick(f);
  const generation = load(f).pending.generation;
  R.applyAction({ home: f.home, generation, action: 'dismiss', nowMs: now });
  R.snoozeFor({ home: f.home, duration: '3h', nowMs: now });
  assert.equal(tick(f, now + 10800000 - 1).submitted, false);
  assert.equal(tick(f, now + 10800000).submitted, true);
  R.snoozeFor({ home: f.home, duration: '1h', nowMs: now + 10800000 });
  R.resumeReminders({ home: f.home, nowMs: now + 10800001 });
  assert.equal(tick(f, now + 10800001).submitted, true);
  assert.equal(tick(f, now + 10800001).submitted, false);
});
test('generation replacement and interval edits preserve root snooze; stale action rejected', t => {
  const f = fixture(t); published(f); const generation = load(f).pending.generation;
  R.snoozeFor({ home: f.home, duration: '3h', nowMs: now }); const expiry = load(f).snoozeUntil;
  published(f, { build: 'two', archive: { ...f.archive, ino: f.archive.ino + 1 } });
  R.setReminderInterval({ home: f.home, duration: '5m' });
  assert.equal(load(f).snoozeUntil, expiry);
  assert.throws(() => R.applyAction({ home: f.home, action: 'snooze', generation, capturedSnoozeMs: 3600000, nowMs: now }), { code: 'stale' });
  assert.equal(load(f).snoozeUntil, expiry);
});
test('interval anchored to last accepted submission; captured button retains posted duration', t => {
  const f = fixture(t); published(f); tick(f);
  R.setReminderInterval({ home: f.home, duration: '5m' });
  assert.equal(tick(f, now + 299999).submitted, false);
  assert.equal(tick(f, now + 300000).submitted, true);
  const generation = load(f).pending.generation;
  R.snoozeFor({ home: f.home, duration: '6h', nowMs: now });
  R.applyAction({ home: f.home, action: 'snooze', generation, capturedSnoozeMs: 10800000, nowMs: now });
  assert.equal(load(f).snoozeUntil, new Date(now + 10800000).toISOString());
});
test('durations are bounded whole minutes, including numeric API input', t => {
  const f = fixture(t);
  for (const input of ['0', '-1m', 'NaN', 'Infinity', '1.5h', '43201m', '1e3']) assert.throws(() => R.parseDuration(input, 'snooze'));
  for (const input of ['4m', '1441m', '1.1m']) assert.throws(() => R.parseDuration(input, 'interval'));
  assert.equal(R.parseDuration('90m', 'snooze'), 5400000);
  assert.equal(R.parseDuration('24h', 'interval'), 86400000);
  for (const ms of [NaN, Infinity, -1, 300001]) assert.throws(() => R.setReminderInterval({ home: f.home, ms }));
});
test('old main, backend, missing evidence, same-second ambiguity and archive mismatch never complete', t => {
  const f = fixture(t); published(f); const pending = load(f).pending;
  const before = pending.boundaryUs - 100000;
  const after = pending.boundaryUs + 100000;
  const cases = [
    observation(f.archive, [main(1, before)]),
    observation(f.archive, [main(2, after, { args: `${exe} --require boot.cjs apps/server/dist/bin.mjs --bootstrap-fd 4` })]),
    observation(f.archive, []), observation(f.archive, [main(3, after)], 'unavailable'),
    observation(f.archive, [main(4, pending.boundaryUs, { startPrecise: false })]),
    observation(f.archive, [main(5, after), main(1, before)]),
    observation({ ...f.archive, ino: 99 }, [main(5, after)]),
    observation(f.archive, [main(6, null)]),
  ];
  for (const obs of cases) assert.equal(R.evaluateCompletion(pending, obs).complete, false);
  assert.equal(R.evaluateCompletion(pending, observation(f.archive, [main(1, after)])).complete, true, 'PID reuse with a positively different, post-publication birth is a genuine new main');
  assert.equal(R.evaluateCompletion(pending, { ...observation(f.archive, [main(9, after)]), openers: [] }).complete, false);
  const obs = observation(f.archive, [main(9, after)]);
  assert.equal(tick(f, now + 1000, { observation: obs }).submitted, false);
  assert.equal(load(f).pending, null);
});
test('process started during preparation or old main opening target is insufficient', t => {
  const f = fixture(t); published(f); const pending = load(f).pending;
  assert.equal(R.evaluateCompletion(pending, observation(f.archive, [main(8, pending.boundaryUs - 1)])).complete, false);
  assert.equal(R.classifyProcess(main(1, now, { args: `${exe} --type=renderer` }), app), 'helper');
  assert.equal(R.classifyProcess(main(1, now, { args: `${exe} --eval code` }), app), 'backend');
});
test('accessibility and positional workers cannot prove a desktop restart as sole archive openers', t => {
  const f = fixture(t); published(f); const pending = load(f).pending;
  const after = pending.boundaryUs + 100000;
  const workerArgs = [
    `${exe} ${app}/Contents/Resources/app.asar/apps/desktop/dist-electron/snapShot/SnapShotAccessibilityWorker.cjs read`,
    `${exe} /fixture/other-worker.cjs read`,
    `${exe} /fixture/other-worker.mjs`,
    `${exe} --unrecognized-worker-mode`,
    '/fixture/unrelated-command',
  ];
  for (const args of workerArgs) {
    const proc = main(54445, after, { args });
    assert.notEqual(R.classifyProcess(proc, app), 'desktop-main');
    assert.equal(R.evaluateCompletion(pending, observation(f.archive, [proc])).complete, false);
  }
  assert.equal(R.evaluateCompletion(pending, observation(f.archive, [main(54399, after)])).complete, true);
});
test('closed app asks to open it; unknown process evidence does not assert closed', t => {
  const f = fixture(t); published(f);
  assert.equal(tick(f).payload.title, 'Open T3 Code');
  R.resumeReminders({ home: f.home });
  assert.equal(tick(f, now, { observation: observation(f.archive, [], 'unavailable') }).payload.title, 'Restart T3 Code');
  assert.ok(load(f).pending);
});
test('prepared-before-rename mismatch creates no requirement; after-rename recovery is conservative and idempotent', t => {
  const f = fixture(t); const intended = { ...f.archive, ino: f.archive.ino + 1 };
  R.notePrepared({ home: f.home, build: 'one', intended, startupReasons: ['firstClick'], uiChanged: false });
  assert.equal(R.reconcileJournal({ home: f.home, actual: f.archive, nowMs: now }).recovered, false);
  assert.equal(load(f).pending, null);
  R.notePrepared({ home: f.home, build: 'one', intended, startupReasons: ['firstClick'], uiChanged: false });
  assert.equal(R.reconcileJournal({ home: f.home, actual: intended, nowMs: now }).recovered, true);
  const first = load(f).pending;
  assert.equal(first.boundarySource, 'recovery');
  assert.ok(first.boundaryUs > now * 1000);
  assert.equal(R.reconcileJournal({ home: f.home, actual: intended, nowMs: now + 10 }).recovered, false);
  assert.deepEqual(load(f).pending, first);
});
test('same-build successful UI replacement carries startup reasons through normal and crash paths', t => {
  const f = fixture(t); published(f);
  const archive2 = { ...f.archive, ino: f.archive.ino + 1 };
  published(f, { archive: archive2, reasons: [], uiChanged: true, live: 'updated' });
  assert.deepEqual(load(f).pending.reasons, ['firstClick']);
  const archive3 = { ...f.archive, ino: f.archive.ino + 2 };
  R.notePrepared({ home: f.home, build: 'one', intended: archive3, startupReasons: [], uiChanged: true });
  R.reconcileJournal({ home: f.home, actual: archive3, nowMs: now });
  assert.ok(load(f).pending.reasons.includes('firstClick'));
  assert.equal(load(f).pending.archive.ino, archive3.ino);
});
test('legacy UI-only, overwritten/no-op, restored, mismatched and restarted histories stay quiet', t => {
  const f = fixture(t);
  const keeper = { build: 'one', results: { firstClick: { state: 'patched' } }, produced: { identity: f.archive }, lastPatchedAt: new Date(now).toISOString() };
  for (const k of [
    { ...keeper, results: { wrap: { state: 'patched' } } }, { ...keeper, results: { firstClick: { state: 'already' } } },
    { ...keeper, status: 'restored' }, { ...keeper, produced: { identity: { ...f.archive, ino: 999 } } },
  ]) assert.equal(R.adoptLegacy({ state: R.freshState(), keeper: k, actual: f.archive, observation: observation(f.archive, [main(1, now * 1000 - 1)]), nowMs: now }).adopted, false);
  assert.equal(R.adoptLegacy({ state: R.freshState(), keeper, actual: f.archive, observation: observation(f.archive, [main(2, now * 1000 + 1000000)]), nowMs: now }).adopted, false);
  const legacyArchive = { ...f.archive, birthtimeMs: now - 500 };
  const knownKeeper = { ...keeper, produced: { identity: legacyArchive } };
  assert.equal(R.adoptLegacy({ state: R.freshState(), keeper: knownKeeper, actual: legacyArchive, observation: observation(legacyArchive, [main(1, now * 1000 - 1000000)]), nowMs: now }).adopted, true);
  assert.equal(R.adoptLegacy({ state: R.freshState(), keeper: knownKeeper, actual: legacyArchive, observation: observation(legacyArchive, [main(1, now * 1000 - 100000)]), nowMs: now }).adopted, false, 'a main born between clone creation and bookkeeping may already have loaded the patches');
});
test('corrupt/unreadable state errors never reset to unsnoozed defaults', t => {
  const f = fixture(t); fs.writeFileSync(f.state, '{broken');
  assert.throws(() => R.snoozeFor({ home: f.home, duration: '3h' }), { code: 'corrupt' });
  assert.equal(fs.readFileSync(f.state, 'utf8'), '{broken');
  for (const corrupt of [
    { ...R.freshState(), lastSubmittedAt: 'invalid timestamp' },
    { ...R.freshState(), pending: { generation: 'g-invalid', reasons: ['firstClick'], boundaryUs: -1, boundarySource: 'published', archive: f.archive } },
    { ...R.freshState(), pending: { generation: 'g-invalid', reasons: ['firstClick'], boundaryUs: now * 1000, boundarySource: 'published', archive: { ...f.archive, ino: 'garbage' } } },
  ]) {
    fs.writeFileSync(f.state, JSON.stringify(corrupt)); const before = fs.readFileSync(f.state);
    assert.throws(() => R.snoozeFor({ home: f.home, duration: '3h' }), { code: 'corrupt' });
    assert.deepEqual(fs.readFileSync(f.state), before);
  }
  fs.rmSync(f.state); fs.mkdirSync(f.state);
  assert.throws(() => R.readStateFile(f.state), { code: 'unreadable' });
});
test('interrupted atomic state rename preserves previous valid state and journal recovers once', t => {
  const f = fixture(t); published(f); const before = fs.readFileSync(f.state, 'utf8');
  process.env.T3_REMINDERS_TEST_HOOKS = '1';
  globalThis.__reminderBeforeStateRename = (_tmp, dest) => { if (dest === f.state) throw new Error('simulated termination before rename'); };
  try { assert.throws(() => R.snoozeFor({ home: f.home, duration: '3h' }), /simulated termination/); }
  finally { delete process.env.T3_REMINDERS_TEST_HOOKS; delete globalThis.__reminderBeforeStateRename; }
  assert.equal(fs.readFileSync(f.state, 'utf8'), before);
  assert.equal(R.reconcileJournal({ home: f.home, actual: f.archive, nowMs: now }).recovered, false);
});
test('CLI acknowledges durable snooze/config and rejects held locks without success', t => {
  const f = fixture(t); published(f);
  let out = cli(f, ['--snooze', '3h']);
  assert.equal(out.status, 0, out.stderr); assert.equal(JSON.parse(out.stdout).durable, true);
  assert.equal(tick(f, Date.now()).submitted, false);
  out = cli(f, ['--remind-every', '30m']); assert.equal(out.status, 0, out.stderr);
  const held = R.acquireReminderLock(f.home);
  try { out = cli(f, ['--snooze', '1h']); assert.equal(out.status, 75); assert.equal(JSON.parse(out.stdout).ok, false); }
  finally { R.releaseReminderLock(held); }
  out = cli(f, ['--reminder-action', 'snooze', '--generation', 'g-old', '--captured-ms', '10800000']); assert.equal(out.status, 2);
});
test('snooze between due reservation and submission cancels the reservation', t => {
  const f = fixture(t); published(f); let posted = 0;
  const result = tick(f, now, { pauseBeforeSubmit: () => R.snoozeFor({ home: f.home, duration: '3h', nowMs: now }), post: () => { posted++; return { accepted: true }; } });
  assert.equal(result.submitted, false); assert.equal(posted, 0);
});
test('kernel lock survives stale files, serializes concurrent entrants, and releases on owner crash', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.home, 'reminder.lock.flock'), 'stale owner text is not a lock');
  fs.writeFileSync(path.join(f.home, 'counter'), '0');
  const workers = Array.from({ length: 8 }, () => worker(f, `const home=process.argv[2];const r=R.withReminderLock(home,'production',()=>{const p=home+'/counter';const n=Number(fs.readFileSync(p));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);fs.writeFileSync(p,String(n+1));},{attempts:200,waitMs:5});process.exit(r.busy?75:0);`));
  for (const w of workers) assert.equal((await w.done).code, 0);
  assert.equal(fs.readFileSync(path.join(f.home, 'counter'), 'utf8'), '8');
  const owner = worker(f, `const home=process.argv[2];const h=R.acquireReminderLock(home);if(!h)process.exit(75);fs.writeFileSync(home+'/ready','yes');setInterval(()=>{},1000);`);
  await until(() => fs.existsSync(path.join(f.home, 'ready')));
  assert.equal(R.acquireReminderLock(f.home), null);
  owner.proc.kill('SIGKILL'); await owner.done;
  const acquired = R.acquireReminderLock(f.home); assert.ok(acquired); R.releaseReminderLock(acquired);
});
test('real processes serialize post against snooze and never submit after durable success', async t => {
  const f = fixture(t); published(f);
  const blocker = worker(f, `const home=process.argv[2];const h=R.acquireReminderLock(home);fs.writeFileSync(home+'/ready','');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);fs.appendFileSync(home+'/events','posted\\n');R.releaseReminderLock(h);`);
  await until(() => fs.existsSync(path.join(f.home, 'ready')));
  R.snoozeFor({ home: f.home, duration: '3h', nowMs: now });
  fs.appendFileSync(path.join(f.home, 'events'), 'snoozed\n');
  assert.equal((await blocker.done).code, 0);
  assert.equal(fs.readFileSync(path.join(f.home, 'events'), 'utf8'), 'posted\nsnoozed\n');
});
test('denied native adapter never claims submission and backs off without clearing pending', t => {
  const f = fixture(t); published(f); let calls = 0;
  const post = () => { calls++; return { accepted: false, denied: true, authorization: 'denied' }; };
  assert.equal(tick(f, now, { post }).submitted, false);
  assert.equal(tick(f, now + 30000, { post }).submitted, false);
  assert.equal(calls, 1); assert.ok(load(f).pending);
});
test('diagnostic namespace is isolated, stale controls cannot mutate newer state, and arbitrary paths rejected', t => {
  const f = fixture(t); published(f); const production = fs.readFileSync(f.state);
  let out = cli(f, ['--diagnostic-create', '--namespace', 'diagnostic', '--generation', 'test-buttons']); assert.equal(out.status, 64, 'keeper only exposes established commands; diagnostics use module directly');
  const invoke = args => spawnSync(process.execPath, [path.join(src, 'reminders.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, T3_KEEPER_HOME: f.home }, timeout: 10000 });
  out = invoke(['--diagnostic-create', '--namespace', 'diagnostic', '--generation', 'test-buttons']); assert.equal(out.status, 0, out.stderr);
  out = invoke(['--reminder-action', 'snooze', '--namespace', 'diagnostic', '--generation', 'test-buttons', '--captured-ms', '10800000']); assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(fs.readFileSync(f.state), production);
  out = invoke(['--snooze', '1h', '--generation', 'old', '--namespace', 'diagnostic']); assert.equal(out.status, 2);
  out = invoke(['--reminders', '--state', '/arbitrary']); assert.notEqual(out.status, 0);
  out = invoke(['--diagnostic-post', '--namespace', 'diagnostic', '--generation', 'test-buttons', '--overlap-seconds', '11']);
  assert.notEqual(out.status, 0); assert.equal(JSON.parse(out.stdout).error, 'diagnostic-rejected');
  const posts = path.join(f.home, 'diagnostic-posts');
  out = spawnSync(process.execPath, [path.join(src, 'reminders.mjs'), '--diagnostic-post', '--namespace', 'diagnostic', '--generation', 'test-buttons', '--overlap-seconds', '8'], {
    encoding: 'utf8', env: { ...process.env, HOME: f.home, T3_KEEPER_HOME: f.home, T3_KEEPER_QUIET: '', T3_REMINDERS_FAKE_POST: posts }, timeout: 10000,
  });
  assert.equal(out.status, 0, out.stderr); assert.equal(JSON.parse(fs.readFileSync(posts, 'utf8')).diagnosticHoldSeconds, 8);
  assert.deepEqual(fs.readFileSync(f.state), production);
});

test('handled-archive CLI auto still ticks; durable CLI snooze suppresses it and genuine completion clears it', t => {
  const f = fixture(t); published(f, { at: Date.now() - 1000 });
  const st = fs.statSync(f.file);
  fs.writeFileSync(path.join(f.home, 'state.json'), JSON.stringify({ keeperVersion: 10, key: `${st.dev}:${st.ino}:${st.size}:${st.birthtimeMs}:${st.mtimeMs}`, status: 'patched' }));
  const processFile = path.join(f.home, 'processes.json');
  const postedFile = path.join(f.home, 'posted.ndjson');
  fs.writeFileSync(processFile, JSON.stringify(observation(f.archive)));
  const adapter = { T3_KEEPER_QUIET: '', T3_REMINDERS_FAKE_POST: postedFile, T3_REMINDERS_PROCESS_FIXTURE: processFile };
  let out = cli(f, ['--auto'], adapter); assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(fs.readFileSync(postedFile, 'utf8').trim().split('\n').length, 1);
  out = cli(f, ['--snooze', '3h']); assert.equal(out.status, 0, out.stdout + out.stderr);
  out = cli(f, ['--auto'], adapter); assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(fs.readFileSync(postedFile, 'utf8').trim().split('\n').length, 1);
  const pending = load(f).pending;
  const worker = main(54445, pending.boundaryUs + 1, { args: `${exe} ${app}/Contents/Resources/app.asar/apps/desktop/dist-electron/snapShot/SnapShotAccessibilityWorker.cjs read` });
  fs.writeFileSync(processFile, JSON.stringify(observation(f.archive, [worker])));
  out = cli(f, ['--auto'], adapter); assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(load(f).pending, 'a worker-only CLI observation never clears the restart requirement');
  fs.writeFileSync(processFile, JSON.stringify(observation(f.archive, [main(99, pending.boundaryUs + 1)])));
  out = cli(f, ['--auto'], adapter); assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(load(f).pending, null); assert.ok(load(f).snoozeUntil, 'completion leaves root snooze policy intact');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'fixture archive', 'handled archive is never reparsed or patched');
});

for (const replacementBuild of ['one', 'two']) {
  test(`actual handled CLI rebinds ${replacementBuild === 'one' ? 'same-build' : 'new-build'} no-op replacement and only a later genuine main completes`, t => {
    const f = fixture(t); published(f, { at: Date.now() - 60000 });
    const originalGeneration = load(f).pending.generation;
    R.snoozeFor({ home: f.home, duration: '3h' }); const savedPolicy = { snoozeUntil: load(f).snoozeUntil, config: load(f).config };
    const replacementApp = path.join(f.home, 'T3 Code.app'); fs.mkdirSync(path.join(replacementApp, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(replacementApp, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${replacementBuild}</string></dict></plist>`);
    fs.writeFileSync(f.file + '.new', 'replacement already contains patches'); fs.renameSync(f.file + '.new', f.file);
    const st = fs.statSync(f.file); f.archive = { dev: st.dev, ino: st.ino, size: st.size, birthtimeMs: st.birthtimeMs };
    fs.writeFileSync(path.join(f.home, 'state.json'), JSON.stringify({ keeperVersion: 10, build: replacementBuild, status: 'patched', results: { firstClick: { state: 'already' } }, key: `${st.dev}:${st.ino}:${st.size}:${st.birthtimeMs}:${st.mtimeMs}` }));
    const obsFile = path.join(f.home, 'processes.json');
    const replacementExe = path.join(replacementApp, 'Contents/MacOS/T3 Code');
    const obs = startUs => ({ ...observation(f.archive, [{ pid: 88, startUs, startPrecise: true, exe: replacementExe, args: replacementExe }]), appPath: replacementApp });
    fs.writeFileSync(obsFile, JSON.stringify(obs((Date.now() - 1000) * 1000)));
    const adapter = { T3_APP_PATH: replacementApp, T3_REMINDERS_PROCESS_FIXTURE: obsFile };
    let out = cli(f, ['--auto'], adapter); assert.equal(out.status, 0, out.stderr);
    const pending = load(f).pending; assert.ok(pending); assert.notEqual(pending.generation, originalGeneration); assert.equal(pending.build, replacementBuild);
    assert.equal(R.sameArchive(pending.archive, f.archive), true); assert.equal(pending.boundarySource, 'recovery');
    assert.deepEqual({ snoozeUntil: load(f).snoozeUntil, config: load(f).config }, savedPolicy);
    assert.throws(() => R.applyAction({ home: f.home, action: 'snooze', generation: originalGeneration, capturedSnoozeMs: 10800000 }), { code: 'stale' });
    fs.writeFileSync(obsFile, JSON.stringify({ ...obs(pending.boundaryUs + 1), evidence: 'unavailable' }));
    out = cli(f, ['--auto'], adapter); assert.equal(out.status, 0); assert.ok(load(f).pending, 'unknown evidence never completes');
    fs.writeFileSync(obsFile, JSON.stringify(obs(pending.boundaryUs + 1)));
    out = cli(f, ['--auto'], adapter); assert.equal(out.status, 0); assert.equal(load(f).pending, null);
    assert.deepEqual({ snoozeUntil: load(f).snoozeUntil, config: load(f).config }, savedPolicy);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'replacement already contains patches');
  });
}
