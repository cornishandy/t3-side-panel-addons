#!/opt/homebrew/bin/node
/**
 * T3 sidebar keeper: re-applies Andy's sidebar-title patch to T3 Code (Nightly)
 * after every update, without depending on the build's minified names.
 *
 * Units (each applies fully or not at all; every file keeps its byte length):
 *   wrap      client/index.html   unlayered <style> so sidebar titles word-wrap
 *   minWidth  main-*.js           sidebar drag minimum 208px -> 140px
 *   rule      server dist *.mjs   title prompt asks for 2-5 words, under 36 chars
 *   fit       server dist *.mjs   generated titles <= 40 chars, child titles <= 42; readable native ids
 *   titleGuide server dist *.mjs  one compact Titles section in every provider's instructions
 *   geminiQuota server dist *.mjs Antigravity limits probe sends a current version, so Google
 *                                 returns the Gemini quota rows (server: next T3 launch); builds
 *                                 that already send 2.24.0 or newer are left as they are
 *   antigravityQuestions server dist *.mjs
 *                                 adds extractElicitationForm to Antigravity's ACP flavor so
 *                                 ask_question folds qN + qN_other, unlocks custom answers, and
 *                                 splits Claude-style headers/option descriptions (server: next
 *                                 T3 launch); yields cleanly if upstream adds its own extractor
 *   antigravitySteer server dist *.mjs
 *                                 prevents steering (user message, delegated completion, or
 *                                 queued-message promotion) from hitting Antigravity while a
 *                                 question/approval waits (upstream #39799 / #35703; server: next
 *                                 T3 launch); yields cleanly once upstream adds each guard
 *   antigravityQuotaOutcome server dist *.mjs
 *                                 parses Antigravity 1.5 JSON quota errors and future/delay reset
 *                                 times in AntigravityTurnOutcome so quota hits arm auto-resume
 *                                 instead of generic Provider error (upstream #40244; server: next
 *                                 T3 launch); yields cleanly once upstream fixes all 6 components
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
const KEEPER_VERSION = 20; // bump when units change so --auto re-checks an already-handled build
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
// Identical semantics to FIT_TITLE in compact pure-ASCII form for small split server chunks
// (such as ProviderEventLoggers-*.mjs, ~34 KB with no multi-line block comments).
const FIT_TITLE_COMPACT = String.raw`function t3KeeperFitTitle(t,m,u=Infinity,a=false){/*t3-keeper-fit-2c*/if(typeof t!=="string")return t;if(a&&t===t.trim()&&/^\/?(?:root\/)?[a-z0-9]+(?:[_/][a-z0-9]+)+$/.test(t)){t=t.replace(/^\/?(?:root\/)?/,"").replace(/[_/]/g," ");t=t.charAt(0).toUpperCase()+t.slice(1);}const s=t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,"").replace(/\s+/g," ").trim();const g=(x)=>Array.from(new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(x),(v)=>v.segment);const f=(l)=>{if(g(s).length<=l)return s;const r=s.match(/\s(\([^()]{1,24}\)|(?:subagent|thread) \d+)$/u);const e=r?" "+r[1]:"";const b=Math.max(1,l-g(e).length-3);let d=r?s.slice(0,r.index):s;const c=d.indexOf(": ");if(c>0&&g(d).length>b){const q=d.slice(c+2),w=d.slice(0,c).split(" "),p=w.length>1&&/^\d+$/.test(w.at(-1))?[w.slice(-2).join(" "),w.at(-1)]:[w.at(-1)];let n=q;for(const k of p){const o=k.charAt(0).toUpperCase()+k.slice(1);if(g(o+": "+q.split(" ")[0]).length<=b){n=o+": "+q;break;}}d=n;}if(g(d).length+g(e).length<=l)return d+e;const y=g(d);let h=y.slice(0,b).join("");if(y[b]!==" "){const i=h.lastIndexOf(" ");if(i>=Math.floor(h.length/2))h=h.slice(0,i);}return h.replace(/[\s:;,&-]+$/u,"")+"..."+e;};let l=m,o=f(l);while(o.length>u&&l>1)o=f(--l);if(o.length>u){const r=s.match(/\s(\([^()]{1,24}\)|(?:subagent|thread) \d+)$/u);const e=r&&r[1].length+5<=u?" "+r[1]:"";let k="";for(const v of g(r&&e?s.slice(0,r.index):s)){if(k.length+v.length>u-3-e.length)break;k+=v;}o=k.trimEnd()+"..."+e;}return o;}
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

function parseTokens(src, sourceType) {
  const tokens = [];
  acorn.parse(src, { ...PARSE, sourceType, onToken: tokens });
  return tokens;
}

function tokenSignature(src, sourceType) {
  const out = [];
  let prevEnd = 0;
  for (const t of parseTokens(src, sourceType)) {
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
      new RegExp(`:Math\\.max\\(${name},[\\w$]+\\)[,}]`),
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

function findMaxTitleCharsDecl(ast) {
  const decls = ast.body
    .filter((n) => n.type === "VariableDeclaration" && n.kind === "const")
    .flatMap((n) => n.declarations)
    .filter((d) => d.id.type === "Identifier" && d.id.name === "MAX_THREAD_TITLE_CHARS");
  if (decls.length !== 1 || countIdentifiers(ast, "MAX_THREAD_TITLE_CHARS") !== 2) {
    throw new Error("MAX_THREAD_TITLE_CHARS is not declared once and used once");
  }
  const init = decls[0].init;
  const isPatched = Boolean(
    init?.type === "MemberExpression" && !init.computed &&
    init.object.type === "Identifier" && init.object.name === "Number" &&
    init.property.type === "Identifier" && init.property.name === "MAX_SAFE_INTEGER",
  );
  const isNumeric = Boolean(init?.type === "Literal" && typeof init.value === "number");
  if (!isPatched && !isNumeric) throw new Error("MAX_THREAD_TITLE_CHARS initializer changed shape");
  return { init, isPatched };
}

/** fit: wrap the server title functions, upgrading the exact v9 helper in place. */
function unitFit(text, ctx = {}) {
  const ast = acorn.parse(text, { ...PARSE, sourceType: "module" });
  const topFns = ast.body.filter((n) => n.type === "FunctionDeclaration" && n.id?.name);
  const topFnNames = new Set(topFns.map((n) => n.id.name));
  const legacy = topFnNames.has("t3KeeperFitTitle") || text.includes("function t3KeeperFitTitle(");
  if (ctx.disabled?.has("fit")) return legacy ? { state: "retained", text } : { state: "disabled", text };
  const wrappers = ctx.wrappers ?? FIT_WRAPPERS.filter(([n]) => topFnNames.has(n) || topFnNames.has(`${n}$t3orig`));
  if (wrappers.length === 0) throw new Error("no title wrapper target found");
  const needsCap = wrappers.some(([n]) => n === "sanitizeThreadTitle");
  const helper = ctx.compact ? FIT_TITLE_COMPACT : FIT_TITLE;
  const expectedWrapperFor = ([n, max, preFit]) => fitWrapper(n, max, preFit, n === "subagentThreadTitle").trimEnd();
  if (legacy) {
    const helperFns = topFns.filter((n) => n.id.name === "t3KeeperFitTitle");
    if (text.split("function t3KeeperFitTitle(").length !== 2 || helperFns.length !== 1) {
      throw new Error("title fitter declared more than once");
    }
    const helperFn = helperFns[0];
    if (helperFn.async || helperFn.generator) throw new Error("t3KeeperFitTitle is async or a generator");
    const helperSrc = text.slice(helperFn.start, helperFn.end);
    const hasCurrentHelper = helperSrc === FIT_TITLE.trimEnd() || helperSrc === FIT_TITLE_COMPACT.trimEnd();
    const wrapperNodes = wrappers.map((w) => {
      const [name] = w;
      const pubs = topFns.filter((n) => n.id.name === name);
      const origs = topFns.filter((n) => n.id.name === `${name}$t3orig`);
      return { w, name, pub: pubs.length === 1 ? pubs[0] : null, orig: origs.length === 1 ? origs[0] : null };
    });
    const allCurrentWrappers = wrapperNodes.every(({ w, pub, orig }) =>
      pub && orig &&
      !pub.async && !pub.generator && !orig.async && !orig.generator &&
      text.slice(pub.start, pub.end) === expectedWrapperFor(w),
    );
    if (hasCurrentHelper && allCurrentWrappers) {
      if (needsCap && !findMaxTitleCharsDecl(ast).isPatched) {
        throw new Error("MAX_THREAD_TITLE_CHARS was not patched");
      }
      return { state: "already", text };
    }
    // Check whether an already-current helper failed only because a wrapper or original is async/generator.
    for (const { name, pub, orig } of wrapperNodes) {
      if (pub && (pub.async || pub.generator)) throw new Error(`${name} is async or a generator`);
      if (orig && (orig.async || orig.generator)) throw new Error(`${name} is async or a generator`);
    }
    const subNode = wrapperNodes.find(({ name }) => name === "subagentThreadTitle");
    const oldWrapper = fitWrapper("subagentThreadTitle", 42, true).trimEnd();
    const nextWrapper = fitWrapper("subagentThreadTitle", 42, true, true).trimEnd();
    const validV9Others = wrapperNodes
      .filter(({ name }) => name !== "subagentThreadTitle")
      .every(({ w, pub, orig }) => pub && orig && text.slice(pub.start, pub.end) === expectedWrapperFor(w));
    if (
      !subNode?.pub || !subNode.orig || !validV9Others ||
      helperSrc !== FIT_TITLE_V9.trimEnd() ||
      text.slice(subNode.pub.start, subNode.pub.end) !== oldWrapper
    ) {
      throw new Error("title fitter is not the exact supported v9 helper and wrapper");
    }
    if (needsCap && !findMaxTitleCharsDecl(ast).isPatched) {
      throw new Error("MAX_THREAD_TITLE_CHARS was not patched");
    }
    const upgradeEdits = [
      { start: helperFn.start, end: helperFn.end, replacement: helper.trimEnd() },
      { start: subNode.pub.start, end: subNode.pub.end, replacement: nextWrapper },
    ];
    let upgraded = text;
    for (const e of upgradeEdits.sort((a, b) => b.start - a.start)) {
      upgraded = upgraded.slice(0, e.start) + e.replacement + upgraded.slice(e.end);
    }
    return { state: "patched", text: upgraded };
  }
  const edits = [];
  // sanitizeThreadTitle would cut at 117 UTF-16 units (can split an emoji) before our fitter sees it.
  if (needsCap) {
    const cap = findMaxTitleCharsDecl(ast);
    if (!cap.isPatched) edits.push({ start: cap.init.start, end: cap.init.end, replacement: "Number.MAX_SAFE_INTEGER" });
  }
  for (let i = 0; i < wrappers.length; i++) {
    const [name, max, preFit] = wrappers[i];
    const hits = topFns.filter((n) => n.id.name === name);
    if (hits.length !== 1) throw new Error(`${name} declared ${hits.length} times`);
    if (hits[0].async || hits[0].generator) throw new Error(`${name} is async or a generator`);
    if (text.includes(`${name}$t3orig`)) throw new Error(`${name}$t3orig already exists`);
    const wrapper = (i === 0 ? helper : "") + fitWrapper(name, max, preFit, name === "subagentThreadTitle");
    edits.push({ start: hits[0].id.start, end: hits[0].id.end, replacement: `${name}$t3orig` });
    edits.push({ start: hits[0].start, end: hits[0].start, replacement: wrapper });
  }
  let next = text;
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    next = next.slice(0, e.start) + e.replacement + next.slice(e.end);
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

function reclaimServerWhitespace(src, mode, protectedRanges) {
  let kept = "", end = 0;
  for (const token of parseTokens(src, "module")) {
    const gap = src.slice(end, token.start);
    const protectedGap = protectedRanges.some((n) => end >= n.start && token.start <= n.end);
    if (!protectedGap && /^[\t\r\n ]*$/.test(gap)) {
      if (mode === "indent") {
        kept += gap.replace(/\n[\t ]+/g, "\n");
      } else if (/[\r\n]/.test(gap)) {
        kept += gap.replace(/[^\r\n]+/g, "");
      } else if (gap.length > 0 && end > 0) {
        const a = src[end - 1], b = src[token.start];
        const safeA = /[,;()[\]{}]/.test(a);
        const safeB = /[,;()[\]{}]/.test(b);
        const opA = /[=:]/.test(a) && !/[=<>!]/.test(b);
        const opB = /[=:]/.test(b) && !/[=<>!+/*%&|^?-]/.test(a);
        kept += (safeA || safeB || opA || opB) ? "" : " ";
      } else {
        kept += gap;
      }
    } else {
      kept += gap;
    }
    kept += src.slice(token.start, token.end);
    end = token.end;
  }
  const tail = src.slice(end);
  kept += /^[\r\n \t]*$/.test(tail) ? tail.replace(/[ \t]+/g, "") : tail;
  return kept;
}

function stripSafeServerLineComments(src, protectedRanges) {
  const comments = [];
  acorn.parse(src, { ...PARSE, sourceType: "module", onComment: comments });
  let kept = src;
  for (const c of comments.slice().reverse()) {
    if (c.type !== "Line") continue;
    // Only reclaim bundler source-path banners (never shebangs, //# or //@ V8 directives, or arbitrary comments).
    if (!/^ (?:\.\.\/|src\/|packages\/|apps\/|node_modules\/)[^\r\n]+\.(?:[cm]?[jt]sx?)$/.test(c.value)) continue;
    if (protectedRanges.some((n) => c.start >= n.start && c.end <= n.end)) continue;
    const lineStart = kept.lastIndexOf("\n", c.start - 1) + 1;
    if (lineStart === 0) continue; // keep line-1 newline signature stable
    const lineEnd = kept.indexOf("\n", c.end);
    if (lineEnd < 0 || kept.slice(lineStart, c.start).trim() || kept.slice(c.end, lineEnd).trim()) continue;
    kept = kept.slice(0, lineStart) + kept.slice(lineEnd + 1);
  }
  return kept;
}

function protectedServerFunctions(src, ast = null) {
  const tree = ast ?? acorn.parse(src, { ...PARSE, sourceType: "module" });
  const protectedTopNames = ["t3KeeperFitTitle", ...FIT_WRAPPERS.map(([name]) => name)];
  return [
    ...tree.body.filter((n) => n.type === "FunctionDeclaration" && protectedTopNames.includes(n.id.name)),
    ...findNamedFunctions(tree, [ANTIGRAVITY_QUESTIONS_FN]),
  ];
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
    // Bundles without large comments: progressively reclaim safe whitespace (and whole-line //
    // path comments only if still short), keeping newlines (ASI), tokens and protected helpers.
    const protectedFunctions = protectedServerFunctions(text, ast);
    const tryCandidate = (kept) => {
      const room = targetBytes - Buffer.byteLength(kept);
      if (room < 0) return null;
      if (!sameTokens(text, kept, "module")) throw new Error("server indentation reclaim changed tokens");
      acorn.parse(kept, { ...PARSE, sourceType: "module" });
      return kept + " ".repeat(room);
    };
    for (const mode of ["indent", "horizontal"]) {
      const out = tryCandidate(reclaimServerWhitespace(text, mode, protectedFunctions));
      if (out !== null) return out;
    }
    const stripped = stripSafeServerLineComments(text, protectedFunctions);
    if (stripped !== text) {
      const out = tryCandidate(reclaimServerWhitespace(stripped, "horizontal", protectedServerFunctions(stripped)));
      if (out !== null) return out;
    }
    throw error;
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

function parseTopModule(text) {
  try {
    return acorn.parse(text, { ...PARSE, sourceType: "module" });
  } catch {
    return null;
  }
}

function topLevelDecls(ast) {
  const out = [];
  for (const n of ast?.body ?? []) {
    if (n.type === "FunctionDeclaration" || n.type === "VariableDeclaration") out.push(n);
    else if ((n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") && n.declaration) {
      if (n.declaration.type === "FunctionDeclaration" || n.declaration.type === "VariableDeclaration") out.push(n.declaration);
    }
  }
  return out;
}

function hasTopLevelFunction(text, name, getAst = null) {
  if (!text.includes(name) && !text.includes("\\u")) return false;
  const ast = getAst ? getAst() : parseTopModule(text);
  return topLevelDecls(ast).some((n) => n.type === "FunctionDeclaration" && n.id?.name === name);
}

function hasTopLevelArrayVar(text, name, getAst = null) {
  if (!text.includes(name) && !text.includes("\\u")) return false;
  const ast = getAst ? getAst() : parseTopModule(text);
  return topLevelDecls(ast)
    .filter((n) => n.type === "VariableDeclaration")
    .flatMap((n) => n.declarations)
    .some((d) => d.id.type === "Identifier" && d.id.name === name && d.init?.type === "ArrayExpression");
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (visit(node) === false) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "start" || k === "end" || k === "loc" || k === "type") continue;
    if (Array.isArray(v)) {
      for (const item of v) walkAst(item, visit);
    } else if (v && typeof v === "object" && typeof v.type === "string") {
      walkAst(v, visit);
    }
  }
}

function hasTopLevelBinding(ast, name) {
  for (const n of ast?.body ?? []) {
    const decl = (n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") ? n.declaration : n;
    if (!decl) continue;
    if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id?.name === name) return true;
    if (decl.type === "VariableDeclaration" && decl.declarations.some((d) => d.id?.type === "Identifier" && d.id.name === name)) return true;
    if (n.type === "ImportDeclaration" && n.specifiers.some((s) => s.local?.name === name)) return true;
  }
  return false;
}

function applyTextEdits(text, edits) {
  if (edits.length === 0) return text;
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let lastStart = Infinity;
  let out = text;
  for (const e of sorted) {
    if (e.end > lastStart) throw new Error("overlapping patch edits");
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    lastStart = e.start;
  }
  return out;
}

function collectAndTerms(node, out = []) {
  if (!node) return out;
  if (node.type === "LogicalExpression" && node.operator === "&&") {
    collectAndTerms(node.left, out);
    collectAndTerms(node.right, out);
  } else {
    out.push(node);
  }
  return out;
}

function isUndefinedNode(node) {
  if (!node) return false;
  if (node.type === "Identifier" && node.name === "undefined") return true;
  if (node.type === "UnaryExpression" && node.operator === "void") return true;
  return false;
}

function isVoidZeroOrNull(node) {
  return (node?.type === "Literal" && node.value === null) || isUndefinedNode(node);
}

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function isMemberIdent(node, objName, propName) {
  const expr = unwrapChain(node);
  return !!expr && expr.type === "MemberExpression" && !expr.computed &&
    expr.object.type === "Identifier" && expr.object.name === objName &&
    expr.property.type === "Identifier" && expr.property.name === propName;
}

function isMemberPath(node, parts) {
  let cur = unwrapChain(node);
  for (let i = parts.length - 1; i >= 1; i--) {
    if (!cur || cur.type !== "MemberExpression" || cur.computed ||
        cur.property.type !== "Identifier" || cur.property.name !== parts[i]) {
      return false;
    }
    cur = unwrapChain(cur.object);
  }
  return cur?.type === "Identifier" && cur.name === parts[0];
}

function extractSingleReturnExpr(fnNode) {
  if (!fnNode || (fnNode.type !== "ArrowFunctionExpression" && fnNode.type !== "FunctionExpression" && fnNode.type !== "FunctionDeclaration")) {
    return null;
  }
  if (fnNode.body.type !== "BlockStatement") return fnNode.body;
  if (fnNode.body.body.length === 1 && fnNode.body.body[0].type === "ReturnStatement") {
    return fnNode.body.body[0].argument;
  }
  return null;
}

function findTopLevelFnLike(ast, name) {
  const hits = [];
  for (const n of topLevelDecls(ast)) {
    if (n.type === "FunctionDeclaration" && n.id?.name === name) hits.push(n);
    else if (n.type === "VariableDeclaration") {
      for (const d of n.declarations) {
        if (d.id?.type === "Identifier" && d.id.name === name &&
            (d.init?.type === "ArrowFunctionExpression" || d.init?.type === "FunctionExpression")) {
          hits.push(d.init);
        }
      }
    }
  }
  if (hits.length !== 1) return null;
  let reassigned = false;
  walkAst(ast, (n) => {
    if (n.type === "AssignmentExpression" && n.left?.type === "Identifier" && n.left.name === name) {
      reassigned = true;
      return false;
    }
  });
  return reassigned ? null : hits[0];
}

function isPositivePendingCallback(cbNode) {
  if (!cbNode || (cbNode.type !== "ArrowFunctionExpression" && cbNode.type !== "FunctionExpression")) return false;
  if (cbNode.params.length !== 1 || cbNode.params[0].type !== "Identifier") return false;
  const param = cbNode.params[0].name;
  const expr = extractSingleReturnExpr(cbNode);
  if (!expr) return false;
  const terms = collectAndTerms(expr);
  let hasStatus = false;
  let hasLiveCap = false;
  for (const t of terms) {
    if (t.type === "BinaryExpression" && t.operator === "===" &&
        ((isMemberPath(t.left, [param, "status"]) && t.right.type === "Literal" && t.right.value === "pending") ||
         (isMemberPath(t.right, [param, "status"]) && t.left.type === "Literal" && t.left.value === "pending"))) {
      hasStatus = true;
      continue;
    }
    if (t.type === "BinaryExpression" && t.operator === "!==" &&
        ((isMemberPath(t.left, [param, "responseCapability", "type"]) && t.right.type === "Literal" && t.right.value === "message") ||
         (isMemberPath(t.right, [param, "responseCapability", "type"]) && t.left.type === "Literal" && t.left.value === "message"))) {
      hasLiveCap = true;
      continue;
    }
    if (t.type === "BinaryExpression" && t.operator === "===" &&
        ((isMemberPath(t.left, [param, "responseCapability", "type"]) && t.right.type === "Literal" && t.right.value === "live") ||
         (isMemberPath(t.right, [param, "responseCapability", "type"]) && t.left.type === "Literal" && t.left.value === "live"))) {
      hasLiveCap = true;
      continue;
    }
    if (t.type === "BinaryExpression" && (t.operator === "!==" || t.operator === "!=") &&
        ((isMemberPath(t.left, [param, "responseCapability"]) && isVoidZeroOrNull(t.right)) ||
         (isMemberPath(t.right, [param, "responseCapability"]) && isVoidZeroOrNull(t.left)))) {
      continue;
    }
    return false;
  }
  return hasStatus && hasLiveCap;
}

function isPositivePendingSomeCall(node, projName) {
  const expr = unwrapChain(node);
  if (!expr || expr.type !== "CallExpression" || expr.arguments.length !== 1) return false;
  if (!isMemberPath(expr.callee, [projName, "runtimeRequests", "some"])) return false;
  return isPositivePendingCallback(expr.arguments[0]);
}

function isPositivePendingRequestExpr(node, ast, projName) {
  if (!node) return false;
  if (isPositivePendingSomeCall(node, projName)) return true;
  if (node.type === "CallExpression" && node.callee.type === "Identifier" &&
      node.callee.name === "waitsOnPendingRequest" &&
      node.arguments.length === 1 && node.arguments[0].type === "Identifier" &&
      node.arguments[0].name === projName) {
    const helper = findTopLevelFnLike(ast, node.callee.name);
    if (!helper || helper.params.length !== 1 || helper.params[0].type !== "Identifier") return false;
    return isPositivePendingSomeCall(extractSingleReturnExpr(helper), helper.params[0].name);
  }
  return false;
}

function hasNegatedPendingGuard(node, ast, projName) {
  return collectAndTerms(node).some((term) =>
    term.type === "UnaryExpression" && term.operator === "!" &&
    isPositivePendingRequestExpr(term.argument, ast, projName)
  );
}

function isYieldGetPending(node, getFn) {
  return node?.type === "YieldExpression" && node.delegate &&
    node.argument?.type === "CallExpression" &&
    node.argument.callee.type === "Identifier" && node.argument.callee.name === getFn &&
    node.argument.arguments.length === 1 &&
    node.argument.arguments[0].type === "Identifier" &&
    node.argument.arguments[0].name === "pendingRuntimeRequests";
}

function isPositivePendingSizeCheck(test, pendingVarNames, getFn) {
  if (!test || test.type !== "BinaryExpression") return false;
  const isPendingSize = (expr) => {
    const e = unwrapChain(expr);
    if (!e || e.type !== "MemberExpression" || e.computed ||
        e.property.type !== "Identifier" || e.property.name !== "size") return false;
    return isYieldGetPending(e.object, getFn) ||
      (e.object.type === "Identifier" && pendingVarNames.has(e.object.name));
  };
  const isLitNum = (expr, n) => expr?.type === "Literal" && expr.value === n;
  if (isPendingSize(test.left)) {
    return (test.operator === ">" && isLitNum(test.right, 0)) ||
      (test.operator === ">=" && isLitNum(test.right, 1)) ||
      (test.operator === "!==" && isLitNum(test.right, 0));
  }
  if (isPendingSize(test.right)) {
    return (test.operator === "<" && isLitNum(test.left, 0)) ||
      (test.operator === "<=" && isLitNum(test.left, 1)) ||
      (test.operator === "!==" && isLitNum(test.left, 0));
  }
  return false;
}

function returnsSteerDeclinedError(node) {
  let ret = node;
  if (ret?.type === "BlockStatement" && ret.body.length === 1) ret = ret.body[0];
  if (ret?.type !== "ReturnStatement" || !ret.argument) return false;
  let expr = ret.argument;
  if (expr.type === "YieldExpression" && expr.delegate) expr = expr.argument;
  if (expr?.type === "CallExpression" && expr.arguments.length === 1) {
    if (calleeBaseName(expr.callee) !== "fail") return false;
    expr = expr.arguments[0];
  }
  return expr?.type === "NewExpression" &&
    ((expr.callee.type === "Identifier" && expr.callee.name === "ProviderAdapterSteerDeclinedError") ||
     (expr.callee.type === "MemberExpression" && !expr.callee.computed && expr.callee.property.name === "ProviderAdapterSteerDeclinedError"));
}

function isFollowUpGuardTerm(node) {
  if (!node || node.type !== "BinaryExpression") return false;
  if (node.operator !== "===" && node.operator !== "==") return false;
  return (isMemberIdent(node.left, "command", "steerFollowUpOfRunId") && isVoidZeroOrNull(node.right)) ||
    (isMemberIdent(node.right, "command", "steerFollowUpOfRunId") && isVoidZeroOrNull(node.left));
}

function findEffectFnCalls(ast, label) {
  const hits = [];
  walkAst(ast, (n) => {
    if (n.type === "CallExpression" &&
        n.callee.type === "CallExpression" &&
        n.callee.arguments.length === 1 &&
        n.callee.arguments[0].type === "Literal" &&
        n.callee.arguments[0].value === label) {
      hits.push(n);
    }
  });
  return hits;
}

function extractTagOrList(node, causeIdent) {
  if (!node) return null;
  if (node.type === "LogicalExpression" && node.operator === "||") {
    const l = extractTagOrList(node.left, causeIdent);
    const r = extractTagOrList(node.right, causeIdent);
    return l && r ? [...l, ...r] : null;
  }
  if (node.type === "BinaryExpression" && node.operator === "===") {
    if (isMemberIdent(node.left, causeIdent, "_tag") && node.right.type === "Literal" && typeof node.right.value === "string") {
      return [node.right.value];
    }
    if (isMemberIdent(node.right, causeIdent, "_tag") && node.left.type === "Literal" && typeof node.left.value === "string") {
      return [node.left.value];
    }
  }
  return null;
}

function isReturnsQueueAfterActive(node) {
  let ret = node;
  if (ret?.type === "BlockStatement" && ret.body.length === 1) ret = ret.body[0];
  if (ret?.type !== "ReturnStatement" || ret.argument?.type !== "ObjectExpression") return false;
  return ret.argument.properties.length === 1 &&
    staticPropKey(ret.argument.properties[0]) === "type" &&
    ret.argument.properties[0].value?.type === "Literal" &&
    ret.argument.properties[0].value.value === "queue_after_active";
}

function isUnconditionalReturnNoSteer(node) {
  if (!node) return false;
  if (countIdentifiers(node, "steerWhenReadyRunId") > 0 ||
      countIdentifiers(node, "dispatchSteerIntoRun") > 0 ||
      countIdentifiers(node, "emitEvent") > 0 ||
      countIdentifiers(node, "stopRunForQueuedCommand") > 0) return false;
  let hasMutation = false;
  walkAst(node, (n) => {
    if (n.type === "AssignmentExpression" || n.type === "UpdateExpression") {
      hasMutation = true;
      return false;
    }
  });
  if (hasMutation) return false;
  if (node.type === "ReturnStatement") return true;
  if (node.type === "BlockStatement" && node.body.length > 0 && node.body.at(-1).type === "ReturnStatement") return true;
  return false;
}

const AG_STEER_MARK = "/*t3-keeper-ag-steer-v1*/";
const AG_STEER_TARGETS = ["acpSteer", "dispatchPolicy", "orchestratorSteer"];

/**
 * antigravitySteer: prevents steers (user message, delegated completion, or queued-message
 * promotion) from hitting Antigravity while a question or approval waits (upstream #39799 / #35703).
 * Supports both single-chunk and split-chunk server bundles and yields cleanly once upstream adds each guard.
 */
function unitAntigravitySteer(text, opts = {}) {
  const targets = opts.targets ?? AG_STEER_TARGETS;
  const ast = acorn.parse(text, { ...PARSE, sourceType: "module" });
  const edits = [];

  if (targets.includes("acpSteer")) {
    // 1a. AcpAdapterV2.steerWithPrompt: decline before mutating turn state when a request is pending.
    const steerCalls = findEffectFnCalls(ast, "AcpAdapterV2.steerWithPrompt");
    if (steerCalls.length !== 1) throw new Error(`AcpAdapterV2.steerWithPrompt found ${steerCalls.length} times`);
    const steerFn = steerCalls[0].arguments[0];
    if (steerFn?.type !== "FunctionExpression" || !steerFn.generator || steerFn.params[0]?.type !== "Identifier") {
      throw new Error("AcpAdapterV2.steerWithPrompt signature changed shape");
    }
    const turnInputParam = steerFn.params[0].name;
    const getFnMatches = [];
    walkAst(steerFn.body, (n) => {
      if (n.type === "VariableDeclarator" &&
          n.id?.type === "Identifier" && n.id.name === "context" &&
          n.init?.type === "YieldExpression" && n.init.delegate &&
          n.init.argument?.type === "CallExpression" &&
          n.init.argument.callee.type === "Identifier" &&
          n.init.argument.arguments.length === 1 &&
          n.init.argument.arguments[0].type === "Identifier" &&
          n.init.argument.arguments[0].name === "activeTurn") {
        getFnMatches.push(n.init.argument.callee.name);
      }
    });
    if (getFnMatches.length !== 1) throw new Error("AcpAdapterV2.steerWithPrompt Ref.get(activeTurn) binding changed shape");
    const getFn = getFnMatches[0];
    const cbCalls = [];
    walkAst(steerFn.body, (n) => {
      if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "runRuntimeCallbackAtGeneration" && n.arguments.length === 2) {
        cbCalls.push(n);
      }
    });
    if (cbCalls.length !== 1) throw new Error(`runRuntimeCallbackAtGeneration inside steerWithPrompt found ${cbCalls.length} times`);
    const genArg = cbCalls[0].arguments[1];
    const cbFn = genArg?.type === "CallExpression" ? genArg.arguments[0] : null;
    if (cbFn?.type !== "FunctionExpression" || !cbFn.generator || cbFn.body?.type !== "BlockStatement" || cbFn.body.body.length < 1) {
      throw new Error("steerWithPrompt callback generator changed shape");
    }
    const firstStmt = cbFn.body.body[0];
    const isFinalizedGuard = firstStmt.type === "IfStatement" &&
      firstStmt.test.type === "LogicalExpression" && firstStmt.test.operator === "||" &&
      isMemberIdent(firstStmt.test.left, "context", "finalized") &&
      isMemberIdent(firstStmt.test.right, "context", "interrupted") &&
      firstStmt.consequent.type === "ReturnStatement" &&
      firstStmt.consequent.argument?.type === "Literal" && firstStmt.consequent.argument.value === false;
    if (!isFinalizedGuard) throw new Error("steerWithPrompt callback finalized/interrupted guard changed shape");
    if (countIdentifiers(ast, "pendingRuntimeRequests") < 1 || !hasTopLevelBinding(ast, "ProviderAdapterSteerDeclinedError")) {
      throw new Error("pendingRuntimeRequests or ProviderAdapterSteerDeclinedError missing in acpSteer bundle");
    }
    let hasEarlyDecline = false;
    let sawContextMutation = false;
    const pendingVarNames = new Set();
    for (const stmt of cbFn.body.body.slice(1)) {
      if (!sawContextMutation) {
        const mutatesContext = (() => {
          let mut = false;
          walkAst(stmt, (n) => {
            if ((n.type === "AssignmentExpression" && n.left.type === "MemberExpression" && n.left.object.type === "Identifier" && n.left.object.name === "context") ||
                (n.type === "UpdateExpression" && n.argument.type === "MemberExpression" && n.argument.object.type === "Identifier" && n.argument.object.name === "context")) {
              mut = true;
              return false;
            }
          });
          return mut;
        })();
        if (mutatesContext) {
          sawContextMutation = true;
        } else if (stmt.type === "VariableDeclaration" && stmt.declarations.length === 1 &&
            stmt.declarations[0].id?.type === "Identifier" && isYieldGetPending(stmt.declarations[0].init, getFn)) {
          pendingVarNames.add(stmt.declarations[0].id.name);
        } else if (stmt.type === "IfStatement" && !stmt.alternate &&
            isPositivePendingSizeCheck(stmt.test, pendingVarNames, getFn) &&
            returnsSteerDeclinedError(stmt.consequent)) {
          hasEarlyDecline = true;
          break;
        }
      }
    }
    if (!hasEarlyDecline) {
      if (countIdentifiers(cbFn.body, "pendingRuntimeRequests") > 0 || countIdentifiers(cbFn.body, "ProviderAdapterSteerDeclinedError") > 0) {
        throw new Error("steerWithPrompt has unexpected pendingRuntimeRequests or ProviderAdapterSteerDeclinedError reference");
      }
      edits.push({
        start: firstStmt.end,
        end: firstStmt.end,
        replacement: `\n\t\t\t\t\t\tif (${AG_STEER_MARK} (yield* ${getFn}(pendingRuntimeRequests)).size > 0) return yield* new ProviderAdapterSteerDeclinedError({ driver, providerThreadId: ${turnInputParam}.providerThread.id, providerTurnId: ${turnInputParam}.providerTurnId });`,
      });
    }

    // 1b. AcpAdapterV2.steerTurn error mapper: pass ProviderAdapterSteerDeclinedError through unchanged.
    const steerTurnCalls = findEffectFnCalls(ast, "AcpAdapterV2.steerTurn");
    if (steerTurnCalls.length !== 1) throw new Error(`AcpAdapterV2.steerTurn found ${steerTurnCalls.length} times`);
    const mapWrapper = steerTurnCalls[0].arguments[1];
    if (!mapWrapper) throw new Error("AcpAdapterV2.steerTurn error mapper missing");
    const conds = [];
    walkAst(mapWrapper, (n) => {
      if (n.type === "ConditionalExpression" &&
          n.consequent.type === "Identifier" &&
          n.alternate.type === "NewExpression" &&
          ((n.alternate.callee.type === "Identifier" && n.alternate.callee.name === "ProviderAdapterSteerRunError") ||
           (n.alternate.callee.type === "MemberExpression" && !n.alternate.callee.computed && n.alternate.callee.property.name === "ProviderAdapterSteerRunError"))) {
        conds.push(n);
      }
    });
    if (conds.length !== 1) throw new Error(`AcpAdapterV2.steerTurn mapError conditional found ${conds.length} times`);
    const cond = conds[0];
    const causeIdent = cond.consequent.name;
    const tags = extractTagOrList(cond.test, causeIdent);
    if (!tags) throw new Error("AcpAdapterV2.steerTurn mapError tag check changed shape");
    const hasUnsupported = tags.includes("ProviderAdapterSteerRunUnsupportedError");
    const hasDeclined = tags.includes("ProviderAdapterSteerDeclinedError");
    if (hasUnsupported && hasDeclined) {
      // already ready
    } else if (tags.length === 1 && hasUnsupported) {
      edits.push({
        start: cond.test.start,
        end: cond.test.end,
        replacement: `${causeIdent}._tag === "ProviderAdapterSteerRunUnsupportedError" || ${causeIdent}._tag === "ProviderAdapterSteerDeclinedError"`,
      });
    } else {
      throw new Error(`AcpAdapterV2.steerTurn mapError checks unexpected tags: ${tags.join(", ")}`);
    }
  }

  if (targets.includes("dispatchPolicy")) {
    const fns = topLevelDecls(ast).filter((n) => n.type === "FunctionDeclaration" && n.id?.name === "resolveMessageDispatchIntent");
    if (fns.length !== 1) throw new Error(`resolveMessageDispatchIntent declared ${fns.length} times`);
    const fnNode = fns[0];
    if (fnNode.params[0]?.type !== "Identifier") throw new Error("resolveMessageDispatchIntent projection parameter changed shape");
    const projParam = fnNode.params[0].name;
    const bodyStmts = fnNode.body.body;
    const steerIfIdx = bodyStmts.findIndex((s) =>
      s.type === "IfStatement" &&
      s.test.type === "BinaryExpression" && s.test.operator === "!==" &&
      s.test.left.type === "MemberExpression" && !s.test.left.computed &&
      s.test.left.object.type === "Identifier" && s.test.left.property.name === "type" &&
      s.test.right.type === "Literal" && s.test.right.value === "steer_active" &&
      s.consequent.type === "ReturnStatement" &&
      s.consequent.argument?.type === "Identifier" && s.consequent.argument.name === s.test.left.object.name
    );
    if (steerIfIdx < 0) throw new Error("resolveMessageDispatchIntent steer_active guard changed shape");
    const hasPendingQueue = bodyStmts.slice(steerIfIdx + 1).some((s) =>
      s.type === "IfStatement" && !s.alternate &&
      isPositivePendingRequestExpr(s.test, ast, projParam) &&
      isReturnsQueueAfterActive(s.consequent)
    );
    if (!hasPendingQueue) {
      if (countIdentifiers(fnNode.body, "waitsOnPendingRequest") > 0 || countIdentifiers(fnNode.body, "runtimeRequests") > 0) {
        throw new Error("resolveMessageDispatchIntent has unexpected pending-request check");
      }
      const anchor = bodyStmts[steerIfIdx];
      edits.push({
        start: anchor.end,
        end: anchor.end,
        replacement: `\n\tif (${AG_STEER_MARK} ${projParam}.runtimeRequests.some((r) => r.status === "pending" && r.responseCapability.type !== "message")) return { type: "queue_after_active" };`,
      });
    }
  }

  if (targets.includes("orchestratorSteer")) {
    // 3a. Mailbox / delegated-completion steering inside dispatchMessage
    const noticeBlocks = [];
    walkAst(ast, (n) => {
      if (n.type !== "BlockStatement") return;
      for (let i = 0; i < n.body.length; i++) {
        const stmt = n.body[i];
        if (stmt.type !== "VariableDeclaration") continue;
        const decl = stmt.declarations.find((d) =>
          d.id?.type === "Identifier" && d.id.name === "noticeKind" &&
          text.slice(d.init?.start ?? 0, d.init?.end ?? 0).replace(/\s+/g, "") === "command.notification?.source.kind"
        );
        if (decl) noticeBlocks.push({ block: n, index: i });
      }
    });
    if (noticeBlocks.length !== 1) throw new Error(`Orchestrator noticeKind block found ${noticeBlocks.length} times`);
    const { block: noticeBlock, index: noticeIdx } = noticeBlocks[0];
    const outerIf = noticeBlock.body.slice(noticeIdx + 1, noticeIdx + 4).find((s) => s.type === "IfStatement");
    if (!outerIf || outerIf.consequent.type !== "BlockStatement") throw new Error("Orchestrator notice steering if-block changed shape");
    const innerIfs = [];
    for (const s of outerIf.consequent.body) {
      if (s.type === "IfStatement") {
        let assignsSteerActive = false;
        walkAst(s.consequent, (n) => {
          if (n.type === "AssignmentExpression" && n.left.type === "Identifier" && n.left.name === "dispatchMode" &&
              n.right.type === "ObjectExpression" &&
              n.right.properties.some((p) => staticPropKey(p) === "type" && p.value?.type === "Literal" && p.value.value === "steer_active")) {
            assignsSteerActive = true;
          }
        });
        if (assignsSteerActive) innerIfs.push(s);
      }
    }
    if (innerIfs.length !== 1) throw new Error(`Orchestrator notice inner steer_active if found ${innerIfs.length} times`);
    const innerIf = innerIfs[0];
    const innerTerms = collectAndTerms(innerIf.test);
    const hasActiveChecks = countIdentifiers(innerIf.test, "active") > 0 &&
      countIdentifiers(innerIf.test, "activeTurn") > 0 &&
      countIdentifiers(innerIf.test, "providerSessionId") > 0;
    if (!hasActiveChecks || innerIf.test.type !== "LogicalExpression" || innerIf.test.operator !== "&&") {
      throw new Error("Orchestrator notice inner steer condition changed shape");
    }
    const hasPendingGuard = hasNegatedPendingGuard(outerIf.test, ast, "projection") || hasNegatedPendingGuard(innerIf.test, ast, "projection");
    const hasFollowUpGuard = collectAndTerms(outerIf.test).some(isFollowUpGuardTerm) || innerTerms.some(isFollowUpGuardTerm);
    if (!hasPendingGuard || !hasFollowUpGuard) {
      if (!hasPendingGuard &&
          (countIdentifiers(outerIf.test, "runtimeRequests") > 0 || countIdentifiers(outerIf.test, "waitsOnPendingRequest") > 0 ||
           countIdentifiers(innerIf.test, "runtimeRequests") > 0 || countIdentifiers(innerIf.test, "waitsOnPendingRequest") > 0)) {
        throw new Error("Orchestrator notice steering has unexpected pending-request guard");
      }
      if (!hasFollowUpGuard &&
          (countIdentifiers(outerIf.test, "steerFollowUpOfRunId") > 0 || countIdentifiers(innerIf.test, "steerFollowUpOfRunId") > 0)) {
        throw new Error("Orchestrator notice steering has unexpected steerFollowUpOfRunId guard");
      }
      const missing = [];
      if (!hasFollowUpGuard) missing.push("command.steerFollowUpOfRunId === void 0");
      if (!hasPendingGuard) missing.push('!projection.runtimeRequests.some((r) => r.status === "pending" && r.responseCapability.type !== "message")');
      edits.push({
        start: innerIf.test.start,
        end: innerIf.test.start,
        replacement: `${AG_STEER_MARK} ${missing.join(" && ")} && `,
      });
    }

    // 3b. dispatchQueuedMessagePromoteToSteer: guard goal-stop and early-return before steerWhenReadyRunId / cancel / dispatchSteerIntoRun.
    const promoteCalls = findEffectFnCalls(ast, "Orchestrator.dispatchQueuedMessagePromoteToSteer");
    if (promoteCalls.length !== 1) throw new Error(`Orchestrator.dispatchQueuedMessagePromoteToSteer found ${promoteCalls.length} times`);
    const promoteFn = promoteCalls[0].arguments[0];
    if (promoteFn?.type !== "FunctionExpression" || !promoteFn.generator || promoteFn.body?.type !== "BlockStatement") {
      throw new Error("dispatchQueuedMessagePromoteToSteer signature changed shape");
    }
    const promoteBody = promoteFn.body.body;
    const goalIfIdx = promoteBody.findIndex((s) =>
      s.type === "IfStatement" &&
      s.test.type === "LogicalExpression" && s.test.operator === "||" &&
      countIdentifiers(s.test.left, "goalCommand") > 0 &&
      countIdentifiers(s.test.right, "isSlashCommand") > 0
    );
    if (goalIfIdx < 0) throw new Error("dispatchQueuedMessagePromoteToSteer goal/slash branch changed shape");
    const goalIf = promoteBody[goalIfIdx];
    const stopsDecls = [];
    walkAst(goalIf.consequent, (n) => {
      if (n.type === "VariableDeclarator" && n.id?.type === "Identifier" && n.id.name === "stops") stopsDecls.push(n);
    });
    if (stopsDecls.length !== 1) throw new Error(`dispatchQueuedMessagePromoteToSteer goal stops declaration found ${stopsDecls.length} times`);
    const stopsDecl = stopsDecls[0];
    if (!hasNegatedPendingGuard(stopsDecl.init, ast, "projection")) {
      if (countIdentifiers(stopsDecl.init, "runtimeRequests") > 0 || countIdentifiers(stopsDecl.init, "waitsOnPendingRequest") > 0) {
        throw new Error("dispatchQueuedMessagePromoteToSteer goal stops has unexpected pending-request guard");
      }
      if (stopsDecl.init?.type !== "LogicalExpression" || stopsDecl.init.operator !== "&&" || countIdentifiers(stopsDecl.init, "goalCommandStopsActiveRun") !== 1) {
        throw new Error("dispatchQueuedMessagePromoteToSteer goal stops expression changed shape");
      }
      edits.push({
        start: stopsDecl.init.start,
        end: stopsDecl.init.start,
        replacement: `${AG_STEER_MARK} !projection.runtimeRequests.some((r) => r.status === "pending" && r.responseCapability.type !== "message") && `,
      });
    }
    const steerReadyIndices = [];
    for (let i = goalIfIdx + 1; i < promoteBody.length; i++) {
      if (promoteBody[i].type === "IfStatement" && countIdentifiers(promoteBody[i].consequent, "steerWhenReadyRunId") > 0) {
        steerReadyIndices.push(i);
      }
    }
    if (steerReadyIndices.length !== 1) throw new Error(`dispatchQueuedMessagePromoteToSteer steerWhenReadyRunId branch found ${steerReadyIndices.length} times`);
    const steerReadyIdx = steerReadyIndices[0];
    const hasDispatchSteerAfter = promoteBody.slice(steerReadyIdx + 1).some((s) => countIdentifiers(s, "dispatchSteerIntoRun") > 0);
    if (!hasDispatchSteerAfter) throw new Error("dispatchQueuedMessagePromoteToSteer missing dispatchSteerIntoRun after steerWhenReadyRunId branch");
    const between = promoteBody.slice(goalIfIdx + 1, steerReadyIdx);
    const hasPromotePendingGuard = between.some((s) =>
      s.type === "IfStatement" && !s.alternate &&
      isPositivePendingRequestExpr(s.test, ast, "projection") &&
      isUnconditionalReturnNoSteer(s.consequent)
    );
    if (!hasPromotePendingGuard) {
      if (between.some((s) => countIdentifiers(s, "runtimeRequests") > 0 || countIdentifiers(s, "waitsOnPendingRequest") > 0)) {
        throw new Error("dispatchQueuedMessagePromoteToSteer has unexpected pending-request guard");
      }
      const anchor = promoteBody[steerReadyIdx];
      edits.push({
        start: anchor.start,
        end: anchor.start,
        replacement: `if (${AG_STEER_MARK} projection.runtimeRequests.some((r) => r.status === "pending" && r.responseCapability.type !== "message")) return;\n\t\t`,
      });
    }
  }

  if (edits.length === 0) return { state: "already", text };
  const next = applyTextEdits(text, edits);
  acorn.parse(next, { ...PARSE, sourceType: "module" });
  return { state: "patched", text: next };
}

const AG_QUOTA_MARK = "/*t3-keeper-ag-quota-v1*/";
const AG_QUOTA_STATUS_ERROR_SRC = "/(CANCELLED|UNKNOWN|INVALID_ARGUMENT|DEADLINE_EXCEEDED|NOT_FOUND|ALREADY_EXISTS|PERMISSION_DENIED|RESOURCE_EXHAUSTED|FAILED_PRECONDITION|ABORTED|OUT_OF_RANGE|UNIMPLEMENTED|INTERNAL|UNAVAILABLE|DATA_LOSS|UNAUTHENTICATED) \\(code (\\d{3})\\): (\\P{Cc}+)/u";
const AG_QUOTA_EXHAUSTED_SRC = '/(?:"reason"\\s*:\\s*"QUOTA_EXHAUSTED"|\\breason:QUOTA_EXHAUSTED\\b)/';
const AG_QUOTA_RESET_TS_SRC = '/(?:"quotaResetTimeStamp"\\s*:\\s*"([^"\\s]+)"|\\bquotaResetTimeStamp:([^\\s\\],}]+))/';
const AG_QUOTA_DURATION_GROUP = "((?:\\d+(?:\\.\\d+)?(?:ns|us|\\u00b5s|\\u03bcs|ms|h|m|s))+)";
const AG_QUOTA_RESET_DELAY_SRC = `/(?:"quotaResetDelay"\\s*:\\s*"${AG_QUOTA_DURATION_GROUP}"|\\bquotaResetDelay:${AG_QUOTA_DURATION_GROUP}(?=[\\s\\],}]|$))/`;
const AG_QUOTA_RETRY_DELAY_SRC = `/(?:"retryDelay"\\s*:\\s*"${AG_QUOTA_DURATION_GROUP}"|\\bretryDelay:${AG_QUOTA_DURATION_GROUP}(?=[\\s\\],}]|$))/`;

function findUniqueTopVar(ast, name) {
  const hits = topLevelDecls(ast)
    .filter((n) => n.type === "VariableDeclaration")
    .flatMap((n) => n.declarations)
    .filter((d) => d.id?.type === "Identifier" && d.id.name === name);
  if (hits.length !== 1) throw new Error(`${name} declared ${hits.length} times`);
  return hits[0];
}

function compileQuotaRegex(decl, ast) {
  if (decl.init?.type === "Literal" && decl.init.regex) {
    return new RegExp(decl.init.regex.pattern, decl.init.regex.flags);
  }
  // Support upstream PR #40244's `delayPattern("quotaResetDelay")` / `delayPattern("retryDelay")` without eval.
  if (decl.init?.type === "CallExpression" &&
      decl.init.callee.type === "Identifier" && decl.init.callee.name === "delayPattern" &&
      decl.init.arguments.length === 1 &&
      decl.init.arguments[0].type === "Literal" && typeof decl.init.arguments[0].value === "string") {
    const field = decl.init.arguments[0].value;
    const durDecl = findUniqueTopVar(ast, "GO_DURATION");
    const patDecl = findUniqueTopVar(ast, "delayPattern");
    if (durDecl.init?.type !== "Literal" || typeof durDecl.init.value !== "string") return null;
    const goDur = durDecl.init.value;
    let tmpl = null;
    walkAst(patDecl.init, (n) => {
      if (n.type === "NewExpression" && n.callee.type === "Identifier" && n.callee.name === "RegExp" &&
          n.arguments.length === 1 && n.arguments[0].type === "TemplateLiteral") {
        tmpl = n.arguments[0];
      }
    });
    if (!tmpl) return null;
    let built = "";
    for (let i = 0; i < tmpl.quasis.length; i++) {
      built += tmpl.quasis[i].value.cooked ?? tmpl.quasis[i].value.raw;
      if (i < tmpl.expressions.length) {
        const expr = tmpl.expressions[i];
        if (expr.type === "Identifier" && expr.name === "GO_DURATION") built += goDur;
        else if (expr.type === "Identifier" && patDecl.init.params?.[0]?.type === "Identifier" && expr.name === patDecl.init.params[0].name) built += field;
        else return null;
      }
    }
    return new RegExp(built);
  }
  return null;
}

const pickGroup = (m) => m?.[1] ?? m?.[2];

function normalizeMicro(s) {
  return s.replaceAll("\\u00b5", "\u00b5").replaceAll("\\u03bc", "\u03bc");
}

function buildResetAtFrom({ textParam, nowParam, isSomeFn, makeFn, formatIsoFn, addFn }) {
  return [
    `function resetAtFrom(${textParam}, ${nowParam}) {`,
    `\t${AG_QUOTA_MARK}`,
    `\tconst pick = (m) => m?.[1] ?? m?.[2];`,
    `\tconst parseDelay = (re) => {`,
    `\t\tconst delay = pick(re.exec(${textParam}));`,
    `\t\tif (delay === void 0) return void 0;`,
    `\t\tlet delayMs = 0;`,
    `\t\tfor (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit] ?? 0);`,
    `\t\treturn delayMs > 0 ? Math.ceil(delayMs) : void 0;`,
    `\t};`,
    `\tconst timestamp = pick(RESET_TIMESTAMP.exec(${textParam}));`,
    `\tconst validTimestamp = timestamp !== void 0 && ${isSomeFn}(${makeFn}(timestamp));`,
    `\tif (validTimestamp && Date.parse(timestamp) > Date.parse(${formatIsoFn}(${nowParam}))) return timestamp;`,
    `\tconst delayMs = parseDelay(RESET_DELAY) ?? parseDelay(RETRY_DELAY);`,
    `\treturn delayMs !== void 0 ? ${formatIsoFn}(${addFn}(${nowParam}, { milliseconds: delayMs })) : validTimestamp ? timestamp : void 0;`,
    `}`,
  ].join("\n");
}

function calleeBaseName(callee) {
  const c = unwrapChain(callee);
  if (c?.type === "Identifier") return c.name.replace(/\$\d+$/, "");
  if (c?.type === "MemberExpression" && !c.computed && c.property.type === "Identifier") {
    return c.property.name.replace(/\$\d+$/, "");
  }
  return null;
}

function isComputedLitMember(node, objName, idx) {
  const expr = unwrapChain(node);
  return !!expr && expr.type === "MemberExpression" && expr.computed &&
    expr.object.type === "Identifier" && expr.object.name === objName &&
    expr.property.type === "Literal" && expr.property.value === idx;
}

function isDualCaptureHelper(fnNode) {
  if (!fnNode || fnNode.params?.length !== 1 || fnNode.params[0].type !== "Identifier") return false;
  const m = fnNode.params[0].name;
  const expr = extractSingleReturnExpr(fnNode);
  return !!expr && expr.type === "LogicalExpression" && (expr.operator === "??" || expr.operator === "||") &&
    isComputedLitMember(expr.left, m, 1) && isComputedLitMember(expr.right, m, 2);
}

function isGoDurationConstantsValid(ast) {
  let partDecl, unitDecl;
  try {
    partDecl = findUniqueTopVar(ast, "GO_DURATION_PART");
    unitDecl = findUniqueTopVar(ast, "GO_DURATION_UNIT_MS");
  } catch {
    return false;
  }
  if (partDecl.init?.type !== "Literal" || !partDecl.init.regex || !partDecl.init.regex.flags.includes("g")) return false;
  const partRe = new RegExp(partDecl.init.regex.pattern, partDecl.init.regex.flags);
  const parts = [...("1h2m3.5s".matchAll(partRe))].map((m) => [m[1], m[2]]);
  const subMs = [...("0.0001s".matchAll(partRe))].map((m) => [m[1], m[2]]);
  const micro1 = [...("5\u00b5s".matchAll(partRe))].map((m) => [m[1], m[2]]);
  const micro2 = [...("5\u03bcs".matchAll(partRe))].map((m) => [m[1], m[2]]);
  if (parts.length !== 3 || parts[0][0] !== "1" || parts[0][1] !== "h" ||
      parts[1][0] !== "2" || parts[1][1] !== "m" || parts[2][0] !== "3.5" || parts[2][1] !== "s" ||
      subMs.length !== 1 || subMs[0][0] !== "0.0001" || subMs[0][1] !== "s" ||
      micro1.length !== 1 || micro1[0][0] !== "5" || micro1[0][1] !== "\u00b5s" ||
      micro2.length !== 1 || micro2[0][0] !== "5" || micro2[0][1] !== "\u03bcs") {
    return false;
  }
  if (unitDecl.init?.type !== "ObjectExpression") return false;
  const units = new Map();
  for (const prop of unitDecl.init.properties) {
    const k = staticPropKey(prop);
    if (k !== null && prop.value?.type === "Literal" && typeof prop.value.value === "number") {
      units.set(k, prop.value.value);
    }
  }
  return units.get("ms") === 1 && units.get("s") === 1000 && units.get("m") === 60000 &&
    units.get("h") === 3600000 && units.get("us") === 0.001 && units.get("ns") === 1e-6 &&
    units.get("\u00b5s") === 0.001 && units.get("\u03bcs") === 0.001;
}

function isDurationProduct(expr, amount, unit) {
  if (!expr || expr.type !== "BinaryExpression" || expr.operator !== "*") return false;
  const isAmount = (n) =>
    (n?.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "Number" &&
     n.arguments.length === 1 && n.arguments[0].type === "Identifier" && n.arguments[0].name === amount) ||
    (n?.type === "UnaryExpression" && n.operator === "+" && n.argument?.type === "Identifier" && n.argument.name === amount);
  const isUnitLookup = (n) => {
    const raw = (n?.type === "LogicalExpression" && (n.operator === "??" || n.operator === "||") &&
      n.right?.type === "Literal" && n.right.value === 0) ? n.left : n;
    return raw?.type === "MemberExpression" && raw.computed &&
      raw.object.type === "Identifier" && raw.object.name === "GO_DURATION_UNIT_MS" &&
      raw.property.type === "Identifier" && raw.property.name === unit;
  };
  return (isAmount(expr.left) && isUnitLookup(expr.right)) || (isAmount(expr.right) && isUnitLookup(expr.left));
}

function isDurationLoopBody(stmts, delayIdent) {
  if (stmts.length !== 4) return false;
  const [guardStmt, initStmt, loopStmt, retStmt] = stmts;
  // 1. if (delay === void 0) return void 0;
  if (guardStmt.type !== "IfStatement" || guardStmt.alternate) return false;
  const isStrictUndefCheck = (t) => t.type === "BinaryExpression" && t.operator === "===" &&
    ((t.left.type === "Identifier" && t.left.name === delayIdent && isUndefinedNode(t.right)) ||
     (t.right.type === "Identifier" && t.right.name === delayIdent && isUndefinedNode(t.left)));
  const isLooseNullishCheck = (t) => t.type === "BinaryExpression" && t.operator === "==" &&
    ((t.left.type === "Identifier" && t.left.name === delayIdent && isVoidZeroOrNull(t.right)) ||
     (t.right.type === "Identifier" && t.right.name === delayIdent && isVoidZeroOrNull(t.left)));
  const missingDelay = isStrictUndefCheck(guardStmt.test) || isLooseNullishCheck(guardStmt.test) ||
    (guardStmt.test.type === "UnaryExpression" && guardStmt.test.operator === "!" &&
     guardStmt.test.argument.type === "Identifier" && guardStmt.test.argument.name === delayIdent);
  let guardRet = guardStmt.consequent;
  if (guardRet.type === "BlockStatement" && guardRet.body.length === 1) guardRet = guardRet.body[0];
  if (!missingDelay || guardRet.type !== "ReturnStatement" || (guardRet.argument !== null && !isUndefinedNode(guardRet.argument))) {
    return false;
  }
  // 2. let delayMs = 0;
  if (initStmt.type !== "VariableDeclaration" || (initStmt.kind !== "let" && initStmt.kind !== "var") || initStmt.declarations.length !== 1) return false;
  const initDecl = initStmt.declarations[0];
  if (initDecl.id?.type !== "Identifier" || initDecl.init?.type !== "Literal" || initDecl.init.value !== 0) return false;
  const acc = initDecl.id.name;
  // 3. for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit] ?? 0);
  if (loopStmt.type !== "ForOfStatement" || loopStmt.left.type !== "VariableDeclaration" || loopStmt.left.declarations.length !== 1) {
    return false;
  }
  const pat = loopStmt.left.declarations[0].id;
  if (pat?.type !== "ArrayPattern" || pat.elements.length !== 3 ||
      pat.elements[1]?.type !== "Identifier" || pat.elements[2]?.type !== "Identifier") {
    return false;
  }
  const amount = pat.elements[1].name;
  const unit = pat.elements[2].name;
  if (loopStmt.right.type !== "CallExpression" ||
      !isMemberIdent(loopStmt.right.callee, delayIdent, "matchAll") ||
      loopStmt.right.arguments.length !== 1 ||
      loopStmt.right.arguments[0].type !== "Identifier" ||
      loopStmt.right.arguments[0].name !== "GO_DURATION_PART") {
    return false;
  }
  let loopBody = loopStmt.body;
  if (loopBody.type === "BlockStatement") {
    if (loopBody.body.length !== 1) return false;
    loopBody = loopBody.body[0];
  }
  if (loopBody.type !== "ExpressionStatement" || loopBody.expression.type !== "AssignmentExpression") return false;
  const assign = loopBody.expression;
  if (assign.left.type !== "Identifier" || assign.left.name !== acc) return false;
  const validAccum = (assign.operator === "+=" && isDurationProduct(assign.right, amount, unit)) ||
    (assign.operator === "=" && assign.right.type === "BinaryExpression" && assign.right.operator === "+" &&
     ((assign.right.left.type === "Identifier" && assign.right.left.name === acc && isDurationProduct(assign.right.right, amount, unit)) ||
      (assign.right.right.type === "Identifier" && assign.right.right.name === acc && isDurationProduct(assign.right.left, amount, unit))));
  if (!validAccum) return false;
  // 4. return delayMs > 0 ? Math.ceil(delayMs) : void 0;
  if (retStmt.type !== "ReturnStatement" || retStmt.argument?.type !== "ConditionalExpression") return false;
  const cond = retStmt.argument;
  const positiveTest = cond.test.type === "BinaryExpression" &&
    ((cond.test.operator === ">" && cond.test.left.type === "Identifier" && cond.test.left.name === acc && cond.test.right.type === "Literal" && cond.test.right.value === 0) ||
     (cond.test.operator === "<" && cond.test.right.type === "Identifier" && cond.test.right.name === acc && cond.test.left.type === "Literal" && cond.test.left.value === 0));
  const ceilAcc = cond.consequent.type === "CallExpression" &&
    isMemberIdent(cond.consequent.callee, "Math", "ceil") &&
    cond.consequent.arguments.length === 1 &&
    cond.consequent.arguments[0].type === "Identifier" && cond.consequent.arguments[0].name === acc;
  return positiveTest && ceilAcc && isUndefinedNode(cond.alternate);
}

function isRegexExecCall(node, reName, textParam) {
  return node?.type === "CallExpression" &&
    isMemberIdent(node.callee, reName, "exec") &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Identifier" && node.arguments[0].name === textParam;
}

function isMatchedRegexCall(node, matchFnName, reName, textParam) {
  return node?.type === "CallExpression" &&
    node.callee.type === "Identifier" && node.callee.name === matchFnName &&
    node.arguments.length === 1 && isRegexExecCall(node.arguments[0], reName, textParam);
}

function isValidUpstreamResetAtFrom(fnNode, ast, textParam, nowParam) {
  if (!isGoDurationConstantsValid(ast)) return false;
  const body = fnNode.body.body;
  let idx = 0;

  // Optional local capture helper (`const pick = (m) => m?.[1] ?? m?.[2]`) or verified top-level `matchedValue`.
  let matchFnName = null;
  if (body[idx]?.type === "VariableDeclaration" && body[idx].declarations.length === 1 &&
      body[idx].declarations[0].id?.type === "Identifier" && isDualCaptureHelper(body[idx].declarations[0].init)) {
    matchFnName = body[idx].declarations[0].id.name;
    idx += 1;
  } else {
    const topMatch = findTopLevelFnLike(ast, "matchedValue");
    if (isDualCaptureHelper(topMatch)) matchFnName = "matchedValue";
  }
  if (!matchFnName) return false;

  // Optional local `parseDelay(re)` helper OR verified top-level `parsePositiveDelayMs(delay)`.
  let delayParserKind = null;
  let delayParserName = null;
  if (body[idx]?.type === "VariableDeclaration" && body[idx].declarations.length === 1 &&
      body[idx].declarations[0].id?.type === "Identifier" &&
      (body[idx].declarations[0].init?.type === "ArrowFunctionExpression" || body[idx].declarations[0].init?.type === "FunctionExpression")) {
    const fn = body[idx].declarations[0].init;
    if (fn.params.length === 1 && fn.params[0].type === "Identifier" && fn.body.type === "BlockStatement" && fn.body.body.length === 5) {
      const reParam = fn.params[0].name;
      const first = fn.body.body[0];
      if (first.type === "VariableDeclaration" && first.declarations.length === 1 &&
          first.declarations[0].id?.type === "Identifier" &&
          isMatchedRegexCall(first.declarations[0].init, matchFnName, reParam, textParam) &&
          isDurationLoopBody(fn.body.body.slice(1), first.declarations[0].id.name)) {
        delayParserKind = "localRe";
        delayParserName = body[idx].declarations[0].id.name;
        idx += 1;
      }
    }
  }
  if (!delayParserKind) {
    const topParse = findTopLevelFnLike(ast, "parsePositiveDelayMs");
    if (topParse?.params?.length === 1 && topParse.params[0].type === "Identifier" &&
        topParse.body?.type === "BlockStatement" &&
        isDurationLoopBody(topParse.body.body, topParse.params[0].name)) {
      delayParserKind = "topDelay";
      delayParserName = "parsePositiveDelayMs";
    }
  }
  if (!delayParserKind) return false;

  // Remaining statements in resetAtFrom must be exactly the 5-step flow:
  // 1) timestamp = matchFn(RESET_TIMESTAMP.exec(text))
  // 2) parsedTimestamp / validTimestamp
  // 3) if (valid && future) return timestamp
  // 4) delayMs = parse(RESET_DELAY) ?? parse(RETRY_DELAY)
  // 5) return delayMs !== void 0 ? formatIso(add(now, { milliseconds: delayMs })) : ...
  const rest = body.slice(idx);
  if (rest.length !== 5) return false;
  const [tsStmt, validStmt, futureIf, delayStmt, finalRet] = rest;

  // Step 1: timestamp
  if (tsStmt.type !== "VariableDeclaration" || tsStmt.declarations.length !== 1) return false;
  const tsDecl = tsStmt.declarations[0];
  if (tsDecl.id?.type !== "Identifier" || !isMatchedRegexCall(tsDecl.init, matchFnName, "RESET_TIMESTAMP", textParam)) return false;
  const tsVar = tsDecl.id.name;

  // Step 2: parsedTimestamp (Option) OR validTimestamp (boolean)
  if (validStmt.type !== "VariableDeclaration" || validStmt.declarations.length !== 1) return false;
  const validDecl = validStmt.declarations[0];
  if (validDecl.id?.type !== "Identifier") return false;
  const validVar = validDecl.id.name;
  const isMakeTs = (n) => n?.type === "CallExpression" && calleeBaseName(n.callee) === "make" &&
    n.arguments.length === 1 && n.arguments[0].type === "Identifier" && n.arguments[0].name === tsVar;
  const isNoneCall = (n) => n?.type === "CallExpression" && calleeBaseName(n.callee) === "none" && n.arguments.length === 0;
  const isIsSomeCall = (n, argPred) => n?.type === "CallExpression" && calleeBaseName(n.callee) === "isSome" &&
    n.arguments.length === 1 && argPred(n.arguments[0]);
  const isTsEqUndef = (n, op) => {
    if (n?.type !== "BinaryExpression" || n.operator !== op) return false;
    const matchVal = (op === "===" || op === "!==") ? isUndefinedNode : isVoidZeroOrNull;
    return (n.left.type === "Identifier" && n.left.name === tsVar && matchVal(n.right)) ||
      (n.right.type === "Identifier" && n.right.name === tsVar && matchVal(n.left));
  };

  let tsKind = null;
  if (validDecl.init?.type === "ConditionalExpression" &&
      ((isTsEqUndef(validDecl.init.test, "===") && isNoneCall(validDecl.init.consequent) && isMakeTs(validDecl.init.alternate)) ||
       (isTsEqUndef(validDecl.init.test, "!==") && isMakeTs(validDecl.init.consequent) && isNoneCall(validDecl.init.alternate)))) {
    tsKind = "option";
  } else if (validDecl.init?.type === "LogicalExpression" && validDecl.init.operator === "&&" &&
      isTsEqUndef(validDecl.init.left, "!==") && isIsSomeCall(validDecl.init.right, isMakeTs)) {
    tsKind = "bool";
  }
  if (!tsKind) return false;

  const isTsValidExpr = (n) => tsKind === "option"
    ? isIsSomeCall(n, (a) => a?.type === "Identifier" && a.name === validVar)
    : (n?.type === "Identifier" && n.name === validVar);

  // Step 3: future-only early return
  if (futureIf.type !== "IfStatement" || futureIf.alternate) return false;
  let futureRet = futureIf.consequent;
  if (futureRet.type === "BlockStatement" && futureRet.body.length === 1) futureRet = futureRet.body[0];
  if (futureRet.type !== "ReturnStatement" || futureRet.argument?.type !== "Identifier" || futureRet.argument.name !== tsVar) {
    return false;
  }
  const futureTerms = collectAndTerms(futureIf.test);
  if (futureTerms.length !== 2) return false;
  const isFutureTerm = (n) => {
    if (tsKind === "option" && n?.type === "CallExpression" && calleeBaseName(n.callee) === "isGreaterThan" &&
        n.arguments.length === 2 &&
        isMemberIdent(n.arguments[0], validVar, "value") &&
        n.arguments[1].type === "Identifier" && n.arguments[1].name === nowParam) {
      return true;
    }
    if (n?.type === "BinaryExpression" && (n.operator === ">" || n.operator === "<")) {
      const lhs = n.operator === ">" ? n.left : n.right;
      const rhs = n.operator === ">" ? n.right : n.left;
      const isDateParseTs = lhs?.type === "CallExpression" && isMemberIdent(lhs.callee, "Date", "parse") &&
        lhs.arguments.length === 1 && lhs.arguments[0].type === "Identifier" && lhs.arguments[0].name === tsVar;
      const isDateParseNow = rhs?.type === "CallExpression" && isMemberIdent(rhs.callee, "Date", "parse") &&
        rhs.arguments.length === 1 && rhs.arguments[0].type === "CallExpression" &&
        calleeBaseName(rhs.arguments[0].callee) === "formatIso" &&
        rhs.arguments[0].arguments.length === 1 &&
        rhs.arguments[0].arguments[0].type === "Identifier" && rhs.arguments[0].arguments[0].name === nowParam;
      return isDateParseTs && isDateParseNow;
    }
    return false;
  };
  const validFutureCheck = (isTsValidExpr(futureTerms[0]) && isFutureTerm(futureTerms[1])) ||
    (isTsValidExpr(futureTerms[1]) && isFutureTerm(futureTerms[0]));
  if (!validFutureCheck) return false;

  // Step 4: delayMs = parse(RESET_DELAY) ?? parse(RETRY_DELAY) (strictly direct CallExpressions; rejects discarded sequences)
  if (delayStmt.type !== "VariableDeclaration" || delayStmt.declarations.length !== 1) return false;
  const delayDecl = delayStmt.declarations[0];
  if (delayDecl.id?.type !== "Identifier" || delayDecl.init?.type !== "LogicalExpression" || delayDecl.init.operator !== "??") {
    return false;
  }
  const delayVar = delayDecl.id.name;
  const isDelayCall = (n, reName) => {
    if (n?.type !== "CallExpression" || n.callee.type !== "Identifier" || n.callee.name !== delayParserName || n.arguments.length !== 1) {
      return false;
    }
    return delayParserKind === "localRe"
      ? (n.arguments[0].type === "Identifier" && n.arguments[0].name === reName)
      : isMatchedRegexCall(n.arguments[0], matchFnName, reName, textParam);
  };
  if (!isDelayCall(delayDecl.init.left, "RESET_DELAY") || !isDelayCall(delayDecl.init.right, "RETRY_DELAY")) {
    return false;
  }

  // Step 5: return delayMs !== void 0 ? formatIso(add(now, { milliseconds: delayMs })) : ...
  if (finalRet.type !== "ReturnStatement" || finalRet.argument?.type !== "ConditionalExpression") return false;
  const retCond = finalRet.argument;
  const isDelayDef = (n, op) => {
    if (n?.type !== "BinaryExpression" || n.operator !== op) return false;
    const matchVal = (op === "===" || op === "!==") ? isUndefinedNode : isVoidZeroOrNull;
    return (n.left.type === "Identifier" && n.left.name === delayVar && matchVal(n.right)) ||
      (n.right.type === "Identifier" && n.right.name === delayVar && matchVal(n.left));
  };
  let delayBranch, fallbackBranch;
  if (isDelayDef(retCond.test, "!==") || isDelayDef(retCond.test, "!=")) {
    delayBranch = retCond.consequent;
    fallbackBranch = retCond.alternate;
  } else if (isDelayDef(retCond.test, "===") || isDelayDef(retCond.test, "==")) {
    delayBranch = retCond.alternate;
    fallbackBranch = retCond.consequent;
  } else {
    return false;
  }
  const isAddDelayIso = delayBranch?.type === "CallExpression" && calleeBaseName(delayBranch.callee) === "formatIso" &&
    delayBranch.arguments.length === 1 &&
    delayBranch.arguments[0].type === "CallExpression" && calleeBaseName(delayBranch.arguments[0].callee) === "add" &&
    delayBranch.arguments[0].arguments.length === 2 &&
    delayBranch.arguments[0].arguments[0].type === "Identifier" && delayBranch.arguments[0].arguments[0].name === nowParam &&
    delayBranch.arguments[0].arguments[1].type === "ObjectExpression" &&
    delayBranch.arguments[0].arguments[1].properties.length === 1 &&
    staticPropKey(delayBranch.arguments[0].arguments[1].properties[0]) === "milliseconds" &&
    delayBranch.arguments[0].arguments[1].properties[0].value?.type === "Identifier" &&
    delayBranch.arguments[0].arguments[1].properties[0].value.name === delayVar;
  if (!isAddDelayIso) return false;
  const validFallback = isVoidZeroOrNull(fallbackBranch) ||
    (fallbackBranch?.type === "ConditionalExpression" &&
     isTsValidExpr(fallbackBranch.test) &&
     fallbackBranch.consequent?.type === "Identifier" && fallbackBranch.consequent.name === tsVar &&
     isVoidZeroOrNull(fallbackBranch.alternate));
  return validFallback;
}

function classifyResetAtFrom(fnNode, ast, text) {
  if (fnNode.params.length !== 2 || fnNode.params[0].type !== "Identifier" || fnNode.params[1].type !== "Identifier") {
    throw new Error("resetAtFrom parameter list changed shape");
  }
  const textParam = fnNode.params[0].name;
  const nowParam = fnNode.params[1].name;
  const src = text.slice(fnNode.start, fnNode.end);

  // Extract isSome(make(timestamp)) and formatIso(add(now, { milliseconds: ... })) bindings from AST.
  const isSomeHits = [];
  const formatAddHits = [];
  walkAst(fnNode.body, (n) => {
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.arguments.length === 1 &&
        n.arguments[0].type === "CallExpression" && n.arguments[0].callee.type === "Identifier" &&
        n.arguments[0].arguments.length === 1 && n.arguments[0].arguments[0].type === "Identifier" &&
        n.arguments[0].arguments[0].name === "timestamp") {
      isSomeHits.push({ isSomeFn: n.callee.name, makeFn: n.arguments[0].callee.name });
    }
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.arguments.length === 1 &&
        n.arguments[0].type === "CallExpression" && n.arguments[0].callee.type === "Identifier" &&
        n.arguments[0].arguments.length === 2 &&
        n.arguments[0].arguments[0].type === "Identifier" && n.arguments[0].arguments[0].name === nowParam &&
        n.arguments[0].arguments[1].type === "ObjectExpression" &&
        n.arguments[0].arguments[1].properties.some((p) => staticPropKey(p) === "milliseconds")) {
      formatAddHits.push({ formatIsoFn: n.callee.name, addFn: n.arguments[0].callee.name });
    }
  });

  // 1. Our own keeper helper (exact match -> already; older keeper version -> upgrade in place).
  if (src.includes("/*t3-keeper-ag-quota-")) {
    if (isSomeHits.length !== 1 || formatAddHits.length !== 1) {
      throw new Error("resetAtFrom keeper helper is malformed; run --restore first");
    }
    const want = buildResetAtFrom({ textParam, nowParam, ...isSomeHits[0], ...formatAddHits[0] });
    if (src === want) return { state: "ready" };
    return { state: "old", replacement: want };
  }

  // 2. Known pre-fix shape: reads only ?.[1], returns valid timestamp unconditionally without checking > now.
  const body = fnNode.body.body;
  const readsOnlyGroup1 = (() => {
    let g1 = 0, g2 = 0;
    walkAst(fnNode.body, (n) => {
      if (n.type === "MemberExpression" && n.computed && n.property.type === "Literal") {
        if (n.property.value === 1) g1 += 1;
        if (n.property.value === 2) g2 += 1;
      }
    });
    return g1 === 3 && g2 === 0;
  })();
  const hasEarlyUnconditionalTsReturn = body.some((s) =>
    s.type === "IfStatement" &&
    s.consequent.type === "ReturnStatement" &&
    s.consequent.argument?.type === "Identifier" && s.consequent.argument.name === "timestamp" &&
    !text.slice(s.test.start, s.test.end).includes("Date.parse") &&
    !text.slice(s.test.start, s.test.end).includes("isGreaterThan")
  );
  if (readsOnlyGroup1 && hasEarlyUnconditionalTsReturn && isSomeHits.length === 1 && formatAddHits.length === 1) {
    return { state: "old", replacement: buildResetAtFrom({ textParam, nowParam, ...isSomeHits[0], ...formatAddHits[0] }) };
  }

  // 3. Upstream fixed shape (e.g. PR #40244): structurally verify dual-capture helper,
  //    real duration conversion loop with Math.ceil(delayMs), future-only timestamp guard,
  //    direct RESET_DELAY ?? RETRY_DELAY fallback, and add(now, { milliseconds: delayMs }).
  if (isValidUpstreamResetAtFrom(fnNode, ast, textParam, nowParam)) {
    return { state: "ready" };
  }
  throw new Error("resetAtFrom has unexpected shape");
}

/**
 * antigravityQuotaOutcome: updates AntigravityTurnOutcome's 5 regexes and resetAtFrom helper
 * to parse Antigravity 1.5 JSON quota payloads and future/delay reset times (upstream #40244).
 * Classifies all 6 components independently and yields ("already") only when all 6 satisfy contract.
 */
function unitAntigravityQuotaOutcome(text) {
  if (!text.includes("AntigravityTurnOutcome.watch")) {
    throw new Error("AntigravityTurnOutcome.watch marker missing");
  }
  const ast = acorn.parse(text, { ...PARSE, sourceType: "module" });
  const statusDecl = findUniqueTopVar(ast, "STATUS_ERROR");
  const quotaDecl = findUniqueTopVar(ast, "QUOTA_EXHAUSTED");
  const tsDecl = findUniqueTopVar(ast, "RESET_TIMESTAMP");
  const resetDelayDecl = findUniqueTopVar(ast, "RESET_DELAY");
  const retryDelayDecl = findUniqueTopVar(ast, "RETRY_DELAY");
  const resetFns = topLevelDecls(ast).filter((n) => n.type === "FunctionDeclaration" && n.id?.name === "resetAtFrom");
  if (resetFns.length !== 1) throw new Error(`resetAtFrom declared ${resetFns.length} times`);
  const resetFn = resetFns[0];

  const edits = [];

  // 1. STATUS_ERROR
  const statusRe = compileQuotaRegex(statusDecl, ast);
  if (!statusRe) throw new Error("STATUS_ERROR is not a recognized regex");
  const statusReady = (() => {
    const m1 = statusRe.exec("ARESOURCE_EXHAUSTED (code 429): Individual quota reached.");
    const m2 = statusRe.exec("ZINTERNAL (code 500): Internal error");
    const m3 = statusRe.exec("FOOBAR (code 429): fake");
    return m1?.[1] === "RESOURCE_EXHAUSTED" && m1?.[2] === "429" && m1?.[3] === "Individual quota reached." &&
      m2?.[1] === "INTERNAL" && m2?.[2] === "500" && m3 === null;
  })();
  if (!statusReady) {
    if (statusDecl.init?.type === "Literal" && statusDecl.init.regex?.pattern === "(?<![A-Z_])([A-Z_]+) \\(code (\\d{3})\\): (\\P{Cc}+)" && statusDecl.init.regex.flags === "u") {
      edits.push({ start: statusDecl.init.start, end: statusDecl.init.end, replacement: AG_QUOTA_STATUS_ERROR_SRC });
    } else {
      throw new Error("STATUS_ERROR has unexpected shape");
    }
  }

  // 2. QUOTA_EXHAUSTED
  const quotaRe = compileQuotaRegex(quotaDecl, ast);
  if (!quotaRe) throw new Error("QUOTA_EXHAUSTED is not a recognized regex");
  const quotaReady = quotaRe.test('{"reason": "QUOTA_EXHAUSTED"}') && quotaRe.test("[reason:QUOTA_EXHAUSTED]") && !quotaRe.test('{"reason": "OTHER"}');
  if (!quotaReady) {
    if (quotaDecl.init?.type === "Literal" && quotaDecl.init.regex?.pattern === "\\breason:QUOTA_EXHAUSTED\\b" && quotaDecl.init.regex.flags === "") {
      edits.push({ start: quotaDecl.init.start, end: quotaDecl.init.end, replacement: AG_QUOTA_EXHAUSTED_SRC });
    } else {
      throw new Error("QUOTA_EXHAUSTED has unexpected shape");
    }
  }

  // 3. RESET_TIMESTAMP
  const tsRe = compileQuotaRegex(tsDecl, ast);
  if (!tsRe) throw new Error("RESET_TIMESTAMP is not a recognized regex");
  const tsReady = pickGroup(tsRe.exec('{"quotaResetTimeStamp": "2026-11-21T06:28:46Z", "x": 1}')) === "2026-11-21T06:28:46Z" &&
    pickGroup(tsRe.exec("[quotaResetTimeStamp:2026-11-21T06:28:46Z]")) === "2026-11-21T06:28:46Z" &&
    tsRe.exec('{"other": "2026-11-21T06:28:46Z"}') === null;
  if (!tsReady) {
    if (tsDecl.init?.type === "Literal" && tsDecl.init.regex?.pattern === "\\bquotaResetTimeStamp:([^\\s\\]]+)" && tsDecl.init.regex.flags === "") {
      edits.push({ start: tsDecl.init.start, end: tsDecl.init.end, replacement: AG_QUOTA_RESET_TS_SRC });
    } else {
      throw new Error("RESET_TIMESTAMP has unexpected shape");
    }
  }

  // 4. RESET_DELAY
  const resetDelayRe = compileQuotaRegex(resetDelayDecl, ast);
  if (!resetDelayRe) throw new Error("RESET_DELAY is not a recognized regex");
  const resetDelayReady = pickGroup(resetDelayRe.exec('{"quotaResetDelay": "2h24m51s"}')) === "2h24m51s" &&
    pickGroup(resetDelayRe.exec('{"quotaResetDelay": "0.0001s"}')) === "0.0001s" &&
    pickGroup(resetDelayRe.exec("[quotaResetDelay:2h24m51s]")) === "2h24m51s" &&
    resetDelayRe.exec('{"quotaResetDelay": "bad"}') === null;
  if (!resetDelayReady) {
    const oldPat = normalizeMicro("\\bquotaResetDelay:((?:\\d+(?:\\.\\d+)?(?:ns|us|\\u00b5s|\\u03bcs|ms|h|m|s))+)(?=[\\s\\]])");
    if (resetDelayDecl.init?.type === "Literal" && normalizeMicro(resetDelayDecl.init.regex?.pattern ?? "") === oldPat && resetDelayDecl.init.regex.flags === "") {
      edits.push({ start: resetDelayDecl.init.start, end: resetDelayDecl.init.end, replacement: AG_QUOTA_RESET_DELAY_SRC });
    } else {
      throw new Error("RESET_DELAY has unexpected shape");
    }
  }

  // 5. RETRY_DELAY
  const retryDelayRe = compileQuotaRegex(retryDelayDecl, ast);
  if (!retryDelayRe) throw new Error("RETRY_DELAY is not a recognized regex");
  const retryDelayReady = pickGroup(retryDelayRe.exec('{"retryDelay": "0.0001s"}')) === "0.0001s" &&
    pickGroup(retryDelayRe.exec("[retryDelay:15s]")) === "15s" &&
    retryDelayRe.exec('{"retryDelay": "bad"}') === null;
  if (!retryDelayReady) {
    const oldPat = normalizeMicro("\\bretryDelay:((?:\\d+(?:\\.\\d+)?(?:ns|us|\\u00b5s|\\u03bcs|ms|h|m|s))+)(?=[\\s\\]])");
    if (retryDelayDecl.init?.type === "Literal" && normalizeMicro(retryDelayDecl.init.regex?.pattern ?? "") === oldPat && retryDelayDecl.init.regex.flags === "") {
      edits.push({ start: retryDelayDecl.init.start, end: retryDelayDecl.init.end, replacement: AG_QUOTA_RETRY_DELAY_SRC });
    } else {
      throw new Error("RETRY_DELAY has unexpected shape");
    }
  }

  // 6. resetAtFrom
  const resetState = classifyResetAtFrom(resetFn, ast, text);
  if (resetState.state === "old") {
    edits.push({ start: resetFn.start, end: resetFn.end, replacement: resetState.replacement });
  }

  if (edits.length === 0) return { state: "already", text };
  const next = applyTextEdits(text, edits);
  acorn.parse(next, { ...PARSE, sourceType: "module" });
  return { state: "patched", text: next };
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
  { name: "rule", file: "ruleFile", run: unitRule },
  { name: "fit", file: "binCli", run: unitFit },
  { name: "titleGuide", file: "titleGuideFile", run: unitTitleGuide },
  { name: "geminiQuota", file: "geminiProbe", run: unitGeminiQuota },
  { name: "antigravityQuestions", file: "antigravityFlavor", run: unitAntigravityQuestions },
  { name: "antigravitySteer", file: "acpSteer", run: unitAntigravitySteer },
  { name: "antigravityQuotaOutcome", file: "antigravityOutcome", run: unitAntigravityQuotaOutcome },
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
  const cache = new Map();
  const astCache = new Map();
  const readCached = (rel) => {
    if (!cache.has(rel)) cache.set(rel, readEntry(fd, layout, rel).toString("utf8"));
    return cache.get(rel);
  };
  const astFor = (rel) => () => {
    if (!astCache.has(rel)) astCache.set(rel, parseTopModule(readCached(rel)));
    return astCache.get(rel);
  };
  // Fail closed on 0 or >1 matches so an ambiguous duplicate marker never silently picks one file.
  // Skip unpacked or non-file archive entries so an unrelated unpacked .mjs cannot abort discovery.
  const pickUnique = (dir, nameRe, matches) => {
    const hits = [];
    for (const name of listDir(layout.header, dir).filter((n) => nameRe.test(n))) {
      const rel = `${dir}/${name}`;
      const entry = entryAt(layout.header, rel);
      if (!entry || entry.unpacked || typeof entry.size !== "number") continue;
      if (matches(readCached(rel), astFor(rel))) hits.push(rel);
    }
    return hits.length === 1 ? hits[0] : null;
  };
  return {
    index: entryAt(layout.header, `${CLIENT}/index.html`) ? `${CLIENT}/index.html` : null,
    mainJs: pickUnique(ASSETS, /^main-[\w-]+\.js$/, (t) => t.includes("chat_thread_sidebar_width")),
    binCli: pickUnique(SERVER, /\.mjs$/, (t, ast) => hasTopLevelFunction(t, "subagentThreadTitle", ast)),
    sanitizeTitles: pickUnique(SERVER, /\.mjs$/, (t, ast) => hasTopLevelFunction(t, "sanitizeThreadTitle", ast)),
    ruleFile: pickUnique(SERVER, /\.mjs$/, (t) => t.includes(RULE_FROM) || t.includes(RULE_TO)),
    titleGuideFile: pickUnique(SERVER, /\.mjs$/, (t, ast) => hasTopLevelArrayVar(t, "T3_CODE_ORCHESTRATION_SECTIONS", ast)),
    delegatedTitles: pickUnique(SERVER, /\.mjs$/, (t, ast) => hasTopLevelFunction(t, "threadTitle", ast)),
    geminiProbe: pickUnique(SERVER, /\.mjs$/, (t) => t.includes(ANTIGRAVITY_UA_MARK)),
    antigravityFlavor: pickUnique(SERVER, /\.mjs$/, (t, ast) => hasTopLevelFunction(t, "makeAntigravityAcpAdapterFlavor", ast)),
    acpSteer: pickUnique(SERVER, /\.mjs$/, (t) => t.includes("AcpAdapterV2.steerWithPrompt") && t.includes("AcpAdapterV2.steerTurn")),
    dispatchPolicy: pickUnique(SERVER, /\.mjs$/, (t, ast) => hasTopLevelFunction(t, "resolveMessageDispatchIntent", ast)),
    orchestratorSteer: pickUnique(SERVER, /\.mjs$/, (t) => t.includes("Orchestrator.dispatchQueuedMessagePromoteToSteer") && t.includes("command.notification?.source.kind")),
    antigravityOutcome: pickUnique(SERVER, /\.mjs$/, (t, ast) => hasTopLevelFunction(t, "resetAtFrom", ast) && t.includes("AntigravityTurnOutcome.watch")),
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
  const serverSlots = [
    "binCli", "delegatedTitles", "sanitizeTitles", "ruleFile", "titleGuideFile",
    "geminiProbe", "antigravityFlavor", "acpSteer", "dispatchPolicy", "orchestratorSteer", "antigravityOutcome",
  ];
  const isServerSlot = (file) => serverSlots.includes(file);
  const resolveSlot = (fileKey) => {
    const rel = targets[fileKey];
    if (!rel) return null;
    if (isServerSlot(fileKey)) {
      for (const slot of serverSlots) {
        if (targets[slot] === rel) return slot;
      }
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
  const multiFileUnits = new Set(["fit", "antigravitySteer"]);
  const permanentlyFailed = new Map();
  const markFailed = (name, error) => {
    const msg = typeof error === "string" ? error : error.message;
    results[name] = { state: "failed", error: msg };
    if (multiFileUnits.has(name) && !permanentlyFailed.has(name)) {
      permanentlyFailed.set(name, msg);
    }
  };
  for (const unit of UNITS) {
    if (unit.name === "fit") {
      try {
        const wrapperTargets = [
          [FIT_WRAPPERS[0], resolveSlot("sanitizeTitles"), "sanitizeThreadTitle bundle not found in this build"],
          [FIT_WRAPPERS[1], resolveSlot("binCli"), "binCli not found in this build"],
          [FIT_WRAPPERS[2], resolveSlot("delegatedTitles"), "delegated threadTitle bundle not found in this build"],
        ];
        const grouped = new Map();
        for (const [wrapper, slot, missingError] of wrapperTargets) {
          if (!slot) {
            if (ctx.disabled.has("fit")) continue;
            throw new Error(missingError);
          }
          if (!grouped.has(slot)) grouped.set(slot, []);
          grouped.get(slot).push(wrapper);
        }
        if (grouped.size === 0) {
          if (ctx.disabled.has("fit")) results.fit = { state: "disabled" };
          else markFailed("fit", "binCli not found in this build");
          continue;
        }
        const staged = new Map();
        for (const [slot, wrappers] of grouped) {
          const opts = { ...ctx, wrappers };
          staged.set(slot, { opts, out: unitFit(readTarget(slot), opts) });
        }
        let fitState = ctx.disabled.has("fit") ? "disabled" : "already";
        for (const [slot, { opts, out }] of staged) {
          texts[slot] = out.text;
          if (out.state === "patched") {
            fitState = "patched";
            recordStep(slot, "fit", (src, extra = {}) => unitFit(src, { ...opts, ...extra }).text);
          } else if (out.state === "retained" && fitState === "disabled") {
            fitState = "retained";
          }
        }
        results.fit = { state: fitState };
      } catch (error) {
        markFailed("fit", error);
      }
      continue;
    }
    if (unit.name === "antigravitySteer") {
      try {
        const steerTargets = [
          ["acpSteer", resolveSlot("acpSteer"), "acpSteer bundle not found in this build"],
          ["dispatchPolicy", resolveSlot("dispatchPolicy"), "dispatchPolicy bundle not found in this build"],
          ["orchestratorSteer", resolveSlot("orchestratorSteer"), "orchestratorSteer bundle not found in this build"],
        ];
        const grouped = new Map();
        for (const [targetName, slot, missingError] of steerTargets) {
          if (!slot) throw new Error(missingError);
          if (!grouped.has(slot)) grouped.set(slot, []);
          grouped.get(slot).push(targetName);
        }
        const staged = new Map();
        for (const [slot, subTargets] of grouped) {
          const opts = { targets: subTargets };
          staged.set(slot, { opts, out: unitAntigravitySteer(readTarget(slot), opts) });
        }
        let steerState = "already";
        for (const [slot, { opts, out }] of staged) {
          texts[slot] = out.text;
          if (out.state === "patched") {
            steerState = "patched";
            recordStep(slot, "antigravitySteer", (src) => unitAntigravitySteer(src, opts).text);
          }
        }
        results.antigravitySteer = { state: steerState };
      } catch (error) {
        markFailed("antigravitySteer", error);
      }
      continue;
    }
    const targetFile = resolveSlot(unit.file);
    if (!targetFile) {
      markFailed(unit.name, `${unit.file} not found in this build`);
      continue;
    }
    const before = readTarget(targetFile);
    try {
      let out;
      if (unit.name === "geminiQuota") {
        // Only rewrite the known-bad 1.0.0 probe inside the primary runtime bundle (binCli/runtimeLayer).
        // Any build that already sends 2.24.0+ succeeds ("already") whichever server chunk holds it.
        const probeRel = targets.geminiProbe;
        const probeBase = probeRel ? probeRel.split("/").pop() : "";
        const isRuntimeProbe = Boolean(targets.binCli && probeRel === targets.binCli && /^(?:binCli|runtimeLayer)-[\w-]+\.mjs$/.test(probeBase));
        const probeOut = unitGeminiQuota(before);
        if (probeOut.state === "already") {
          out = probeOut;
        } else if (!isRuntimeProbe) {
          throw new Error("Antigravity probe in the server bundle sends the old version; this keeper only rewrites it in the runtime bundle");
        } else {
          out = probeOut;
          recordStep(targetFile, "geminiQuota", (src) => unitGeminiQuota(src).text);
        }
      } else {
        out = unit.run(before, ctx);
        if (out.state === "patched") recordStep(targetFile, unit.name, (src) => unit.run(src, ctx).text);
      }
      results[unit.name] = { state: out.state, ...(out.error ? { error: out.error } : {}) };
      texts[targetFile] = out.text;
    } catch (error) {
      markFailed(unit.name, error);
    }
  }
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
  const replayAll = (file, steps, extraForFit) => {
    let cur = originals[file].toString("utf8");
    const patchedSet = new Set();
    for (const step of steps) {
      cur = step.name === "fit" ? step.apply(cur, extraForFit) : step.apply(cur);
      patchedSet.add(step.name);
    }
    return { built: balanceFile(file, cur, patchedSet), patchedSet };
  };
  // If multiple server units together overflow a file's byte budget, replay them incrementally
  // in UNITS order while excluding any already-failed multi-file units so rollback never revives one.
  const rebuildIncremental = (file, steps, excludedUnits, { restoreFailed = false } = {}) => {
    let cur = originals[file].toString("utf8");
    const kept = new Set();
    let built = null;
    let newlyFailedMulti = false;
    for (const step of steps) {
      if (excludedUnits.has(step.name)) continue;
      const candidateSet = new Set([...kept, step.name]);
      try {
        const next = step.apply(cur);
        built = balanceFile(file, next, candidateSet);
        cur = next;
        kept.add(step.name);
        if (restoreFailed && !excludedUnits.has(step.name)) results[step.name] = { state: "patched" };
      } catch (error) {
        if (step.name === "fit" && /no comment block could absorb/.test(error.message)) {
          try {
            const compactNext = step.apply(cur, { compact: true });
            built = balanceFile(file, compactNext, candidateSet);
            cur = compactNext;
            kept.add(step.name);
            if (restoreFailed && !excludedUnits.has(step.name)) results[step.name] = { state: "patched" };
            continue;
          } catch (compactError) {
            const wasFailed = permanentlyFailed.has(step.name);
            markFailed(step.name, compactError);
            if (!wasFailed && permanentlyFailed.has(step.name)) newlyFailedMulti = true;
            continue;
          }
        }
        const wasFailed = permanentlyFailed.has(step.name);
        markFailed(step.name, error);
        if (!wasFailed && permanentlyFailed.has(step.name)) newlyFailedMulti = true;
      }
    }
    return { built, kept, newlyFailedMulti };
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
      if (patchedSet.has("fit") && /no comment block could absorb/.test(error.message)) {
        try {
          const compact = replayAll(file, steps, { compact: true });
          if (compact.built) {
            files[file] = compact.built;
            publishedUnits[file] = compact.patchedSet;
          }
          continue;
        } catch {}
      }
      if (steps.length > 1) {
        const { built, kept } = rebuildIncremental(file, steps, permanentlyFailed);
        if (built) {
          files[file] = built;
          publishedUnits[file] = kept;
        }
      } else {
        for (const name of patchedSet) {
          if (results[name]?.state === "patched") markFailed(name, error);
        }
      }
    }
  }
  // Generalized atomic rollback across all multi-file units (fixed point): if any multi-file unit
  // failed on any chunk, strip it from every shared/sibling chunk without reviving any other failed unit.
  let rollbackChanged = true;
  while (rollbackChanged) {
    rollbackChanged = false;
    for (const file of Object.keys(publishedUnits)) {
      const pub = publishedUnits[file];
      if (!pub || ![...pub].some((name) => permanentlyFailed.has(name))) continue;
      const remaining = (fileSteps[file] ?? []).filter((s) => !permanentlyFailed.has(s.name));
      delete files[file];
      delete publishedUnits[file];
      if (remaining.length > 0) {
        const { built, kept } = rebuildIncremental(file, remaining, permanentlyFailed, { restoreFailed: true });
        if (built) {
          files[file] = built;
          publishedUnits[file] = kept;
        }
      }
      rollbackChanged = true;
    }
  }
  for (const [name, error] of permanentlyFailed) {
    results[name] = { state: "failed", error };
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
  const serverFiles = Object.keys(files).filter((k) => k !== "index" && k !== "mainJs" && k !== "desktopMain");
  if (serverFiles.length > 0) {
    for (const unit of ["rule", "fit", "titleGuide", "geminiQuota", "antigravityQuestions", "antigravitySteer", "antigravityQuotaOutcome"]) {
      if (results[unit]?.state === "patched") startupReasons.push(unit);
    }
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
  unitWrap, unitMinWidth, unitRule, unitFit, unitTitleGuide, unitGeminiQuota, unitAntigravityQuestions, unitAntigravitySteer, unitAntigravityQuotaOutcome, unitExtras, unitFirstClick, finishBinCli, absorb, FIT_TITLE, FIT_TITLE_COMPACT, FIT_TITLE_V9, TITLE_GUIDE, ANTIGRAVITY_QUESTIONS_HELPER, WRAP_CSS, TMP_PREFIX,
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
