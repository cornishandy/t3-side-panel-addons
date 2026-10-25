/** Installer-only coordinator. Never installed; never snapshots mutable state. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireKernelLock, releaseReminderLock, writeDurable } from './reminders.mjs';

const [home, stage, plist, domain, mode] = process.argv.slice(2);
const rollingBack = mode === 'rollback';
const label = 'com.cornishandy.t3-sidebar-keeper';
const testing = Boolean(process.env.T3_KEEPER_INSTALL_ROOT);
const items = ['keeper.mjs', 'reminders.mjs', 'proc-birth', 'vendor', 'T3 Restart Reminders.app'];
const marker = path.join(home, 'install-in-progress.json');
const failAt = process.env.T3_KEEPER_INSTALL_FAIL_AT;
const delay = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hit = boundary => { if (failAt === boundary) throw new Error(`injected failure at ${boundary}`); };
function ctl(args, { optional = false } = {}) {
  if (testing) { fs.appendFileSync(path.join(process.env.T3_KEEPER_INSTALL_ROOT, 'launchctl.log'), `${args.join(' ')}\n`); return; }
  const run = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 15000 });
  if (!optional && (run.error || run.status !== 0)) throw new Error(`launchctl ${args[0]} failed: ${run.error?.message ?? run.stderr.trim()}`);
}
function pids(kind) {
  const run = spawnSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error('Cannot inspect running keeper/helper processes; code unchanged.');
  const helper = path.join(home, 'T3 Restart Reminders.app/Contents/MacOS/T3 Restart Reminders');
  const scripts = ['keeper.mjs', 'reminders.mjs'].map(name => path.join(home, name));
  return run.stdout.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid) return [];
    const command = m[2];
    const match = kind === 'helper' ? (command === helper || command.startsWith(`${helper} `))
      : scripts.some(script => {
        // ps preserves argv[0], which can be simply "node" or a Homebrew
        // versioned path. Exact script argument boundaries avoid unrelated jobs.
        const at = command.indexOf(` ${script}`);
        return at > 0 && /(?:^|\/)node$/.test(command.slice(0, at))
          && (command.length === at + 1 + script.length || command[at + 1 + script.length] === ' ');
      });
    return match ? [Number(m[1])] : [];
  });
}
function quiesce() {
  ctl(['bootout', `${domain}/${label}`], { optional: true });
  for (const pid of pids('helper')) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const deadline = Date.now() + 30000;
  // Helpers defer SIGTERM until their asynchronous action has a durable result.
  // Old v9 manual keepers do not have code leases: wait for those too.
  while (pids('helper').length || pids('scripts').length) {
    if (Date.now() >= deadline) throw new Error('Keeper/helper still running; no code was replaced. Close Controls and retry.');
    delay(100);
  }
}
function snapshot(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const item of items) if (fs.existsSync(path.join(home, item))) fs.cpSync(path.join(home, item), path.join(dir, item), { recursive: true, preserveTimestamps: true });
  if (fs.existsSync(plist)) fs.copyFileSync(plist, path.join(dir, 'old.plist'));
}
function restore(dir) {
  for (const item of items) {
    fs.rmSync(path.join(home, item), { recursive: true, force: true });
    if (fs.existsSync(path.join(dir, item))) fs.cpSync(path.join(dir, item), path.join(home, item), { recursive: true });
  }
  if (fs.existsSync(path.join(dir, 'old.plist'))) fs.copyFileSync(path.join(dir, 'old.plist'), plist);
  else fs.rmSync(plist, { force: true });
}
function bootstrap() { if (fs.existsSync(plist)) ctl(['bootstrap', domain, plist]); }

let installLock, codeLock, nativeLock, backup, recovery = null, touched = false, paused = false, success = false;
function holdNativeBarrier() {
  const until = Date.now() + 30000;
  while (!(nativeLock = acquireKernelLock(path.join(home, 'native.flock')))) {
    if (Date.now() > until) throw new Error('Native helper admission still active; code unchanged.');
    delay(50);
  }
}
try {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  installLock = acquireKernelLock(path.join(home, 'install.flock'));
  if (!installLock) throw new Error('Another install is running.');
  if (fs.existsSync(marker)) {
    const previous = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (!['quiescing', 'replacing', 'complete'].includes(previous.phase)
      || typeof previous.backup !== 'string'
      || path.dirname(path.resolve(previous.backup)) !== path.join(path.resolve(home), 'install-rollback')
      || !fs.statSync(previous.backup).isDirectory()) throw new Error('Unknown interrupted-install marker; refusing code changes.');
    recovery = previous;
    quiesce(); paused = true;
    holdNativeBarrier();
    codeLock = acquireKernelLock(path.join(home, 'code.flock'));
    if (!codeLock) throw new Error('Existing code is busy; retry installation.');
    if (previous.phase === 'replacing') restore(previous.backup);
    fs.rmSync(marker);
    recovery = null;
    releaseReminderLock(codeLock); codeLock = null;
    releaseReminderLock(nativeLock); nativeLock = null;
  }
  backup = path.join(home, 'install-rollback', `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`);
  snapshot(backup);
  writeDurable(marker, { phase: 'quiescing', backup, pid: process.pid });
  paused = true;
  quiesce();
  holdNativeBarrier();
  hit('quiesce');
  const deadline = Date.now() + 30000;
  while (!(codeLock = acquireKernelLock(path.join(home, 'code.flock')))) {
    if (Date.now() > deadline) throw new Error('Reminder command still active; code unchanged.');
    delay(100);
  }
  if (process.env.T3_KEEPER_INSTALL_PAUSE_AT === 'replace') {
    const flag = process.env.T3_KEEPER_INSTALL_PAUSE_FLAG || path.join(process.env.T3_KEEPER_INSTALL_ROOT, 'install-paused');
    fs.writeFileSync(flag, '');
    const until = Date.now() + 30000;
    while (fs.existsSync(flag)) { if (Date.now() > until) throw new Error('install pause timed out'); delay(50); }
  }
  // Legacy native images do not cooperate with the admission lock. Refuse a
  // late observed legacy entrant rather than replacing code beneath it. The
  // shared native barrier, not this compatibility scan, closes the race for
  // every helper built with the supported admission protocol.
  if (pids('helper').length) throw new Error('Late legacy native helper detected; code unchanged. Retry after it exits.');
  writeDurable(marker, { phase: 'replacing', backup, pid: process.pid });
  touched = true;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const next = path.join(home, `.install-next-${index}`);
    fs.rmSync(next, { recursive: true, force: true });
    const present = fs.existsSync(path.join(stage, item));
    if (!present && !rollingBack) throw new Error(`Missing staged code: ${item}`);
    if (present) fs.cpSync(path.join(stage, item), next, { recursive: true });
    // Every failure from here is caught, not only explicit test injections.
    fs.rmSync(path.join(home, item), { recursive: true, force: true });
    if (present) fs.renameSync(next, path.join(home, item));
    hit(`replace-${index + 1}`);
  }
  hit('replace');
  if (fs.existsSync(path.join(stage, 'agent.plist'))) fs.copyFileSync(path.join(stage, 'agent.plist'), plist);
  else if (rollingBack) fs.rmSync(plist, { force: true });
  else throw new Error('Missing staged LaunchAgent');
  hit('plist');
  hit('bootstrap');
  // Leave marker until bootstrap returns; a timer launched during this interval
  // fails visibly/busy, then the ordinary 30-second timer retries.
  bootstrap();
  writeDurable(marker, { phase: 'complete', backup, pid: process.pid });
  fs.rmSync(marker);
  success = true;
  console.log(JSON.stringify({ ok: true, installed: home, rollback: backup, notificationsVerified: false }));
} catch (error) {
  console.error(error.stack);
  let recovered = true;
  try {
    // A failed interrupted-install recovery must retain its existing marker.
    // In particular, never bootstrap mixed code just because its lease was busy.
    if (recovery) throw new Error(`Interrupted installation still needs recovery from ${recovery.backup}`);
    if (touched) {
      ctl(['bootout', `${domain}/${label}`], { optional: true });
      restore(backup);
    }
    if (paused) {
      fs.rmSync(marker, { force: true });
      bootstrap();
    }
  } catch (rollbackError) { recovered = false; console.error(`Rollback incomplete: ${rollbackError.message}. Retained ${backup}`); }
  // An incomplete rollback keeps its marker, so commands fail closed until the
  // next installer recovers the retained code snapshot. User state stays live.
  if (!recovered && backup && !recovery) writeDurable(marker, { phase: 'replacing', backup, pid: process.pid });
  process.exitCode = 1;
} finally {
  releaseReminderLock(codeLock);
  releaseReminderLock(nativeLock);
  releaseReminderLock(installLock);
  if (!success) console.error('Install failed; retained code backup if one was created. Reminder/config state was not restored.');
}
