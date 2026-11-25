// Nightly 5230 groups threads under project folders and draws each one as
// data-testid="sidebar-row-folder" (a slim row indented with ps-9, or a two-line
// "folder-multiline" variant). The selected thread marker must reach it.
// Real extras.css in headless Chrome; the predicates are the break check's own (extras.js checkRead).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const CSS = process.env.T3X_TEST_EXTRAS_CSS || path.join(SRC, 'public/extras.css');
// The break check's own outline-width test, taken from extras.js.
const WIDE_SRC = fs.readFileSync(path.join(SRC, 'public/extras.js'), 'utf8').match(/const markerOutlineWide = (\(w, dpr\) => \{[^\n]*\});/)[1];
const markerOutlineWide = vm.runInNewContext(WIDE_SRC);

// Andy's T3 on Nightly 5230 read the 2px outline back as 1.6px (check-in, 25 Nov 2026 08:35 UTC):
// Chrome snaps outline widths to whole device pixels. The check must still see it as the marker.
test('marker outline check allows for device-pixel snapping', () => {
  assert.equal(markerOutlineWide(1.6, 1.25), true, 'the reading from Andy\'s screen');
  assert.equal(markerOutlineWide(1.6, 1.875), true);
  for (const dpr of [1, 1.5, 2, 3]) assert.equal(markerOutlineWide(2, dpr), true, `unsnapped 2px at ${dpr}`);
  assert.equal(markerOutlineWide(1, 1), false, 'a 1px outline is not the marker');
  assert.equal(markerOutlineWide(1, 2), false);
  assert.equal(markerOutlineWide(0, 2), false);
  assert.equal(markerOutlineWide(2, 0), true, 'a missing ratio counts as 1');
});
function newestHeadlessChrome() {
  const root = path.join(os.homedir(), '.t3/tools/chrome-headless-shell/mac-arm64');
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter(v => /^\d+(\.\d+)+$/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  return path.join(root, versions[0] ?? 'missing', 'chrome-headless-shell');
}
// Row markup as Nightly 0.1.12-nightly.20261125.5230 renders it (main-BpjTpk0f.js).
const ROW = 'group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none';
function folderRow(id, { current = false, multiline = false } = {}) {
  const layout = multiline ? 'flex flex-col justify-center px-2.5 py-1.5 ps-9' : 'flex h-9 items-center gap-2.5 px-2.5 ps-9';
  return `<li data-thread-item="env:${id}" class="list-none"><div role="button" tabindex="0" data-sidebar-row="env:${id}" data-testid="sidebar-row-folder" ${current ? 'aria-current="page"' : ''} class="${ROW} ${layout}">
    <span id="${id}-title" class="min-w-0 flex-1 text-start text-sm">Thread ${id}</span></div></li>`;
}
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
@layer utilities {
:root { --font-sans:Arial,sans-serif; --sidebar-foreground:#eee; }
body { font:14px var(--font-sans); margin:0; } #side {width:260px;} ul {margin:0;padding:0;} .list-none {list-style:none;}
.relative {position:relative;} .w-full {width:100%;} .overflow-hidden {overflow:hidden;} .outline-none {outline-style:none;}
.flex {display:flex;} .flex-col {flex-direction:column;} .flex-1 {flex:1;} .min-w-0 {min-width:0;} .items-center {align-items:center;}
.h-9 {height:36px;} .px-2\\.5 {padding-inline:10px;} .py-1\\.5 {padding-block:6px;} .ps-9 {padding-inline-start:36px;} .text-sm {font-size:14px;}
}
</style><link rel="stylesheet" href="/extras.css"></head><body>
<div id="side" data-slot="sidebar-content"><ul>${folderRow('open', { current: true })}${folderRow('other')}${folderRow('two', { current: true, multiline: true })}</ul></div>
</body></html>`;

test('5230 folder rows get the selected thread marker in both styles', { timeout: 60_000 }, async t => {
  const chromePath = newestHeadlessChrome();
  assert.ok(fs.existsSync(chromePath), `headless Chrome missing: ${chromePath}`);
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname;
    if (name === '/extras.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); return res.end(fs.readFileSync(CSS, 'utf8')); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tmp = path.join(SRC, 'task-output/tmp'); fs.mkdirSync(tmp, { recursive: true });
  const profile = fs.mkdtempSync(path.join(tmp, 'sidebar-5230-'));
  const chrome = spawn(chromePath, ['--headless', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  const timer = setTimeout(() => chrome.kill('SIGKILL'), 55_000);
  let ws;
  try {
    let wsUrl;
    for (let i = 0; i < 100 && !wsUrl; i++) {
      await new Promise(r => setTimeout(r, 100));
      try {
        const [port] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
        wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page')?.webSocketDebuggerUrl;
      } catch {}
    }
    assert.ok(wsUrl, 'no debugger page');
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let id = 0; const pending = new Map();
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async expression => {
      const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.ok(!m.result?.exceptionDetails, JSON.stringify(m.result?.exceptionDetails));
      return m.result?.result?.value;
    };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    assert.equal(await ev(`(async()=>{for(let i=0;i<100;i++){if(document.readyState==='complete'&&document.styleSheets.length>=2)return 'ready';await new Promise(r=>setTimeout(r,50));}return 'missing';})()`), 'ready');
    // The break check's selection and predicates, copied from extras.js checkRead().
    const read = style => ev(`(()=>{document.documentElement.setAttribute('data-t3x-marker','${style}');
      const rows=[...document.querySelectorAll('li[data-thread-item]')];
      const selected=rows.map(r=>r.querySelector('[aria-current="page"], [data-active="true"]')).filter(Boolean);
      const markerOutlineWide=${WIDE_SRC};
      const ok=el=>'${style}'==='outline'?getComputedStyle(el).outlineStyle==='solid'&&markerOutlineWide(parseFloat(getComputedStyle(el).outlineWidth),devicePixelRatio):getComputedStyle(el,'::after').content==='""'&&parseFloat(getComputedStyle(el,'::after').width)===3;
      const other=document.querySelector('[data-thread-item="env:other"] > div');
      return {seen:selected.length,matched:selected.filter(ok).length,otherMarked:ok(other),
        weight:getComputedStyle(document.getElementById('open-title')).fontWeight,otherWeight:getComputedStyle(document.getElementById('other-title')).fontWeight};})()`);

    await t.test('outline style reaches the open folder row and no other', async () => {
      const r = await read('outline');
      assert.equal(r.seen, 2); assert.equal(r.matched, 2, 'both selected folder rows (one-line and two-line) carry the outline');
      assert.equal(r.otherMarked, false);
    });
    await t.test('bar style draws the 3 px bar and bolds the title on the open folder row only', async () => {
      const r = await read('bar');
      assert.equal(r.seen, 2); assert.equal(r.matched, 2);
      assert.equal(r.otherMarked, false);
      assert.equal(r.weight, '600'); assert.notEqual(r.otherWeight, '600');
    });
  } finally {
    clearTimeout(timer); try { ws?.close(); } catch {}
    const exited = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise(r => chrome.once('exit', r));
    chrome.kill('SIGKILL'); server.close();
    await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
