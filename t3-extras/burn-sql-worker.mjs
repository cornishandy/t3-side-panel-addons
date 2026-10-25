/**
 * The burn tells' one SQLite reader, in a worker so the service can time it out (a busy timeout
 * alone doesn't bound a query). Each request opens T3's statev2.sqlite read-only (file:…?mode=ro),
 * runs one SELECT, and closes it: no transaction is ever held between ticks. Never writes.
 */
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// updated_at is ISO text ("2026-10-20T04:10:46.071Z"), so the cutoff is bound as ISO text too
// (datetime('now', …) gives "2026-10-20 03:31:00", which every same-day row sorts after).
const SQL = `SELECT thread_id AS t, provider AS p, provider_instance_id AS i,
  json_extract(payload_json, '$.nativeThreadRef.nativeId') AS n
  FROM orchestration_v2_projection_provider_threads
  WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`;

parentPort.on("message", ({ id, file, cutoff, limit }) => {
  let db = null;
  try {
    const url = pathToFileURL(file);
    url.search = "?mode=ro";
    db = new DatabaseSync(url, { readOnly: true, timeout: 500 });
    const rows = db.prepare(SQL).all(String(cutoff), Number(limit));
    parentPort.postMessage({ id, rows });
  } catch (error) {
    parentPort.postMessage({ id, error: typeof error?.code === "string" ? error.code : "sqlite" });
  } finally {
    try {
      db?.close();
    } catch {}
  }
});
