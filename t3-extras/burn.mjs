/**
 * Burn-rate tells: the I/O. Every 30 s while T3 is open:
 *  1. one read-only SQLite query (in a worker, timed out after 2 s; nothing held open between
 *     ticks) maps T3 threads updated in the last 40 min to their provider transcripts;
 *  2. transcripts are found (each checked: inside the provider's own folder after resolving links,
 *     and holding the expected session id) and tailed: only new bytes, with per-file and per-tick
 *     byte and time caps, so a huge transcript can't stall the service;
 *  3. spend is attributed exactly: one T3 thread may sum several sessions; Claude subagent files
 *     fold into their parent once; a transcript (or a charge) claimed by two threads is withheld;
 *  4. each thread gets one observation and steps its tier state (burn-core.mjs).
 * Nothing here writes to T3's database, transcripts or settings. Errors are counted, never logged
 * with paths.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  KEEP_MS, WINDOWS, DEFAULT_THRESHOLDS, parseClaudeRecord, parseCodexRecord, parseGrokRecord, newCodexState, parseRateTable, overrideTable,
  priceRecord, family, observe, newThreadState, step, tierOf, calibrate,
} from "./burn-core.mjs";

export const BURN_LIMITS = Object.freeze({
  mapMinutes: 40,
  maxThreads: 150, // rows read per tick
  maxFiles: 160, // transcripts tailed at once (subagents included)
  maxSubagents: 40, // per parent
  initialTail: 3 << 20, // a new file is read from its last 3 MB
  perFileTick: 3 << 20,
  tickBytes: 24 << 20,
  tickMs: 300,
  maxPartial: 2 << 20, // a longer line is skipped
  maxEvents: 6_000, // per file
  maxKeys: 10_000, // dedupe keys per file
  maxGlobalKeys: 60_000,
  discoveriesPerTick: 25,
  discoveryEntries: 6_000, // directory entries visited per tick, all discovery together
  codexBackScan: 8 << 20, // bytes scanned back from a Codex tail start for its model and speed
  guardBytes: 64, // bytes before the offset kept to spot a same-inode rewrite
  codexIndexDays: 45,
  maxIndex: 25_000,
  sqlTimeoutMs: 2_000,
  scanCacheMaxBytes: 64 << 20,
});

const PROVIDERS = {
  claudeAgent: { name: "claude", kind: "stream", markers: ['"usage"'] },
  codex: { name: "codex", kind: "stream", markers: ['"token_count"', '"turn_context"', '"thread_settings_applied"', '"session_meta"'] },
  grok: { name: "grok", kind: "turns", markers: ['"turn_completed"'] },
};
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/; // a native id is a file name part: no slashes, no ".."

export function createBurn(opts = {}) {
  const home = opts.home ?? os.homedir();
  const L = { ...BURN_LIMITS, ...(opts.limits ?? {}) };
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const P = {
    statev2: opts.statev2 ?? path.join(home, ".t3/userdata/statev2.sqlite"),
    claude: path.join(home, ".claude/projects"),
    codex: { codex: path.join(home, ".codex/sessions"), codex_openai_api: path.join(home, ".codex-t3-api/sessions") },
    grok: path.join(home, ".grok/sessions"),
    rates: path.join(home, ".t3/userdata/usage-model-rates.json"),
    settings: path.join(home, ".t3/userdata/settings.json"),
    scanCache: path.join(home, ".t3/userdata/usage-scan-cache-v5.json"),
  };
  const counts = { ticks: 0, sqlFail: 0, readFail: 0, withheld: 0, unpriced: 0 };
  const warned = new Set();
  const warn = (kind, error) => {
    counts[kind === "sql" ? "sqlFail" : "readFail"]++;
    if (warned.has(kind)) return;
    warned.add(kind);
    log(`burn: ${kind} failed (${typeof error?.code === "string" ? error.code : "error"})`); // codes only: no paths
  };

  // ---------------- SQLite in a worker, with a hard timeout ----------------
  let worker = null;
  let reqId = 0;
  const waiting = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("./burn-sql-worker.mjs", import.meta.url));
    worker.unref();
    worker.on("message", (m) => {
      const w = waiting.get(m.id);
      if (w) {
        waiting.delete(m.id);
        w(m);
      }
    });
    worker.on("error", () => {});
    worker.on("exit", () => {
      worker = null;
      for (const w of waiting.values()) w({ error: "exit" });
      waiting.clear();
    });
    return worker;
  }
  function query(t) {
    const id = ++reqId;
    const cutoff = new Date(t - L.mapMinutes * 60_000).toISOString();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        worker?.terminate(); // a stuck read is killed, never left holding the database
        resolve({ error: "timeout" });
      }, L.sqlTimeoutMs);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      try {
        getWorker().postMessage({ id, file: P.statev2, cutoff, limit: L.maxThreads });
      } catch (error) {
        clearTimeout(timer);
        waiting.delete(id);
        resolve({ error: error?.code ?? "worker" });
      }
    });
  }

  // ---------------- prices: T3's table and overrides, reloaded when they change ----------------
  let rates = { mtime: -1, table: new Map() };
  let overrides = { mtime: -1, table: new Map() };
  function loadPrices() {
    try {
      const st = fs.statSync(P.rates);
      if (st.mtimeMs !== rates.mtime && st.size < 32 << 20) rates = { mtime: st.mtimeMs, table: parseRateTable(JSON.parse(fs.readFileSync(P.rates, "utf8"))?.document) };
    } catch (error) {
      if (error.code !== "ENOENT") warn("rates", error);
    }
    try {
      const st = fs.statSync(P.settings);
      if (st.mtimeMs !== overrides.mtime && st.size < 8 << 20) overrides = { mtime: st.mtimeMs, table: overrideTable(JSON.parse(fs.readFileSync(P.settings, "utf8"))?.usagePriceOverrides) };
    } catch (error) {
      if (error.code !== "ENOENT") warn("settings", error);
    }
  }

  // ---------------- calibration (startup and every 6 h, bounded) ----------------
  let calib = { source: "default", referenceDays: 7, computedAt: null, thresholds: { ...DEFAULT_THRESHOLDS }, usual: {} };
  function recalibrate() {
    try {
      loadPrices();
      const st = fs.statSync(P.scanCache);
      if (st.size > L.scanCacheMaxBytes) return calib;
      calib = calibrate(JSON.parse(fs.readFileSync(P.scanCache, "utf8")), rates.table, overrides.table, now());
    } catch (error) {
      if (error.code !== "ENOENT") warn("calibration", error);
    }
    return calib;
  }

  // ---------------- discovery: native id -> transcript, inside the provider's folder ----------------
  const realRoots = new Map();
  const realRoot = (root) => {
    if (!realRoots.has(root)) {
      try {
        realRoots.set(root, fs.realpathSync(root));
      } catch {
        return null;
      }
    }
    return realRoots.get(root);
  };
  /** The file's real path, if it really is a file inside `root`. */
  function inside(root, file) {
    const r = realRoot(root);
    if (!r) return null;
    try {
      const real = fs.realpathSync(file);
      if (!real.startsWith(`${r}${path.sep}`) || !fs.statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }
  const found = new Map(); // "provider|instance|nativeId" -> { path, root } | { miss: time }
  let claudeDirs = { at: 0, list: [] };
  let codexIndex = { at: 0, byId: new Map(), root: null };
  let grokDirs = { at: 0, list: [] };
  // This tick's shared work budget: discovery and tailing draw on the same entries, bytes and time.
  let budget = { deadline: Infinity, entries: 0, bytes: 0 };
  const spent = () => performance.now() > budget.deadline || budget.entries >= L.discoveryEntries;
  const PARTIAL = Symbol("partial"); // a search cut short by the budget: try again, don't record a miss
  /** Up to `cap` entry names in `dir`, visiting no more than that (opendir, not a full listing).
   *  complete is false when the tick's budget stopped it. */
  function iterDir(dir, cap, dirsOnly = true) {
    const names = [];
    let d;
    try {
      d = fs.opendirSync(dir);
      for (let e = d.readSync(); e && names.length < cap; e = d.readSync()) {
        if (spent()) return { names, complete: false };
        budget.entries++;
        if (!dirsOnly || e.isDirectory()) names.push(e.name);
      }
      return { names, complete: true };
    } catch {
      return { names, complete: true }; // missing or unreadable: nothing there
    } finally {
      try {
        d?.closeSync();
      } catch {}
    }
  }
  function cachedDirs(cache, root, t, cap) {
    if (t - cache.at <= 5 * 60_000) return cache;
    const r = iterDir(root, cap);
    return r.complete ? { at: t, list: r.names } : null;
  }
  function findClaude(id, t) {
    const c = cachedDirs(claudeDirs, P.claude, t, 2_000);
    if (!c) return PARTIAL;
    claudeDirs = c;
    for (const d of claudeDirs.list) {
      if (spent()) return PARTIAL;
      budget.entries++;
      const real = inside(P.claude, path.join(P.claude, d, `${id}.jsonl`));
      if (real) return { path: real, root: P.claude, dir: path.join(P.claude, d) };
    }
    return null;
  }
  function findCodex(instance, id, t) {
    const root = P.codex[instance];
    if (!root) return null;
    const stale = codexIndex.root !== root || (t - codexIndex.at > 2 * 60_000 && !codexIndex.byId.has(id));
    if (stale) {
      const byId = new Map();
      const cut = new Date(t - L.codexIndexDays * 86_400_000);
      const level = (dir) => {
        const r = iterDir(dir, 400);
        if (!r.complete) throw PARTIAL;
        return r.names.sort().reverse();
      };
      try {
        outer: for (const y of level(root)) {
          for (const m of level(path.join(root, y))) {
            for (const d of level(path.join(root, y, m))) {
              if (new Date(`${y}-${m}-${d}T23:59:59Z`) < cut) break outer;
              const r = iterDir(path.join(root, y, m, d), L.maxIndex, false);
              if (!r.complete) throw PARTIAL;
              for (const n of r.names) {
                const mm = /^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/.exec(n);
                if (mm && !byId.has(mm[1])) byId.set(mm[1], path.join(root, y, m, d, n));
                if (byId.size >= L.maxIndex) break outer;
              }
            }
          }
        }
      } catch (error) {
        if (error === PARTIAL) return PARTIAL;
        throw error;
      }
      codexIndex = { at: t, byId, root };
    }
    const p = codexIndex.byId.get(id);
    const real = p ? inside(root, p) : null;
    return real ? { path: real, root } : null;
  }
  function findGrok(id, t) {
    const c = cachedDirs(grokDirs, P.grok, t, 500);
    if (!c) return PARTIAL;
    grokDirs = c;
    for (const d of grokDirs.list) {
      if (spent()) return PARTIAL;
      budget.entries++;
      const real = inside(P.grok, path.join(P.grok, d, id, "updates.jsonl"));
      if (real) return { path: real, root: P.grok };
    }
    return null;
  }

  // ---------------- tailing ----------------
  const files = new Map(); // real path -> tail state
  function newTail(p, provider, expect, role) {
    return { path: p, provider, expect, role, dev: null, ino: null, offset: 0, size: 0, guard: null, partial: null, skipping: false, coveredFrom: null, codex: newCodexState(), keys: new Map(), events: [], invalid: false, ok: true, backlog: false, init: false };
  }
  function resetTail(f, st) {
    f.dev = st.dev;
    f.ino = st.ino;
    f.offset = Math.max(0, st.size - L.initialTail);
    f.skipping = f.offset > 0; // the first piece is a cut line
    f.coveredFrom = f.offset === 0 ? -Infinity : null;
    f.partial = null;
    f.guard = null;
    f.codex = newCodexState();
    f.keys.clear();
    f.events = [];
    f.invalid = false;
    f.init = true;
    if (f.provider === "codex") readCodexHead(f);
  }
  /** Codex: the session id and fork flag sit at the top of the file; the model and speed in force
   *  at the tail start come from the last turn_context / thread_settings_applied before it, found
   *  by scanning back from the tail start (capped). If that can't be settled, the file's charges
   *  are priced as unknown until the tail itself shows a new context: never a guess. */
  function readCodexHead(f) {
    let fd;
    try {
      fd = fs.openSync(f.path, "r");
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      budget.bytes += n;
      const head = buf.subarray(0, n);
      let pos = 0;
      for (let i = head.indexOf(10); i !== -1; i = head.indexOf(10, pos)) {
        const line = head.subarray(pos, i).toString("utf8");
        const end = i + 1;
        const isMeta = line.includes('"session_meta"');
        // State lines count only if they come before the tail start (the tail replays the rest).
        if (isMeta || (end <= f.offset && /"turn_context"|"thread_settings_applied"/.test(line))) {
          try {
            parseCodexRecord(JSON.parse(line), f.codex);
          } catch {}
        }
        pos = end;
      }
      if (!f.codex.sawMeta || f.codex.sessionId !== f.expect) f.invalid = true; // not the expected session
      if (f.offset > pos) {
        const back = scanBack(fd, pos, f.offset);
        if (back.model !== undefined) f.codex.model = back.model;
        else if (!back.reached) f.codex.model = UNKNOWN_MODEL;
        if (back.speed !== undefined) f.codex.speed = back.speed;
        else if (!back.reached) f.codex.speed = "unknown";
      }
      f.codex.lastSig = null;
      f.codex.forking = f.offset === 0 && f.codex.forking; // copies sit at the top only
    } catch (error) {
      f.ok = false;
      warn("read", error);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  const UNKNOWN_MODEL = "\u0000unknown"; // never in the rate table: priced as unknown
  /** The last turn_context model and thread_settings speed in [lo, hi) of the file, scanning back
   *  from hi up to codexBackScan bytes. reached = the scan covered everything down to lo. */
  function scanBack(fd, lo, hi) {
    const start = Math.max(lo, hi - L.codexBackScan);
    const buf = Buffer.alloc(hi - start);
    const got = fs.readSync(fd, buf, 0, buf.length, start);
    budget.bytes += got;
    const data = buf.subarray(0, got);
    // Whole lines only: drop the cut line at hi, and (unless start is a line boundary) the cut line at start.
    const lastNl = data.lastIndexOf(10);
    const firstOk = start === lo ? 0 : data.indexOf(10) + 1;
    const out = { model: undefined, speed: undefined, reached: start === lo };
    const lastRecord = (marker, pick) => {
      for (let i = data.lastIndexOf(marker, lastNl); i !== -1 && i >= firstOk; i = data.lastIndexOf(marker, i - 1)) {
        const a = data.lastIndexOf(10, i) + 1;
        const b = data.indexOf(10, i);
        if (a < firstOk || b === -1 || b > lastNl) continue;
        let o;
        try {
          o = JSON.parse(data.subarray(a, b).toString("utf8"));
        } catch {
          continue;
        }
        const v = pick(o);
        if (v !== undefined) return v;
        i = a; // keep looking further back
      }
      return undefined;
    };
    out.model = lastRecord('"turn_context"', (o) => (o?.type === "turn_context" && typeof o.payload?.model === "string" ? o.payload.model : undefined));
    out.speed = lastRecord('"thread_settings_applied"', (o) => {
      if (o?.payload?.type !== "thread_settings_applied") return undefined;
      const tier = o.payload.thread_settings?.service_tier;
      return tier === "priority" || tier === "fast" ? "fast" : tier === "ultrafast" ? "ultrafast" : "standard";
    });
    return out;
  }
  function lineTs(o) {
    const agent = o?.params?._meta?.agentTimestampMs;
    if (typeof agent === "number") return agent;
    if (typeof o?.timestamp === "string") return Date.parse(o.timestamp);
    if (typeof o?.timestamp === "number") return o.timestamp > 0xe8d4a51000 ? o.timestamp : o.timestamp * 1000;
    return null;
  }
  function onLine(f, text, t) {
    const meta = PROVIDERS[f.provider === "claude" ? "claudeAgent" : f.provider];
    const needCover = f.coveredFrom === null;
    if (!needCover && !meta.markers.some((m) => text.includes(m))) return;
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      return; // a broken line is skipped, never fatal
    }
    if (needCover) {
      const ts = lineTs(o);
      if (Number.isFinite(ts)) f.coveredFrom = ts;
      if (!meta.markers.some((m) => text.includes(m))) return;
    }
    let recs = [];
    if (f.provider === "claude") {
      const r = parseClaudeRecord(o);
      if (r) recs = [r];
    } else if (f.provider === "codex") {
      const r = parseCodexRecord(o, f.codex);
      if (r) recs = [r];
    } else recs = parseGrokRecord(o);
    for (const r of recs) {
      // Identity: every record must carry the session this file was mapped to.
      if (f.provider !== "codex" && r.sessionId && r.sessionId !== f.expect) {
        f.invalid = true;
        continue;
      }
      if (r.ts < t - KEEP_MS) continue;
      if (r.key !== null) {
        if (f.keys.has(r.key)) continue;
        if (f.keys.size >= L.maxKeys) f.keys.delete(f.keys.keys().next().value);
        f.keys.set(r.key, r.ts);
      }
      const { cost, source } = priceRecord(rates.table, overrides.table, r);
      if (source === "unpriced") counts.unpriced++;
      f.events.push({ ts: r.ts, cost, turn: r.turn, fam: family(r.model), key: r.key });
      if (f.events.length > L.maxEvents) f.events.splice(0, f.events.length - L.maxEvents);
    }
  }
  /** Reads up to `room` new bytes; returns the bytes read. Never throws. */
  function tail(f, room, t) {
    let st;
    try {
      st = fs.statSync(f.path);
    } catch (error) {
      f.ok = false;
      warn("read", error);
      return 0;
    }
    f.ok = true;
    let fd;
    try {
      fd = fs.openSync(f.path, "r");
      // Same file, same inode, but rewritten under us (truncated and grown back past our offset)?
      // The bytes just before the offset must still be the ones we read; if not, start again.
      if (f.init && st.ino === f.ino && st.dev === f.dev && st.size >= f.offset && f.guard) {
        const g = Buffer.alloc(f.guard.length);
        fs.readSync(fd, g, 0, g.length, f.offset - g.length);
        if (!g.equals(f.guard)) {
          resetTail(f, st);
          counts.rewound = (counts.rewound ?? 0) + 1;
        }
      }
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      f.ok = false;
      warn("read", error);
      return 0;
    }
    if (!f.init || st.ino !== f.ino || st.dev !== f.dev || st.size < f.offset) resetTail(f, st); // new, replaced or truncated
    f.size = st.size;
    const n = Math.min(st.size - f.offset, L.perFileTick, room);
    if (n > 0) {
      try {
        const buf = Buffer.alloc(n);
        const got = fs.readSync(fd, buf, 0, n, f.offset);
        f.offset += got;
        let data = f.partial ? Buffer.concat([f.partial, buf.subarray(0, got)]) : buf.subarray(0, got);
        f.partial = null;
        let start = 0;
        for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) {
          if (f.skipping) f.skipping = false; // drop the cut (or over-long) line
          else onLine(f, data.subarray(start, i).toString("utf8"), t); // whole lines only: no split UTF-8
          start = i + 1;
        }
        const rest = data.subarray(start);
        if (rest.length > L.maxPartial) f.skipping = true;
        else if (rest.length && !f.skipping) f.partial = Buffer.from(rest);
      } catch (error) {
        f.ok = false;
        warn("read", error);
      }
    }
    try {
      const k = Math.min(L.guardBytes, f.offset);
      if (k > 0) {
        f.guard = Buffer.alloc(k);
        fs.readSync(fd, f.guard, 0, k, f.offset - k);
      } else f.guard = null;
    } catch {
      f.guard = null;
    } finally {
      fs.closeSync(fd);
    }
    f.backlog = f.offset < st.size;
    const cut = t - KEEP_MS;
    if (f.events.length && f.events[0].ts < cut) f.events = f.events.filter((e) => e.ts >= cut);
    for (const [k, ts] of f.keys) if (ts < cut) f.keys.delete(k);
    return Math.max(0, n);
  }

  // ---------------- threads ----------------
  const threads = new Map(); // T3 thread id -> { provider, kind, state, keys: Set }
  let rr = 0; // round-robin start, so every file gets its turn under the caps
  let last = { at: null, sqlOk: false };

  async function tick() {
    const t = now();
    counts.ticks++;
    loadPrices();
    const res = await query(t); // SQLite finishes before any tailing starts
    budget = { deadline: performance.now() + L.tickMs, entries: 0, bytes: 0 };
    if (res.error) {
      warn("sql", { code: res.error });
      for (const th of threads.values()) th.state = step(th.state, { ok: false }, calib.thresholds, t, th.kind);
      last = { at: t, sqlOk: false };
      return;
    }
    // 1. Map threads to sessions (provider + instance + native id).
    const mapped = new Map();
    for (const row of Array.isArray(res.rows) ? res.rows : []) {
      const prov = PROVIDERS[row.p];
      if (!prov || typeof row.t !== "string" || row.t.length > 200 || typeof row.n !== "string" || !SAFE_ID.test(row.n)) continue; // e.g. Gemini: not measured
      if (!mapped.has(row.t)) mapped.set(row.t, { provider: prov.name, kind: prov.kind, sessions: [] });
      mapped.get(row.t).sessions.push({ p: row.p, i: typeof row.i === "string" ? row.i : row.p, n: row.n });
    }
    // 2. Find transcripts (a bounded number of new lookups per tick).
    let lookups = 0;
    const want = new Map(); // real path -> { threads: Set, provider, expect, role }
    const claim = (p, threadId, provider, expect, role) => {
      if (!want.has(p)) want.set(p, { threads: new Set(), provider, expect, role });
      want.get(p).threads.add(threadId);
    };
    const nativeIds = new Set([...mapped.values()].flatMap((m) => m.sessions.map((s) => s.n)));
    const unresolved = new Set();
    for (const [threadId, m] of mapped) {
      for (const s of m.sessions) {
        const key = `${s.p}|${s.i}|${s.n}`;
        let hit = found.get(key);
        if ((!hit || (hit.miss && t - hit.miss > 2 * 60_000)) && lookups < L.discoveriesPerTick) {
          lookups++;
          const f = s.p === "claudeAgent" ? (s.i === "claudeAgent" ? findClaude(s.n, t) : null) : s.p === "codex" ? findCodex(s.i, s.n, t) : s.i === "grok" ? findGrok(s.n, t) : null;
          if (f === PARTIAL) {
            unresolved.add(threadId); // the budget ran out mid-search: unknown this tick, no miss recorded
            continue;
          }
          hit = f ?? { miss: t };
          found.set(key, hit);
          if (found.size > 2_000) found.delete(found.keys().next().value);
        }
        if (!hit || hit.miss) {
          unresolved.add(threadId);
          continue;
        }
        claim(hit.path, threadId, m.provider, s.n, "main");
        if (m.provider === "claude" && hit.dir) {
          // Subagent files fold into the parent once; a child that is its own T3 thread doesn't.
          const subDir = path.join(hit.dir, s.n, "subagents");
          const sub = iterDir(subDir, L.maxSubagents * 4, false);
          if (!sub.complete) unresolved.add(threadId);
          const names = sub.names.filter((x) => x.endsWith(".jsonl")).slice(0, L.maxSubagents);
          for (const name of names) {
            if (nativeIds.has(name.slice(0, -6))) continue;
            const real = inside(P.claude, path.join(subDir, name));
            if (real) claim(real, threadId, "claude", s.n, "sub");
          }
        }
      }
    }
    // 3. A transcript claimed by two threads is withheld from both (no double counting).
    const withheld = new Set();
    for (const [p, w] of want) {
      if (w.threads.size > 1) {
        for (const th of w.threads) withheld.add(th);
        want.delete(p);
        counts.withheld++;
      }
    }
    // 4. Tail (caps: files, bytes and time per tick, shared with discovery; round-robin). A thread
    // with any wanted file left out by the file cap is incomplete: unknown, never a lower rate.
    const list = [...want.keys()].slice(0, L.maxFiles);
    const listed = new Set(list);
    for (const [p, w] of want) if (!listed.has(p)) for (const th of w.threads) unresolved.add(th);
    for (const p of files.keys()) if (!listed.has(p)) files.delete(p); // never more states than the cap
    for (const p of list) if (!files.has(p)) files.set(p, newTail(p, want.get(p).provider, want.get(p).expect, want.get(p).role));
    const order = list.map((_, k) => list[(k + rr) % list.length]);
    rr = (rr + 1) % Math.max(1, list.length);
    const done = new Set();
    for (const p of order) {
      if (budget.bytes >= L.tickBytes || performance.now() > budget.deadline) break;
      budget.bytes += tail(files.get(p), L.tickBytes - budget.bytes, t);
      done.add(p);
    }
    // 5. Charges claimed by two threads (e.g. a fork copying history) are withheld from both.
    const owner = new Map();
    const ambiguous = new Set();
    for (const p of done) {
      const th = [...want.get(p).threads][0];
      for (const e of files.get(p).events) {
        if (e.key === null) continue;
        const o = owner.get(e.key);
        if (o === undefined) {
          if (owner.size < L.maxGlobalKeys) owner.set(e.key, th);
        } else if (o !== th) ambiguous.add(e.key);
      }
    }
    // 6. One observation per thread, then its tier.
    const byThread = new Map();
    for (const p of list) {
      const th = [...want.get(p).threads][0];
      if (!byThread.has(th)) byThread.set(th, []);
      byThread.get(th).push(p);
    }
    for (const [threadId, m] of mapped) {
      const paths = byThread.get(threadId) ?? [];
      const complete = paths.length > 0 && !withheld.has(threadId) && !unresolved.has(threadId)
        && paths.every((p) => done.has(p) && files.get(p).ok && !files.get(p).invalid && !files.get(p).backlog && files.get(p).coveredFrom !== null && files.get(p).coveredFrom <= t - WINDOWS.w15);
      const seen = new Set();
      const events = [];
      for (const p of paths) {
        for (const e of files.get(p).events) {
          if (e.key !== null && (ambiguous.has(e.key) || seen.has(e.key))) continue;
          if (e.key !== null) seen.add(e.key);
          events.push(e);
        }
      }
      const th = threads.get(threadId) ?? { provider: m.provider, kind: m.kind, state: newThreadState() };
      th.provider = m.provider;
      th.kind = m.kind;
      const obs = complete ? { ...observe(events, t), ok: true } : { ok: false };
      th.state = step(th.state, obs, calib.thresholds, t, th.kind);
      if (obs.ok && obs.fam) th.fam = obs.fam;
      threads.set(threadId, th);
    }
    for (const id of threads.keys()) if (!mapped.has(id)) threads.delete(id); // idle 40 min: dropped
    last = { at: t, sqlOk: true };
  }

  /** The /burn answer: only threads with a tier; no titles, text or paths. */
  function snapshot() {
    const t = now();
    const out = {};
    for (const [id, th] of threads) {
      const tier = tierOf(th.state, t, th.kind);
      if (!tier) continue;
      const usual = th.fam ? calib.usual?.[th.fam] ?? null : null;
      out[id] = {
        ...tier,
        rateUsdPerHour: tier.rateUsdPerHour === null || tier.rateUsdPerHour === undefined ? null : Math.round(tier.rateUsdPerHour * 100) / 100,
        burstUsd: tier.burstUsd === undefined ? undefined : Math.round(tier.burstUsd * 100) / 100,
        provider: th.provider,
        usualUsdPerHour: usual,
      };
    }
    return {
      generatedAt: last.at,
      ok: last.sqlOk,
      thresholds: { ...calib.thresholds, source: calib.source, referenceDays: calib.referenceDays, computedAt: calib.computedAt },
      threads: out,
    };
  }

  return {
    tick,
    snapshot,
    recalibrate,
    stats: () => ({ ...counts, threads: threads.size, files: files.size }),
    close: () => worker?.terminate(),
    _files: files,
  };
}
