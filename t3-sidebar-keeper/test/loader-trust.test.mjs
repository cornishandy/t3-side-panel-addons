// The real loader string, against a spare-port listener. Port 8793 is never bound.
// A bad signature inserts nothing, so the fixture payload is not executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import vm from "node:vm";
import { once } from "node:events";
import * as K from "../keeper.mjs";
import { signedBytes } from "../../t3-extras/payload.mjs";

const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const spki = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const boot = K.extrasBoot(spki);
const inner = boot.slice(boot.indexOf(">") + 1, -"</script>".length);
const FIXTURE = "globalThis.fixturePayloadExecuted=true";
const CSS = "html{}";
const VERSION = "v1";

function sign(version, css, js, key = pair.privateKey) {
  return crypto.sign("sha256", signedBytes(version, css, js), { key, dsaEncoding: "ieee-p1363" }).toString("base64");
}

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  assert.notEqual(port, 8793);
  return { server, port };
}

async function runLoader(files) {
  const { server, port } = await listen((req, res) => {
    const body = files[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(body);
  });
  const head = [];
  const pending = [];
  const context = vm.createContext({
    document: {
      head: { append(...nodes) { head.push(...nodes); } },
      createElement: (tag) => ({ tag }),
      querySelectorAll: () => [],
    },
    window: { addEventListener() {} },
    fetch(url, opts) {
      const routed = String(url).replace("http://127.0.0.1:8793/", `http://127.0.0.1:${port}/`);
      assert.equal(routed.includes(":8793/"), false);
      const job = fetch(routed, opts);
      pending.push(job);
      return job;
    },
    Promise, crypto, atob, TextEncoder, Uint8Array,
    fixturePayloadExecuted: false,
  });
  try {
    vm.runInContext(inner, context);
    await Promise.all(pending);
    await new Promise((r) => setTimeout(r, 80));
    const script = head.find((n) => n.id === "t3x-js");
    if (script && script.textContent === FIXTURE) vm.runInContext(script.textContent, context);
    return { port, head, executed: context.fixturePayloadExecuted === true };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("the production loader still names port 8793 and is ASCII", () => {
  assert.match(inner, /http:\/\/127\.0\.0\.1:8793\//);
  assert.equal(inner.includes("<"), false);
  assert.match(inner, /^[\x20-\x7e]*$/);
  new vm.Script(inner);
});

test("a good signature inserts the add-ons and a bad one does not run the payload", async () => {
  const good = await runLoader({
    "/version": VERSION,
    "/extras.css": CSS,
    "/extras.js": FIXTURE,
    "/extras.sig": sign(VERSION, CSS, FIXTURE),
  });
  assert.equal(good.executed, true);
  assert.deepEqual(good.head.map((n) => [n.tag, n.id, n.textContent]), [["style", "t3x-css", CSS], ["script", "t3x-js", FIXTURE]]);

  const cases = {
    bad: { "/extras.sig": Buffer.from("not-the-signature").toString("base64") },
    other: { "/extras.sig": sign(VERSION, CSS, FIXTURE, other.privateKey) },
    missing: {},
    boundary: { "/extras.css": FIXTURE, "/extras.js": CSS, "/extras.sig": sign(VERSION, CSS, FIXTURE) },
    tamper: { "/extras.js": `${FIXTURE} ` },
  };
  for (const [name, over] of Object.entries(cases)) {
    const files = {
      "/version": VERSION,
      "/extras.css": CSS,
      "/extras.js": FIXTURE,
      "/extras.sig": sign(VERSION, CSS, FIXTURE),
      ...over,
    };
    if (name === "missing") delete files["/extras.sig"];
    const out = await runLoader(files);
    assert.equal(out.head.some((n) => n.id === "t3x-js" || n.id === "t3x-css"), false, name);
    assert.equal(out.executed, false, name);
  }
});
