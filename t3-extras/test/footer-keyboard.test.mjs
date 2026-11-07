// Trusted keyboard regression for the same footerPass that ensure/change call.
// File fixture only: no T3 session, installed add-on, HTTP server or user profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

export async function probeFooterKeyboard({ outDir, sourceRoot = new URL('../public/', import.meta.url), chromePath } = {}) {
  const dir = await fs.mkdtemp(path.join(outDir || os.tmpdir(), 'footer-keyboard-'));
  if (!chromePath) {
    const root = path.join(os.homedir(), '.t3/tools/chrome-headless-shell/mac-arm64');
    const versions = (await fs.readdir(root)).filter(v => /^\d+(\.\d+)+$/.test(v)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    chromePath = path.join(root, versions[0], 'chrome-headless-shell');
  }
  const [js, css] = await Promise.all(['extras.js', 'extras.css'].map(name => fs.readFile(new URL(name, sourceRoot), 'utf8')));
  const file = path.join(dir, 'fixture.html');
  await fs.writeFile(file, `<!doctype html><html data-t3x-footer-team="always-show"><style>${css}</style><body>
    <div class="chat-markdown" id="reply"><hr><div class="chat-markdown-table-container"><table><thead><tr><th><span itemprop="settle-yes">Safe</span></th><th></th><th></th></tr></thead></table></div><div id="team"></div></div>
    <div data-markdown-details data-markdown-details-open="true" id="other"><button data-markdown-details-summary>Other summary</button><div>Other panel</div></div>
    <script>window.__T3X_TEST__={};</script><script>${js.replaceAll('</script', '<\\/script')}</script><script>
    const seen = new WeakSet(); window.mode = 'always-show'; window.closeCount = 0; window.focusLoss = 0; window.trustedKeys = [];
    document.addEventListener('keydown', e => { if (e.isTrusted) trustedKeys.push(e.key); }, true);
    function wire(el) {
      const btn = el.querySelector('button');
      btn.addEventListener('blur', () => window.focusLoss++);
      const toggle = () => {
        const open = el.getAttribute('data-markdown-details-open') === 'true';
        el.setAttribute('data-markdown-details-open', String(!open));
        if (open) { el.querySelector('.panel').remove(); window.closeCount++; }
        else { const panel = document.createElement('div'); panel.className = 'panel'; panel.textContent = 'Team body'; el.append(panel); }
      };
      btn.onclick = toggle;
      // React/Base UI style handlers, in addition to native button activation.
      btn.onkeydown = e => { if(e.key === 'Enter') { e.preventDefault(); toggle(); } };
      btn.onkeyup = e => { if(e.key === ' ') { e.preventDefault(); toggle(); } };
      return el;
    }
    window.newFooter = () => { const el = document.createElement('div'); el.setAttribute('data-markdown-details',''); el.setAttribute('data-markdown-details-open','false'); el.innerHTML = '<button data-markdown-details-summary><span>Team</span></button>'; document.querySelector('#team').append(el); return wire(el); };
    window.details = newFooter(); window.button = details.querySelector('button');
    document.querySelector('#other div').className = 'panel'; wire(document.querySelector('#other'));
    window.pass = next => { if(next) mode = next; document.documentElement.setAttribute('data-t3x-footer-team', mode); return __T3X_TEST__.core.footerPass(document, mode, seen); };
    window.state = () => ({ open: details.getAttribute('data-markdown-details-open') === 'true', samePanel: details.querySelector('.panel') === window.originalPanel, visible: !!details.querySelector('.panel')?.checkVisibility(), focused: document.activeElement === button, focusLoss: window.focusLoss, closed: window.closeCount });
    </script>`);
  const profile = path.join(dir, 'profile');
  const chrome = spawn(chromePath, ['--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const killTimer = setTimeout(() => chrome.kill('SIGKILL'), 25000);
  let socket;
  try {
    let stderr = '';
    const wsUrl = await new Promise((resolve, reject) => {
      chrome.stderr.on('data', x => { stderr += x; const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) resolve(m[1]); });
      chrome.once('error', reject);
      chrome.once('exit', () => reject(new Error(stderr)));
    });
    socket = new WebSocket(wsUrl); await once(socket, 'open');
    let id = 0; const pending = new Map();
    socket.addEventListener('message', e => { const r = JSON.parse(e.data); if (pending.has(r.id)) { const { resolve, reject } = pending.get(r.id); pending.delete(r.id); r.error ? reject(new Error(JSON.stringify(r.error))) : resolve(r.result); } });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const { targetId } = await send('Target.createTarget', { url: pathToFileURL(file).href });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cdp = (m, p) => send(m, p, sessionId);
    const evaluate = async expression => {
      const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value;
    };
    await cdp('Runtime.enable'); await cdp('Page.bringToFront');
    await evaluate(`new Promise(resolve => { if(document.readyState === 'complete') resolve(); else addEventListener('load', resolve, {once:true}); })`);
    const key = async k => {
      const fields = k === 'Enter' ? { key: k, code: 'Enter', windowsVirtualKeyCode: 13 } : { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 };
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...fields });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
    };
    // Initial pass installs the actual source guards BEFORE trusted keys.
    assert.equal(await evaluate('pass()'), 1, 'saved closed footer restored');
    await evaluate('window.originalPanel = details.querySelector(".panel"); button.focus()');
    const checks = [];
    for (const k of ['Enter', ' ']) {
      await key(k); const state = await evaluate('state()');
      assert.deepEqual(state, { open: true, samePanel: true, visible: true, focused: true, focusLoss: 0, closed: 0 });
      checks.push({ mode: 'always-show', key: k, ...state });
    }
    assert.equal(await evaluate('pass()'), 0, 'no repair click needed');
    assert.equal(await evaluate('button.querySelector("span").click(); window.closeCount'), 0, 'nested click also guarded');
    assert.equal(await evaluate('newFooter(); pass()'), 1, 'new closed reply restored');
    assert.equal(await evaluate('details.setAttribute("data-markdown-details-open", "false"); details.querySelector(".panel").remove(); pass()'), 1, 'late closed state restored');
    // No guard on other summaries.
    await evaluate('document.querySelector("#other button").focus()'); await key('Enter');
    assert.equal(await evaluate('document.querySelector("#other").getAttribute("data-markdown-details-open")'), 'false');
    for (const mode of ['start-open', 'start-folded']) {
      await evaluate(`pass(${JSON.stringify(mode)}); button.focus()`);
      for (const k of ['Enter', ' ']) {
        const before = await evaluate('state().open'); await key(k);
        const state = await evaluate('state()'); assert.equal(state.open, !before, `${mode} ${k} toggles`); assert.equal(state.focused, true);
        checks.push({ mode, key: k, ...state });
      }
      const before = await evaluate('state().open'); await evaluate('pass()');
      assert.equal(await evaluate('state().open'), before, `${mode} preserves user control on later pass`);
    }
    await evaluate('pass("always-show"); window.originalPanel = details.querySelector(".panel"); window.closeCount = 0; button.focus(); window.focusLoss = 0');
    for (const k of ['Enter', ' ']) await key(k);
    assert.deepEqual(await evaluate('state()'), { open: true, samePanel: true, visible: true, focused: true, focusLoss: 0, closed: 0 }, 'guard re-enabled after mode switches');
    const trustedKeys = await evaluate('trustedKeys'); assert.equal(trustedKeys.length, 9);
    const result = { fixturePath: file, sourceRoot: String(sourceRoot), scope: 'Synthetic T3-shaped unmounting collapsibles; actual source footerPass installs guards; trusted CDP Enter/Space; no repair between keys', checks, trustedKeys, savedClosedRestored: true, newClosedRestored: true, lateClosedRestored: true, unrelatedSummaryToggles: true, guardReenabled: true };
    if (outDir) await fs.writeFile(path.join(outDir, 'round2-keyboard.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    clearTimeout(killTimer); socket?.close();
    chrome.kill('SIGTERM'); if (chrome.exitCode === null && chrome.signalCode === null) await once(chrome, 'exit');
    await fs.rm(outDir ? profile : dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

if (!process.env.T3X_FOOTER_PROBE_ONLY) test('footer team list: trusted Enter and Space cannot close always-show; mode switches restore controls', { timeout: 30000 }, () => probeFooterKeyboard());
