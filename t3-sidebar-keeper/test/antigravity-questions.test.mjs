// Local-only: exercises unitAntigravityQuestions and the injected extractor on synthetic
// fixtures and on a temporary APFS clone of the installed app.asar. Never writes to the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as acorn from "../vendor/acorn/acorn.mjs";

const APP = "/Applications/T3 Code (Nightly).app";
const INSTALLED = `${APP}/Contents/Resources/app.asar`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-keeper-agq-test-"));
const asar = path.join(tmp, "Resources", "app.asar");
fs.mkdirSync(path.dirname(asar));
const pristine = path.join(tmp, "pristine.asar");
execFileSync("/bin/cp", ["-c", INSTALLED, pristine]);
const BUILD = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", `${APP}/Contents/Info.plist`], { encoding: "utf8" })).CFBundleShortVersionString;
const REAL_BACKUP = path.join(os.homedir(), ".local/share/t3-sidebar-keeper/backups", `${BUILD}.json.gz`);
process.env.T3_ASAR_PATH = asar;
process.env.T3_KEEPER_HOME = path.join(tmp, "home");
process.env.T3_KEEPER_QUIET = "1";
process.env.T3_USER_DATA_DIR = path.join(tmp, "userdata");
process.env.T3_TEMP_DIR = path.join(tmp, "tempdir");
fs.mkdirSync(process.env.T3_KEEPER_HOME);
const loaderPair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.T3X_LOADER_KEY = path.join(tmp, "loader-key.json");
fs.writeFileSync(process.env.T3X_LOADER_KEY, `${JSON.stringify({ spki: loaderPair.publicKey.export({ type: "spki", format: "der" }).toString("base64") })}\n`, { mode: 0o600 });
const K = await import("../keeper.mjs");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

if (fs.existsSync(REAL_BACKUP)) {
  const backup = JSON.parse(zlib.gunzipSync(fs.readFileSync(REAL_BACKUP)).toString("utf8"));
  const fd = fs.openSync(pristine, "r+");
  try {
    const items = Object.entries(backup.files).map(([rel, info]) => ({ rel, buf: Buffer.from(info.base64, "base64") }));
    K.writeEntries(fd, K.readLayout(fd), items);
  } finally {
    fs.closeSync(fd);
  }
}

const fresh = () => {
  fs.rmSync(asar, { force: true });
  fs.rmSync(path.join(process.env.T3_KEEPER_HOME, "disabled.json"), { force: true });
  execFileSync("/bin/cp", ["-c", pristine, asar]);
};

function loadExtractor(code = K.ANTIGRAVITY_QUESTIONS_HELPER) {
  const fn = vm.runInNewContext(`${code}\nt3KeeperAntigravityElicitationForm;`, {});
  return (req) => {
    const out = fn(req);
    if (!out) return out;
    return {
      questions: structuredClone(out.questions),
      respond: (answers) => structuredClone(out.respond(answers)),
    };
  };
}

function flavorFixture(extraProp = "", before = "") {
  return `${before}function makeAntigravityAcpAdapterFlavor(options) {
  return {
    driver: "antigravity",
    ${extraProp}extractPermissionQuestion: (request) => request,
  };
}
/*
${" ".repeat(4500)}*/
/*
${" ".repeat(4500)}*/
`;
}

// ---------- AST patching, idempotence, upgrade, upstream yield ----------

test("antigravityQuestions patches a clean flavor, is pure ASCII, and is idempotent", () => {
  assert.match(K.ANTIGRAVITY_QUESTIONS_HELPER, /^[\x00-\x7f]*$/, "helper must stay pure ASCII");
  const src = flavorFixture();
  const first = K.unitAntigravityQuestions(src);
  assert.equal(first.state, "patched");
  const balanced = K.finishBinCli(first.text, Buffer.byteLength(src), false, ["t3KeeperAntigravityElicitationForm"]);
  assert.equal(Buffer.byteLength(balanced), Buffer.byteLength(src));
  assert.equal(K.unitAntigravityQuestions(balanced).state, "already");
  const ast = acorn.parse(balanced, { ecmaVersion: "latest", sourceType: "module" });
  const flavor = ast.body.find((n) => n.type === "FunctionDeclaration" && n.id.name === "makeAntigravityAcpAdapterFlavor");
  const ret = flavor.body.body.find((s) => s.type === "ReturnStatement");
  const prop = ret.argument.properties.find((p) => p.key?.name === "extractElicitationForm");
  assert.ok(prop && prop.value.type === "FunctionExpression" && prop.value.id?.name === "t3KeeperAntigravityElicitationForm");
});

test("antigravityQuestions yields cleanly when upstream T3 adds its own extractElicitationForm", () => {
  const direct = flavorFixture("extractElicitationForm: extractUpstreamAntigravityForm,\n    ");
  assert.deepEqual(K.unitAntigravityQuestions(direct), { state: "already", text: direct });
  const shorthand = flavorFixture("extractElicitationForm,\n    ");
  assert.deepEqual(K.unitAntigravityQuestions(shorthand), { state: "already", text: shorthand });
  const spread = flavorFixture("...(opts.v2 ? { extractElicitationForm: fnA } : { extractElicitationForm: fnB }),\n    ");
  assert.deepEqual(K.unitAntigravityQuestions(spread), { state: "already", text: spread });
  const mixedSpread = flavorFixture("...(opts.v2 ? { extractElicitationForm: fn } : {}),\n    ");
  assert.throws(() => K.unitAntigravityQuestions(mixedSpread), /changed shape/);
});

test("antigravityQuestions upgrades an older keeper helper in place and refuses corrupt states", () => {
  const src = flavorFixture();
  const patched = K.unitAntigravityQuestions(src).text;
  const older = patched.replace("/*t3-keeper-agq-1*/", "/*t3-keeper-agq-0*/\n\tvoid 0;");
  const upgraded = K.unitAntigravityQuestions(older);
  assert.equal(upgraded.state, "patched");
  assert.equal(upgraded.text, patched);
  // Orphan helper without property
  assert.throws(() => K.unitAntigravityQuestions(flavorFixture("", K.ANTIGRAVITY_QUESTIONS_HELPER)), /already appears unexpectedly/);
  // Property referencing missing identifier (stray keeper name)
  assert.throws(() => K.unitAntigravityQuestions(flavorFixture("extractElicitationForm: t3KeeperAntigravityElicitationForm,\n    ")), /no longer references keeper helper/);
  // Unknown helper body without keeper marker
  const foreign = patched.replace("/*t3-keeper-agq-1*/", "/*custom*/");
  assert.throws(() => K.unitAntigravityQuestions(foreign), /not a supported keeper helper/);
  // Missing flavor
  assert.throws(() => K.unitAntigravityQuestions("export const x = 1;\n"), /declared 0 times/);
});

// ---------- Extractor runtime behavior: single-select, multi-select, free-form, attachments ----------

test("single-select: folds q1 + q1_other, unlocks custom answers, handles click, write-in, and attachments", () => {
  const extract = loadExtractor();
  const form = extract({
    mode: "form",
    message: "The agent has a question.",
    requestedSchema: {
      type: "object",
      properties: {
        q1: {
          type: "string",
          title: "1. Hosting: Where should the podcast page live? Blocks publishing.",
          oneOf: [
            { const: "opt_a", title: "Tailnet (Recommended) — Private to your devices; Opus and Astra agree." },
            { const: "opt_b", title: "GitHub Pages – Public static site" },
            { const: "opt_c", title: "Explain and ask me more" },
          ],
        },
        q1_other: {
          type: "string",
          title: "Other",
          description: "Optional free-form answer to: 1. Hosting: Where should the podcast page live? Blocks publishing.",
        },
      },
    },
  });
  assert.ok(form);
  assert.equal(form.questions.length, 1);
  const [q] = form.questions;
  assert.equal(q.id, "q1");
  assert.equal(q.header, "1. Hosting");
  assert.equal(q.question, "Where should the podcast page live? Blocks publishing.");
  assert.equal(q.allowCustomAnswer, undefined);
  assert.equal(q.multiSelect, undefined);
  assert.deepEqual(q.options, [
    { label: "Tailnet (Recommended)", description: "Private to your devices; Opus and Astra agree.", value: "opt_a" },
    { label: "GitHub Pages", description: "Public static site", value: "opt_b" },
    { label: "Explain and ask me more", description: "Explain and ask me more", value: "opt_c" },
  ]);

  // Option click
  assert.deepEqual(form.respond({ q1: "opt_a" }), { action: "accept", content: { q1: "opt_a" } });
  // Custom typed answer
  assert.deepEqual(form.respond({ q1: "Keep it local for now" }), { action: "accept", content: { q1_other: "Keep it local for now" } });
  // Option click + attachment appended by T3 server
  const att = 'Attached image "mock.png": "/tmp/mock.png"';
  assert.deepEqual(form.respond({ q1: `opt_a\n\n${att}` }), { action: "accept", content: { q1: "opt_a", q1_other: att } });
  // Multi-paragraph custom answer + attachment
  const customWithAtt = `First line\n\nSecond line\n\n${att}`;
  assert.deepEqual(form.respond({ q1: customWithAtt }), { action: "accept", content: { q1_other: customWithAtt } });
  // Attachment only (no option, no typed text)
  assert.deepEqual(form.respond({ q1: att }), { action: "accept", content: { q1_other: att } });
  // Empty/missing answers cancel
  assert.deepEqual(form.respond({ q1: "   " }), { action: "cancel" });
  assert.deepEqual(form.respond({}), { action: "cancel" });
});

test("multi-select: folds array/anyOf + q1_other, supports checkbox arrays, attachments, and custom write-ins", () => {
  const extract = loadExtractor();
  const form = extract({
    mode: "form",
    message: "The agent has a question.",
    requestedSchema: {
      type: "object",
      properties: {
        q1: {
          type: "array",
          title: "Scope — Which checks should run?",
          items: {
            anyOf: [
              { const: "lint", title: "Lint — ESLint + formatting" },
              { const: "unit", title: "Unit tests" },
              { const: "e2e", title: "End-to-end — Slow browser checks" },
            ],
          },
        },
        q1_other: {
          type: "string",
          title: "Other",
          description: "Optional free-form answer to: Scope — Which checks should run?",
        },
      },
    },
  });
  assert.ok(form);
  assert.equal(form.questions.length, 1);
  assert.equal(form.questions[0].header, "Scope");
  assert.equal(form.questions[0].question, "Which checks should run?");
  assert.equal(form.questions[0].multiSelect, true);
  assert.equal(form.questions[0].allowCustomAnswer, undefined);

  // Checked options (deduplicates)
  assert.deepEqual(form.respond({ q1: ["lint", "unit", "lint"] }), { action: "accept", content: { q1: ["lint", "unit"] } });
  // Checked options + T3 server-appended attachment element
  const att = 'Attached file "log.txt": "/tmp/log.txt"';
  assert.deepEqual(form.respond({ q1: ["lint", "e2e", att] }), { action: "accept", content: { q1: ["lint", "e2e"], q1_other: att } });
  // Custom text typed in composer (T3 sends a string even for multiSelect!)
  assert.deepEqual(form.respond({ q1: "Run only unit tests on macOS" }), { action: "accept", content: { q1_other: "Run only unit tests on macOS" } });
  // Single string matching an option const + attachment
  assert.deepEqual(form.respond({ q1: `unit\n\n${att}` }), { action: "accept", content: { q1: ["unit"], q1_other: att } });
  // Empty array or non-string element cancels
  assert.deepEqual(form.respond({ q1: [] }), { action: "cancel" });
  assert.deepEqual(form.respond({ q1: [123] }), { action: "cancel" });
});

test("free-form (qN_other only) and numerical q1..q10 ordering defeat Go lexicographical map sorting", () => {
  const extract = loadExtractor();
  const properties = {};
  // Deliberately insert in Go JSON sorted key order: q1, q10, q10_other, q1_other, q2, ...
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    if (i === 5) keys.push(`q${i}_other`);
    else keys.push(`q${i}`, `q${i}_other`);
  }
  keys.sort();
  for (const key of keys) {
    const n = Number(/^q(\d+)/.exec(key)[1]);
    if (n === 5) {
      properties[key] = { type: "string", title: "5. Notes: Any extra comments?" };
    } else if (key.endsWith("_other")) {
      properties[key] = { type: "string", title: "Other", description: `Optional free-form answer to: Question #${n}` };
    } else {
      properties[key] = { type: "string", title: `Plain prompt #${n}?`, oneOf: [{ const: `v${n}`, title: `Choice ${n}` }] };
    }
  }
  const form = extract({ mode: "form", message: "The agent has 10 questions.", requestedSchema: { type: "object", properties } });
  assert.ok(form);
  assert.deepEqual(form.questions.map((q) => q.id), ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10"]);
  assert.equal(form.questions[0].header, "Question 1");
  assert.equal(form.questions[4].header, "5. Notes");
  assert.equal(form.questions[4].question, "Any extra comments?");
  assert.deepEqual(form.questions[4].options, []);
  assert.equal(form.questions[9].header, "Question 10");

  const answers = Object.fromEntries(form.questions.map((q, idx) => [q.id, idx === 4 ? "Ship it" : `v${idx + 1}`]));
  const res = form.respond(answers);
  assert.equal(res.action, "accept");
  assert.equal(res.content.q5_other, "Ship it");
  assert.equal(res.content.q5, undefined);
  assert.equal(res.content.q10, "v10");
});

test("header and option parsing handles waiting prefix, brackets, middots, and refuses false positives", () => {
  const extract = loadExtractor();
  const one = (title, optTitle = "Yes") => extract({
    mode: "form",
    message: "The agent has a question.",
    requestedSchema: {
      type: "object",
      properties: {
        q1: { type: "string", title, oneOf: [{ const: "y", title: optTitle }] },
        q1_other: { type: "string", title: "Other" },
      },
    },
  }).questions[0];

  assert.deepEqual([one("1. Confirm — Should we ship it?").header, one("1. Confirm — Should we ship it?").question], ["1. Confirm", "Should we ship it?"]);
  assert.deepEqual([one("1. Confirm - Should we ship it?").header, one("1. Confirm - Should we ship it?").question], ["1. Confirm", "Should we ship it?"]);
  assert.deepEqual([one("1. Confirm · Should we ship it?").header, one("1. Confirm · Should we ship it?").question], ["1. Confirm", "Should we ship it?"]);
  assert.deepEqual([one("[2. Theme] Pick dark or light?").header, one("[2. Theme] Pick dark or light?").question], ["2. Theme", "Pick dark or light?"]);
  assert.deepEqual(
    [one("I'm waiting on you now: 1. Confirm — Should we ship it?").header, one("I'm waiting on you now: 1. Confirm — Should we ship it?").question],
    ["1. Confirm", "I'm waiting on you now: Should we ship it?"],
  );
  assert.deepEqual(
    [one("1. Confirm: I'm waiting on you now: Should we ship it?").header, one("1. Confirm: I'm waiting on you now: Should we ship it?").question],
    ["1. Confirm", "I'm waiting on you now: Should we ship it?"],
  );
  // Waiting prefix alone must NOT become the header!
  assert.deepEqual(
    [one("I'm waiting on you now: Which theme do you want?").header, one("I'm waiting on you now: Which theme do you want?").question],
    ["Question", "I'm waiting on you now: Which theme do you want?"],
  );
  assert.deepEqual([one("Optional: Also update README?").header, one("Optional: Also update README?").question], ["Optional", "Also update README?"]);
  assert.deepEqual([one("Optional - Also update README?").header, one("Optional - Also update README?").question], ["Optional", "Also update README?"]);
  // False-positive guards
  assert.deepEqual([one("Use dark - or light theme?").header, one("Use dark - or light theme?").question], ["Question", "Use dark - or light theme?"]);
  assert.deepEqual([one("Open http://localhost:3000 now?").header, one("Open http://localhost:3000 now?").question], ["Question", "Open http://localhost:3000 now?"]);
  // Option splitting guards: bare hyphen and numeric em-dash must NOT split
  assert.deepEqual(one("Pick one?", "Auto-hide in narrow windows").options[0], { label: "Auto-hide in narrow windows", description: "Auto-hide in narrow windows", value: "y" });
  assert.deepEqual(one("Pick one?", "Mac - dark mode").options[0], { label: "Mac - dark mode", description: "Mac - dark mode", value: "y" });
  assert.deepEqual(one("Pick one?", "2 — 4 hours").options[0], { label: "2 — 4 hours", description: "2 — 4 hours", value: "y" });
});

test("non-Antigravity or malformed schemas return undefined to fall back to parseElicitationForm", () => {
  const extract = loadExtractor();
  assert.equal(extract({ mode: "url", url: "https://example.com" }), undefined);
  assert.equal(extract({ mode: "form", requestedSchema: { type: "object", properties: {} } }), undefined);
  // Required fields present (Antigravity omits required)
  assert.equal(extract({
    mode: "form",
    requestedSchema: {
      type: "object",
      required: ["q1"],
      properties: {
        q1: { type: "string", title: "Pick", oneOf: [{ const: "a", title: "A" }] },
        q1_other: { type: "string", title: "Other" },
      },
    },
  }), undefined);
  // Missing companion q1_other
  assert.equal(extract({
    mode: "form",
    requestedSchema: { type: "object", properties: { q1: { type: "string", title: "Pick", oneOf: [{ const: "a", title: "A" }] } } },
  }), undefined);
  // Unknown property key
  assert.equal(extract({
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        q1: { type: "string", title: "Pick", oneOf: [{ const: "a", title: "A" }] },
        q1_other: { type: "string", title: "Other" },
        extra: { type: "string", title: "Extra" },
      },
    },
  }), undefined);
  // Non-contiguous numbering (q1, q3)
  assert.equal(extract({
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        q1: { type: "string", title: "A?", oneOf: [{ const: "a", title: "A" }] },
        q1_other: { type: "string", title: "Other" },
        q3: { type: "string", title: "B?", oneOf: [{ const: "b", title: "B" }] },
        q3_other: { type: "string", title: "Other" },
      },
    },
  }), undefined);
  // Duplicate const values
  assert.equal(extract({
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        q1: { type: "string", title: "A?", oneOf: [{ const: "dup", title: "A" }, { const: "dup", title: "B" }] },
        q1_other: { type: "string", title: "Other" },
      },
    },
  }), undefined);
});

// ---------- Real installed app.asar integration ----------

test("patches the real installed server bundle, preserves exact bytes, parses with acorn, and runs live", () => {
  fresh();
  const beforeInspect = K.inspect(asar);
  assert.equal(beforeInspect.results.antigravityQuestions.state, "patched");
  const serverRel = beforeInspect.targets.antigravityFlavor ?? beforeInspect.targets.delegatedTitles;
  assert.ok(serverRel, "server bundle target found");

  const first = K.apply({ reason: "agq-integration" });
  assert.equal(first.results.antigravityQuestions.state, "patched");
  assert.equal(fs.statSync(asar).size, fs.statSync(pristine).size);

  const fd = fs.openSync(asar, "r");
  let serverSrc;
  try {
    const layout = K.readLayout(fd);
    serverSrc = K.readEntry(fd, layout, serverRel).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const ast = acorn.parse(serverSrc, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const flavorNode = ast.body.find((n) => n.type === "FunctionDeclaration" && n.id?.name === "makeAntigravityAcpAdapterFlavor");
  const ret = flavorNode.body.body.find((s) => s.type === "ReturnStatement");
  const extractProp = ret.argument.properties.find((p) => p.key?.name === "extractElicitationForm");
  assert.ok(extractProp && extractProp.value.type === "FunctionExpression" && extractProp.value.id?.name === "t3KeeperAntigravityElicitationForm");

  // Execute the actual extracted helper from the patched server bundle!
  const liveExtract = loadExtractor(serverSrc.slice(extractProp.value.start, extractProp.value.end));
  const form = liveExtract({
    mode: "form",
    message: "The agent has a question.",
    requestedSchema: {
      type: "object",
      properties: {
        q1: { type: "string", title: "1. Restart: Quit and reopen T3 Code?", oneOf: [{ const: "yes", title: "Done — Restarted T3" }] },
        q1_other: { type: "string", title: "Other", description: "Optional free-form answer to: 1. Restart: Quit and reopen T3 Code?" },
      },
    },
  });
  assert.equal(form.questions.length, 1);
  assert.equal(form.questions[0].header, "1. Restart");
  assert.equal(form.questions[0].options[0].label, "Done");
  assert.equal(form.questions[0].options[0].description, "Restarted T3");
  assert.deepEqual(form.respond({ q1: "yes" }), { action: "accept", content: { q1: "yes" } });

  // Second pass is idempotent for antigravityQuestions
  const second = K.inspect(asar);
  assert.equal(second.results.antigravityQuestions.state, "already");
  assert.equal(second.files.delegatedTitles, undefined);
});

test("antigravityQuestions still patches server bundle cleanly when fit is disabled or fails", () => {
  fresh();
  fs.writeFileSync(path.join(process.env.T3_KEEPER_HOME, "disabled.json"), JSON.stringify({ disabled: ["fit"] }));
  const dis = K.inspect(asar);
  assert.equal(dis.results.fit.state, dis.targets.binCli ? "disabled" : "failed");
  assert.equal(dis.results.antigravityQuestions.state, "patched");
  const disFile = dis.files.delegatedTitles ?? dis.files.antigravityFlavor;
  assert.ok(disFile);
  const disSrc = disFile.buf.toString("utf8");
  assert.ok(disSrc.includes("function t3KeeperAntigravityElicitationForm("));
  assert.ok(!disSrc.includes("function t3KeeperFitTitle("));

  // Break threadTitle so fit fails; antigravityQuestions must still succeed cleanly
  fresh();
  const fd = fs.openSync(asar, "r+");
  try {
    const layout = K.readLayout(fd);
    const rel = K.findTargets(fd, layout).delegatedTitles;
    if (rel) {
      const orig = K.readEntry(fd, layout, rel);
      const broken = Buffer.from(orig.toString("utf8").replace("function threadTitle(", "function otherTitlex("));
      assert.equal(broken.length, orig.length);
      K.writeEntries(fd, layout, [{ rel, buf: broken }]);
    }
  } finally {
    fs.closeSync(fd);
  }
  const res = K.inspect(asar);
  assert.equal(res.results.fit.state, "failed");
  assert.equal(res.results.antigravityQuestions.state, "patched");
  const agqFile = res.files.antigravityFlavor ?? res.files.delegatedTitles;
  assert.ok(agqFile);
  const srvSrc = agqFile.buf.toString("utf8");
  assert.ok(srvSrc.includes("function t3KeeperAntigravityElicitationForm("));
  assert.ok(!srvSrc.includes("function t3KeeperFitTitle("));
  if (res.files.binCli) assert.ok(!res.files.binCli.buf.toString("utf8").includes("function t3KeeperFitTitle("));
});

// ---------- Sol review adversarial regressions ----------

function syntheticAsar(servers) {
  const pad = (size) => `/*\n${" ".repeat(size)}*/`;
  const runtime = [
    "const MAX_THREAD_TITLE_CHARS = 40;",
    "function sanitizeThreadTitle(t){return t.slice(0,MAX_THREAD_TITLE_CHARS);}",
    "function subagentThreadTitle(t){return t;}",
    pad(10000),
  ].join("\n");
  const entries = { "runtimeLayer-x.mjs": runtime, ...servers };
  let offset = 0;
  const archiveEntries = {};
  for (const [name, source] of Object.entries(entries)) {
    const size = Buffer.byteLength(source);
    archiveEntries[name] = { size, offset: String(offset) };
    offset += size;
  }
  const json = Buffer.from(JSON.stringify({
    files: { apps: { files: { server: { files: { dist: { files: archiveEntries } } } } } },
  }));
  const header = Buffer.alloc(16 + Math.ceil(json.length / 4) * 4);
  [4, header.length - 8, header.length - 12, json.length].forEach((v, i) => header.writeUInt32LE(v, i * 4));
  json.copy(header, 16);
  const outPath = path.join(tmp, `synth-${crypto.randomUUID()}.asar`);
  fs.writeFileSync(outPath, Buffer.concat([header, ...Object.values(entries).map((s) => Buffer.from(s))]));
  return outPath;
}

test("Sol regressions: separate server chunks, tight byte budget isolation, comments, whitespace/attachment consts, and 1-char/4-word headers", () => {
  fresh();
  const pad = (n) => `/*\n${" ".repeat(n)}*/`;
  const flavorSrc = (prefix = "") => `function makeAntigravityAcpAdapterFlavor(){return {driver:1,${prefix}extractPermissionQuestion:f}}\n`;
  const titleSrc = "function threadTitle(t){return t;}\n";

  // 1. Separate server chunks in both file orders
  for (const [a, b] of [[flavorSrc(), titleSrc], [titleSrc, flavorSrc()]]) {
    const file = syntheticAsar({ "server-a.mjs": a + pad(10000), "server-b.mjs": b + pad(10000) });
    const res = K.inspect(file);
    assert.deepEqual([res.results.fit.state, res.results.antigravityQuestions.state], ["patched", "patched"]);
    assert.ok(res.files.delegatedTitles && res.files.antigravityFlavor);
  }

  // 2. Shared server chunk with room for fit alone (8000 B) preserves fit while only antigravityQuestions fails
  const tight = syntheticAsar({ "server-x.mjs": titleSrc + flavorSrc() + pad(8000) });
  const tightRes = K.inspect(tight);
  assert.equal(tightRes.results.fit.state, "patched");
  assert.equal(tightRes.results.antigravityQuestions.state, "failed");
  assert.ok(tightRes.files.delegatedTitles.buf.toString("utf8").includes("function t3KeeperFitTitle("));
  assert.ok(!tightRes.files.delegatedTitles.buf.toString("utf8").includes("function t3KeeperAntigravityElicitationForm("));

  // 3. Comment mentioning extractElicitationForm does NOT suppress patching
  assert.equal(K.unitAntigravityQuestions(flavorSrc("/* TODO extractElicitationForm */ ") + pad(10000)).state, "patched");

  // 4. Numbered 4-word topic, 1-char option label, whitespace const, and attachment-like const substring
  const extract = loadExtractor();
  const make = (title, optTitle, value = "x") => extract({
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        q1: { type: "string", title, oneOf: [{ const: value, title: optTitle }] },
        q1_other: { type: "string", title: "Other" },
      },
    },
  });
  assert.equal(make("1. Who can see it: Publish now?", "Publish").questions[0].header, "1. Who can see it");
  assert.deepEqual(
    [make("Pick one?", "A — Use the first option").questions[0].options[0].label, make("Pick one?", "A — Use the first option").questions[0].options[0].description],
    ["A", "Use the first option"],
  );
  assert.deepEqual(make("Pick one?", "Blank", " ").respond({ q1: " " }), { action: "accept", content: { q1: " " } });
  const tricky = 'key\n\nAttached image "old": "old"';
  const att = 'Attached image "new": "new"';
  assert.deepEqual(make("Pick one?", "Option", tricky).respond({ q1: `${tricky}\n\n${att}` }), {
    action: "accept",
    content: { q1: tricky, q1_other: att },
  });

  // 5. Round 2 regressions: split-fit rollback replays Antigravity in BOTH directions
  const baseRuntime = [
    "const MAX_THREAD_TITLE_CHARS = 40;",
    "function sanitizeThreadTitle(t){return t.slice(0,MAX_THREAD_TITLE_CHARS);}",
    "function subagentThreadTitle(t){return t;}",
    "",
  ].join("\n");
  // 5a. Runtime chunk holds flavor + 8000 B pad, delegated-title chunk has 0 pad
  const splitA = syntheticAsar({
    "runtimeLayer-x.mjs": baseRuntime + flavorSrc() + pad(8000),
    "server-a.mjs": titleSrc,
  });
  const resA = K.inspect(splitA);
  assert.equal(resA.results.fit.state, "failed");
  assert.equal(resA.results.antigravityQuestions.state, "patched");
  assert.ok(resA.files.binCli.buf.toString("utf8").includes("function t3KeeperAntigravityElicitationForm("));
  assert.ok(!resA.files.binCli.buf.toString("utf8").includes("function t3KeeperFitTitle("));

  // 5b. Symmetric: runtime chunk has 0 pad (fit fails first), server chunk holds title + flavor + 8000 B pad
  const splitB = syntheticAsar({
    "runtimeLayer-x.mjs": baseRuntime,
    "server-a.mjs": titleSrc + flavorSrc() + pad(8000),
  });
  const resB = K.inspect(splitB);
  assert.equal(resB.results.fit.state, "failed");
  assert.equal(resB.results.antigravityQuestions.state, "patched");
  assert.ok(resB.files.delegatedTitles.buf.toString("utf8").includes("function t3KeeperAntigravityElicitationForm("));
  assert.ok(!resB.files.delegatedTitles.buf.toString("utf8").includes("function t3KeeperFitTitle("));

  // 6. Comment-only earlier server chunk never shadows real flavor declaration
  const commentShadow = syntheticAsar({
    "server-a.mjs": titleSrc + "// function makeAntigravityAcpAdapterFlavor(\n" + pad(10000),
    "server-b.mjs": flavorSrc() + pad(10000),
  });
  const shadowRes = K.inspect(commentShadow);
  assert.equal(shadowRes.targets.antigravityFlavor, "apps/server/dist/server-b.mjs");
  assert.equal(shadowRes.results.antigravityQuestions.state, "patched");

  // 7. Nested spread property does not suppress patching; computed literal key & top-level spread yield cleanly
  assert.equal(K.unitAntigravityQuestions(flavorSrc("...{metadata:{extractElicitationForm:f}},")).state, "patched");
  assert.equal(K.unitAntigravityQuestions(flavorSrc('["extractElicitationForm"]:f,')).state, "already");
  assert.equal(K.unitAntigravityQuestions(flavorSrc("[`extractElicitationForm`]:f,")).state, "already");
  assert.equal(K.unitAntigravityQuestions(flavorSrc("...{extractElicitationForm:f},")).state, "already");

  // 8. Documented numbered topics accept 1-char, non-ASCII, dotted, punctuation-leading, and dashed topics
  for (const topic of ["A", "Équipe", "日本語", "Node.js", ".NET", ".env", "UI – iOS"]) {
    const q = make(`1. ${topic}: Publish now?`, "Publish").questions[0];
    assert.deepEqual([q.header, q.question], [`1. ${topic}`, "Publish now?"]);
  }
  const waitDotNet = make("I'm waiting on you now: 1. .NET: Use version 10?", "Use 10").questions[0];
  assert.deepEqual([waitDotNet.header, waitDotNet.question], ["1. .NET", "I'm waiting on you now: Use version 10?"]);
  assert.equal(make("1. ---: Publish now?", "Publish").questions[0].header, "Question");

  // 9. Round 3 & 4 regressions: opaque/dynamic spreads & computed keys refuse safely instead of guessing
  const opaqueCases = [
    [
      "const upstream = () => {}; const shared = { extractElicitationForm: upstream }; const alias = shared;",
      "function makeAntigravityAcpAdapterFlavor() { const shared = {}; return { driver: 1, ...alias, extractPermissionQuestion() {} }; }",
    ].join("\n"),
    flavorSrc("...({extractElicitationForm(){}} && {}),"),
    flavorSrc("...((0 && {}) && {extractElicitationForm(){}}),"),
    [
      "const enabled = false;",
      "function makeAntigravityAcpAdapterFlavor() {",
      "  { var enabled = true; }",
      "  return { driver: 1, ...(enabled && { extractElicitationForm() {} }), extractPermissionQuestion() {} };",
      "}",
    ].join("\n"),
    flavorSrc("[dynamicKey]: f,"),
    flavorSrc("[/hook/]: f,"),
    flavorSrc("__proto__: { extractElicitationForm: f },"),
    "function makeAntigravityAcpAdapterFlavor(a) { if (a) return { driver: 1, extractPermissionQuestion() {} }; return { driver: 1, extractElicitationForm: f, extractPermissionQuestion() {} }; }",
  ];
  for (const src of opaqueCases) {
    assert.throws(() => K.unitAntigravityQuestions(src), /changed shape/);
  }
  // Later literal spread shadowing our keeper helper refuses instead of reporting already
  const shadowedKeeper = K.unitAntigravityQuestions(flavorSrc()).text
    .replace("extractPermissionQuestion:f", "extractPermissionQuestion:f, ...{ extractElicitationForm: upstream }");
  assert.throws(() => K.unitAntigravityQuestions(shadowedKeeper), /shadowed by a spread/);
  // Round 6 & 7 regressions: inlined FunctionExpression is immune to param/local shadowing, reassignment, and direct eval
  const patchedBase = K.unitAntigravityQuestions("function makeAntigravityAcpAdapterFlavor(f) { return {driver:1,extractPermissionQuestion:f}; }").text;
  const fnName = "t3KeeperAntigravityElicitationForm";
  for (const mutated of [
    patchedBase.replace("Flavor(f)", `Flavor(f, ${fnName} = 0)`),
    patchedBase.replace("Flavor(f) {", `Flavor(f) { const ${fnName} = 0;`),
    patchedBase.replace("Flavor(f) {", "Flavor(f) { const \\u00743KeeperAntigravityElicitationForm = 0;"),
    `${patchedBase}\nvar ${fnName} = 0;`,
    `${patchedBase}\neval("t3KeeperAntigravity" + "ElicitationForm = 0");`,
  ]) {
    const out = K.unitAntigravityQuestions(mutated);
    assert.equal(out.state, "already");
    const hook = vm.runInNewContext(`${out.text}\nmakeAntigravityAcpAdapterFlavor(null).extractElicitationForm`);
    assert.equal(typeof hook, "function");
    assert.equal(hook.name, fnName);
  }
  // Plain nested literal spread with extractElicitationForm still yields cleanly
  assert.equal(K.unitAntigravityQuestions(flavorSrc("...{ ...{ extractElicitationForm: f } },")).state, "already");

  const commentFit = syntheticAsar({
    "runtimeLayer-x.mjs": baseRuntime + "// function threadTitle(\n" + pad(16000),
    "server-a.mjs": titleSrc + flavorSrc() + pad(16000),
  });
  const commentFitRes = K.inspect(commentFit);
  assert.equal(commentFitRes.targets.delegatedTitles, "apps/server/dist/server-a.mjs");
  assert.deepEqual([commentFitRes.results.fit.state, commentFitRes.results.antigravityQuestions.state], ["patched", "patched"]);
});
