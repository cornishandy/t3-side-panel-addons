// Real querySelectorAll: the Made fold and the team fold do not select each other.
// File fixture only. No T3 session, installed add-on, or user profile.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

function card() {
  return '<div class="chat-markdown-table-container"><table><thead><tr><th><span itemprop="settle-yes">Safe</span></th><th></th><th></th></tr></thead></table></div>';
}
function fold(id, made) {
  const summary = made ? '<span itemprop="made">Made so far</span> · 2:' : "Team";
  return `<div><div data-markdown-details id="${id}"><button data-markdown-details-summary>${summary}</button></div></div>`;
}

test("footer selectors: Made and team folds do not cross-match", { timeout: 30000 }, async () => {
  const root = path.join(os.homedir(), ".t3/tools/chrome-headless-shell/mac-arm64");
  const versions = (await fs.readdir(root)).filter((v) => /^\d+(\.\d+)+$/.test(v)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  const chromePath = path.join(root, versions[0], "chrome-headless-shell");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "footer-made-"));
  const js = await fs.readFile(new URL("../public/extras.js", import.meta.url), "utf8");
  const html = `<!doctype html><body>
    <div class="chat-markdown" id="both"><hr>${card()}${fold("made-both", true)}${fold("team-both", false)}</div>
    <div class="chat-markdown" id="made-only"><hr>${card()}${fold("made-solo", true)}</div>
    <div class="chat-markdown" id="team-only"><hr>${card()}${fold("team-solo", false)}</div>
    <div class="chat-markdown" id="stray"><div data-markdown-details id="stray-fold"><button data-markdown-details-summary>Not a footer</button></div></div>
    <div class="chat-markdown" id="two-col"><hr><div class="chat-markdown-table-container"><table><thead><tr><th>A</th><th>B</th></tr></thead></table></div>${fold("two-made", true)}${fold("two-team", false)}</div>
    <script>window.__T3X_TEST__={};</script><script>${js.replaceAll("</script", "<\\/script")}</script>
    <script>window.ids = sel => [...document.querySelectorAll(sel)].map(el => el.id).sort();</script>`;
  const file = path.join(dir, "fixture.html");
  await fs.writeFile(file, html);
  const chrome = spawn(chromePath, ["--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost", "--remote-debugging-port=0", "--user-data-dir=" + path.join(dir, "profile"), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 25000);
  let socket;
  try {
    let stderr = "";
    const wsUrl = await new Promise((resolve, reject) => {
      chrome.stderr.on("data", (chunk) => { stderr += chunk; const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) resolve(m[1]); });
      chrome.once("error", reject);
      chrome.once("exit", () => reject(new Error(stderr || "chrome exited")));
    });
    socket = new WebSocket(wsUrl);
    await once(socket, "open");
    let id = 0;
    const pending = new Map();
    socket.addEventListener("message", (e) => {
      const r = JSON.parse(e.data);
      if (!pending.has(r.id)) return;
      const { resolve, reject } = pending.get(r.id);
      pending.delete(r.id);
      r.error ? reject(new Error(JSON.stringify(r.error))) : resolve(r.result);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      socket.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await send("Target.createTarget", { url: pathToFileURL(file).href });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    await send("Runtime.enable", {}, sessionId);
    await evaluate("new Promise(resolve => { if (document.readyState === 'complete') resolve(); else addEventListener('load', resolve, { once: true }); })");
    const made = await evaluate("ids(__T3X_TEST__.core.FOOTER_MADE)");
    const team = await evaluate("ids(__T3X_TEST__.core.FOOTER_DETAILS)");
    assert.deepEqual(made, ["made-both", "made-solo"]);
    assert.deepEqual(team, ["team-both", "team-solo"]);
  } finally {
    clearTimeout(killTimer);
    socket?.close();
    chrome.kill("SIGTERM");
    if (chrome.exitCode === null && chrome.signalCode === null) await once(chrome, "exit");
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
