// Local-only: node --test test/ reads the installed app.asar and this build's backup with cp -c, then works on that temp clone. It never writes to the app or the backup.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync, spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { signedBytes } from "../../t3-extras/payload.mjs";
import * as acorn from "../vendor/acorn/acorn.mjs";

const APP = "/Applications/T3 Code (Nightly).app";
const INSTALLED = `${APP}/Contents/Resources/app.asar`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-keeper-test-"));
const asar = path.join(tmp, "Resources", "app.asar");
fs.mkdirSync(path.dirname(asar));
const pristine = path.join(tmp, "pristine.asar");
execFileSync("/bin/cp", ["-c", INSTALLED, pristine]);
const BUILD = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", `${APP}/Contents/Info.plist`], { encoding: "utf8" })).CFBundleShortVersionString;
const REAL_BACKUP = path.join(os.homedir(), ".local/share/t3-sidebar-keeper/backups", `${BUILD}.json.gz`);
process.env.T3_ASAR_PATH = asar;
process.env.T3_KEEPER_HOME = path.join(tmp, "home");
process.env.T3_KEEPER_QUIET = "1";
process.env.T3_USER_DATA_DIR = path.join(tmp, "userdata"); // keep the real T3 caches out of tests
process.env.T3_TEMP_DIR = path.join(tmp, "tempdir");
fs.mkdirSync(process.env.T3_KEEPER_HOME);
const loaderPair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const LOADER_SPKI = loaderPair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
process.env.T3X_LOADER_KEY = path.join(tmp, "loader-key.json");
fs.writeFileSync(process.env.T3X_LOADER_KEY, `${JSON.stringify({ spki: LOADER_SPKI })}\n`, { mode: 0o600 });
const K = await import("../keeper.mjs");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// The installed app is normally already patched by the keeper, so put this build's original
// bytes (the keeper's own backup) back into the copy: the tests then start from a fresh build.
if (fs.existsSync(REAL_BACKUP)) {
  const backup = JSON.parse(zlib.gunzipSync(fs.readFileSync(REAL_BACKUP)).toString("utf8"));
  const fd = fs.openSync(pristine, "r+");
  try {
    const items = Object.entries(backup.files).map(([rel, info]) => ({ rel, buf: Buffer.from(info.base64, "base64") }));
    for (const { buf } of items) assert.ok(buf.length > 0);
    K.writeEntries(fd, K.readLayout(fd), items);
  } finally {
    fs.closeSync(fd);
  }
}

const DISABLED = path.join(process.env.T3_KEEPER_HOME, "disabled.json");
const setDisabled = (list) => fs.writeFileSync(DISABLED, JSON.stringify({ disabled: list }));
const fresh = () => {
  fs.rmSync(asar, { force: true });
  fs.rmSync(DISABLED, { force: true });
  execFileSync("/bin/cp", ["-c", pristine, asar]);
};
const fileSha = (file) => K.sha(fs.readFileSync(file));
const ctx = { desktopMain: "style-src 'self' 'unsafe-inline'" };
const html = (script) => `<!doctype html><html><head>\n<script>\n${script}\n</script>\n</head><body></body></html>\n`;

function binCliOf(file = asar) {
  const fd = fs.openSync(file, "r");
  try {
    const layout = K.readLayout(fd);
    return K.readEntry(fd, layout, K.findTargets(fd, layout).binCli).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function orchestrationSections(text) {
  const ast = acorn.parse(text, { ecmaVersion: "latest", sourceType: "module" });
  const declaration = ast.body.flatMap((n) => n.type === "VariableDeclaration" ? n.declarations : [])
    .find((n) => n.id.name === "T3_CODE_ORCHESTRATION_SECTIONS");
  return vm.runInNewContext(text.slice(declaration.init.start, declaration.init.end));
}

function legacyFit(text) {
  // Pin the full helper from keeper.mjs.before, so this fixture cannot silently drift with v10.
  assert.equal(K.sha(Buffer.from(K.FIT_TITLE_V9)), "54359e27b005a882013d34b14057d7ec05403be386972cee0841afbd96d36c04");
  const oldWrapper = "function subagentThreadTitle(input) {\n\treturn t3KeeperFitTitle(subagentThreadTitle$t3orig(input && typeof input === \"object\" ? { ...input, title: t3KeeperFitTitle(input.title, 42, 64), prompt: t3KeeperFitTitle(input.prompt, 42, 64) } : input), 42);\n}\n";
  const newWrapper = oldWrapper.replace("input.title, 42, 64)", "input.title, 42, 64, true)");
  const patched = K.unitFit(text).text;
  assert.equal(patched.split(newWrapper).length, 2);
  return K.finishBinCli(patched.replace(K.FIT_TITLE, K.FIT_TITLE_V9).replace(newWrapper, oldWrapper), Buffer.byteLength(text), true);
}

// ---------- parser-based room making (Astra round 1 fixtures) ----------

test("wrap keeps // lines that are template-literal content", () => {
  const script = [
    "const a = 1;",
    "        // a real comment that can go, padding padding padding padding padding padding padding padding",
    ...Array.from({ length: 12 }, (_, i) => `        // filler comment ${i} padding padding padding padding padding padding padding padding`),
    "const t = `start \\` still template",
    "        // NOT a comment: inside the template",
    "end`;",
    "console.log(a, t);",
  ].join("\n");
  const out = K.unitWrap(html(script), ctx);
  assert.equal(out.state, "patched");
  assert.ok(out.text.includes("        // NOT a comment: inside the template"), "template content was stripped");
  assert.ok(!out.text.includes("// a real comment"));
  assert.equal(Buffer.byteLength(out.text), Buffer.byteLength(html(script)));
});

test("wrap refuses when there is not enough comment room", () => {
  assert.throws(() => K.unitWrap(html("const a = 1; // short"), ctx), /more bytes/);
});

test("wrap refuses when the content policy may block inline styles", () => {
  assert.throws(() => K.unitWrap(html("const a = 1;"), { desktopMain: "style-src 'self'" }), /content policy/);
});

test("binCli balance never edits a /** */ that is string content", () => {
  const fake = [
    'const s = "abc\\',
    "/**\\",
    "* looks like a comment but is string data\\",
    '*/ def";',
    "/**",
    "* a real comment with plenty of room to absorb the extra bytes we add later on",
    "* more lines more lines more lines more lines more lines more lines",
    "*/",
    "export const x = s;",
    "",
  ].join("\n");
  const grown = fake.replace("export const x = s;", "export const x = s + 'twelve bytes';");
  const out = K.finishBinCli(grown, Buffer.byteLength(fake), false);
  assert.equal(Buffer.byteLength(out), Buffer.byteLength(fake));
  assert.ok(out.includes("* looks like a comment but is string data\\"), "string data was changed");
  assert.ok(!out.includes("a real comment with plenty"));
});

test("binCli balance keeps a line break in the replaced comment (ASI)", () => {
  const fake = "let a = 1\n/**\n* comment comment comment comment comment comment\n*/\nexport default a;\n";
  const out = K.finishBinCli(fake.replace("a = 1", "a = 1234"), Buffer.byteLength(fake), false);
  assert.match(out, /\/\*\n +\*\//);
});

// ---------- whole-build patching ----------

test("the test copy starts unpatched (rebuilt from the keeper's backup when the app is patched)", () => {
  fresh();
  const states = Object.values(K.inspect(asar).results).map((r) => r.state);
  assert.deepEqual(states, ["patched", "patched", "patched", "patched", "patched", "patched", "patched"], "pristine copy is not a fresh build");
});

test("all units apply to the installed build; a second pass finds nothing to do", () => {
  fresh();
  const first = K.apply({ reason: "test" });
  assert.deepEqual(Object.values(first.results).map((r) => r.state), ["patched", "patched", "patched", "patched", "patched", "patched", "patched"]);
  const again = K.apply({ reason: "test" });
  assert.equal(again.wrote, false);
  assert.deepEqual(Object.values(again.results).map((r) => r.state), ["already", "already", "already", "already", "already", "already", "already"]);
});

// ---------- title guide and already-patched upgrades ----------

test("titleGuide appends one exact last section to a clean binCli and keeps its byte length", () => {
  fresh();
  const before = binCliOf();
  const sections = orchestrationSections(before);
  const result = K.unitTitleGuide(before);
  assert.equal(result.state, "patched");
  const after = K.finishBinCli(result.text, Buffer.byteLength(before), false);
  assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
  const nextSections = orchestrationSections(after); // also parses the entire balanced module with acorn
  assert.deepEqual(Array.from(nextSections.slice(0, -1)), Array.from(sections));
  assert.equal(nextSections.at(-1), K.TITLE_GUIDE);
  assert.ok(Buffer.byteLength(nextSections.at(-1)) < 1000);
  assert.ok(Buffer.byteLength(nextSections.at(-1)) < 4000);
  assert.equal(nextSections.filter((s) => s.startsWith("## Titles\n")).length, 1);
  assert.deepEqual(K.unitTitleGuide(after), { state: "already", text: after });
});

test("titleGuide replaces its previous text in place, including after the heading changes", () => {
  const original = `const T3_CODE_ORCHESTRATION_SECTIONS = ["First",];\n/*\n${" ".repeat(2000)}*/\n`;
  const added = K.unitTitleGuide(original).text;
  const old = added.replace(JSON.stringify(K.TITLE_GUIDE), JSON.stringify("## Older title guide\n\nOld wording"));
  const updated = K.unitTitleGuide(old);
  assert.equal(updated.state, "patched");
  const balanced = K.finishBinCli(updated.text, Buffer.byteLength(original), false);
  assert.equal(Buffer.byteLength(balanced), Buffer.byteLength(original));
  assert.deepEqual(Array.from(orchestrationSections(balanced)), ["First", K.TITLE_GUIDE]);
  assert.equal(balanced.split("/*t3-keeper-title-guide*/").length, 2);
  assert.equal(K.unitTitleGuide(balanced).state, "already");
});

test("titleGuide refuses ambiguous arrays and reports an exhausted byte budget", () => {
  assert.throws(() => K.unitTitleGuide("const unrelated = [];"), /single array declaration/);
  assert.throws(() => K.unitTitleGuide('const T3_CODE_ORCHESTRATION_SECTIONS = ["## Titles\\nOld", "## Titles\\nOther"];'), /more than once/);
  const noRoom = "const T3_CODE_ORCHESTRATION_SECTIONS = [];";
  assert.throws(() => K.finishBinCli(K.unitTitleGuide(noRoom).text, Buffer.byteLength(noRoom), false), /no comment block could absorb/);
});

test("an already-patched v9 archive upgrades fit and titleGuide in place and is idempotent", async () => {
  fresh();
  const before = binCliOf();
  const legacy = legacyFit(K.unitRule(before).text);
  K.apply({ reason: "v9 fixture" }); // patch the other units in the isolated archive
  const fd = fs.openSync(asar, "r+");
  try {
    const layout = K.readLayout(fd);
    K.writeEntries(fd, layout, [{ rel: K.findTargets(fd, layout).binCli, buf: Buffer.from(legacy) }]);
  } finally {
    fs.closeSync(fd);
  }
  for (const name of ["reminders.json", "reminder-journal.json"]) fs.rmSync(path.join(process.env.T3_KEEPER_HOME, name), { force: true });
  const archiveBytes = fs.statSync(asar).size;
  const result = K.apply({ reason: "v9 upgrade" });
  assert.deepEqual(Object.values(result.results).map((r) => r.state), ["already", "already", "already", "patched", "patched", "already", "already"]);
  const after = binCliOf();
  assert.equal(Buffer.byteLength(after), Buffer.byteLength(legacy));
  assert.equal(fs.statSync(asar).size, archiveBytes);
  assert.ok(after.includes(K.FIT_TITLE));
  assert.ok(!after.includes(K.FIT_TITLE_V9));
  const sections = orchestrationSections(after);
  assert.equal(sections.at(-1), K.TITLE_GUIDE);
  assert.equal(sections.filter((s) => s.startsWith("## Titles\n")).length, 1);
  assert.ok(Buffer.byteLength(sections.at(-1)) < 4000);
  assert.equal(titleFunctions(after).subagentThreadTitle({ title: "/root/reminders_warm_final_gate", ordinal: 1, parentTitle: "Parent" }), "Reminders warm final gate");
  const R = await import("../reminders.mjs");
  const pending = R.readStateFile(path.join(process.env.T3_KEEPER_HOME, "reminders.json")).state.pending;
  assert.deepEqual(pending.reasons, ["fit", "titleGuide"]);
  assert.deepEqual(K.unitTitleGuide(after), { state: "already", text: after });
  const again = K.apply({ reason: "v9 upgrade repeated" });
  assert.equal(again.wrote, false);
  assert.ok(Object.values(again.results).every((r) => r.state === "already"));
});

test("fit upgrades only the exact v9 helper and refuses an unknown helper", () => {
  fresh();
  const legacy = legacyFit(binCliOf());
  assert.equal(K.unitFit(legacy).state, "patched");
  assert.equal(K.unitFit(K.unitFit(legacy).text).state, "already");
  assert.throws(() => K.unitFit(legacy.replace("let limit = max;", "let limit = max + 1;")), /exact supported v9 helper/);
});

// ---------- unit extras (add-ons loader) ----------

const indexOf = (file) => {
  const fd = fs.openSync(file, "r");
  try {
    const layout = K.readLayout(fd);
    return K.readEntry(fd, layout, K.findTargets(fd, layout).index).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
};

const loaderCsp = 'function makeDesktopContentSecurityPolicy(input) { return [`script-src "\'unsafe-inline\'"`, `connect-src "http:"`, `img-src x`].join("; "); }';
const roomyWrappedPage = () => K.unitWrap(html("// " + "padding ".repeat(500) + "\nconst nativeBoot = 1;"), ctx).text;
const extrasBoot = () => K.extrasBoot(LOADER_SPKI);
const extrasOn = (extra = {}) => ({ loaderKey: LOADER_SPKI, ...extra });

test("extras on an already wrapped page takes its bytes from wrap's padding", () => {
  const before = roomyWrappedPage();
  const out = K.unitExtras(before, extrasOn({ desktopMain: loaderCsp }));
  assert.equal(out.state, "patched");
  const next = out.text;
  assert.equal(Buffer.byteLength(next), Buffer.byteLength(before));
  const style = next.indexOf(`<style id="${K.STYLE_ID}">`);
  const end = next.indexOf("</style>", style) + "</style>".length;
  assert.ok(next.startsWith(extrasBoot(), end), "loader is not right after wrap's style");
  assert.equal(next.slice(0, style), before.slice(0, style), "roomy page's native boot changed");
  assert.equal(next.slice(end + extrasBoot().length), before.slice(before.indexOf("</style>", style) + 8), "bytes after the loader changed");
});

test("--disable extras returns the exact roomy page and leaves wrap intact", () => {
  const before = roomyWrappedPage();
  const enabled = K.unitExtras(before, extrasOn({ desktopMain: loaderCsp })).text;
  const off = K.unitExtras(enabled, { disabled: new Set(["extras"]) });
  assert.equal(off.state, "removed");
  assert.equal(off.text, before);
  assert.equal(K.unitWrap(off.text, ctx).state, "already");
  const again = K.unitExtras(off.text, { disabled: new Set(["extras"]) });
  assert.equal(again.state, "disabled");
  assert.equal(again.text, off.text);
});

test("extras refuses when wrap's padding is too small, and when the CSP would block it", () => {
  const css = `<style id="${K.STYLE_ID}">a{b:c}${" ".repeat(20)}</style>`;
  const page = `<!doctype html><html><head>${css}\n</head><body></body></html>`;
  const csp = 'function makeDesktopContentSecurityPolicy(input) { return [`script-src ${["\'self\'", "\'unsafe-inline\'"].join(" ")}`, `connect-src ${["\'self\'", "http:"].join(" ")}`, `img-src x`].join("; "); }';
  assert.ok(K.cspAllowsLoader(csp));
  assert.throws(() => K.unitExtras(page, extrasOn({ desktopMain: csp })), new RegExp(`needs ${Buffer.byteLength(extrasBoot()) - 20} more bytes`));
  const roomy = page.replace(" ".repeat(20), " ".repeat(2000));
  const out = K.unitExtras(roomy, extrasOn({ desktopMain: csp }));
  assert.equal(out.state, "patched");
  assert.equal(Buffer.byteLength(out.text), Buffer.byteLength(roomy));
  assert.throws(() => K.unitExtras(roomy, extrasOn({ desktopMain: csp.replace("\'unsafe-inline\'", "\'none\'") })), /content policy/);
  assert.throws(() => K.unitExtras(roomy, extrasOn({ desktopMain: csp.replace('"http:"', '"https:"') })), /content policy/);
  assert.throws(() => K.unitExtras("<html><head></head></html>", extrasOn({ desktopMain: csp })), /wrap's <style> is missing/);
});

test("an older loader version is replaced in place", () => {
  const css = `<style id="${K.STYLE_ID}">a{b:c}${" ".repeat(1500)}</style>`;
  const page = `<html><head>${css}\n</head></html>`;
  const csp = 'function makeDesktopContentSecurityPolicy(input) { return [`script-src ${["\'self\'", "\'unsafe-inline\'"].join(" ")}`, `connect-src http:`, `img-src x`].join("; "); }';
  const old = '<script id="t3x-boot-0">(()=>{})()</script>';
  const withOld = page.replace(" ".repeat(old.length) + "</style>", "</style>" + old);
  assert.equal(withOld.length, page.length);
  const out = K.unitExtras(withOld, extrasOn({ desktopMain: csp.replace("connect-src http:", 'connect-src "http:"') }));
  assert.equal(out.state, "patched");
  assert.ok(!out.text.includes("t3x-boot-0") && out.text.includes(extrasBoot()));
  assert.equal(out.text.length, page.length);
});

test("extras reclaims boot indentation without changing template text or automatic semicolons", () => {
  const script = `\n${" ".repeat(1600)}globalThis.result = (() => {\n    const text = \`first\n        keep template indentation\nlast\`;\n    const regex = /a  b/;\n    // keep this comment\n    return\n      [text, regex.source];\n  })();\n`;
  const page = html(script).replace("</head>", `<style id="${K.STYLE_ID}">a{b:c}</style></head>`);
  const csp = 'function makeDesktopContentSecurityPolicy(input) { return [`script-src "\'unsafe-inline\'"`, `connect-src "http:"`, `img-src x`].join("; "); }';
  const out = K.unitExtras(page, extrasOn({ desktopMain: csp }));
  assert.equal(Buffer.byteLength(out.text), Buffer.byteLength(page));
  assert.ok(out.text.includes("        keep template indentation"));
  assert.ok(out.text.includes("// keep this comment"));
  const boot = out.text.match(/<script>([\s\S]*?)<\/script>/)[1];
  const before = {}, after = {};
  vm.runInNewContext(script, before);
  vm.runInNewContext(boot, after);
  assert.equal(after.result, before.result);
  assert.equal(after.result, undefined, "return newline must not turn into return expression");
  assert.equal(K.unitExtras(out.text, extrasOn({ desktopMain: csp })).state, "already");
  const off = K.unitExtras(out.text, { disabled: new Set(["extras"]) });
  assert.equal(Buffer.byteLength(off.text), Buffer.byteLength(page));
  assert.ok(!off.text.includes("t3x-boot"));
  assert.equal(K.unitExtras(off.text, extrasOn({ desktopMain: csp })).state, "patched");
});

test("extras reclaims enough space on the current nightly and preserves native theme startup", () => {
  fresh();
  const fd = fs.openSync(asar, "r");
  let original, desktopMain;
  try {
    const layout = K.readLayout(fd), targets = K.findTargets(fd, layout);
    original = K.readEntry(fd, layout, targets.index).toString();
    desktopMain = K.readEntry(fd, layout, targets.desktopMain).toString();
  } finally { fs.closeSync(fd); }
  const wrapped = K.unitWrap(original, { desktopMain }).text;
  const out = K.unitExtras(wrapped, extrasOn({ desktopMain }));
  assert.equal(out.state, "patched");
  assert.equal(Buffer.byteLength(out.text), Buffer.byteLength(original));
  const scriptOf = (text) => text.match(/<script>([\s\S]*?)<\/script>/)[1];
  const runTheme = (script, theme, dark) => {
    const result = { dataset: {}, styles: {}, classes: {}, meta: {} };
    const context = {
      window: { localStorage: { getItem: key => key === "t3code:theme" ? theme : null }, matchMedia: () => ({ matches: dark }) },
      document: {
        documentElement: { dataset: result.dataset, classList: { toggle: (key, value) => { result.classes[key] = value; } }, style: { setProperty: (key, value) => { result.styles[key] = value; }, set backgroundColor(value) { result.styles.backgroundColor = value; } } },
        querySelectorAll: () => [{ setAttribute: (key, value) => { result.meta[key] = value; } }],
      },
      CSS: { supports: () => true },
    };
    vm.runInNewContext(script, context);
    return result;
  };
  for (const theme of [null, "system", "light", "dark", "grove", "t3-chat"]) {
    for (const dark of [false, true]) assert.deepEqual(runTheme(scriptOf(out.text), theme, dark), runTheme(scriptOf(original), theme, dark));
  }
});

test("the loader inserts the add-ons inline, re-fetches on a new /version, and is silent when the service is down", async () => {
  const inner = extrasBoot().slice(extrasBoot().indexOf(">") + 1, -"</script>".length);
  assert.ok(inner.includes("http://127.0.0.1:8793/"));
  assert.ok(!inner.includes("<") && /^[\x20-\x7e]*$/.test(inner));
  new vm.Script(inner);
  const sign = (version, css, js) => crypto.sign("sha256", signedBytes(version, css, js), { key: loaderPair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  const run = async (serve) => {
    const head = [];
    const listeners = {};
    const doc = {
      head: { append: (...nodes) => head.push(...nodes) },
      createElement: (tag) => ({ tag, remove() { head.splice(head.indexOf(this), 1); } }),
      querySelectorAll: (sel) => head.filter((n) => sel.split(",").includes(`#${n.id}`)),
    };
    const win = { addEventListener: (type, fn) => { listeners[type] = fn; } };
    const pending = [];
    const fetch = (url) => {
      const job = (async () => {
        const body = await serve(url);
        if (body === null) throw new TypeError("Failed to fetch");
        return { ok: true, text: async () => body };
      })();
      pending.push(job);
      return job;
    };
    vm.runInNewContext(inner, { document: doc, window: win, fetch, Promise, crypto, atob, TextEncoder, Uint8Array });
    await Promise.allSettled(pending);
    await new Promise((r) => setTimeout(r, 50));
    return { head, listeners, win };
  };
  let version = "1";
  const css = "x{}";
  const js = "void 0";
  const served = await run(async (url) => {
    const name = url.replace("http://127.0.0.1:8793/", "");
    if (name === "extras.sig") return sign(version, css, js);
    return { version, "extras.css": css, "extras.js": js }[name];
  });
  assert.deepEqual(served.head.map((n) => [n.tag, n.id, n.textContent]), [["style", "t3x-css", "x{}"], ["script", "t3x-js", "void 0"]]);
  let torn = 0;
  served.win.t3xTeardown = () => { torn += 1; };
  served.listeners.focus();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(torn, 0, "same version must not reload");
  version = "2";
  served.listeners.focus();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(torn, 1);
  assert.equal(served.head.length, 2, "old add-on nodes were not removed");
  const down = await run(async () => null);
  assert.equal(down.head.length, 0);
  assert.equal(typeof down.listeners.focus, "function");
});

// ---------- unit firstClick (acceptFirstMouse) ----------

const desktopMainOf = (file) => {
  const fd = fs.openSync(file, "r");
  try {
    const layout = K.readLayout(fd);
    return K.readEntry(fd, layout, K.findTargets(fd, layout).desktopMain).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
};

test("firstClick turns on acceptFirstMouse for the Mac window only, keeping main.cjs's length", () => {
  fresh();
  const before = desktopMainOf(asar);
  assert.equal(K.apply({ reason: "test" }).results.firstClick.state, "patched");
  const after = desktopMainOf(asar);
  assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
  const fn = acorn.parse(after, { ecmaVersion: "latest", sourceType: "script" }).body
    .find((n) => n.type === "FunctionDeclaration" && n.id.name === "getWindowTitleBarOptions");
  const box = { MACOS_WORKSPACE_TOPBAR_HEIGHT: 40, MACOS_WINDOW_BUTTON_RADIUS: 6, TITLEBAR_COLOR: "", TITLEBAR_HEIGHT: 40, TITLEBAR_DARK_SYMBOL_COLOR: "", TITLEBAR_LIGHT_SYMBOL_COLOR: "" };
  vm.runInNewContext(`${after.slice(fn.start, fn.end)}; mac = getWindowTitleBarOptions(false, "darwin"); other = getWindowTitleBarOptions(false, "win32");`, box);
  assert.equal(box.mac.acceptFirstMouse, true);
  assert.equal(box.mac.titleBarStyle, "hiddenInset");
  assert.equal(box.other.acceptFirstMouse, undefined);
  assert.equal(K.unitFirstClick(after).state, "already");
});

test("firstClick refuses when T3 sets acceptFirstMouse itself or the Mac branch changes shape", () => {
  const fake = (body) => `function getWindowTitleBarOptions(dark, platform) {\n${body}\n}\nnew BrowserWindow({ ...getWindowTitleBarOptions(false, "darwin") });\n`;
  const mac = `if (platform === "darwin") return {\n\ttitleBarStyle: "hiddenInset"\n};\nreturn {};`;
  assert.equal(K.unitFirstClick(fake(mac)).state, "patched");
  assert.throws(() => K.unitFirstClick(fake(mac).replace("BrowserWindow({", "BrowserWindow({ acceptFirstMouse: false,")), /sets acceptFirstMouse itself/);
  assert.equal(K.unitFirstClick(fake(`if (platform === "darwin") return { acceptFirstMouse: true, titleBarStyle: "hiddenInset" };\nreturn {};`)).state, "already");
  assert.throws(() => K.unitFirstClick(fake(`if (platform === "darwin") return { ...base, titleBarStyle: "hiddenInset" };\nreturn {};`)), /spread/);
  assert.throws(() => K.unitFirstClick(fake(`return { titleBarStyle: "hidden" };`)), /Mac branch/);
  assert.throws(() => K.unitFirstClick(fake(mac).replace("BrowserWindow({ ...getWindowTitleBarOptions(false, \"darwin\") })", "BrowserWindow(getWindowTitleBarOptions(false, \"darwin\"))")), /no longer spreads/);
  assert.throws(() => K.unitFirstClick("function other() {}\n"), /declared 0 times/);
  assert.throws(() => K.absorb("var a = 1;\n", 5, "script"), /no comment block/);
});

test("--disable refuses units that can't be switched off on their own", () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../keeper.mjs", import.meta.url)), "--disable", "wrap"], { env: { ...process.env }, encoding: "utf8" });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /only extras, rule, fit, titleGuide can be switched off/);
});

test("the old copy a running app holds open gets the same bytes (live effect)", () => {
  fresh();
  const appFd = fs.openSync(asar, "r"); // what T3's running process has open
  try {
    K.apply({ reason: "test" });
    const onDisk = fs.readFileSync(asar);
    const seen = Buffer.alloc(onDisk.length);
    fs.readSync(appFd, seen, 0, seen.length, 0);
    const fd = fs.openSync(asar, "r");
    const layout = K.readLayout(fd);
    const t = K.findTargets(fd, layout);
    const bin = layout.header; // offsets are identical in both copies
    fs.closeSync(fd);
    const entry = (rel) => rel.split("/").reduce((n, p) => n.files[p], bin);
    const slice = (buf, rel) => buf.subarray(layout.dataOffset + Number(entry(rel).offset), layout.dataOffset + Number(entry(rel).offset) + entry(rel).size);
    const pristineBuf = fs.readFileSync(pristine);
    assert.ok(slice(seen, t.index).equals(slice(onDisk, t.index)), "running app's index.html not updated");
    assert.ok(slice(seen, t.mainJs).equals(slice(onDisk, t.mainJs)), "running app's main JS not updated");
    assert.ok(slice(seen, t.binCli).equals(slice(pristineBuf, t.binCli)), "server file should be left alone in the running copy");
    assert.ok(slice(seen, t.desktopMain).equals(slice(pristineBuf, t.desktopMain)), "desktop main should be left alone in the running copy");
    assert.notEqual(fs.fstatSync(appFd).ino, fs.statSync(asar).ino, "file was edited in place, not replaced");
  } finally {
    fs.closeSync(appFd);
  }
});

// ---------- crash safety (Astra round 2: "torn") ----------

test("a crash before the switch leaves app.asar untouched; the leftover clone is cleaned up", () => {
  fresh();
  const before = fileSha(asar);
  const ino = fs.statSync(asar).ino;
  assert.throws(() => K.apply({ reason: "test", hooks: { beforeRename: () => { throw new Error("simulated crash"); } } }), /simulated crash/);
  assert.equal(fileSha(asar), before);
  assert.equal(fs.statSync(asar).ino, ino);
  assert.deepEqual(fs.readdirSync(path.dirname(asar)).filter((n) => n.startsWith(K.TMP_PREFIX)), []);
  // A killed process can't run its cleanup: its clone stays until the next run removes it.
  const stale = path.join(path.dirname(asar), `${K.TMP_PREFIX}999999`);
  fs.writeFileSync(stale, "half-written");
  K.removeStaleTemps();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fileSha(asar), before);
});

// ---------- exact build generation (Astra round 2: "guard-race") ----------

test("an app.asar swapped in after the check is never written", () => {
  fresh();
  const checked = K.asarIdentity();
  const swapped = path.join(tmp, "swapped.asar");
  execFileSync("/bin/cp", ["-c", pristine, swapped]);
  fs.renameSync(swapped, asar); // update lands between the check and apply()
  const before = fileSha(asar);
  assert.throws(() => K.apply({ reason: "test", checked }), /replaced/);
  assert.equal(fileSha(asar), before);
});

test("a swap during the write is caught at the switch", () => {
  fresh();
  const checked = K.asarIdentity();
  const swapped = path.join(tmp, "swapped2.asar");
  execFileSync("/bin/cp", ["-c", pristine, swapped]);
  let before;
  assert.throws(() => K.apply({
    reason: "test",
    checked,
    hooks: { beforeRename: () => { fs.renameSync(swapped, asar); before = fileSha(asar); } },
  }), /replaced/);
  assert.equal(fileSha(asar), before);
  assert.deepEqual(fs.readdirSync(path.dirname(asar)).filter((n) => n.startsWith(K.TMP_PREFIX)), []);
});

test("nothing is written once T3 for the checked build has stopped", () => {
  fresh();
  const before = fileSha(asar);
  assert.throws(() => K.apply({ reason: "test", checked: K.asarIdentity(), guard: () => false }), /no longer running/);
  assert.equal(fileSha(asar), before);
});

// ---------- titles through the real patched functions (Astra round 2: "titles") ----------

function patchedTitleFunctions() {
  fresh();
  return titleFunctions(K.unitFit(binCliOf()).text);
}

function titleFunctions(patched) {
  const ast = acorn.parse(patched, { ecmaVersion: "latest", sourceType: "module" });
  const names = ["t3KeeperFitTitle", "subagentThreadTitle", "subagentThreadTitle$t3orig", "threadTitle", "threadTitle$t3orig", "sanitizeThreadTitle", "sanitizeThreadTitle$t3orig", "trimmed$1"];
  const code = ast.body.filter((n) => n.type === "FunctionDeclaration" && names.includes(n.id.name)).map((n) => patched.slice(n.start, n.end)).join("\n");
  const maxDecl = patched.match(/^const MAX_THREAD_TITLE_CHARS = [^;]+;$/m)[0]; // the patched value
  const stubs = maxDecl + " const isSome = (o) => o?._tag === 'Some'; function decodeJsonThreadTitle(raw) { try { const v = JSON.parse(raw); return typeof v?.title === 'string' ? { _tag: 'Some', value: v } : { _tag: 'None' }; } catch { return { _tag: 'None' }; } }\n";
  return vm.runInNewContext(`${stubs}${code}\n({ subagentThreadTitle, threadTitle, sanitizeThreadTitle })`, { Intl });
}

test("only subagent title inputs wordify recognised native agent IDs", () => {
  const T = patchedTitleFunctions();
  const cases = [
    ["/root/reminders_warm_final_gate", "Reminders warm final gate"],
    ["/root/review_footer_rules_3", "Review footer rules 3"],
    ["review_footer_rules_3", "Review footer rules 3"],
    ["root/review_footer_rules_3", "Review footer rules 3"],
    ["/root/review/footer_rules_3", "Review footer rules 3"],
    ["Review: footer rules 3 (Astra)", "Review: footer rules 3 (Astra)"],
    ["fixTitle", "fixTitle"],
    ["Use fixTitle and review_footer_rules", "Use fixTitle and review_footer_rules"],
    ["/Users/x/My File", "/Users/x/My File"],
    ["Review_footer_rules", "Review_footer_rules"],
    ["review footer_rules", "review footer_rules"],
    ["fix-title", "fix-title"],
  ];
  for (const [title, expected] of cases) {
    assert.equal(T.subagentThreadTitle({ title, ordinal: 1, parentTitle: "Parent" }), expected, title);
    assert.equal(T.threadTitle({ title, index: 0, parentTitle: "Parent" }), title, `threadTitle: ${title}`);
    assert.equal(T.sanitizeThreadTitle(title), title, `sanitizeThreadTitle: ${title}`);
  }
  assert.equal(T.subagentThreadTitle({ title: "/root/review_footer_rules_3\n", ordinal: 1, parentTitle: "Parent" }), "/root/review_footer_rules_3");
  const prompt = "/root/review_footer_rules_3";
  assert.equal(T.subagentThreadTitle({ title: "", prompt, ordinal: 1, parentTitle: "Parent" }), prompt);
});

test("shortening a numbered role keeps the preceding role word", () => {
  const T = patchedTitleFunctions();
  for (const name of ["subagentThreadTitle", "threadTitle"]) {
    const out = T[name]({ title: "Code review 3: footer redesign (GPT-6.1-Sol)", ordinal: 1, index: 0, parentTitle: "Parent" });
    assert.equal(out, "Review 3: footer redesign (GPT-6.1-Sol)");
    assert.ok(!out.startsWith("3:"));
  }
  // When "Review N" plus the first subject word won't fit, the round number alone stays, so siblings differ.
  for (const [n, subject] of [["100", "authentication flow for the sidebar keeper"], ["3", "internationalization of the sidebar titles"]]) {
    const a = T.subagentThreadTitle({ title: `Code review ${n}: ${subject} (GPT-6.1-Sol)`, ordinal: 1, parentTitle: "Parent" });
    const b = T.subagentThreadTitle({ title: `Code review ${Number(n) + 1}: ${subject} (GPT-6.1-Sol)`, ordinal: 1, parentTitle: "Parent" });
    assert.notEqual(a, b);
    assert.ok(a.startsWith(`${n}: `), a);
  }
});

test("real wrappers never split emoji and keep a trailing tag", () => {
  const T = patchedTitleFunctions();
  const graphemes = (s) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
  const cases = [
    ["subagentThreadTitle", "😀".repeat(40), 42],
    ["threadTitle", "😀".repeat(41), 42],
    ["subagentThreadTitle", "😀".repeat(40) + " (audit)", 42],
    ["threadTitle", "👨‍👩‍👧".repeat(40) + " (audit)", 42],
    ["subagentThreadTitle", "Technical & Adversarial Review: sidebar persistence keeper installer (GPT-6.1-Sol)", 42],
    ["sanitizeThreadTitle", "😀".repeat(130), 40],
    ["sanitizeThreadTitle", "👨‍👩‍👧".repeat(30), 40],
  ];
  for (const [name, title, max] of cases) {
    const input = name === "sanitizeThreadTitle" ? title : { title, parentTitle: "Parent", ordinal: 1, index: 0 };
    const out = T[name](input);
    assert.ok(out.isWellFormed(), `${name}: not well formed: ${out}`);
    assert.ok(graphemes(out) <= max, `${name}: ${out} has ${graphemes(out)} > ${max}`);
    if (title.endsWith(" (audit)")) assert.ok(out.endsWith(" (audit)"), `${name}: lost tag: ${out}`);
  }
  assert.match(T.subagentThreadTitle({ title: cases[4][1], ordinal: 1, parentTitle: "P" }), /\(GPT-6\.1-Sol\)$/);
  assert.match(T.subagentThreadTitle({ title: "", prompt: "", ordinal: 3, parentTitle: "Wrap side-panel thread titles and keep them wrapped forever" }), / subagent 3$/);
  assert.equal(T.threadTitle({ title: "UI cleanup", index: 0, parentTitle: "p" }), "UI cleanup");
  assert.equal(T.sanitizeThreadTitle("Persist sidebar fix"), "Persist sidebar fix");
  assert.equal(T.sanitizeThreadTitle("   "), "New thread");
});

test("title fitter on its own: graphemes, limits, lone surrogates", () => {
  const sandbox = vm.createContext({ Intl });
  vm.runInContext(K.FIT_TITLE, sandbox);
  const fit = (s, n, u) => vm.runInContext(`t3KeeperFitTitle(${JSON.stringify(s)}, ${n}${u ? `, ${u}` : ""})`, sandbox);
  const graphemes = (s) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
  for (const [s, n] of [["a".repeat(31) + "😀" + "b".repeat(20), 32], ["Family 👨‍👩‍👧 trip planning and booking all the things", 20], ["Café au lait and many other drinks to try out", 12], ["x".repeat(80) + " (audit)", 42]]) {
    const out = fit(s, n);
    assert.ok(out.isWellFormed());
    assert.ok(graphemes(out) <= n);
  }
  assert.equal(fit("abc\uD83D", 40), "abc");
  assert.ok(fit("😀".repeat(40), 42, 64).length <= 64);
  assert.equal(fit(undefined, 40), undefined);
});

// ---------- round 3 (Astra): live tear, late swap, pathological titles, short writes ----------

test("a failed live write is rolled back; the file on disk is still fully patched", () => {
  fresh();
  const appFd = fs.openSync(asar, "r");
  try {
    let n = 0;
    const out = K.apply({ reason: "test", hooks: { liveWrite: () => { if (++n === 2) throw new Error("injected I/O error"); } } });
    assert.equal(out.live, "rolled-back");
    const seen = Buffer.alloc(fs.statSync(pristine).size);
    fs.readSync(appFd, seen, 0, seen.length, 0);
    const pristineBuf = fs.readFileSync(pristine);
    // body bytes the running app reads are all original again (its header is cached by Electron anyway)
    const fd = fs.openSync(pristine, "r");
    const layout = K.readLayout(fd);
    fs.closeSync(fd);
    assert.ok(seen.subarray(layout.dataOffset).equals(pristineBuf.subarray(layout.dataOffset)), "running copy left torn");
    assert.equal(K.inspect(asar).results.wrap.state, "already", "disk copy should be patched");
  } finally {
    fs.closeSync(appFd);
  }
});

test("a swap after the guard but before the switch is caught", () => {
  fresh();
  const swapped = path.join(tmp, "swapped3.asar");
  execFileSync("/bin/cp", ["-c", pristine, swapped]);
  let before;
  assert.throws(() => K.apply({
    reason: "test",
    checked: K.asarIdentity(),
    hooks: { afterGuard: () => { fs.renameSync(swapped, asar); before = fileSha(asar); } },
  }), /replaced/);
  assert.equal(fileSha(asar), before);
});

test("pathological titles: long family emoji, one letter with 100 accents", () => {
  const T = patchedTitleFunctions();
  const graphemes = (s) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
  const family = "👨‍👩‍👧‍👦";
  const heavy = "a" + "́".repeat(100);
  const outs = [
    T.sanitizeThreadTitle(family.repeat(30)),
    T.subagentThreadTitle({ title: heavy + " (audit)", ordinal: 1, parentTitle: "P" }),
    T.threadTitle({ title: heavy + " (audit)", index: 0, parentTitle: "P" }),
  ];
  for (const out of outs) {
    assert.ok(out.isWellFormed(), out);
    for (const g of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(out)) {
      if (g.segment.includes("‍")) assert.equal(g.segment, family, `broken family emoji in ${out}`);
    }
  }
  assert.ok(graphemes(outs[0]) <= 40);
  assert.ok(outs[1].endsWith(" (audit)"), outs[1]);
  assert.ok(outs[2].endsWith(" (audit)"), outs[2]);
});

test("short writes are completed, so backups stay readable", () => {
  fresh();
  const real = fs.writeSync;
  fs.writeSync = (fd, buf, off = 0, len = buf.length - off, pos = null) => real(fd, buf, off, Math.max(1, Math.floor(len / 2)), pos);
  try {
    K.apply({ reason: "test" });
  } finally {
    fs.writeSync = real;
  }
  const backups = fs.readdirSync(path.join(process.env.T3_KEEPER_HOME, "backups"));
  assert.ok(backups.length > 0);
  for (const b of backups) {
    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(process.env.T3_KEEPER_HOME, "backups", b))).toString("utf8"));
    for (const info of Object.values(data.files)) assert.equal(K.sha(Buffer.from(info.base64, "base64")), info.sha);
  }
  assert.equal(K.inspect(asar).results.fit.state, "already");
});

// ---------- round 4 (Sol): real kill mid-live-write, exact-file guard, restore, state ----------

const KEEPER = fileURLToPath(new URL("../keeper.mjs", import.meta.url));
const env = () => ({ ...process.env });

test("a keeper killed during the live update leaves each running-copy file wholly old or new", () => {
  fresh();
  const appFd = fs.openSync(asar, "r");
  try {
    const worker = path.join(tmp, "kill-worker.mjs");
    fs.writeFileSync(worker, `
      const K = await import(${JSON.stringify(KEEPER)});
      let n = 0;
      K.apply({ reason: "kill-test", hooks: { liveWrite: () => { if (++n === 2) process.kill(process.pid, "SIGKILL"); } } });
    `);
    const r = spawnSync(process.execPath, [worker], { env: env(), encoding: "utf8" });
    assert.equal(r.signal, "SIGKILL", r.stderr);
    const fd = fs.openSync(pristine, "r");
    const layout = K.readLayout(fd);
    const t = K.findTargets(fd, layout);
    fs.closeSync(fd);
    const patchedFd = fs.openSync(asar, "r"); // the new file on disk is complete and patched
    const patchedLayout = K.readLayout(patchedFd);
    for (const rel of [t.index, t.mainJs]) {
      const entry = rel.split("/").reduce((n, p) => n.files[p], layout.header);
      const seen = Buffer.alloc(entry.size);
      fs.readSync(appFd, seen, 0, entry.size, layout.dataOffset + Number(entry.offset));
      const orig = K.readEntry(fs.openSync(pristine, "r"), layout, rel);
      const next = K.readEntry(patchedFd, patchedLayout, rel);
      assert.ok(seen.equals(orig) || seen.equals(next), `${rel} is torn in the running copy`);
    }
    fs.closeSync(patchedFd);
    assert.equal(K.inspect(asar).results.wrap.state, "already");
  } finally {
    fs.closeSync(appFd);
  }
});

test("only an app.asar a running T3 process has open counts as launched", () => {
  fresh();
  const fd = fs.openSync(asar, "r"); // open by this test process, not by T3
  try {
    assert.equal(K.launchedByT3(K.asarIdentity()), false);
  } finally {
    fs.closeSync(fd);
  }
});

test("restore only undoes the exact file the keeper produced", () => {
  fresh();
  const before = fileSha(asar);
  const run = (flag) => spawnSync(process.execPath, [KEEPER, flag], { env: env(), encoding: "utf8" });
  const a1 = run("--apply");
  assert.equal(a1.status, 0, a1.stdout + a1.stderr);
  assert.notEqual(fileSha(asar), before);
  const r1 = run("--restore");
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.equal(fileSha(asar), before, "restore did not give back the original bytes");
  // a different install of the same build must never be "restored" over
  assert.equal(run("--apply").status, 0);
  fresh();
  const other = fileSha(asar);
  const r2 = run("--restore");
  assert.notEqual(r2.status, 0);
  assert.match(r2.stdout + r2.stderr, /not the file the keeper patched/);
  assert.equal(fileSha(asar), other);
});

test("a new device number after a Mac restart still counts as the keeper's own file", () => {
  fresh();
  const before = fileSha(asar);
  const run = (flag) => spawnSync(process.execPath, [KEEPER, flag], { env: env(), encoding: "utf8" });
  assert.equal(run("--apply").status, 0);
  // APFS gave /Applications a new device number at the restart on 19 Oct 2026
  const statePath = path.join(process.env.T3_KEEPER_HOME, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.produced.identity.dev += 2;
  fs.writeFileSync(statePath, JSON.stringify(state));
  const r = run("--restore");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fileSha(asar), before, "restore did not give back the original bytes");
});

test("apply reports the identity of the file it wrote, not whatever is at the path later", () => {
  fresh();
  const out = K.apply({ reason: "test" });
  const st = fs.statSync(asar);
  assert.equal(out.produced.ino, st.ino);
  assert.equal(out.produced.birthtimeMs, st.birthtimeMs);
  fresh(); // an update lands right after
  assert.notEqual(out.produced.ino, fs.statSync(asar).ino);
});

// These exercise the real archive transaction hooks, in the existing isolated
// APFS fixture. No real app is modified and T3_KEEPER_QUIET stays enabled.
for (const boundary of ['afterArchiveRename', 'beforeReminderFinalize']) {
  test(`restart journal recovers exactly one requirement after crash at ${boundary}`, async () => {
    const R = await import('../reminders.mjs');
    fresh();
    for (const name of ['reminders.json', 'reminder-journal.json']) fs.rmSync(path.join(process.env.T3_KEEPER_HOME, name), { force: true });
    assert.throws(() => K.apply({ reason: 'crash fixture', hooks: { [boundary]: () => { throw new Error(`crash at ${boundary}`); } } }), /crash at/);
    const actual = K.asarIdentity();
    const recovered = R.reconcileJournal({ home: process.env.T3_KEEPER_HOME, actual, build: BUILD });
    assert.equal(recovered.recovered, true);
    const first = R.readStateFile(path.join(process.env.T3_KEEPER_HOME, 'reminders.json')).state.pending;
    assert.ok(first.reasons.includes('firstClick'));
    assert.equal(R.sameArchive(first.archive, actual), true);
    assert.equal(first.boundarySource, boundary === 'afterArchiveRename' ? 'recovery' : 'published');
    assert.equal(R.reconcileJournal({ home: process.env.T3_KEEPER_HOME, actual, build: BUILD }).recovered, false);
    assert.deepEqual(R.readStateFile(path.join(process.env.T3_KEEPER_HOME, 'reminders.json')).state.pending, first);
  });
}

test("geminiQuota: the Antigravity probe sends a version Google returns Gemini buckets for", () => {
  const before = binCliOf(pristine);
  const out = K.unitGeminiQuota(before);
  assert.equal(out.state, "patched");
  assert.ok(out.text.includes("`antigravity/hub/2.24.0 (aidev_client;") && !out.text.includes("antigravity/hub/1.0.0"));
  assert.equal(K.unitGeminiQuota(out.text).state, "already");
  const balanced = K.finishBinCli(out.text, Buffer.byteLength(before), false);
  assert.equal(Buffer.byteLength(balanced), Buffer.byteLength(before));
  assert.throws(() => K.unitGeminiQuota("const ua = `other`;"), /found 0 times/);
});
