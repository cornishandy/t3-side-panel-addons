// The installer key: create once, derive a missing public key, refuse anything inconsistent.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureKey, signPayload } from "../sign.mjs";
import { payloadVersion } from "../payload.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-sign-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const mode = (file) => fs.lstatSync(file).mode & 0o777;

function pairDir(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

test("a new pair is mode 0600 and signs the css-then-js tuple", () => {
  const dir = pairDir("new");
  const { spki, privateKey } = ensureKey(dir);
  assert.equal(mode(path.join(dir, "signing-key.pem")), 0o600);
  assert.equal(mode(path.join(dir, "loader-key.json")), 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "loader-key.json"), "utf8")).spki, spki);
  const sig = signPayload(privateKey, "abc", "css", "js");
  const ok = crypto.verify(
    "sha256",
    Buffer.from(JSON.stringify(["t3x1", "abc", "css", "js"])),
    { key: privateKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(sig, "base64"),
  );
  assert.equal(ok, true);
  assert.equal(payloadVersion("js", "css"), crypto.createHash("sha256").update("js").update("css").digest("hex").slice(0, 16));
});

test("a private key with no loader-key.json gets its public key derived", () => {
  const dir = pairDir("derive");
  const first = ensureKey(dir);
  fs.rmSync(path.join(dir, "loader-key.json"));
  const again = ensureKey(dir);
  assert.equal(again.spki, first.spki);
  assert.equal(mode(path.join(dir, "loader-key.json")), 0o600);
});

test("a public key without its private key is refused and not replaced", () => {
  const dir = pairDir("public-only");
  const { spki } = ensureKey(dir);
  fs.rmSync(path.join(dir, "signing-key.pem"));
  assert.throws(() => ensureKey(dir), /without its private key/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "loader-key.json"), "utf8")).spki, spki);
  assert.equal(fs.existsSync(path.join(dir, "signing-key.pem")), false);
});

test("a mismatched pair, a symlink, and a 0644 key are refused without regeneration", () => {
  const dir = pairDir("refuse");
  ensureKey(dir);
  const pem = fs.readFileSync(path.join(dir, "signing-key.pem"));
  const pub = path.join(dir, "loader-key.json");
  fs.writeFileSync(pub, `${JSON.stringify({ spki: "AAAA" })}\n`, { mode: 0o600 });
  assert.throws(() => ensureKey(dir), /do not match/);
  assert.equal(fs.readFileSync(path.join(dir, "signing-key.pem")).equals(pem), true);
  fs.writeFileSync(pub, fs.readFileSync(pub)); // keep the bad public file in place
  const key = path.join(dir, "signing-key.pem");
  fs.chmodSync(key, 0o644);
  assert.throws(() => ensureKey(dir), /0600/);
  assert.equal(mode(key), 0o644);
  fs.chmodSync(key, 0o600);
  const other = path.join(dir, "other.pem");
  fs.writeFileSync(other, pem);
  fs.rmSync(key);
  fs.symlinkSync(other, key);
  assert.throws(() => ensureKey(dir), /symlink/);
  assert.equal(fs.readFileSync(other).equals(pem), true);
  assert.equal(fs.lstatSync(key).isSymbolicLink(), true);
});
