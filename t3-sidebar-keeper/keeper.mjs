#!/opt/homebrew/bin/node
/**
 * T3 sidebar keeper: re-applies Andy's sidebar-title patch to T3 Code (Nightly)
 * after every update, without depending on the build's minified names.
 *
 * Units (each applies fully or not at all; every file keeps its byte length):
 *   wrap      client/index.html   unlayered <style> so sidebar titles word-wrap
 *   minWidth  main-*.js           sidebar drag minimum 208px -> 140px
 *   rule      binCli-*.mjs        title prompt asks for 2-5 words, under 36 chars
 *   fit       binCli-*.mjs        generated titles <= 40 chars, child titles <= 42; readable native ids
 *   titleGuide binCli-*.mjs       one compact Titles section in every provider's instructions
 *   geminiQuota binCli-*.mjs      Antigravity limits probe sends a current version, so Google
 *                                 returns the Gemini quota rows (server: next T3 launch); builds
 *                                 that already send 2.24.0 or newer are left as they are
 *   antigravityQuestions server-*.mjs
 *                                 adds extractElicitationForm to Antigravity's ACP flavor so
 *                                 ask_question folds qN + qN_other, unlocks custom answers, and
 *                                 splits Claude-style headers/option descriptions (server: next
 *                                 T3 launch); yields cleanly if upstream adds its own extractor
 *   extras    client/index.html   tiny inline loader for the t3-extras add-ons (127.0.0.1:8793);
 *                                 its bytes come out of wrap's <style> padding
 *   firstClick desktop main.cjs   acceptFirstMouse on the Mac window, so the first click on an
 *                                 inactive T3 window also clicks (starts at T3's next launch)
 *
 * Usage:
 *   keeper.mjs --status        what is patched in the installed build
 *   keeper.mjs --apply         patch now (needs write access to the app)
 *   keeper.mjs --auto          launchd entry: patch only after the build's first launch
 *   keeper.mjs --restore       put back this build's original bytes
 *   keeper.mjs --dry-run       patch a temporary copy and report (writes nothing to the app)
 *   keeper.mjs --probe         can this process open app.asar for writing? (changes nothing)
 *   keeper.mjs --disable <unit> / --enable <unit>
 *                              extras, rule, fit or titleGuide (kept in disabled.json);
 *                              the other units stay as they are until --restore
 *   keeper.mjs --reminders     restart-reminder status (JSON)
 *   keeper.mjs --snooze 3h     snooze restart reminders (also 90m, 1h, …)
 *   keeper.mjs --resume-reminders
 *   keeper.mjs --remind-every 15m
 *   keeper.mjs --reminder-controls
 *                              open the reminder window; it never quits T3
 *
 * Safety:
 *   - Gatekeeper scans a build on its first launch and shows a "damaged" prompt
 *     if it was modified before then, so --auto only patches an app.asar that a
 *     running T3 process has open (same device and inode, checked with lsof).
 *   - Refuses to patch if Electron's asar-integrity fuse is on (T3 would not start).
 *   - Comments are found with a real parser (vendored acorn), never by pattern.
 *   - The file on disk is swapped atomically: a clone is patched, verified and
 *     renamed over app.asar, so a crash leaves either the old or the new
 *     complete file. The running app keeps the old file open, so the same bytes
 *     are then written into that old copy too; that is what Shift-Cmd-R reloads.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = process.env.T3_APP_PATH || "/Applications/T3 Code (Nightly).app";
const ASAR = process.env.T3_ASAR_PATH || path.join(APP, "Contents/Resources/app.asar");
const HOME = process.env.T3_KEEPER_HOME || path.join(os.homedir(), ".local/share/t3-sidebar-keeper");
const IS_ENTRY = Boolean(process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)));
// Take the code lease before importing replaceable siblings. The installer
// leaves this permanent inode in place, marks maintenance, then takes the
// same lock. A manually started keeper cannot import mixed code during it.
let entryLease = null;
if (IS_ENTRY) {
  const marker = path.join(HOME, "install-in-progress.json");
  const busy = () => {
    if (entryLease !== null) fs.closeSync(entryLease);
    process.stdout.write(`${JSON.stringify({ ok: false, error: "busy", message: "The reminder helper is updating. Try again." })}\n`);
    process.exit(75);
  };
  if (fs.existsSync(marker)) busy();
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  entryLease = fs.openSync(path.join(HOME, "code.flock"), "a+", 0o600);
  const locked = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], { stdio: ["ignore", "pipe", "pipe", entryLease], timeout: 5000 });
  if (locked.status === 75) busy();
  if (locked.status !== 0) {
    fs.closeSync(entryLease);
    throw new Error(`code lease failed (${locked.error?.code ?? locked.status})`);
  }
  if (fs.existsSync(marker)) busy();
}
const [acorn, reminders] = await Promise.all([import("./vendor/acorn/acorn.mjs"), import("./reminders.mjs")]);
const STATE = path.join(HOME, "state.json");
const DISABLED = path.join(HOME, "disabled.json");
const BACKUPS = path.join(HOME, "backups");
const LOCK = path.join(HOME, "keeper.lock");
const USER_DATA = process.env.T3_USER_DATA_DIR || path.join(os.homedir(), "Library/Application Support/t3code-v2");
const FRAMEWORK = path.join(APP, "Contents/Frameworks/Electron Framework.framework/Electron Framework");
const STYLE_ID = "t3-keeper-sidebar-2"; // bump the number when WRAP_CSS changes
const KEEP_BACKUPS = 3;
const KEEPER_VERSION = 18; // bump when units change so --auto re-checks an already-handled build
const MIN_FREE_BYTES = 1024 ** 3;
const TMP_PREFIX = ".app.asar.t3-keeper-";
const PARSE = { ecmaVersion: "latest", allowHashBang: true };

// Unlayered, so it beats Tailwind's @layer utilities (.truncate, .h-9) without !important.
const WRAP_CSS = [
  "[data-thread-item] span.min-w-0.flex-1.text-start,",
  ":is([data-testid=sidebar-row-card],[data-testid=sidebar-row-slim]) span[aria-hidden].flex-1.truncate,",
  "[data-testid=sidebar-draft-row] .mt-0\\.5.truncate,",
  "[data-testid^=thread-title-],",
  "#sidebar-thread-search-results span.min-w-0.flex-1.truncate",
  "{white-space:normal;overflow-wrap:anywhere;text-overflow:clip;line-height:1.3}",
  "[data-testid=sidebar-row-slim]{height:auto;min-height:2.25rem;padding-block:.375rem}",
  ":is([data-testid=sidebar-row-card],[data-testid=sidebar-draft-row]) .h-\\[4\\.875rem\\]{height:auto;min-height:4.875rem}",
  "[data-slot=sidebar-menu-sub-button]:has([data-testid^=thread-title-]){height:auto;min-height:1.75rem;padding-block:.25rem}",
].join("");

// Markup the CSS relies on; if a build drops one, --status and the notification say so.
const WRAP_HOOKS = [
  "sidebar-row-card",
  "sidebar-row-slim",
  "sidebar-draft-row",
  "sidebar-thread-search-results",
  "h-[4.875rem]",
  "min-w-0 flex-1 text-start text-sm", // the title span itself (4736 and older rows)
];
const INLINE_STYLE_CSP = "style-src 'self' 'unsafe-inline'";

// T3's renderer is t3code://app with a CSP that refuses remote <script src> and <link>, but
// allows inline scripts and fetch() to http:. So the loader fetches the add-ons' code from the
// loopback service and inserts it inline. It re-fetches when /version changes, checked only on
// window focus. Silent when the service is down. ASCII only and no "<" inside, so its bytes are
// exact and "</script>" ends it. Bump the number in EXTRAS_ID when the loader changes.
// The public key is read from loader-key.json at patch time and baked into this string.
const EXTRAS_ID = "t3x-boot-2";
const LOADER_KEY = process.env.T3X_LOADER_KEY || path.join(os.homedir(), ".local/share/t3-extras/loader-key.json");

/** Which loader key the last pass saw ("missing" when none), so a new key re-patches the loader. */
function loaderKeyId() {
  try {
    return sha(fs.readFileSync(LOADER_KEY));
  } catch {
    return "missing";
  }
}

function extrasBoot(spki) {
  if (typeof spki !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(spki) || spki.length > 200) {
    throw new Error("loader key is not SPKI base64");
  }
  const body = `(()=>{try{const u="http://127.0.0.1:8793/",d=document,w=window,k="${spki}";let v;` +
    `const g=p=>fetch(u+p,{cache:"no-store"}).then(r=>r.ok?r.text():Promise.reject()),` +
    `b=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)),` +
    `L=()=>Promise.all([g("version"),g("extras.css"),g("extras.js"),g("extras.sig")]).then(([n,c,j,sg])=>` +
    `crypto.subtle.importKey("spki",b(k),{name:"ECDSA",namedCurve:"P-256"},!1,["verify"]).then(K=>` +
    `crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},K,b(sg.trim()),new TextEncoder().encode(JSON.stringify(["t3x1",n,c,j]))))` +
    `.then(ok=>{if(!ok)return;v=n;try{w.t3xTeardown&&w.t3xTeardown()}catch(e){}` +
    `d.querySelectorAll("#t3x-css,#t3x-js").forEach(x=>x.remove());` +
    `const s=d.createElement("style"),e=d.createElement("script");s.id="t3x-css";s.textContent=c;e.id="t3x-js";e.textContent=j;d.head.append(s,e)}))` +
    `.catch(()=>{});w.addEventListener("focus",()=>{g("version").then(n=>{n!==v&&L()}).catch(()=>{})});L()}catch(e){}})()`;
  if (body.includes("<") || !/^[\x20-\x7e]*$/.test(body)) throw new Error("loader is not ASCII");
  return `<script id="${EXTRAS_ID}">${body}</script>`;
}

function readLoaderKey() {
  try {
    const spki = JSON.parse(fs.readFileSync(LOADER_KEY, "utf8")).spki;
    if (typeof spki === "string" && /^[A-Za-z0-9+/]+=*$/.test(spki)) return spki;
  } catch {}
  return null;
}

// Counts and cuts whole graphemes, so emoji and accents are never split. Drops lone
// surrogates (left by an upstream UTF-16 cut). "units" caps the UTF-16 length too.
// Exact v9 helper retained for a byte-for-byte upgrade of already-patched builds.
const FIT_TITLE_V9 = String.raw`function t3KeeperFitTitle(title, max, units = Infinity) {
	if (typeof title !== "string") return title;
	const text = title.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "").replace(/\s+/g, " ").trim();
	const g = (s) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);
	const fit = (limit) => {
		if (g(text).length <= limit) return text;
		const tag = text.match(/\s(\([^()]{1,24}\)|(?:subagent|thread) \d+)$/u);
		const tail = tag ? " " + tag[1] : "";
		const budget = Math.max(1, limit - g(tail).length - 3);
		let lead = tag ? text.slice(0, tag.index) : text;
		// "Long Role Name: subject" keeps the role's last word, or drops it, so siblings stay distinct.
		const colon = lead.indexOf(": ");
		if (colon > 0 && g(lead).length > budget) {
			const subject = lead.slice(colon + 2);
			const word = lead.slice(0, colon).split(" ").pop();
			const role = word.charAt(0).toUpperCase() + word.slice(1);
			lead = g(role + ": " + subject.split(" ")[0]).length > budget ? subject : role + ": " + subject;
		}
		if (g(lead).length + g(tail).length <= limit) return lead + tail;
		const body = g(lead);
		let head = body.slice(0, budget).join("");
		if (body[budget] !== " ") {
			const space = head.lastIndexOf(" ");
			if (space >= Math.floor(head.length / 2)) head = head.slice(0, space);
		}
		return head.replace(/[\s:;,&-]+$/u, "") + "..." + tail;
	};
	let limit = max;
	let out = fit(limit);
	while (out.length > units && limit > 1) out = fit(--limit);
	if (out.length > units) {
		// A grapheme longer than the cap (e.g. a letter with 100 accents) is dropped whole; the tag stays.
		const tag = text.match(/\s(\([^()]{1,24}\)|(?:subagent|thread) \d+)$/u);
		const tail = tag && tag[1].length + 5 <= units ? " " + tag[1] : "";
		let cut = "";
		for (const seg of g(tag && tail ? text.slice(0, tag.index) : text)) {
			if (cut.length + seg.length > units - 3 - tail.length) break;
			cut += seg;
		}
		out = cut.trimEnd() + "..." + tail;
	}
	return out;
}
`;

const FIT_TITLE = String.raw`function t3KeeperFitTitle(title, max, units = Infinity, nativeAgent = false) {
	// t3-keeper-fit-2: native ids are words only for the subagent title input.
	if (typeof title !== "string") return title;
	if (nativeAgent && title === title.trim() && /^\/?(?:root\/)?[a-z0-9]+(?:[_/][a-z0-9]+)+$/.test(title)) {
		title = title.replace(/^\/?(?:root\/)?/, "").replace(/[_/]/g, " ");
		title = title.charAt(0).toUpperCase() + title.slice(1);
	}
	const text = title.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "").replace(/\s+/g, " ").trim();
	const g = (s) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);
	const fit = (limit) => {
		if (g(text).length <= limit) return text;
		const tag = text.match(/\s(\([^()]{1,24}\)|(?:subagent|thread) \d+)$/u);
		const tail = tag ? " " + tag[1] : "";
		const budget = Math.max(1, limit - g(tail).length - 3);
		let lead = tag ? text.slice(0, tag.index) : text;
		// Keep the last role word (and its number), or drop the role, so siblings stay distinct.
		const colon = lead.indexOf(": ");
		if (colon > 0 && g(lead).length > budget) {
			const subject = lead.slice(colon + 2);
			const words = lead.slice(0, colon).split(" ");
			// "Code review 3" tries "Review 3", then "3", so numbered rounds never collapse together.
			const tries = words.length > 1 && /^\d+$/.test(words.at(-1)) ? [words.slice(-2).join(" "), words.at(-1)] : [words.at(-1)];
			let next = subject;
			for (const word of tries) {
				const role = word.charAt(0).toUpperCase() + word.slice(1);
				if (g(role + ": " + subject.split(" ")[0]).length <= budget) { next = role + ": " + subject; break; }
			}
			lead = next;
		}
		if (g(lead).length + g(tail).length <= limit) return lead + tail;
		const body = g(lead);
		let head = body.slice(0, budget).join("");
		if (body[budget] !== " ") {
			const space = head.lastIndexOf(" ");
			if (space >= Math.floor(head.length / 2)) head = head.slice(0, space);
		}
		return head.replace(/[\s:;,&-]+$/u, "") + "..." + tail;
	};
	let limit = max;
	let out = fit(limit);
	while (out.length > units && limit > 1) out = fit(--limit);
	if (out.length > units) {
		// A grapheme longer than the cap (e.g. a letter with 100 accents) is dropped whole; the tag stays.
		const tag = text.match(/\s(\([^()]{1,24}\)|(?:subagent|thread) \d+)$/u);
		const tail = tag && tag[1].length + 5 <= units ? " " + tag[1] : "";
		let cut = "";
		for (const seg of g(tag && tail ? text.slice(0, tag.index) : text)) {
			if (cut.length + seg.length > units - 3 - tail.length) break;
			cut += seg;
		}
		out = cut.trimEnd() + "..." + tail;
	}
	return out;
}
`;
// [function, max graphemes, shorten input.title/input.prompt first, to under 64 UTF-16 units, so
//  upstream's own cut at 72/80 units never fires (it can split an emoji and drop a "(tag)")]
const FIT_WRAPPERS = [
  ["sanitizeThreadTitle", 40, false],
  ["subagentThreadTitle", 42, true],
  ["threadTitle", 42, true],
];

// The marker is a source comment; the injected instruction text stays exact.
const TITLE_GUIDE_MARKER = "t3-keeper-title-guide";
const TITLE_GUIDE = String.raw`## Titles

Follow the title-naming skill when you can; the user's own names always win.
- Sentence case, plain words, distinctive subject first. No project name, IDs, revision codes, file or agent paths, filler or "done" claims. Never cut a title with "..."; rewrite it shorter.
- Threads: 2-5 words, under 36 characters.
- Handovers: keep the base and add or replace its number ("Sidebar keeper (2)" -> "Sidebar keeper (3)"); the whole title stays under 36.
- delegate_task: always set title as "Role: subject (Model)", under 42 characters, with a one-word role and a short model name (Sol, Astra, Grok, Gemini, Fable, Opus, Haiku). A later round goes after the subject: "Review: footer rules 3 (Astra)".
- Native subagent names: 2-4 readable words as role_subject, never a path.
- Never rename folders or repos unless asked.
Count every visible character before sending.`;

// ---------- small helpers ----------

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

function notify(message, subtitle = "") {
  if (process.env.T3_KEEPER_QUIET) return;
  return spawnSync("/usr/bin/osascript", ["-e", `display notification ${JSON.stringify(message)} with title "T3 sidebar fix"${subtitle ? ` subtitle ${JSON.stringify(subtitle)}` : ""}`]).status === 0;
}

function writeFileDurable(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    writeAt(fd, buf, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!fs.readFileSync(tmp).equals(buf)) throw new Error(`${path.basename(file)} was not written completely`);
  fs.renameSync(tmp, file);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  const previous = loadState();
  // Spreading previous state at an error/wait path must not carry a build A asset to B.
  const mainJs = state.mainJs ?? (state.build === previous.build ? previous.mainJs ?? null : null);
  state = { ...state, mainJs };
  fs.mkdirSync(HOME, { recursive: true });
  writeFileDurable(STATE, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}

function processStart(pid) {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function withLock(fn) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const me = `${process.pid} ${processStart(process.pid)}`;
  try {
    fs.writeFileSync(LOCK, me, { flag: "wx" });
  } catch {
    const held = fs.readFileSync(LOCK, "utf8");
    const [pid, ...start] = held.split(" ");
    if (Number(pid) && processStart(Number(pid)) === start.join(" ")) {
      log(`another keeper run (pid ${pid}) holds the lock; skipping`);
      return 0;
    }
    // Stale (its owner is gone): remove it and take it with an exclusive create, so two runs can't both win.
    fs.rmSync(LOCK, { force: true });
    try {
      fs.writeFileSync(LOCK, me, { flag: "wx" });
    } catch {
      log("another keeper run took over the stale lock; skipping");
      return 0;
    }
  }
  try {
    removeStaleTemps();
    return fn();
  } finally {
    if (fs.existsSync(LOCK) && fs.readFileSync(LOCK, "utf8") === me) fs.rmSync(LOCK, { force: true });
  }
}

// ---------- app.asar ----------

function readLayout(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(12);
  const headerBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, headerBuf, 0, headerSize, 16);
  const header = JSON.parse(headerBuf.toString("utf8"));
  // Re-serializing must reproduce the header exactly, or offsets can't be trusted.
  if (Buffer.byteLength(JSON.stringify(header)) !== headerSize) {
    throw new Error("app.asar header does not round-trip; refusing to patch");
  }
  return { header, headerSize, headerBuf, dataOffset: 8 + head.readUInt32LE(4) };
}

function entryAt(header, rel) {
  let node = header;
  for (const part of rel.split("/")) node = node?.files?.[part];
  return node ?? null;
}

function listDir(header, rel) {
  return Object.keys(entryAt(header, rel)?.files ?? {});
}

function readAt(fd, at, size) {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = fs.readSync(fd, buf, off, size - off, at + off);
    if (n <= 0) throw new Error("short read from app.asar");
    off += n;
  }
  return buf;
}

function writeAt(fd, buf, at) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off, at + off);
    if (n <= 0) throw new Error("short write to app.asar");
    off += n;
  }
}

function readEntry(fd, layout, rel) {
  const entry = entryAt(layout.header, rel);
  if (!entry || entry.unpacked || typeof entry.size !== "number") throw new Error(`missing ${rel}`);
  return readAt(fd, layout.dataOffset + Number(entry.offset), entry.size);
}

function integrityOf(buf, blockSize) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += blockSize) blocks.push(sha(buf.subarray(i, i + blockSize)));
  return { algorithm: "SHA256", hash: sha(buf), blockSize, blocks };
}

/** Write file bodies, then the header with fresh integrity hashes; read everything back. */
function writeEntries(fd, layout, items) {
  const header = structuredClone(layout.header);
  const writes = [];
  for (const { rel, buf } of items) {
    const entry = entryAt(header, rel);
    if (!entry || buf.length !== entry.size) throw new Error(`size mismatch for ${rel}`);
    entry.integrity = integrityOf(buf, entry.integrity?.blockSize ?? 4194304);
    writes.push({ buf, at: layout.dataOffset + Number(entry.offset) });
  }
  const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBuf.length !== layout.headerSize) throw new Error("header length changed; nothing written");
  for (const w of writes) writeAt(fd, w.buf, w.at);
  writeAt(fd, headerBuf, 16);
  fs.fsyncSync(fd);
  for (const w of writes) {
    if (!readAt(fd, w.at, w.buf.length).equals(w.buf)) throw new Error("read-back after write did not match");
  }
  if (!readAt(fd, 16, headerBuf.length).equals(headerBuf)) throw new Error("header read-back did not match");
}

function asarIdentity(file = ASAR) {
  const st = fs.statSync(file);
  return { dev: st.dev, ino: st.ino, size: st.size, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs };
}

function identityOfFd(fd) {
  const st = fs.fstatSync(fd);
  return { dev: st.dev, ino: st.ino, size: st.size, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs };
}

// Not dev: APFS gave /Applications a new device number at a Mac restart (19 Oct 2026), which
// made the keeper treat its own output as a stranger's and overwrite that build's backup.
const sameFile = (a, b) => a.ino === b.ino && a.size === b.size && a.birthtimeMs === b.birthtimeMs;

// ---------- atomic commit ----------

function removeStaleTemps() {
  const dir = path.dirname(ASAR);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(TMP_PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(name.slice(TMP_PREFIX.length));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        continue; // its writer is still running
      } catch {}
    }
    fs.rmSync(path.join(dir, name), { force: true });
    log(`removed leftover ${name}`);
  }
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

/** [first, last + 1) byte span where two equal-length buffers differ, or null. */
function changedSpan(a, b) {
  let start = 0;
  while (start < a.length && a[start] === b[start]) start++;
  if (start === a.length) return null;
  let end = a.length;
  while (end > start && a[end - 1] === b[end - 1]) end--;
  return [start, end];
}

/**
 * Write the changed span of each UI file into the copy the running app has open, as a
 * single write per file, so a killed keeper leaves every file wholly old or wholly new
 * (the server file is already loaded, so it is left alone). On a failed or short write the
 * original bytes are put back. Returns "updated", "rolled-back" or "torn".
 */
function liveUpdate(fd, layout, items, hooks = {}) {
  const written = [];
  try {
    for (const f of items.filter((x) => x.live)) {
      const base = layout.dataOffset + Number(entryAt(layout.header, f.rel).offset);
      const span = changedSpan(f.original, f.buf);
      if (!span) continue;
      const [start, end] = span;
      written.push({ at: base + start, before: f.original.subarray(start, end) });
      hooks.liveWrite?.(f.rel, start);
      const n = fs.writeSync(fd, f.buf, start, end - start, base + start);
      if (n !== end - start) throw new Error("short write");
      if (!readAt(fd, base, f.buf.length).equals(f.buf)) throw new Error("read-back did not match");
    }
    return "updated";
  } catch (error) {
    let state = "rolled-back";
    for (const w of written.reverse()) {
      try {
        writeAt(fd, w.before, w.at);
      } catch {
        state = "torn";
      }
    }
    log(`the open T3 window's copy was not updated (${error.message}); ${state}`);
    return state;
  }
}

/**
 * Patch a clone, verify it, and rename it over app.asar. Then write the same bytes into
 * the old copy, which the running app still has open (live effect after Shift-Cmd-R).
 * "checked" is the app.asar identity that was approved for writing; any other file aborts.
 */
function commit({ checked, version, layout, items, guard = () => true, hooks = {}, reminder = null }) {
  const fuse = integrityFuse();
  if (fuse !== "off") throw new Error(`Electron asar integrity check is ${fuse}; patching would stop T3 starting`);
  const dir = path.dirname(ASAR);
  const free = fs.statfsSync(dir);
  if (free.bavail * free.bsize < MIN_FREE_BYTES) throw new Error("less than 1 GB free disk space");
  const tmp = path.join(dir, `${TMP_PREFIX}${process.pid}`);
  let live = "skipped";
  let produced = null;
  const oldFd = fs.openSync(ASAR, "r+");
  try {
    if (!sameFile(identityOfFd(oldFd), checked)) throw new Error("app.asar was replaced; will retry");
    const oldLayout = readLayout(oldFd);
    if (!oldLayout.headerBuf.equals(layout.headerBuf)) throw new Error("app.asar changed while planning; will retry");
    for (const f of items) {
      if (!readEntry(oldFd, oldLayout, f.rel).equals(f.original)) throw new Error(`${f.rel} changed while planning; will retry`);
    }
    fs.copyFileSync(ASAR, tmp, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL); // APFS clone (plain copy elsewhere)
    const tfd = fs.openSync(tmp, "r+");
    try {
      const tmpLayout = readLayout(tfd);
      if (!tmpLayout.headerBuf.equals(layout.headerBuf)) throw new Error("clone differs from the planned app.asar");
      writeEntries(tfd, tmpLayout, items);
      produced = identityOfFd(tfd);
    } finally {
      fs.closeSync(tfd);
    }
    if (reminder) {
      reminders.notePrepared({
        home: HOME,
        appPath: APP,
        build: version,
        intended: produced,
        startupReasons: reminder.startupReasons,
        uiChanged: reminder.uiChanged,
      });
    }
    hooks.beforeRename?.();
    // Slow checks first (subprocesses), then the identity stat as the very last step before the switch.
    if (bundleVersion() !== version) throw new Error("T3 was updated meanwhile; will retry");
    if (!guard()) throw new Error("T3 for this build is no longer running; will retry");
    hooks.afterGuard?.();
    if (!sameFile(asarIdentity(), checked)) throw new Error("app.asar was replaced; will retry");
    fs.renameSync(tmp, ASAR);
    fsyncDir(dir);
    hooks.afterArchiveRename?.();
    let boundaryUs = null;
    if (reminder) {
      try {
        boundaryUs = reminders.noteCommitted({ home: HOME, intended: produced });
      } catch (error) {
        log(`reminders journal commit: ${error.message}`);
      }
    }
    live = liveUpdate(oldFd, oldLayout, items, hooks);
    hooks.beforeReminderFinalize?.();
    if (reminder) {
      try {
        reminders.noteFinalized({
          home: HOME,
          build: version,
          intended: produced,
          live,
          startupReasons: reminder.startupReasons,
          uiChanged: reminder.uiChanged,
          boundaryUs,
        });
      } catch (error) {
        log(`reminders finalize: ${error.message}`);
      }
    }
  } finally {
    fs.closeSync(oldFd);
    fs.rmSync(tmp, { force: true });
  }
  clearCaches();
  return { live, produced };
}

// ---------- environment checks ----------

function bundleVersion() {
  try {
    const raw = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(APP, "Contents/Info.plist")], { encoding: "utf8" });
    return JSON.parse(raw).CFBundleShortVersionString ?? null;
  } catch {
    return null;
  }
}

/** Electron fuse wire v1: index 4 is EnableEmbeddedAsarIntegrityValidation. Patching with it on would stop T3 starting. */
function integrityFuse() {
  const buf = fs.readFileSync(FRAMEWORK);
  const at = buf.indexOf("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  if (at < 0 || buf[at + 32] !== 1 || buf[at + 33] < 5) return "unknown";
  return String.fromCharCode(buf[at + 34 + 4]) === "0" ? "off" : "on";
}

function psField(pid, field) {
  return execFileSync("/bin/ps", ["-p", String(pid), "-o", `${field}=`], { encoding: "utf8" }).trim();
}

/**
 * True only when a running T3 process (its own executable inside the app) has this exact
 * app.asar (same device and inode) open. Then this generation was launched, so Gatekeeper
 * has already scanned it. Version strings and dates are not trusted for this.
 */
function launchedByT3(identity) {
  let out;
  try {
    out = execFileSync("/usr/sbin/lsof", ["-nP", "-F", "pDi", "--", ASAR], { encoding: "utf8" });
  } catch {
    return false; // lsof exits 1 when nothing has the file open
  }
  let pid = null;
  let dev = null;
  for (const line of out.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value);
      dev = null;
    } else if (tag === "D") {
      dev = Number.parseInt(value, 16);
    } else if (tag === "i" && pid && pid !== process.pid && Number(value) === identity.ino && dev === identity.dev) {
      try {
        if (psField(pid, "args").startsWith(`${APP}/Contents/MacOS/`)) return true;
      } catch {}
    }
  }
  return false;
}

// ---------- parsing ----------

function tokenSignature(src, sourceType) {
  const out = [];
  let prevEnd = 0;
  for (const t of acorn.tokenizer(src, { ...PARSE, sourceType })) {
    const v = t.type.label === "regexp" ? `${t.value.pattern}/${t.value.flags}` : String(t.value ?? "");
    const newline = /[\n\r\u2028\u2029]/.test(src.slice(prevEnd, t.start)); // what ASI sees
    out.push(`${t.type.label}\u0000${v}\u0000${newline}`);
    prevEnd = t.end;
  }
  return out;
}

const sameTokens = (a, b, sourceType) => {
  const x = tokenSignature(a, sourceType);
  const y = tokenSignature(b, sourceType);
  return x.length === y.length && x.every((t, i) => t === y[i]);
};

// ---------- units ----------

/** wrap: <style> in index.html; room comes from whole-line // comments in the boot script (found by acorn). */
function unitWrap(text, ctx) {
  if (text.includes(`<style id="${STYLE_ID}">`)) return { state: "already", text };
  if (text.includes('<style id="t3-keeper-sidebar')) throw new Error("an older keeper style is present; run --restore first");
  if (!ctx.desktopMain.includes(INLINE_STYLE_CSP)) throw new Error("T3's content policy may block inline styles");
  const open = text.indexOf("<script>");
  const close = open < 0 ? -1 : text.indexOf("</script>", open);
  const headEnd = text.indexOf("</head>");
  if (open < 0 || close < 0 || headEnd < close) throw new Error("boot script or </head> not found");
  const script = text.slice(open + 8, close);
  const comments = [];
  acorn.parse(script, { ...PARSE, sourceType: "script", onComment: comments });
  let kept = script;
  for (const c of comments.slice().reverse()) {
    if (c.type !== "Line") continue;
    const lineStart = script.lastIndexOf("\n", c.start - 1) + 1;
    const lineEnd = script.indexOf("\n", c.end);
    if (lineEnd < 0 || script.slice(lineStart, c.start).trim() || script.slice(c.end, lineEnd).trim()) continue;
    kept = kept.slice(0, lineStart) + kept.slice(lineEnd + 1);
  }
  if (!sameTokens(script, kept, "script")) throw new Error("comment strip would change the boot script");
  const stripped = text.slice(0, open + 8) + kept + text.slice(close);
  const tag = `<style id="${STYLE_ID}">${WRAP_CSS}</style>\n  `;
  const room = Buffer.byteLength(text) - Buffer.byteLength(stripped) - Buffer.byteLength(tag);
  if (room < 0) throw new Error(`index.html needs ${-room} more bytes`);
  const padded = `<style id="${STYLE_ID}">${WRAP_CSS}${" ".repeat(room)}</style>\n  `;
  const at = stripped.indexOf("</head>");
  return { state: "patched", text: stripped.slice(0, at) + padded + stripped.slice(at) };
}

/** True when T3's desktop CSP (main.cjs) still lets an inline script fetch() from http:. */
function cspAllowsLoader(desktopMain) {
  const at = desktopMain.indexOf("function makeDesktopContentSecurityPolicy(");
  if (at < 0) return false;
  const body = desktopMain.slice(at, desktopMain.indexOf('].join("; ")', at));
  const part = (name, next) => body.slice(body.indexOf(name), body.indexOf(next, body.indexOf(name)));
  const script = part("script-src", "connect-src");
  const connect = part("connect-src", "img-src");
  return script.includes("'unsafe-inline'") && !script.includes("strict-dynamic") && !script.includes("nonce-") && /["'`]http:["'`]/.test(connect);
}

/** Puts the loader's bytes back into wrap's <style> padding (any loader version). */
function removeExtras(text) {
  const open = text.indexOf('<script id="t3x-boot-');
  const close = text.indexOf("</script>", open) + "</script>".length;
  const tag = text.slice(open, close);
  const styleOpen = text.indexOf(`<style id="${STYLE_ID}">`);
  const styleClose = text.indexOf("</style>", styleOpen);
  if (styleOpen < 0 || styleClose < 0 || styleClose + "</style>".length !== open) throw new Error("the add-ons loader is not where the keeper put it");
  const back = " ".repeat(Buffer.byteLength(tag));
  return text.slice(0, styleClose) + back + "</style>" + text.slice(close);
}

// Reclaim indentation only between boot-script tokens. Keep every newline (ASI),
// comment and token byte, including indentation inside strings/templates/regexes.
// New nightlies can have too few removable comments to hold the add-ons loader.
function reclaimBootIndentation(text) {
  const open = text.indexOf("<script>");
  const close = open < 0 ? -1 : text.indexOf("</script>", open);
  if (open < 0 || close < 0) return text;
  const script = text.slice(open + 8, close);
  let kept = "", end = 0;
  for (const token of acorn.tokenizer(script, { ...PARSE, sourceType: "script" })) {
    const gap = script.slice(end, token.start);
    kept += /^[\t\r\n ]*$/.test(gap) ? gap.replace(/\n[\t ]+/g, "\n") : gap;
    kept += script.slice(token.start, token.end);
    end = token.end;
  }
  kept += script.slice(end);
  if (!sameTokens(script, kept, "script")) throw new Error("indent strip would change the boot script");
  const saved = Buffer.byteLength(script) - Buffer.byteLength(kept);
  if (!saved) return text;
  const next = text.slice(0, open + 8) + kept + text.slice(close);
  const styleClose = next.indexOf("</style>", next.indexOf(`<style id="${STYLE_ID}">`));
  return next.slice(0, styleClose) + " ".repeat(saved) + next.slice(styleClose);
}

/**
 * extras: an inline loader right after wrap's <style>, its bytes taken from that style's
 * trailing padding (no comment room is left once wrap has run). Runs after wrap in UNITS.
 * Switched off (disabled.json), it gives the bytes back, so wrap stays exactly as it was.
 */
function unitExtras(text, ctx) {
  const present = text.includes('<script id="t3x-boot-');
  if (ctx.disabled?.has("extras")) return present ? { state: "removed", text: removeExtras(text) } : { state: "disabled", text };
  const spki = ctx.loaderKey ?? null;
  let boot = null;
  try {
    if (spki) boot = extrasBoot(spki);
  } catch {
    boot = null;
  }
  // No key: do not leave an older unsigned loader in place, and do not claim the add-ons are protected.
  if (!boot) {
    const error = "install t3-extras first";
    if (!present) return { state: "blocked", text, error };
    try {
      return { state: "blocked", text: removeExtras(text), error };
    } catch (error2) {
      throw new Error(`${error} (${error2.message})`);
    }
  }
  if (text.includes(boot)) return { state: "already", text };
  if (!cspAllowsLoader(ctx.desktopMain)) throw new Error("T3's content policy may block the add-ons loader");
  let base = present ? removeExtras(text) : text; // an older loader version, or another key, is replaced
  let styleOpen = base.indexOf(`<style id="${STYLE_ID}">`);
  if (styleOpen < 0) throw new Error("unit wrap's <style> is missing (extras takes its room from it)");
  let styleClose = base.indexOf("</style>", styleOpen);
  let pad = base.slice(styleOpen, styleClose).match(/ *$/)[0].length;
  const need = Buffer.byteLength(boot);
  if (pad < need) {
    base = reclaimBootIndentation(base);
    styleOpen = base.indexOf(`<style id="${STYLE_ID}">`);
    styleClose = base.indexOf("</style>", styleOpen);
    pad = base.slice(styleOpen, styleClose).match(/ *$/)[0].length;
  }
  if (pad < need) throw new Error(`index.html needs ${need - pad} more bytes`);
  const after = styleClose + "</style>".length;
  return { state: "patched", text: base.slice(0, styleClose - need) + "</style>" + boot + base.slice(after) };
}

const MIN_WIDTH_PATTERNS = [
  /Math\.max\((208|140),Math\.ceil\([\w$]+\)\)/g,
  /=(208|140)\)\{return Math\.max\([\w$]+,Math\.floor\([\w$]+\)-640\)\}/g,
  /\?[\w$]+:Math\.max\((208|140),[\w$]+\),/g,
];

/** minWidth: the three 208s right after the chat_thread_sidebar_width key, each confirmed as a number token. */
function unitMinWidth(text) {
  let anchor = -1;
  const regionTokens = [];
  for (const token of acorn.tokenizer(text, { ...PARSE, sourceType: "module" })) {
    if (anchor < 0 && token.type.label === "name" && /^[\w$]+=`chat_thread_sidebar_width`/.test(text.slice(token.start, token.start + 100))) anchor = token.start;
    if (anchor >= 0) {
      if (token.start > anchor + 900) break;
      regionTokens.push(token);
    }
  }
  if (anchor < 0) throw new Error("sidebar width key not found");
  const region = text.slice(anchor, anchor + 900);
  // Newer builds share one minimum constant across all three clamps. Bind its
  // name through the anchored declaration, then confirm every clamp uses it.
  const shared = region.match(/^([\w$]+)=`chat_thread_sidebar_width`,[\w$]+=256,([\w$]+)=(208|140);/);
  if (shared) {
    const name = shared[2].replace(/[$]/g, "\\$");
    const checks = [
      new RegExp(`Math\\.max\\(${name},Math\\.ceil\\([\\w$]+\\)\\)`),
      new RegExp(`=${name}\\)\\{return Math\\.max\\([\\w$]+,Math\\.floor\\([\\w$]+\\)-640\\)`),
      new RegExp(`:Math\\.max\\(${name},[\\w$]+\\),`),
    ];
    const tokenStarts = new Set(regionTokens.map((t) => t.start));
    if (!checks.every((re) => {
      const matches = [...region.matchAll(new RegExp(re.source, "g"))].filter((m) => tokenStarts.has(anchor + m.index));
      return matches.length === 1;
    })) throw new Error("shared sidebar width clamp changed shape");
    const at = anchor + shared[0].lastIndexOf(shared[3]);
    const number = regionTokens.find((t) => t.start === at);
    if (number?.type.label !== "num" || number.value !== Number(shared[3]) || number.end !== at + 3) throw new Error("sidebar minimum is not a number literal");
    if (shared[3] === "140") return { state: "already", text };
    return { state: "patched", text: text.slice(0, at) + "140" + text.slice(at + 3) };
  }
  const found = MIN_WIDTH_PATTERNS.map((re) => [...region.matchAll(re)]);
  if (found.some((m) => m.length !== 1)) throw new Error("sidebar width clamp changed shape");
  const values = found.map(([m]) => m[1]);
  if (values.every((v) => v === "140")) return { state: "already", text };
  if (!values.every((v) => v === "208")) throw new Error("sidebar width clamp is half-patched");
  const spots = found.map(([m]) => anchor + m.index + m[0].indexOf("208")).sort((a, b) => a - b);
  let i = 0;
  for (const t of acorn.tokenizer(text, { ...PARSE, sourceType: "module" })) {
    if (t.start > spots[i]) throw new Error("208 is not a token of its own");
    if (t.start === spots[i]) {
      if (t.type.label !== "num" || t.value !== 208 || t.end !== t.start + 3) throw new Error("208 is not a number literal");
      i += 1;
      if (i === spots.length) break;
    }
  }
  if (i !== spots.length) throw new Error("208 literals not found by the tokenizer");
  let next = text;
  for (const at of spots) next = next.slice(0, at) + "140" + next.slice(at + 3);
  return { state: "patched", text: next };
}

const RULE_FROM = "- 3-8 words, fewer than 40 characters.";
const RULE_TO = "- 2-5 words, fewer than 36 characters.";

/** rule: the title prompt's length rule (byte balance is done once for the file). */
function unitRule(text, ctx = {}) {
  const applied = text.includes(RULE_TO) && !text.includes(RULE_FROM);
  if (ctx.disabled?.has("rule")) return applied ? { state: "retained", text } : { state: "disabled", text };
  if (applied) return { state: "already", text };
  if (!text.includes(RULE_FROM)) throw new Error("title prompt length rule not found");
  return { state: "patched", text: text.split(RULE_FROM).join(RULE_TO) };
}

function fitWrapper(name, max, preFit, nativeAgent = false) {
  const call = preFit
    ? `${name}$t3orig(input && typeof input === "object" ? { ...input, title: t3KeeperFitTitle(input.title, ${max}, 64${nativeAgent ? ", true" : ""}), prompt: t3KeeperFitTitle(input.prompt, ${max}, 64) } : input)`
    : `${name}$t3orig(input)`;
  return `function ${name}(input) {\n\treturn t3KeeperFitTitle(${call}, ${max});\n}\n`;
}

/** fit: wrap the three server title functions, upgrading the exact v9 helper in place. */
function unitFit(text, ctx = {}) {
  const legacy = text.includes("function t3KeeperFitTitle(");
  const applied = text.includes(FIT_TITLE) && (text.includes(fitWrapper("subagentThreadTitle", 42, true, true)) || (ctx.wrappers?.length === 1 && text.includes(fitWrapper("threadTitle", 42, true))));
  if (ctx.disabled?.has("fit")) return (applied || legacy) ? { state: "retained", text } : { state: "disabled", text };
  if (text.includes("function t3KeeperFitTitle(")) {
    if (text.split("function t3KeeperFitTitle(").length !== 2) throw new Error("title fitter declared more than once");
    const oldWrapper = fitWrapper("subagentThreadTitle", 42, true);
    const nextWrapper = ctx.wrappers?.length === 1 ? fitWrapper("threadTitle", 42, true) : fitWrapper("subagentThreadTitle", 42, true, true);
    if (text.includes(FIT_TITLE) && text.includes(nextWrapper)) return { state: "already", text };
    if (!text.includes(FIT_TITLE_V9) || text.split(oldWrapper).length !== 2) {
      throw new Error("title fitter is not the exact supported v9 helper and wrapper");
    }
    return { state: "patched", text: text.replace(FIT_TITLE_V9, () => FIT_TITLE).replace(oldWrapper, () => nextWrapper) };
  }
  const wrappers = ctx.wrappers ?? (hasTopLevelFunction(text, "threadTitle") ? FIT_WRAPPERS : FIT_WRAPPERS.slice(0, 2));
  // sanitizeThreadTitle would cut at 117 UTF-16 units (can split an emoji) before our fitter sees it.
  const maxDecl = /^const MAX_THREAD_TITLE_CHARS = \d+;$/gm;
  if (wrappers.some(([n]) => n === "sanitizeThreadTitle") && ([...text.matchAll(maxDecl)].length !== 1 || text.split("MAX_THREAD_TITLE_CHARS").length !== 3)) {
    throw new Error("MAX_THREAD_TITLE_CHARS is not declared once and used once");
  }
  let next = text.replace(maxDecl, "const MAX_THREAD_TITLE_CHARS = Number.MAX_SAFE_INTEGER;");
  for (const [name, max, preFit] of wrappers) {
    const hits = [...next.matchAll(new RegExp(`^function ${name}\\(`, "gm"))];
    if (hits.length !== 1) throw new Error(`${name} declared ${hits.length} times`);
    if (next.includes(`${name}$t3orig`)) throw new Error(`${name}$t3orig already exists`);
    const wrapper =
      (name === wrappers[0][0] ? FIT_TITLE : "") +
      fitWrapper(name, max, preFit, name === "subagentThreadTitle");
    const at = hits[0].index;
    next = next.slice(0, at) + wrapper + `function ${name}$t3orig(` + next.slice(at + hits[0][0].length);
  }
  return { state: "patched", text: next };
}

/** titleGuide: one replaceable last instruction section, found by the stable array name. */
function unitTitleGuide(text, ctx = {}) {
  if (ctx.disabled?.has("titleGuide")) {
    try {
      const next = titleGuideBody(text);
      if (next.state === "already" || text.includes("## Titles\n")) return { state: "retained", text };
      return { state: "disabled", text };
    } catch {
      return { state: "disabled", text };
    }
  }
  return titleGuideBody(text);
}

function titleGuideBody(text) {
  if (Buffer.byteLength(TITLE_GUIDE) >= 4000) throw new Error("title guide must stay under 4,000 bytes");
  const comments = [];
  const ast = acorn.parse(text, { ...PARSE, sourceType: "module", onComment: comments });
  const decls = ast.body.flatMap((n) => n.type === "VariableDeclaration" ? n.declarations : [])
    .filter((n) => n.id.type === "Identifier" && n.id.name === "T3_CODE_ORCHESTRATION_SECTIONS");
  if (decls.length !== 1 || decls[0].init?.type !== "ArrayExpression") {
    throw new Error("T3_CODE_ORCHESTRATION_SECTIONS is not a single array declaration");
  }
  const array = decls[0].init;
  const sections = array.elements.filter(Boolean).map((node) => ({
    node,
    value: node.type === "Literal" ? node.value
      : node.type === "TemplateLiteral" && node.expressions.length === 0 ? node.quasis[0].value.cooked : null,
    marked: comments.some((c) => c.type === "Block" && c.value === TITLE_GUIDE_MARKER && c.end <= node.start && /^\s*$/.test(text.slice(c.end, node.start))),
  }));
  const ours = sections.filter((s) => s.marked || (typeof s.value === "string" && /^## Titles(?:\r?\n|$)/.test(s.value)));
  if (ours.length > 1) throw new Error("title guide section occurs more than once");
  if (ours.length === 1) {
    const { node, value } = ours[0];
    if (value === TITLE_GUIDE) return { state: "already", text };
    return { state: "patched", text: text.slice(0, node.start) + JSON.stringify(TITLE_GUIDE) + text.slice(node.end) };
  }
  const last = array.elements.at(-1);
  if (array.elements.some((n) => n === null)) throw new Error("orchestration sections array has holes");
  const at = last ? last.end : array.start + 1;
  const added = `${last ? "," : ""}\n\t/*${TITLE_GUIDE_MARKER}*/${JSON.stringify(TITLE_GUIDE)}`;
  return { state: "patched", text: text.slice(0, at) + added + text.slice(at) };
}

/**
 * binCli: parse once (acorn), check the wrappers are top-level, then restore the
 * original byte length by shrinking or padding one real block comment. The
 * replacement keeps a line break, so automatic semicolon insertion can't change.
 */
function findNamedFunctions(node, names, out = []) {
  if (!node || typeof node !== "object") return out;
  if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") &&
      node.id?.type === "Identifier" && names.includes(node.id.name)) {
    out.push(node);
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "start" || k === "end" || k === "loc" || k === "type") continue;
    if (Array.isArray(v)) {
      for (const item of v) findNamedFunctions(item, names, out);
    } else if (v && typeof v === "object" && typeof v.type === "string") {
      findNamedFunctions(v, names, out);
    }
  }
  return out;
}

function finishBinCli(text, targetBytes, fitApplied, extraTopFunctions = []) {
  const comments = [];
  const ast = acorn.parse(text, { ...PARSE, sourceType: "module", onComment: comments });
  const top = ast.body.filter((n) => n.type === "FunctionDeclaration").map((n) => n.id.name);
  const requiredTop = fitApplied
    ? ["t3KeeperFitTitle", ...FIT_WRAPPERS.filter(([n]) => top.includes(n) || top.includes(`${n}$t3orig`)).flatMap(([n]) => [n, `${n}$t3orig`])]
    : [];
  for (const name of requiredTop) {
    if (top.filter((n) => n === name).length !== 1) throw new Error(`${name} is not a single top-level function`);
  }
  if (extraTopFunctions.length > 0) {
    const found = findNamedFunctions(ast, extraTopFunctions);
    for (const name of extraTopFunctions) {
      if (found.filter((n) => n.id.name === name).length !== 1) throw new Error(`${name} is not a single named function`);
    }
  }
  try { return absorb(text, targetBytes, "module", comments); }
  catch (error) {
    if (!/no comment block could absorb/.test(error.message)) throw error;
    // Bundles without large comments: reclaim only whitespace between tokens.
    // Keep newlines (ASI) and every token/comment byte intact, then pad EOF.
    const protectedTopNames = ["t3KeeperFitTitle", ...FIT_WRAPPERS.map(([name]) => name)];
    const protectedFunctions = [
      ...ast.body.filter((n) => n.type === "FunctionDeclaration" && protectedTopNames.includes(n.id.name)),
      ...findNamedFunctions(ast, [ANTIGRAVITY_QUESTIONS_FN]),
    ];
    let kept = "", end = 0;
    for (const token of acorn.tokenizer(text, { ...PARSE, sourceType: "module" })) {
      const gap = text.slice(end, token.start);
      const protectedGap = protectedFunctions.some((n) => end >= n.start && token.start <= n.end);
      kept += !protectedGap && /^[\t\r\n ]*$/.test(gap) ? gap.replace(/\n[\t ]+/g, "\n") : gap;
      kept += text.slice(token.start, token.end);
      end = token.end;
    }
    const tail = text.slice(end);
    kept += /^[\r\n \t]*$/.test(tail) ? tail.replace(/[ \t]+/g, "") : tail;
    const room = targetBytes - Buffer.byteLength(kept);
    if (room < 0) throw error;
    if (!sameTokens(text, kept, "module")) throw new Error("server indentation reclaim changed tokens");
    acorn.parse(kept, { ...PARSE, sourceType: "module" });
    return kept + " ".repeat(room);
  }
}

/** Restore the original byte length by shrinking or padding ASCII block comment(s) that span lines. */
function absorb(text, targetBytes, sourceType, comments = null) {
  const delta = Buffer.byteLength(text) - targetBytes;
  if (delta === 0) return text;
  if (!comments) {
    comments = [];
    acorn.parse(text, { ...PARSE, sourceType, onComment: comments });
  }
  const eligible = [];
  for (const c of comments) {
    if (c.type !== "Block") continue;
    const old = text.slice(c.start, c.end);
    if (!/^[\x00-\x7f]*$/.test(old) || !/[\n\r]/.test(old)) continue;
    const fill = old.length - delta - 5; // "/*" + "\n" + spaces + "*/"
    if (fill >= 0) {
      const next = text.slice(0, c.start) + `/*\n${" ".repeat(fill)}*/` + text.slice(c.end);
      if (Buffer.byteLength(next) === targetBytes) {
        acorn.parse(next, { ...PARSE, sourceType });
        return next;
      }
    }
    if (old.length > 5) eligible.push({ start: c.start, end: c.end, maxSave: old.length - 5 });
  }
  if (delta > 0 && eligible.length > 1) {
    let remaining = delta;
    const edits = [];
    for (const c of eligible.sort((a, b) => b.maxSave - a.maxSave)) {
      if (remaining <= 0) break;
      const take = Math.min(c.maxSave, remaining);
      edits.push({ start: c.start, end: c.end, fill: c.maxSave - take });
      remaining -= take;
    }
    if (remaining === 0) {
      let next = text;
      for (const e of edits.sort((a, b) => b.start - a.start)) {
        next = next.slice(0, e.start) + `/*\n${" ".repeat(e.fill)}*/` + next.slice(e.end);
      }
      if (Buffer.byteLength(next) === targetBytes) {
        acorn.parse(next, { ...PARSE, sourceType });
        return next;
      }
    }
  }
  throw new Error(`no comment block could absorb ${delta} bytes`);
}

const ANTIGRAVITY_UA_MARK = "`antigravity/hub/";
const ANTIGRAVITY_UA_FROM = "`antigravity/hub/1.0.0 (aidev_client;";
const ANTIGRAVITY_UA_TO = "`antigravity/hub/2.24.0 (aidev_client;";
const ANTIGRAVITY_UA_RE = /`antigravity\/hub\/(\d+)\.(\d+)\.(\d+) \(aidev_client;/g;

/**
 * geminiQuota: older T3 builds' Antigravity limits probe calls itself antigravity/hub/1.0.0, and
 * Google leaves the Gemini buckets (gemini-5h, gemini-weekly) out of its quota summary for that
 * version, so only the shared Claude/GPT rows show (upstream #22876; checked here 25 Oct 2026:
 * 2.24.0 returns them). T3 has sent 2.24.0 itself since the 6 Nov nightly, so a build that sends
 * 2.24.0 or newer is left alone ("already"); only the known-bad 1.0.0 is rewritten.
 * Server code, so it starts at T3's next launch. Byte balance is done once for the file.
 */
function unitGeminiQuota(text) {
  const found = [...text.matchAll(ANTIGRAVITY_UA_RE)];
  if (found.length !== 1) throw new Error(`Antigravity probe User-Agent found ${found.length} times`);
  const [major, minor, patch] = found[0].slice(1).map(Number);
  if (major > 2 || (major === 2 && minor >= 24)) return { state: "already", text };
  if (found[0][0] !== ANTIGRAVITY_UA_FROM) throw new Error(`Antigravity probe sends version ${major}.${minor}.${patch}, which is not known to return the Gemini rows`);
  return { state: "patched", text: text.replace(ANTIGRAVITY_UA_FROM, () => ANTIGRAVITY_UA_TO) };
}

const FIRST_CLICK = "acceptFirstMouse: true, ";
const keyName =(p) => (p.type !== "Property" || p.computed ? null : p.key.type === "Identifier" ? p.key.name : String(p.key.value));
const isDarwinTest = (t) =>
  t.type === "BinaryExpression" && (t.operator === "===" || t.operator === "==") &&
  [t.left, t.right].some((x) => x.type === "Literal" && x.value === "darwin");

/**
 * firstClick: Electron's acceptFirstMouse, added to the darwin branch of
 * getWindowTitleBarOptions, which the main window spreads into its BrowserWindow options.
 * Without it, the first click on an inactive T3 window only brings the window forward.
 * Main-process code, so it starts at T3's next launch. Byte balance is done in plan().
 */
function unitFirstClick(text) {
  const ast = acorn.parse(text, { ...PARSE, sourceType: "script" });
  const fns = ast.body.filter((n) => n.type === "FunctionDeclaration" && n.id?.name === "getWindowTitleBarOptions");
  if (fns.length !== 1) throw new Error(`getWindowTitleBarOptions declared ${fns.length} times`);
  if (text.split("...getWindowTitleBarOptions(").length !== 2) throw new Error("the main window no longer spreads getWindowTitleBarOptions");
  const branches = fns[0].body.body.filter((s) => s.type === "IfStatement" && isDarwinTest(s.test));
  if (branches.length !== 1) throw new Error("the Mac branch of getWindowTitleBarOptions changed shape");
  let ret = branches[0].consequent;
  if (ret.type === "BlockStatement" && ret.body.length === 1) ret = ret.body[0];
  if (ret.type !== "ReturnStatement" || ret.argument?.type !== "ObjectExpression") throw new Error("the Mac window options changed shape");
  const props = ret.argument.properties;
  if (!props.some((p) => keyName(p) === "titleBarStyle")) throw new Error("the Mac window options no longer set titleBarStyle");
  if (props.some((p) => p.type !== "Property")) throw new Error("the Mac window options now use a spread");
  const ours = props.filter((p) => keyName(p) === "acceptFirstMouse");
  const mentions = text.split("acceptFirstMouse").length - 1;
  if (ours.length === 1 && ours[0].value.type === "Literal" && ours[0].value.value === true && mentions === 1) return { state: "already", text };
  if (mentions > 0) throw new Error("T3 now sets acceptFirstMouse itself; check whether this unit is still needed");
  const at = ret.argument.start + 1; // just inside the "{"
  return { state: "patched", text: text.slice(0, at) + FIRST_CLICK + text.slice(at) };
}

const ANTIGRAVITY_QUESTIONS_FN = "t3KeeperAntigravityElicitationForm";
// Pure ASCII so byte length === string length and absorb()/reclaim stay exact.
const ANTIGRAVITY_QUESTIONS_HELPER = String.raw`function t3KeeperAntigravityElicitationForm(request) {
	/*t3-keeper-agq-1*/
	const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
	const trim = (v) => (typeof v === "string" ? v.trim() : "");
	if (!isRec(request) || request.mode !== "form" || !isRec(request.requestedSchema)) return void 0;
	const schema = request.requestedSchema;
	if (!isRec(schema.properties) || (Array.isArray(schema.required) && schema.required.length > 0)) return void 0;
	const entries = Object.entries(schema.properties);
	if (entries.length === 0) return void 0;
	const groups = new Map();
	for (const [key, prop] of entries) {
		const m = /^q([1-9]\d*)(_other)?$/.exec(key);
		if (!m || !isRec(prop)) return void 0;
		const n = Number(m[1]);
		let g = groups.get(n);
		if (!g) groups.set(n, g = { id: "q" + n });
		if (m[2]) g.other = prop;
		else g.main = prop;
	}
	const isPlainStr = (p) => isRec(p) && p.type === "string" && !("oneOf" in p) && !("enum" in p) && !("anyOf" in p) && !("items" in p);
	const readChoices = (list, isEnum) => {
		if (!Array.isArray(list) || list.length === 0) return void 0;
		const out = [];
		const seen = new Set();
		for (const item of list) {
			let value, title, desc;
			if (isEnum) {
				if (typeof item !== "string" || !item.trim()) return void 0;
				value = item;
				title = item.trim();
			} else {
				if (!isRec(item) || typeof item.const !== "string" || !item.const.length) return void 0;
				title = trim(item.title);
				if (!title) return void 0;
				value = item.const;
				desc = trim(item.description);
			}
			if (seen.has(value)) return void 0;
			seen.add(value);
			let label = title;
			let description = desc && desc !== title ? desc : title;
			if (!desc) {
				const sep = /\s+[\u2014\u2013]\s+/.exec(title);
				if (sep) {
					const left = title.slice(0, sep.index).trim();
					const right = title.slice(sep.index + sep[0].length).trim();
					if (left.length >= 1 && right.length >= 2 && !/^\d+$/.test(left)) {
						label = left;
						description = right;
					}
				}
			}
			out.push({ label, description, value });
		}
		return out;
	};
	const splitHeader = (raw, fallback) => {
		const s = trim(raw);
		const wait = /^I'm waiting on you now:\s*/i.exec(s);
		const prefix = wait ? "I'm waiting on you now: " : "";
		const body = wait ? s.slice(wait[0].length) : s;
		const ok = (h, rest, explicit, colon) => {
			if (!h || h.length > 24 || !rest || rest.length < 2 || rest.startsWith("//")) return null;
			const numbered = /^\d+\.\s+/.test(h);
			const core = numbered ? h.replace(/^\d+\.\s+/, "") : h;
			const maxWords = explicit ? 5 : 3;
			const minCore = explicit ? 1 : 2;
			if (core.length < minCore || core.split(/\s+/).length > maxWords) return null;
			if (explicit && colon ? (/[?!]/.test(core) || /\.(?:\s|$)/.test(core)) : /[.?!,;'"()]/.test(core)) return null;
			if (explicit && colon ? !/[\p{L}\p{N}]/u.test(core) : !/^[\p{L}\p{N}]/u.test(core)) return null;
			if (!explicit && !/^optional$/i.test(core) && h.length > 20) return null;
			return { header: h, question: prefix + rest };
		};
		const br = /^\[([^\[\]\n]{1,24})\]\s+([\s\S]+)$/.exec(body);
		if (br) {
			const r = ok(br[1].trim(), br[2].trim(), true, false);
			if (r) return r;
		}
		const numColon = /^((?:\d+\.\s+[^\n:]{1,21}|Optional)):\s+([\s\S]+)$/i.exec(body);
		if (numColon) {
			const r = ok(numColon[1].trim(), numColon[2].trim(), true, true);
			if (r) return r;
		}
		const num = /^((?:\d+\.\s+[^\n:]{1,21}?|Optional))(?:\s+[\u2014\u2013\u00b7-]\s+|\r?\n)([\s\S]+)$/i.exec(body);
		if (num) {
			const r = ok(num[1].trim(), num[2].trim(), true, false);
			if (r) return r;
		}
		const m = /^([^\n:]{1,20}?)(?::\s+|\s+[\u2014\u2013\u00b7]\s+|\r?\n)([\s\S]+)$/.exec(body);
		if (m) {
			const r = ok(m[1].trim(), m[2].trim(), false, false);
			if (r) return r;
		}
		return { header: fallback, question: s };
	};
	const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]);
	const total = ordered.length;
	const questions = [];
	for (let i = 0; i < total; i++) {
		if (ordered[i][0] !== i + 1) return void 0;
		const { id, main, other } = ordered[i][1];
		const fallback = total === 1 ? "Question" : "Question " + (i + 1);
		if (!isPlainStr(other)) return void 0;
		if (!main) {
			const raw = trim(other.title);
			if (!raw) return void 0;
			const { header, question } = splitHeader(raw, fallback);
			questions.push({ id, header, question, options: [] });
			continue;
		}
		const rawTitle = trim(main.title);
		if (!rawTitle) return void 0;
		let options, multiSelect = false;
		if (main.type === "string") {
			options = Array.isArray(main.oneOf) ? readChoices(main.oneOf, false) : Array.isArray(main.enum) ? readChoices(main.enum, true) : void 0;
		} else if (main.type === "array" && isRec(main.items)) {
			multiSelect = true;
			options = Array.isArray(main.items.anyOf) ? readChoices(main.items.anyOf, false) : main.items.type === "string" && Array.isArray(main.items.enum) ? readChoices(main.items.enum, true) : void 0;
		}
		if (!options) return void 0;
		const rawDesc = trim(main.description);
		const parsed = rawDesc && rawDesc !== rawTitle && rawTitle.length <= 24 ? { header: rawTitle, question: rawDesc } : splitHeader(rawTitle, fallback);
		questions.push({
			id,
			header: parsed.header,
			question: parsed.question,
			options,
			...multiSelect ? { multiSelect: true } : {}
		});
	}
	const splitAtt = (v, vals) => {
		const re = /\n\nAttached (?:image|file) "(?:\\.|[^"\\\r\n])*": "/g;
		let match = null;
		for (let m; (m = re.exec(v)) !== null; ) {
			if (vals.has(v.slice(0, m.index))) match = m;
		}
		return match ? { prefix: v.slice(0, match.index), suffix: v.slice(match.index + 2) } : void 0;
	};
	return {
		questions,
		respond: (answers) => {
			if (!isRec(answers)) return { action: "cancel" };
			const content = {};
			for (const q of questions) {
				if (!Object.hasOwn(answers, q.id)) return { action: "cancel" };
				const answer = answers[q.id];
				const otherId = q.id + "_other";
				const vals = new Set(q.options.map((o) => o.value));
				if (q.options.length === 0) {
					if (typeof answer !== "string" || !answer.trim()) return { action: "cancel" };
					content[otherId] = answer;
				} else if (q.multiSelect) {
					if (Array.isArray(answer)) {
						const sel = [];
						const extra = [];
						for (const item of answer) {
							if (typeof item !== "string") return { action: "cancel" };
							if (vals.has(item)) {
								if (!sel.includes(item)) sel.push(item);
							} else if (item.trim()) extra.push(item);
						}
						if (sel.length === 0 && extra.length === 0) return { action: "cancel" };
						if (sel.length > 0) content[q.id] = sel;
						if (extra.length > 0) content[otherId] = extra.join("\n\n");
					} else if (typeof answer === "string") {
						if (vals.has(answer)) content[q.id] = [answer];
						else {
							const att = splitAtt(answer, vals);
							if (att) {
								content[q.id] = [att.prefix];
								content[otherId] = att.suffix;
							} else if (answer.trim()) content[otherId] = answer;
							else return { action: "cancel" };
						}
					} else return { action: "cancel" };
				} else {
					if (typeof answer !== "string") return { action: "cancel" };
					if (vals.has(answer)) content[q.id] = answer;
					else {
						const att = splitAtt(answer, vals);
						if (att) {
							content[q.id] = att.prefix;
							content[otherId] = att.suffix;
						} else if (answer.trim()) content[otherId] = answer;
						else return { action: "cancel" };
					}
				}
			}
			return { action: "accept", content };
		}
	};
}
`;

function staticPropKey(prop) {
  if (!prop || prop.type !== "Property") return null;
  if (!prop.computed) {
    if (prop.key.type === "Identifier") return prop.key.name;
    if (prop.key.type === "Literal" && !prop.key.regex && (typeof prop.key.value === "string" || typeof prop.key.value === "number" || typeof prop.key.value === "bigint")) {
      return String(prop.key.value);
    }
    return null;
  }
  if (prop.key.type === "Literal" && !prop.key.regex && (prop.key.value === null || typeof prop.key.value !== "object")) {
    return String(prop.key.value);
  }
  if (prop.key.type === "TemplateLiteral" && prop.key.expressions.length === 0 && prop.key.quasis.length === 1) {
    return prop.key.quasis[0].value.cooked ?? prop.key.quasis[0].value.raw;
  }
  return null;
}

function classifyObjectLiteral(expr, targetKey) {
  if (!expr) return "opaque";
  if (expr.type === "ConditionalExpression") {
    const a = classifyObjectLiteral(expr.consequent, targetKey);
    const b = classifyObjectLiteral(expr.alternate, targetKey);
    return a === b ? a : "opaque";
  }
  if (expr.type !== "ObjectExpression") return "opaque";
  let hasKey = false;
  for (const p of expr.properties) {
    if (p.type === "Property") {
      const k = staticPropKey(p);
      if (k === null || (!p.computed && k === "__proto__")) return "opaque";
      if (k === targetKey) hasKey = true;
    } else if (p.type === "SpreadElement") {
      const sub = classifyObjectLiteral(p.argument, targetKey);
      if (sub === "opaque") return "opaque";
      if (sub === "has-key") hasKey = true;
    } else {
      return "opaque";
    }
  }
  return hasKey ? "has-key" : "no-key";
}

function collectFunctionReturns(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "ReturnStatement") {
    out.push(node);
    return out;
  }
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" || node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "start" || k === "end" || k === "loc" || k === "type") continue;
    if (Array.isArray(v)) {
      for (const item of v) collectFunctionReturns(item, out);
    } else if (v && typeof v === "object" && typeof v.type === "string") {
      collectFunctionReturns(v, out);
    }
  }
  return out;
}

function countIdentifiers(node, name) {
  if (!node || typeof node !== "object") return 0;
  let total = node.type === "Identifier" && node.name === name ? 1 : 0;
  for (const [k, v] of Object.entries(node)) {
    if (k === "start" || k === "end" || k === "loc" || k === "type") continue;
    if (Array.isArray(v)) {
      for (const item of v) total += countIdentifiers(item, name);
    } else if (v && typeof v === "object" && typeof v.type === "string") {
      total += countIdentifiers(v, name);
    }
  }
  return total;
}

function hasTopLevelFunction(text, name) {
  if (!text.includes(name)) return false;
  try {
    const ast = acorn.parse(text, { ...PARSE, sourceType: "module" });
    return ast.body.some((n) => n.type === "FunctionDeclaration" && n.id?.name === name);
  } catch {
    return false;
  }
}

/**
 * antigravityQuestions: wire extractElicitationForm into makeAntigravityAcpAdapterFlavor so
 * Antigravity ask_question cards fold qN + qN_other, keep custom answers unlocked, support
 * multi-select/free-form/attachments, and match Claude's header + option-description layout.
 * Yields cleanly ("already") if upstream T3 adds its own extractElicitationForm.
 */
function unitAntigravityQuestions(text) {
  const ast = acorn.parse(text, { ...PARSE, sourceType: "module" });
  const flavors = ast.body.filter((n) => n.type === "FunctionDeclaration" && n.id?.name === "makeAntigravityAcpAdapterFlavor");
  if (flavors.length !== 1) throw new Error(`makeAntigravityAcpAdapterFlavor declared ${flavors.length} times`);
  const returns = collectFunctionReturns(flavors[0].body);
  if (returns.length !== 1 || returns[0].argument?.type !== "ObjectExpression" || !flavors[0].body.body.includes(returns[0])) {
    throw new Error("makeAntigravityAcpAdapterFlavor return object changed shape");
  }
  const props = returns[0].argument.properties;
  const permProp = props.find((p) => staticPropKey(p) === "extractPermissionQuestion");
  if (!permProp || !props.some((p) => staticPropKey(p) === "driver")) {
    throw new Error("makeAntigravityAcpAdapterFlavor properties changed shape");
  }
  if (props.some((p) => p.type === "Property" && (staticPropKey(p) === null || (!p.computed && staticPropKey(p) === "__proto__")))) {
    throw new Error("makeAntigravityAcpAdapterFlavor return object uses a dynamic computed key; changed shape");
  }
  const spreadStates = props
    .filter((p) => p.type === "SpreadElement")
    .map((p) => classifyObjectLiteral(p.argument, "extractElicitationForm"));
  if (spreadStates.includes("opaque")) {
    throw new Error("makeAntigravityAcpAdapterFlavor return object uses an unsupported spread; changed shape");
  }
  const extractProps = props.filter((p) => staticPropKey(p) === "extractElicitationForm");
  if (extractProps.length > 1) throw new Error("extractElicitationForm appears more than once");
  const extractProp = extractProps[0] ?? null;
  const pointsToOurs = Boolean(
    extractProp &&
    !extractProp.computed &&
    !extractProp.method &&
    extractProp.kind === "init" &&
    extractProp.value.type === "FunctionExpression" &&
    extractProp.value.id?.name === ANTIGRAVITY_QUESTIONS_FN
  );
  if (pointsToOurs && spreadStates.includes("has-key")) {
    throw new Error("extractElicitationForm is shadowed by a spread; run --restore first");
  }
  const strayKeeper = text.includes(ANTIGRAVITY_QUESTIONS_FN) || countIdentifiers(ast, ANTIGRAVITY_QUESTIONS_FN) > 0;
  if (extractProp && !pointsToOurs) {
    if (strayKeeper) throw new Error("extractElicitationForm no longer references keeper helper; run --restore first");
    return { state: "already", text };
  }
  if (!extractProp && spreadStates.includes("has-key")) {
    if (strayKeeper) throw new Error("extractElicitationForm no longer references keeper helper; run --restore first");
    return { state: "already", text };
  }
  const wantFn = ANTIGRAVITY_QUESTIONS_HELPER.trimEnd();
  if (pointsToOurs) {
    const existing = text.slice(extractProp.value.start, extractProp.value.end);
    if (existing === wantFn) return { state: "already", text };
    if (!existing.includes("/*t3-keeper-agq-")) {
      throw new Error(`${ANTIGRAVITY_QUESTIONS_FN} is not a supported keeper helper; run --restore first`);
    }
    return { state: "patched", text: text.slice(0, extractProp.value.start) + wantFn + text.slice(extractProp.value.end) };
  }
  if (strayKeeper) {
    throw new Error(`${ANTIGRAVITY_QUESTIONS_FN} already appears unexpectedly; run --restore first`);
  }
  const propLine = `extractElicitationForm: ${wantFn},\n`;
  return { state: "patched", text: text.slice(0, permProp.start) + propLine + text.slice(permProp.start) };
}

const UNITS = [
  { name: "wrap", file: "index", run: unitWrap },
  { name: "minWidth", file: "mainJs", run: unitMinWidth },
  { name: "rule", file: "binCli", run: unitRule },
  { name: "fit", file: "binCli", run: unitFit },
  { name: "titleGuide", file: "binCli", run: unitTitleGuide },
  { name: "geminiQuota", file: "binCli", run: unitGeminiQuota },
  { name: "antigravityQuestions", file: "antigravityFlavor", run: unitAntigravityQuestions },
  { name: "extras", file: "index", run: unitExtras }, // after wrap: it takes wrap's padding
  { name: "firstClick", file: "desktopMain", run: unitFirstClick },
];

// Units that can be switched off on their own. rule, fit and titleGuide are personal
// defaults: a fresh install turns them off, and an already-patched build keeps them until --restore.
const SWITCHABLE = ["extras", "rule", "fit", "titleGuide"];

function loadDisabled() {
  try {
    const list = JSON.parse(fs.readFileSync(DISABLED, "utf8")).disabled;
    return new Set(Array.isArray(list) ? list.filter((u) => SWITCHABLE.includes(u)) : []);
  } catch {
    return new Set();
  }
}

const CLIENT = "apps/server/dist/client";
const ASSETS = `${CLIENT}/assets`;
const SERVER = "apps/server/dist";
const DESKTOP_MAIN = "apps/desktop/dist-electron/main.cjs";

function findTargets(fd, layout) {
  const pick = (dir, nameRe, matches) => {
    for (const name of listDir(layout.header, dir).filter((n) => nameRe.test(n))) {
      const rel = `${dir}/${name}`;
      if (matches(readEntry(fd, layout, rel).toString("utf8"))) return rel;
    }
    return null;
  };
  return {
    index: entryAt(layout.header, `${CLIENT}/index.html`) ? `${CLIENT}/index.html` : null,
    mainJs: pick(ASSETS, /^main-[\w-]+\.js$/, (t) => t.includes("chat_thread_sidebar_width")),
    binCli: pick(SERVER, /^(?:binCli|runtimeLayer)-[\w-]+\.mjs$/, (t) => hasTopLevelFunction(t, "sanitizeThreadTitle")),
    delegatedTitles: pick(SERVER, /^server-[\w-]+\.mjs$/, (t) => hasTopLevelFunction(t, "threadTitle")),
    antigravityFlavor: pick(SERVER, /^(?:server|binCli|runtimeLayer)-[\w-]+\.mjs$/, (t) => hasTopLevelFunction(t, "makeAntigravityAcpAdapterFlavor")),
    desktopMain: entryAt(layout.header, DESKTOP_MAIN) ? DESKTOP_MAIN : null,
  };
}

/** Run every unit against the current bytes; returns per-unit results and the files that would change. */
function plan(fd, layout, targets) {
  const ctx = {
    desktopMain: entryAt(layout.header, DESKTOP_MAIN) ? readEntry(fd, layout, DESKTOP_MAIN).toString("utf8") : "",
    disabled: loadDisabled(),
    loaderKey: readLoaderKey(),
  };
  const originals = {};
  const results = {};
  const texts = {};
  const fileSteps = {};
  const resolveSlot = (fileKey) => {
    const rel = targets[fileKey];
    if (!rel) return null;
    if (fileKey === "antigravityFlavor") {
      if (rel === targets.delegatedTitles) return "delegatedTitles";
      if (rel === targets.binCli) return "binCli";
    }
    return fileKey;
  };
  const readTarget = (file) => {
    originals[file] ??= readEntry(fd, layout, targets[file]);
    return texts[file] ?? originals[file].toString("utf8");
  };
  const recordStep = (file, name, applyFn) => {
    (fileSteps[file] ??= []).push({ name, apply: applyFn });
  };
  let splitFitPatched = false;
  for (const unit of UNITS) {
    const targetFile = resolveSlot(unit.file);
    if (!targetFile) {
      results[unit.name] = { state: "failed", error: `${unit.file} not found in this build` };
      continue;
    }
    const before = readTarget(targetFile);
    try {
      let out;
      const runtimeHasThreadTitle = unit.name === "fit" && hasTopLevelFunction(before, "threadTitle");
      if (unit.name === "fit" && !runtimeHasThreadTitle && !targets.delegatedTitles && !ctx.disabled.has("fit")) {
        throw new Error("delegated threadTitle bundle not found in this build");
      }
      if (unit.name === "fit" && targets.delegatedTitles && !runtimeHasThreadTitle) {
        const childBefore = readTarget("delegatedTitles");
        const rtOpts = { ...ctx, wrappers: FIT_WRAPPERS.slice(0, 2) };
        const chOpts = { ...ctx, wrappers: FIT_WRAPPERS.slice(2) };
        out = unitFit(before, rtOpts);
        const child = unitFit(childBefore, chOpts);
        const rtPatched = out.state === "patched";
        if (child.state === "patched") out.state = "patched";
        else if (child.state === "retained" && out.state === "disabled") out.state = "retained";
        texts.delegatedTitles = child.text;
        if (child.state === "patched") {
          recordStep("delegatedTitles", "fit", (src) => unitFit(src, chOpts).text);
          splitFitPatched = true;
        }
        if (rtPatched) {
          recordStep(targetFile, "fit", (src) => unitFit(src, rtOpts).text);
          splitFitPatched = true;
        }
      } else if (unit.name === "geminiQuota" && targets.delegatedTitles && !before.includes(ANTIGRAVITY_UA_MARK)) {
        // 13 Nov nightly: the probe moved to the server bundle, which sends T3's own corrected
        // version. Recognise it there; the old-version rewrite stays in the runtime bundle.
        const server = readTarget("delegatedTitles");
        if (unitGeminiQuota(server).state !== "already") throw new Error("Antigravity probe in the server bundle sends the old version; this keeper only rewrites it in the runtime bundle");
        out = { state: "already", text: before };
      } else {
        out = unit.run(before, ctx);
        if (out.state === "patched") recordStep(targetFile, unit.name, (src) => unit.run(src, ctx).text);
      }
      results[unit.name] = { state: out.state, ...(out.error ? { error: out.error } : {}) };
      texts[targetFile] = out.text;
    } catch (error) {
      results[unit.name] = { state: "failed", error: error.message };
    }
  }
  const isServerSlot = (file) => file === "binCli" || file === "delegatedTitles" || file === "antigravityFlavor";
  const balanceFile = (file, text, patchedSet) => {
    const original = originals[file];
    if (text === original.toString("utf8")) return null;
    const finalText =
      isServerSlot(file)
        ? finishBinCli(text, original.length, patchedSet.has("fit"), patchedSet.has("antigravityQuestions") ? [ANTIGRAVITY_QUESTIONS_FN] : [])
      : file === "desktopMain" ? absorb(text, original.length, "script")
      : text;
    const buf = Buffer.from(finalText, "utf8");
    if (buf.length !== original.length) throw new Error("byte length changed");
    // Only the UI files are re-read by a running T3 (Shift-Cmd-R); the server and the
    // desktop main process have already loaded theirs.
    return { rel: targets[file], buf, original, live: file === "index" || file === "mainJs" };
  };
  // If multiple server units together overflow a file's byte budget, replay them incrementally
  // in UNITS order so earlier units (like fit) survive while only overflowing units fail.
  const rebuildIncremental = (file, steps, { restoreFailed = false } = {}) => {
    let cur = originals[file].toString("utf8");
    const kept = new Set();
    let built = null;
    for (const step of steps) {
      try {
        const next = step.apply(cur);
        const candidateSet = new Set([...kept, step.name]);
        built = balanceFile(file, next, candidateSet);
        cur = next;
        kept.add(step.name);
        if (restoreFailed) results[step.name] = { state: "patched" };
      } catch (error) {
        results[step.name] = { state: "failed", error: error.message };
      }
    }
    return { built, kept };
  };
  const files = {};
  const publishedUnits = {};
  for (const [file, text] of Object.entries(texts)) {
    const steps = fileSteps[file] ?? [];
    const patchedSet = new Set(steps.map((s) => s.name));
    try {
      const built = balanceFile(file, text, patchedSet);
      if (built) {
        files[file] = built;
        publishedUnits[file] = patchedSet;
      }
    } catch (error) {
      if (steps.length > 1) {
        const { built, kept } = rebuildIncremental(file, steps);
        if (built) {
          files[file] = built;
          publishedUnits[file] = kept;
        }
      } else {
        for (const name of patchedSet) {
          if (results[name]?.state === "patched") results[name] = { state: "failed", error: error.message };
        }
      }
    }
  }
  if (splitFitPatched && results.fit?.state === "failed") {
    for (const file of ["binCli", "delegatedTitles"]) {
      if (!files[file] || !publishedUnits[file]?.has("fit")) continue;
      const remaining = (fileSteps[file] ?? []).filter((s) => s.name !== "fit");
      delete files[file];
      delete publishedUnits[file];
      if (remaining.length === 0) continue;
      const { built, kept } = rebuildIncremental(file, remaining, { restoreFailed: true });
      if (built) {
        files[file] = built;
        publishedUnits[file] = kept;
      }
    }
  }
  return { results, files, missingHooks: scanWrapHooks(fd, layout) };
}

function scanWrapHooks(fd, layout) {
  const missing = new Set(WRAP_HOOKS);
  for (const name of listDir(layout.header, ASSETS).filter(n => n.endsWith(".js"))) {
    const text = readEntry(fd, layout, `${ASSETS}/${name}`).toString("utf8");
    for (const hook of missing) if (text.includes(hook)) missing.delete(hook);
  }
  return [...missing];
}

// Compatibility state is deliberately outside state.json's replace-on-save lifecycle.
const COMPAT = path.join(HOME, "compat.json");
const SCREEN = process.env.T3X_SCREEN_FILE || path.join(os.homedir(), ".local/share/t3-extras/screen.json");
const ADDON_NAMES = ["Wrapped titles", "Thread titles font", "One-row titles", "Compact threads", "Selected thread marker", "panel", "bars", "header", "composer", "Older"];
function readJson(file, fallback = {}) {
  try { const value = JSON.parse(fs.readFileSync(file, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : fallback; } catch { return fallback; }
}
function initCompat() {
  const old = readJson(COMPAT);
  if (typeof old.trial?.startedAt === "string" && Number.isFinite(Date.parse(old.trial.startedAt))) return { ...old, events: Array.isArray(old.events) ? old.events.filter(x => x && typeof x === "object") : [], outcomes: Array.isArray(old.outcomes) ? old.outcomes.filter(x => x && typeof x === "object") : [], notices: Array.isArray(old.notices) ? old.notices : [] };
  const value = { trial: { startedAt: new Date().toISOString(), endsAt: new Date(2026, 10, 29, 23, 59).toISOString() }, events: [], outcomes: [], notices: [] };
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileDurable(COMPAT, JSON.stringify(value, null, 2));
  return value;
}
function trialState(c) {
  const falseAlarms = new Set((Array.isArray(c.outcomes) ? c.outcomes : []).filter(x => x?.outcome === "false-alarm").map(x => JSON.stringify([x.build, x.addon]))).size;
  return { ...c.trial, ended: Boolean(c.trial?.endsAt && Date.now() > Date.parse(c.trial.endsAt)), falseAlarms, alertsStopped: falseAlarms >= 2, status: falseAlarms >= 2 ? "alerts stopped after 2 false alarms" : null };
}
function compatStatus(missingHooks = []) {
  const c = readJson(COMPAT), screen = readJson(SCREEN);
  const events = Array.isArray(c.events) ? c.events.filter(x => x && typeof x === "object").map(x => ({...x})) : [];
  for (const r of Array.isArray(screen.results) ? screen.results : []) {
    if (!r || typeof r.firstShownAt !== "string" || !Number.isFinite(Date.parse(r.firstShownAt))) continue;
    const event = { build: r.build, addon: r.addon, layer: "screen", firstShownAt: r.firstShownAt };
    const old = events.find(x => x.build === event.build && x.addon === event.addon && x.layer === event.layer);
    if (!old) events.push(event);
    else if (event.firstShownAt < old.firstShownAt) old.firstShownAt = event.firstShownAt;
  }
  return { missingHooks, screen: Array.isArray(screen.results) ? screen.results : [], outcomes: Array.isArray(c.outcomes) ? c.outcomes.filter(x => x && typeof x === "object") : [], trial: trialState(c), events };
}
function buildLabel(version) { return /-nightly\.\d+\.(\d+)$/.exec(version ?? "")?.[1] ?? version; }
function noticeFor(out, names = out.missingHooks?.length ? ["Wrapped titles"] : [], stopped = false) {
  const label = buildLabel(out.version);
  const body = out.failed.length ? `Couldn't fully apply the sidebar fix to build ${label}. Ask an agent to update it.`
    : out.wrote ? `Re-applied to build ${label}. Press Shift-Cmd-R in T3 to reload.`
    : names.length ? `Your T3 sidebar changes are on build ${label}.` : null;
  const subtitle = stopped || !names.length ? "" : names.length === 1 ? `${names[0]} may need an update` : `${names.length} add-ons may need an update`;
  return { body, subtitle };
}
function notifyApply(out) {
  const c = initCompat();
  const { body, subtitle } = noticeFor(out, undefined, trialState(c).alertsStopped);
  const key = JSON.stringify([out.version, body, subtitle]);
  if (!body || (c.notices ?? []).includes(key)) return;
  // A refused notification and quiet mode are observations, never shown events.
  if (!notify(body, subtitle)) return;
  c.notices = [...(c.notices ?? []), key];
  if (subtitle && !(c.events ?? []).some(e => e.build === out.version && e.addon === "Wrapped titles" && e.layer === "marker")) {
    c.events = [...(c.events ?? []), { build: out.version, addon: "Wrapped titles", layer: "marker", firstShownAt: new Date().toISOString() }];
  }
  writeFileDurable(COMPAT, JSON.stringify(c, null, 2));
}
function cmdOutcome(outcome) {
  return withLock(() => {
    const addon = process.argv[3], extra = process.argv.slice(4);
    if (!ADDON_NAMES.includes(addon) || (extra.length && (extra.length !== 2 || extra[0] !== "--build"))) throw new Error("invalid outcome arguments");
    const build = extra[1] ?? bundleVersion();
    const c = initCompat();
    if (!compatStatus().events.some(e => e.build === build && e.addon === addon)) throw new Error("no shown event for this build and add-on");
    c.outcomes ??= [];
    const old = c.outcomes.find(x => x.build === build && x.addon === addon);
    if (old?.outcome === outcome) return;
    log(`compat outcome: ${build} ${addon}: ${old?.outcome ?? "unrecorded"} -> ${outcome}`);
    c.outcomes = c.outcomes.filter(x => x !== old);
    c.outcomes.push({ build, addon, outcome, recordedAt: new Date().toISOString() });
    writeFileDurable(COMPAT, JSON.stringify(c, null, 2));
  });
}
function cmdTrialReport() {
  const c = compatStatus();
  const groups = { "confirmed real": [], "confirmed false alarm": [], "never sent to an agent": [] };
  for (const event of c.events.filter(e => e.firstShownAt >= (c.trial.startedAt ?? ""))) {
    const outcome = c.outcomes.find(x => x.build === event.build && x.addon === event.addon);
    groups[outcome?.outcome === "real" ? "confirmed real" : outcome?.outcome === "false-alarm" ? "confirmed false alarm" : "never sent to an agent"].push({ ...event, outcomeAt: outcome?.recordedAt ?? null });
  }
  console.log(JSON.stringify({ trial: c.trial, ...groups }, null, 2));
}

function inspect(asarPath = ASAR, checked = null) {
  const fd = fs.openSync(asarPath, "r");
  try {
    if (checked && !sameFile(identityOfFd(fd), checked)) throw new Error("app.asar was replaced; will retry");
    const layout = readLayout(fd);
    const targets = findTargets(fd, layout);
    return { layout, targets, ...plan(fd, layout, targets) };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- caches and backups ----------

function userTempDir() {
  if (process.env.T3_TEMP_DIR) return process.env.T3_TEMP_DIR;
  try {
    return execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  } catch {
    return os.tmpdir();
  }
}

function clearCaches() {
  // Same-length JS edits can match stale V8 bytecode, so drop it.
  for (const dir of [path.join(userTempDir(), "t3code", "compile-cache"), path.join(USER_DATA, "Code Cache", "js")]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function saveBackup(version, identity, items, producedByUs = false) {
  fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
  const file = path.join(BACKUPS, `${version ?? "unknown"}.json.gz`);
  let backup = { version, identity, files: {} };
  try {
    const old = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
    // Same file again, or our own patched output of it: keep the first (true) originals.
    if (old.identity && (sameFile(old.identity, identity) || producedByUs)) backup = old;
  } catch {}
  for (const { rel, original } of items) backup.files[rel] ??= { sha: sha(original), base64: original.toString("base64") };
  writeFileDurable(file, zlib.gzipSync(JSON.stringify(backup)));
  const check = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  for (const { rel } of items) {
    if (sha(Buffer.from(check.files[rel].base64, "base64")) !== check.files[rel].sha) throw new Error(`backup of ${rel} did not verify`);
  }
  const all = fs.readdirSync(BACKUPS).filter((n) => n.endsWith(".json.gz"))
    .map((n) => ({ n, t: fs.statSync(path.join(BACKUPS, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of all.slice(KEEP_BACKUPS)) fs.rmSync(path.join(BACKUPS, old.n), { force: true });
}

// ---------- apply / restore ----------

function reminderPlanFrom(results, files) {
  const startupReasons = [];
  if (files.binCli) {
    if (results.rule?.state === "patched") startupReasons.push("rule");
    if (results.fit?.state === "patched") startupReasons.push("fit");
    if (results.titleGuide?.state === "patched") startupReasons.push("titleGuide");
    if (results.geminiQuota?.state === "patched") startupReasons.push("geminiQuota");
    if (results.antigravityQuestions?.state === "patched") startupReasons.push("antigravityQuestions");
    if (startupReasons.length === 0) startupReasons.push("server");
  }
  if (files.delegatedTitles) {
    if (results.fit?.state === "patched" && !startupReasons.includes("fit")) startupReasons.push("fit");
    if (results.antigravityQuestions?.state === "patched" && !startupReasons.includes("antigravityQuestions")) startupReasons.push("antigravityQuestions");
    if (startupReasons.length === 0) startupReasons.push("server");
  }
  if (files.antigravityFlavor) {
    if (results.antigravityQuestions?.state === "patched" && !startupReasons.includes("antigravityQuestions")) startupReasons.push("antigravityQuestions");
    if (startupReasons.length === 0) startupReasons.push("server");
  }
  if (files.desktopMain) startupReasons.push(results.firstClick?.state === "patched" ? "firstClick" : "desktop-main");
  return { startupReasons, uiChanged: Boolean(files.index || files.mainJs) };
}

function reminderTick() {
  try {
    reminders.schedulerTick({ home: HOME, appPath: APP, asarPath: ASAR, build: bundleVersion(), keeperStatePath: STATE });
  } catch (error) {
    log(`reminders: ${error.message}`);
  }
}

/** Plan read-only against the approved app.asar; commit only when something changes. */
function apply({ reason, checked = asarIdentity(), version = bundleVersion(), guard, hooks }) {
  try {
    reminders.reconcileJournal({ home: HOME, actual: checked, build: version });
  } catch (error) {
    log(`reminders reconcile: ${error.message}`);
    if (error.code === "corrupt" || error.code === "unreadable" || error.code === "busy") throw error;
  }
  const planned = inspect(ASAR, checked);
  const items = Object.values(planned.files);
  let live = "skipped";
  let produced = null;
  if (items.length > 0) {
    const { produced: ours } = loadState();
    const producedByUs = Boolean(ours && ours.build === version && sameFile(ours.identity, checked));
    if (producedByUs && !fs.existsSync(path.join(BACKUPS, `${version}.json.gz`))) {
      throw new Error("the originals for this build are not backed up, so the keeper will not patch its own output again");
    }
    saveBackup(version, checked, items, producedByUs);
    ({ live, produced } = commit({
      checked, version, layout: planned.layout, items, guard, hooks,
      reminder: reminderPlanFrom(planned.results, planned.files),
    }));
  }
  const failed = Object.entries(planned.results).filter(([, v]) => v.state === "failed").map(([k]) => k);
  log(`${reason}: build ${version}: ${summary(planned.results)}${planned.missingHooks.length ? `; missing hooks ${planned.missingHooks.join(", ")}` : ""}`);
  return { version, wrote: items.length > 0, live, produced, checked, failed, results: planned.results, missingHooks: planned.missingHooks, mainJs: planned.targets.mainJs ? path.basename(planned.targets.mainJs) : null };
}

function cmdRestore() {
  return withLock(() => {
    const version = bundleVersion();
    const checked = asarIdentity();
    const { produced } = loadState();
    // Only undo our own work: the file at the path must be exactly the one the keeper wrote.
    if (!produced || produced.build !== version || !sameFile(produced.identity, checked)) {
      throw new Error("app.asar is not the file the keeper patched (T3 was updated or reinstalled); nothing to restore");
    }
    const backup = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(BACKUPS, `${version}.json.gz`))).toString("utf8"));
    const fd = fs.openSync(ASAR, "r");
    let layout;
    let items;
    try {
      if (!sameFile(identityOfFd(fd), checked)) throw new Error("app.asar was replaced; try again");
      layout = readLayout(fd);
      items = Object.entries(backup.files).map(([rel, info]) => {
        const buf = Buffer.from(info.base64, "base64");
        if (sha(buf) !== info.sha) throw new Error(`backup for ${rel} is corrupt`);
        return { rel, buf, original: readEntry(fd, layout, rel), live: false };
      });
    } finally {
      fs.closeSync(fd);
    }
    const out = commit({ checked, version, layout, items, reminder: false });
    // Keyed to the restored file, so --auto leaves it alone until T3's next update.
    saveState({ keeperVersion: KEEPER_VERSION, loaderKey: loaderKeyId(), key: asarKey(out.produced), status: "restored", build: version, produced: null });
    try {
      reminders.noteRestored({ home: HOME, actual: out.produced });
    } catch (error) {
      log(`reminders: ${error.message}`);
    }
    log(`restored original bytes for build ${version}; quit and reopen T3 to see it; the keeper re-patches at the next T3 update`);
  });
}

// ---------- commands ----------

function summary(results) {
  return Object.entries(results).map(([k, v]) => `${k}:${v.state}${v.error ? ` (${v.error})` : ""}`).join(", ");
}

const asarKey = (id = asarIdentity()) => `${id.dev}:${id.ino}:${id.size}:${id.birthtimeMs}:${id.mtimeMs}`;

function cmdStatus() {
  const version = bundleVersion();
  const { targets, results, missingHooks } = inspect();
  const units = Object.fromEntries(
    Object.entries(results).map(([k, v]) => [k, {
      already: "patched",
      patched: "not patched",
      disabled: "switched off",
      removed: "switched off (still in the app until --apply)",
      retained: "switched off (still in the app until --restore)",
      blocked: v.error || "install t3-extras first",
    }[v.state] ?? `cannot patch: ${v.error}`]),
  );
  console.log(JSON.stringify({
    app: APP,
    build: version,
    launchedByT3: launchedByT3(asarIdentity()),
    asarIntegrityFuse: integrityFuse(),
    units,
    results,
    compat: compatStatus(missingHooks),
    targets,
    switchedOff: [...loadDisabled()],
    state: loadState(),
  }, null, 2));
}

function cmdProbe() {
  try {
    fs.closeSync(fs.openSync(ASAR, "r+"));
    console.log("PROBE: can write app.asar");
  } catch (error) {
    console.log(`PROBE: cannot write app.asar (${error.code})`);
    process.exitCode = 3;
  }
}

function cmdDryRun() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-keeper-dry-"));
  const copy = path.join(tmpDir, "app.asar");
  execFileSync("/bin/cp", ["-c", ASAR, copy]);
  try {
    const fd = fs.openSync(copy, "r+");
    let planned;
    try {
      const layout = readLayout(fd);
      planned = plan(fd, layout, findTargets(fd, layout));
      if (Object.keys(planned.files).length) writeEntries(fd, layout, Object.values(planned.files));
    } finally {
      fs.closeSync(fd);
    }
    const again = inspect(copy);
    console.log(JSON.stringify({ firstPass: summary(planned.results), secondPass: summary(again.results), missingHooks: again.missingHooks }, null, 2));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function recordApply(out) {
  const prev = loadState();
  saveState({ keeperVersion: KEEPER_VERSION, loaderKey: loaderKeyId(), key: asarKey(out.produced ?? out.checked), build: out.version, mainJs: out.mainJs, status: out.failed.length ? "partial" : "patched", results: out.results, produced: out.produced ? { build: out.version, identity: out.produced } : prev.produced ?? null, lastPatchedAt: out.wrote ? new Date().toISOString() : prev.lastPatchedAt ?? null });
  return out.failed.length ? 2 : 0;
}

function cmdApply() {
  return withLock(() => {
    const code = recordApply(apply({ reason: "manual" }));
    reminderTick();
    return code;
  });
}

/** --disable / --enable <unit>: record the switch, then apply it now if this build has had its first launch. */
function cmdSwitch(on) {
  const unit = process.argv[3];
  if (!SWITCHABLE.includes(unit)) {
    console.error(`only ${SWITCHABLE.join(", ")} can be switched ${on ? "on" : "off"} on its own; --restore undoes every other unit`);
    return 64;
  }
  return withLock(() => {
    const set = loadDisabled();
    if (on) set.delete(unit);
    else set.add(unit);
    writeFileDurable(DISABLED, JSON.stringify({ disabled: [...set], updatedAt: new Date().toISOString() }, null, 2));
    const identity = asarIdentity();
    if (!launchedByT3(identity)) {
      saveState({ ...loadState(), key: null }); // --auto applies it once T3 is running this build
      console.log(`${unit} switched ${on ? "on" : "off"}; T3 isn't running this build, so the background job applies it after T3 starts`);
      return 0;
    }
    const out = apply({ reason: `${on ? "enable" : "disable"} ${unit}`, checked: identity, guard: () => launchedByT3(identity) });
    console.log(`${unit} switched ${on ? "on" : "off"} (${out.results[unit].state}); press Shift-Cmd-R in T3 to see it`);
    const code = recordApply(out);
    reminderTick();
    return code;
  });
}

function cmdAuto() {
  if (!fs.existsSync(ASAR)) return 0;
  return withLock(() => {
    reminderTick(); // before the handled-archive return, including a build that is already patched
    const state = loadState();
    const identity = asarIdentity();
    if (state.key === asarKey(identity) && state.keeperVersion === KEEPER_VERSION && state.loaderKey === loaderKeyId()) return 0; // this exact app.asar was handled, with this key
    const version = bundleVersion();
    if (!launchedByT3(identity)) {
      if (state.status !== "waiting-first-launch" || state.waitingFor !== version) {
        log(`build ${version}: waiting for its first launch so Gatekeeper scans it unpatched`);
        saveState({ ...state, mainJs: state.build === version ? state.mainJs : null, key: null, build: version, status: "waiting-first-launch", waitingFor: version });
      }
      return 0;
    }
    // After a failure on this same file, wait 10 minutes before trying again (planning parses ~13 MB).
    if (state.status === "error" && state.errorKey === asarKey(identity) && Date.now() - (state.errorAt ?? 0) < 10 * 60 * 1000) return 0;
    let out;
    try {
      fs.closeSync(fs.openSync(ASAR, "r+")); // cheap App Management check before the expensive part
      out = apply({ reason: "auto", checked: identity, version, guard: () => launchedByT3(identity) });
    } catch (error) {
      const denied = error.code === "EPERM" || error.code === "EACCES";
      log(`build ${version}: ${denied ? "macOS blocked the write (App Management not granted)" : error.message}`);
      if (state.errorBuild !== version) {
        notify(denied
          ? "Can't re-apply the T3 sidebar fix: switch on node in System Settings > Privacy & Security > App Management (a Homebrew node update can switch it off)."
          : `T3 sidebar fix failed on build ${version}: ${error.message}`);
      }
      saveState({ ...state, mainJs: state.build === version ? state.mainJs : null, key: null, build: version, status: "error", errorBuild: version, error: error.message, errorKey: asarKey(identity), errorAt: Date.now() });
      return 1;
    }
    const status = out.failed.length === 0 ? "patched" : out.failed.length === UNITS.length ? "failed" : "partial";
    notifyApply(out);
    saveState({
      keeperVersion: KEEPER_VERSION,
      loaderKey: loaderKeyId(),
      key: asarKey(out.produced ?? identity),
      produced: out.produced ? { build: version, identity: out.produced } : state.produced ?? null,
      build: version,
      mainJs: out.mainJs,
      status,
      results: out.results,
      lastPatchedAt: out.wrote ? new Date().toISOString() : (state.lastPatchedAt ?? null),
    });
    reminderTick();
    return 0;
  });
}

// For test/keeper.test.mjs.
export {
  unitWrap, unitMinWidth, unitRule, unitFit, unitTitleGuide, unitGeminiQuota, unitAntigravityQuestions, unitExtras, unitFirstClick, finishBinCli, absorb, FIT_TITLE, FIT_TITLE_V9, TITLE_GUIDE, ANTIGRAVITY_QUESTIONS_HELPER, WRAP_CSS, TMP_PREFIX,
  extrasBoot, EXTRAS_ID, STYLE_ID, cspAllowsLoader,
  readLayout, readEntry, writeEntries, findTargets, inspect, apply, asarIdentity, sha, removeStaleTemps, launchedByT3,
};

function rotateLog() {
  const file = path.join(HOME, "keeper.log");
  let fd;
  let size = 0;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    size = fs.fstatSync(fd).size;
    fs.fchmodSync(fd, 0o600);
  } catch {
    return; // missing, or a symlink this will not follow
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  if (size <= 1024 * 1024) return;
  try {
    const rotated = `${file}.1`;
    fs.renameSync(file, rotated);
    const out = fs.openSync(rotated, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fchmodSync(out, 0o600); } finally { fs.closeSync(out); }
  } catch {}
}

function mainBody() {
  const arg = process.argv[2] ?? "--status";
  // Only commands that write take the lock to start the trial file; --status, --trial-report and the reminder
  // commands read it as it is, so a running --auto never puts a lock message in front of their output.
  if (["--auto", "--apply", "--restore", "--false-alarm", "--confirm-real"].includes(arg)) withLock(initCompat);
  if (reminders.isKeeperArg(arg)) {
    process.exitCode = reminders.runFromKeeperArgv(process.argv);
    return;
  }
  if (arg === "--auto") rotateLog();
  const commands = {
    "--status": cmdStatus, "--apply": cmdApply, "--auto": cmdAuto, "--restore": cmdRestore, "--dry-run": cmdDryRun, "--probe": cmdProbe,
    "--false-alarm": () => cmdOutcome("false-alarm"), "--confirm-real": () => cmdOutcome("real"), "--trial-report": cmdTrialReport,
    "--disable": () => cmdSwitch(false), "--enable": () => cmdSwitch(true),
  };
  const run = commands[arg];
  if (!run) {
    console.error(`unknown command ${arg}; use ${Object.keys(commands).join(" | ")}`);
    process.exit(64);
  }
  try {
    const code = run();
    if (typeof code === "number" && code !== 0) process.exitCode = code;
  } catch (error) {
    log(`error: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}

if (IS_ENTRY) {
  try { mainBody(); }
  finally { if (entryLease !== null) fs.closeSync(entryLease); }
}
