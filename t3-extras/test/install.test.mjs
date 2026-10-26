// Installs only under T3X_EXTRAS_INSTALL_ROOT. No launchd, no port 8793, no font download.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { payloadVersion, signedBytes } from "../payload.mjs";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "t3x-extras-install-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

function run(root, extra = {}) {
  return spawnSync("/bin/bash", [path.join(src, "install.sh")], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, HOME: root, T3X_EXTRAS_INSTALL_ROOT: root, T3X_NODE: process.execPath, ...extra },
  });
}

test("a test-root install signs the served files and keeps the given node path", () => {
  const root = fs.mkdtempSync(path.join(scratch, "ok-"));
  const link = path.join(root, ".nvm", "node");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(fs.realpathSync(process.execPath), link);
  const result = run(root, { T3X_NODE: link });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Installed under the test root/);
  assert.match(result.stderr, /version manager/);
  assert.doesNotMatch(result.stdout + result.stderr, /Loaded com\.cornishandy\.t3-extras on/);
  const home = path.join(root, ".local/share/t3-extras");
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, "signing-key.pem")).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(path.join(home, "signing-key.pem")).isSymbolicLink(), false);
  const spki = JSON.parse(fs.readFileSync(path.join(home, "loader-key.json"), "utf8")).spki;
  const js = fs.readFileSync(path.join(home, "public/extras.js"));
  const css = fs.readFileSync(path.join(home, "public/extras.css"));
  const version = payloadVersion(js, css);
  const sig = fs.readFileSync(path.join(home, "public/extras.sig"), "utf8").trim();
  const key = crypto.createPrivateKey(fs.readFileSync(path.join(home, "signing-key.pem"), "utf8"));
  assert.equal(crypto.verify("sha256", signedBytes(version, css, js), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64")), true);
  assert.equal(crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64"), spki);
  const plist = JSON.parse(spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(root, "Library/LaunchAgents/com.cornishandy.t3-extras.plist")], { encoding: "utf8" }).stdout);
  assert.equal(plist.ProgramArguments[0], link);
  assert.equal(plist.EnvironmentVariables.PATH.split(":")[0], path.dirname(link));
  assert.equal(fs.existsSync(path.join(home, "public/grouping.js")), false);

  fs.rmSync(path.join(home, "loader-key.json"));
  const recovered = run(root, { T3X_NODE: link });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "loader-key.json"), "utf8")).spki, spki);

  const pem = fs.readFileSync(path.join(home, "signing-key.pem"));
  fs.writeFileSync(path.join(home, "loader-key.json"), `${JSON.stringify({ spki: "AAAA" })}\n`, { mode: 0o600 });
  const refused = run(root, { T3X_NODE: link });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /do not match/);
  assert.equal(fs.readFileSync(path.join(home, "signing-key.pem")).equals(pem), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "loader-key.json"), "utf8")).spki, "AAAA");
});
