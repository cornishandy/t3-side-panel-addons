/**
 * The bytes the loader verifies: JSON.stringify(["t3x1", version, css, js]).
 * version is the same 16-hex digest /version serves for those exact bodies.
 */
import crypto from "node:crypto";

export function payloadVersion(js, css) {
  const j = Buffer.isBuffer(js) ? js : Buffer.from(String(js));
  const c = Buffer.isBuffer(css) ? css : Buffer.from(String(css));
  return crypto.createHash("sha256").update(j).update(c).digest("hex").slice(0, 16);
}

export function signedBytes(version, css, js) {
  const c = Buffer.isBuffer(css) ? css.toString("utf8") : String(css);
  const j = Buffer.isBuffer(js) ? js.toString("utf8") : String(js);
  return Buffer.from(JSON.stringify(["t3x1", String(version), c, j]), "utf8");
}
