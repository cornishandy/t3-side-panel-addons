/**
 * Create the add-ons signing key (installer only) and sign the bytes the loader checks.
 * The private key never goes to the running service. A bad or borrowed key is refused;
 * this script does not delete one and make another.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { payloadVersion, signedBytes } from "./payload.mjs";

const KEY_NAME = "signing-key.pem";
const PUB_NAME = "loader-key.json";

function fail(message) {
  const error = new Error(message);
  error.code = "T3X_KEY";
  throw error;
}

function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function modeOk(st) {
  return (st.mode & 0o777) === 0o600 && st.uid === process.getuid();
}

function writeAtomic(dest, data) {
  const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(tmp, flags, 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  const out = fs.openSync(dest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.fchmodSync(out, 0o600);
  } finally {
    fs.closeSync(out);
  }
}

function readPublic(file) {
  const st = lstat(file);
  if (!st || st.isSymbolicLink() || !st.isFile()) fail(`${path.basename(file)} is missing or not a regular file`);
  const raw = fs.readFileSync(file, "utf8");
  let spki;
  try {
    spki = JSON.parse(raw).spki;
  } catch {
    fail("loader-key.json is not the public key");
  }
  if (typeof spki !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(spki)) fail("loader-key.json is not SPKI base64");
  return spki;
}

/**
 * Return { spki, privateKey } for `dir`, creating the pair only when both files are absent.
 * A private key with no loader-key.json gets its public key derived. Anything else inconsistent
 * is refused.
 */
export function ensureKey(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const keyPath = path.join(dir, KEY_NAME);
  const pubPath = path.join(dir, PUB_NAME);
  const keyStat = lstat(keyPath);
  const pubStat = lstat(pubPath);
  if (keyStat?.isSymbolicLink()) fail("signing key is a symlink; refusing to sign");
  if (pubStat?.isSymbolicLink()) fail("loader-key.json is a symlink; refusing to sign");
  if (keyStat && (!keyStat.isFile() || !modeOk(keyStat))) fail("signing key must be a regular file, mode 0600, owned by you");
  if (pubStat && (!pubStat.isFile() || !modeOk(pubStat))) fail("loader-key.json must be a regular file, mode 0600, owned by you");

  if (!keyStat && pubStat) fail("loader-key.json exists without its private key; refusing to replace either");
  if (!keyStat && !pubStat) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    writeAtomic(keyPath, pem);
    writeAtomic(pubPath, `${JSON.stringify({ spki })}\n`);
    return { spki, privateKey };
  }

  const pem = fs.readFileSync(keyPath, "utf8");
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(pem);
  } catch {
    fail("signing key could not be read; refusing to replace it");
  }
  const derived = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
  if (!pubStat) {
    writeAtomic(pubPath, `${JSON.stringify({ spki: derived })}\n`);
    return { spki: derived, privateKey };
  }
  const spki = readPublic(pubPath);
  if (spki !== derived) fail("signing key and loader-key.json do not match; refusing to replace either");
  return { spki, privateKey };
}

export function signPayload(privateKey, version, css, js) {
  return crypto.sign("sha256", signedBytes(version, css, js), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
}

/** Sign the css and js that the service will serve from `dir/public`. */
export function signInstalled(dir) {
  const { privateKey } = ensureKey(dir);
  const js = fs.readFileSync(path.join(dir, "public", "extras.js"));
  const css = fs.readFileSync(path.join(dir, "public", "extras.css"));
  const version = payloadVersion(js, css);
  const sig = signPayload(privateKey, version, css, js);
  writeAtomic(path.join(dir, "public", "extras.sig"), `${sig}\n`);
  return { version, sig };
}

const isMain = process.argv[1]
  && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: sign.mjs DIR");
    process.exit(2);
  }
  try {
    const { version } = signInstalled(dir);
    console.log(`signed extras ${version}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
