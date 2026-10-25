// Fixture app copies share the real bundle id. If macOS keeps one registered,
// a click on a real reminder can open that copy, which reads an empty folder
// (seen 20 Oct 2026). Forget every fixture copy before deleting it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export function appsUnder(dir) {
  const found = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.name.endsWith('.app')) found.push(p); else walk(p);
    }
  };
  walk(dir);
  return found;
}

// lsregister -u exits 1 for a copy that was never registered, so its status
// can't be trusted; check the registry afterwards instead.
export function forgetApps(dir) {
  for (const app of appsUnder(dir)) {
    const r = spawnSync(LSREGISTER, ['-u', app], { stdio: 'ignore', timeout: 30000 });
    if (r.error) throw r.error;
  }
  const left = registeredUnder(dir);
  if (left.length) throw new Error(`still registered with macOS: ${left.join(', ')}`);
}

export function registeredUnder(dir) {
  const r = spawnSync(LSREGISTER, ['-dump'], { encoding: 'utf8', maxBuffer: 1 << 30, timeout: 120000 });
  if (r.error) throw r.error;
  if (r.status !== 0 || !r.stdout) throw new Error(`lsregister -dump failed (status ${r.status})`);
  const dump = r.stdout;
  const prefix = path.resolve(dir) + path.sep;
  return dump.split('\n').filter(l => /^path:\s/.test(l)).map(l => l.replace(/^path:\s+/, '').replace(/ \(0x[0-9a-f]+\)$/, '')).filter(p => p.startsWith(prefix));
}
