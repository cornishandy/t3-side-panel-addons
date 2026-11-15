// Build 4736's title spans lost aria-hidden/test IDs, and rows without metadata now
// carry their provider icons beside the title. Real add-ons + keeper CSS, no live T3.
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
function newestHeadlessChrome() {
  const root = path.join(os.homedir(), '.t3/tools/chrome-headless-shell/mac-arm64');
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter(v => /^\d+(\.\d+)+$/.test(v)) : [];
  versions.sort((a,b) => b.localeCompare(a, 'en', {numeric:true}));
  return path.join(root, versions[0] ?? 'missing', 'chrome-headless-shell');
}
const title = 'A long sidebar thread title with enough words to wrap across several lines (48)';
function row(id, {slim=false, metadata=false, legacy=false, active=false}={}) {
  const text = `<span id="${id}" ${legacy ? 'aria-hidden="true" data-testid="thread-title-old"' : ''} class="min-w-0 flex-1 text-start text-sm transition-opacity font-medium truncate" dir="ltr">${title}</span>`;
  const icons = `<span id="${id}-icons" aria-hidden="true" class="${metadata ? 'pointer-events-none ml-auto ' : ''}inline-flex shrink-0 items-center gap-1"><svg width="14" height="14"></svg></span>`;
  const status = '<span class="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch"><span>5h</span><span></span></span>';
  return `<li data-thread-item="env:${id}"><div data-testid="sidebar-row-${slim?'slim':'card'}" ${active?'aria-current="page"':''} role="button" aria-label="${title}">
    ${slim ? text+status : `<div class="relative z-10 h-[4.875rem]"><div class="flex h-5 min-w-0 items-center gap-1.5"><i class="size-4"></i><span id="${id}-project" class="min-w-0 flex-1 truncate font-normal text-xs">Project</span>${status}</div><div class="mt-1 flex min-w-0 items-center gap-1.5">${text}${metadata?'':icons}</div>${metadata ? `<div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs"><span class="flex min-w-0 flex-1"><span>branch</span></span>${icons}</div>`:''}</div>`}
  </div></li>`;
}
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
@layer native {
:root { --font-sans:Arial,sans-serif; --foreground:#eee; --background:#111; --border:#555; --popover:#222; --muted-foreground:#aaa; }
body { font:14px var(--font-sans); } #side {width:220px;} ul {margin:0;padding:0;} li {list-style:none;}
.flex {display:flex;} .inline-flex {display:inline-flex;} .flex-1 {flex:1;} .min-w-0 {min-width:0;} .shrink-0 {flex-shrink:0;} .relative {position:relative;}
.items-center {align-items:center;} .ml-auto {margin-left:auto;} .h-5 {height:20px;} .size-4 {width:16px;height:16px;} .text-sm {font-size:14px;} .text-xs {font-size:12px;}
.font-medium {font-weight:500;} .font-normal {font-weight:400;} .truncate {white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
}
</style><link rel="stylesheet" href="/keeper.css"><link rel="stylesheet" href="/extras.css"></head><body>
<div id="side" data-slot="sidebar-content"><ul>${row('current',{active:true})}${row('meta',{metadata:true})}${row('slim',{slim:true})}${row('legacy',{legacy:true,metadata:true})}</ul></div>
<input aria-label="Thread title" id="rename" value="Rename title"><button id="anchor">Panel</button>
<script>localStorage.setItem('t3x:settings:v1',JSON.stringify({compactThreads:false,oneRowTitles:false,inlineIcon:false,foldOlder:false,burnTells:true}));window.__T3X_PICK_TEST__={};</script>
<script src="/extras.js"></script></body></html>`;

test('4736 sidebar hooks preserve fonts, wrapping, suffixes, markers and model-icon anchors', {timeout:60_000}, async t => {
  const chromePath = newestHeadlessChrome();
  assert.ok(fs.existsSync(chromePath), `headless Chrome missing: ${chromePath}`);
  const keeper = fs.readFileSync(path.join(SRC,'../t3-sidebar-keeper/keeper.mjs'),'utf8');
  const wrap = vm.runInNewContext(keeper.match(/const WRAP_CSS = (\[[\s\S]*?\]\.join\(""\));/)[1]);
  const server = http.createServer((req,res) => {
    const name = new URL(req.url,'http://x').pathname;
    const file = {'/extras.css':'text/css','/extras.js':'text/javascript'}[name];
    res.writeHead(200, {'Content-Type':`${file || (name==='/keeper.css'?'text/css':'text/html')}; charset=utf-8`});
    if (name==='/keeper.css') return res.end(wrap);
    if (name==='/font-catalog') return res.end('{"families":[]}');
    if (name==='/state') return res.end('{"localEnvironmentId":"env"}');
    if (name==='/burn') return res.end(JSON.stringify({threads:{current:{tier:'hot',rateUsdPerHour:20,hotForMin:10}}}));
    if (name!=='/' && !file) return res.end('{}');
    res.end(file ? fs.readFileSync(path.join(SRC,'public',name.slice(1)),'utf8').replace('const BASE = "http://127.0.0.1:8793/";', 'const BASE = location.origin + "/";') : PAGE);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const tmp = path.join(SRC,'task-output/tmp'); fs.mkdirSync(tmp,{recursive:true});
  const profile = fs.mkdtempSync(path.join(tmp,'sidebar-4736-'));
  const chrome = spawn(chromePath,['--headless','--disable-gpu',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:'ignore'});
  const timer = setTimeout(()=>chrome.kill('SIGKILL'),55_000);
  let ws;
  try {
    let wsUrl;
    for(let i=0;i<100&&!wsUrl;i++) {
      await new Promise(r=>setTimeout(r,100));
      try {
        const [port] = fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n');
        wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page')?.webSocketDebuggerUrl;
      } catch {}
    }
    assert.ok(wsUrl,'no debugger page');
    ws = new WebSocket(wsUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    let id=0; const pending=new Map(), errors=[];
    ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);});
    const send = (method,params={}) => new Promise(resolve=>{const n=++id;pending.set(n,resolve);ws.send(JSON.stringify({id:n,method,params}));});
    const ev = async expression => {
      const m=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      assert.ok(!m.result?.exceptionDetails,JSON.stringify(m.result?.exceptionDetails));
      return m.result?.result?.value;
    };
    const frames = () => ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))');
    const attrs = async (on,off=[]) => { await ev(`(()=>{const r=document.documentElement;for(const a of ${JSON.stringify(off)})r.removeAttribute(a);for(const a of ${JSON.stringify(on)})r.setAttribute(a,'');return 1;})()`); await frames(); };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
    assert.equal(await ev(`(async()=>{for(let i=0;i<100;i++){if(window.__T3X_PICK_TEST__?.areaOwners&&document.querySelector('.t3x-burn-chip'))return 'ready';await new Promise(r=>setTimeout(r,50));}return 'missing';})()`),'ready');

    await t.test('Thread titles font and screen picker reach current and legacy titles only', async()=>{
      await attrs(['data-t3x-fthreadtitles']);
      const result = await ev(`(()=>{const ids=['current','meta','slim','legacy','current-project','rename'];const els=ids.map(id=>document.getElementById(id));return {families:els.map(e=>getComputedStyle(e).fontFamily),owners:window.__T3X_PICK_TEST__.areaOwners(els),hidden:els[0].hasAttribute('aria-hidden'),testid:els[0].hasAttribute('data-testid')};})()`);
      for(let i=0;i<4;i++){assert.match(result.families[i],/T3X Thread titles/);assert.equal(result.owners[i].role,'threadtitles');}
      for(let i=4;i<6;i++) assert.doesNotMatch(result.families[i],/T3X Thread titles/);
      assert.equal(result.hidden,false);assert.equal(result.testid,false);
      await attrs([],['data-t3x-fthreadtitles']);
    });
    await t.test('keeper wraps; tighter rows and selected-title bold reach the new span',async()=>{
      assert.equal(await ev(`getComputedStyle(document.getElementById('current')).whiteSpace`),'normal');
      await attrs(['data-t3x-tight']);
      assert.equal(await ev(`getComputedStyle(document.getElementById('current')).lineHeight`),'17.5px');
      assert.equal(await ev(`getComputedStyle(document.getElementById('current')).fontWeight`),'600');
      assert.equal(await ev(`getComputedStyle(document.getElementById('meta')).fontWeight`),'500');
      await attrs([],['data-t3x-tight']);
    });
    await t.test('compact clamp, unlimited lines and one-row suffix survive resize, rename and replacement',async()=>{
      await ev(`window.__T3X_PICK_TEST__.openPanel(document.getElementById('anchor'));document.querySelector('[data-focus="sw-compactThreads"]').click();1`);await frames();await frames();
      assert.equal(await ev(`getComputedStyle(document.getElementById('current')).webkitLineClamp`),'2');
      assert.equal(await ev(`getComputedStyle(document.getElementById('current-icons')).display`),'none','compact rows still hide provider icons');
      await ev(`document.documentElement.setAttribute('data-t3x-title-lines','unlimited');1`); await frames();
      assert.equal(await ev(`getComputedStyle(document.getElementById('current')).webkitLineClamp`),'none');
      await ev(`document.querySelector('[data-focus="sw-oneRowTitles"]').click();1`); await frames();await frames();
      const suffix = () => ev(`(()=>{const e=document.getElementById('current'),s=e.nextElementSibling;return {clamp:getComputedStyle(e).webkitLineClamp,space:getComputedStyle(e).whiteSpace,text:s?.textContent,hidden:s?.hidden,original:e.textContent};})()`);
      let s=await suffix();assert.equal(s.clamp,'none');assert.equal(s.space,'nowrap');assert.equal(s.text,'(48)');assert.equal(s.hidden,false);assert.equal(s.original,title);
      await ev(`document.getElementById('side').style.width='1000px';1`);await frames();await frames();
      assert.equal((await suffix()).hidden,true,'resize hides an unnecessary suffix');
      await ev(`document.getElementById('side').style.width='220px';document.getElementById('current').textContent='${title.replace('(48)','(49)')}';1`);await frames();await frames();
      assert.equal((await suffix()).text,'(49)');
      await ev(`window.savedTitle=document.getElementById('current');savedTitle.replaceWith(Object.assign(document.createElement('input'),{id:'rename-current'}));1`);await frames();await frames();
      assert.equal(await ev(`document.querySelector('[data-thread-item="env:current"] [data-t3x="sfx"]')===null`),true,'rename removes the stale copy');
      await ev(`document.getElementById('rename-current').replaceWith(savedTitle);1`);await frames();await frames();
      assert.equal((await suffix()).text,'(49)');
      await ev(`document.querySelector('[data-focus="sw-oneRowTitles"]').click();1`);await frames();await frames();
      assert.equal(await ev(`document.querySelectorAll('[data-t3x="sfx"]').length`),0,'off removes copies');
      await ev(`document.querySelector('[data-focus="sw-compactThreads"]').click();1`);await frames();await frames();
    });
    await t.test('two-row inline model icon and burn chip use the new icon position',async()=>{
      await attrs([],['data-t3x-inline-icon']);
      const burn = await ev(`(()=>{const li=document.querySelector('[data-thread-item="env:current"]'),node=li.querySelector('[data-t3x="burn"]'),i=document.getElementById('current-icons').getBoundingClientRect(),r=li.getBoundingClientRect();return {right:node.style.getPropertyValue('--cr'),expected:Math.round(r.right-i.left+6)+'px'};})()`);
      assert.equal(burn.right,burn.expected,'chip is beside the current provider icons');
      await ev(`document.querySelector('[data-focus="sw-inlineIcon"]').click();1`);await frames();await frames();
      const layout=await ev(`(()=>{const text=document.getElementById('current'),icon=document.getElementById('current-icons');return {display:getComputedStyle(text.parentElement).display,ix:icon.getBoundingClientRect().left,tx:text.getBoundingClientRect().left,iy:icon.getBoundingClientRect().top,ty:text.getBoundingClientRect().top,meta:getComputedStyle(document.getElementById('meta').parentElement).display};})()`);
      assert.equal(layout.display,'flex');assert.ok(layout.ix<layout.tx);assert.ok(Math.abs(layout.iy-layout.ty)<1);assert.equal(layout.meta,'flex','metadata rows keep their layout');
      await ev(`document.querySelector('[data-focus="sw-oneRowTitles"]').click();1`);await frames();await frames();
      const combined=await ev(`(()=>{const e=document.getElementById('current'),s=e.nextElementSibling,i=document.getElementById('current-icons');return {ix:i.getBoundingClientRect().left,tx:e.getBoundingClientRect().left,sx:s.getBoundingClientRect().left,tr:e.getBoundingClientRect().right,hidden:s.hidden};})()`);
      assert.ok(combined.ix<combined.tx);assert.ok(combined.sx>=combined.tr-1);assert.equal(combined.hidden,false,'inline icons preserve the suffix beside the title');
    });
    assert.deepEqual(errors,[]);
  } finally {
    clearTimeout(timer);try{ws?.close();}catch{}chrome.kill('SIGKILL');
    await new Promise(resolve=>{if(chrome.exitCode!==null||chrome.signalCode!==null)resolve();else{chrome.once('exit',resolve);setTimeout(resolve,3000);}});
    server.close();fs.rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
