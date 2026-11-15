// Real CSS/JS in headless Chrome. Only invented rows and private temporary service state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fixture,BUILD} from './break-check-fixture.mjs';
const row=(id,selected=false)=>`<li data-thread-item="private-${id}"><div data-testid="sidebar-row-card" ${selected?'aria-current="page"':''}><div class="relative z-10"><div><i class="size-4"></i><span class="flex-1">Project</span></div><div><span class="min-w-0 flex-1 text-start text-sm">PRIVATE_TITLE_${id}</span></div></div></div></li>`;
const page=({js,css})=>`<!doctype html><html><head><meta charset="utf-8"><style>
@layer native { :root{--font-sans:'PRIVATE_FONT_CANARY',Arial,sans-serif,'PRIVATE_FONT_CANARY';--warning:#fa0;--background:#111;--foreground:#eee;--border:#555;--popover:#222;--muted-foreground:#aaa;}
body{font:14px var(--font-sans);margin:0;}#side{width:240px;}ul{margin:0;padding:0;}li{list-style:none;}li[data-thread-item]{min-height:44px;}[data-testid=sidebar-row-card]{padding:4px;} .flex-1{flex:1;}.min-w-0{min-width:0;}[data-slot=sidebar-footer]{height:40px;}.relative{position:relative;} }
</style><style id="t3x-css">${css}</style></head><body><div id="side" data-slot="sidebar-content"><ul id="rows">${row(1,true)}${row(2)}</ul></div><div data-slot="sidebar-footer"><ul data-slot="sidebar-menu"></ul></div><button id="anchor">Panel</button>
<script src="/assets/main-fixture.js"></script><script>
window.__T3X_CHECK_TEST__={};window.copied=null;window.copyFails=false;
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(window.copyFails)throw Error('denied');window.copied=text;}}});
localStorage.setItem('t3x:settings:v1',JSON.stringify({fontThreadtitles:{family:'T3 system font',size:null},fontSources:{threadtitles:'own'},compactThreads:false,oneRowTitles:false,marker:'off',usageHeader:false,usageComposer:false,usageSidebar:false,burnTells:false,handoverButton:false,chainPill:false,foldOlder:false}));
</script><script id="t3x-js">${js}</script></body></html>`;
async function chrome(t,url,root) {
  const base=path.join(os.homedir(),'.t3/tools/chrome-headless-shell/mac-arm64');
  const versions=fs.readdirSync(base).filter(v=>/^\d+(\.\d+)+$/.test(v)).sort((a,b)=>b.localeCompare(a,'en',{numeric:true}));
  const exe=path.join(base,versions[0],'chrome-headless-shell');
  const profile=path.join(root,'chrome');
  const proc=spawn(exe,['--headless','--disable-gpu',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{stdio:'ignore'});
  let ws; t.after(()=>{ws?.close();proc.kill('SIGKILL');});
  let endpoint;
  for(let i=0;i<100&&!endpoint;i++) {await new Promise(r=>setTimeout(r,100));try {const [port]=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n');endpoint=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page')?.webSocketDebuggerUrl;}catch{}}
  assert.ok(endpoint,'headless debugger did not start');ws=new WebSocket(endpoint);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
  const send=(method,params={})=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const m=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!m.result?.exceptionDetails,JSON.stringify(m.result?.exceptionDetails));return m.result?.result?.value;};
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setFocusEmulationEnabled',{enabled:true});await send('Page.navigate',{url});
  const until=async expression=>{for(let i=0;i<160;i++){const v=await ev(expression);if(v)return v;await new Promise(r=>setTimeout(r,50));}assert.fail(`timed out: ${expression}; errors: ${JSON.stringify(errors)}`);};
  await until(`window.__T3X_CHECK_TEST__?.snapshot?.().version && document.documentElement.hasAttribute('data-t3x-fthreadtitles')`);
  return {ev,send,until,errors};
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('break check on real 4736 rows, eligibility, agreement, recovery, warnings and private copy', {timeout:150000}, async t=>{
  const f=await fixture(t,page), c=await chrome(t,f.base+'/',f.dir),{ev,until,send}=c;
  const read=()=>ev('window.__T3X_CHECK_TEST__.read()');
  const wake=()=>ev('window.__T3X_CHECK_TEST__.cancel();window.__T3X_CHECK_TEST__.wake(true);1');
  const result=()=>ev('window.__T3X_CHECK_TEST__.snapshot().results');
  const change=async patch=>{await ev(`window.__T3X_CHECK_TEST__.change(${JSON.stringify(patch)});1`);await wait(200);};
  const breakTitles=()=>ev(`document.querySelectorAll('#rows .text-start').forEach(x=>x.classList.remove('text-start'));1`);
  const restore=()=>ev(`document.querySelectorAll('#rows span.text-sm').forEach(x=>x.classList.add('text-start'));1`);
  await t.test('T3-source family is healthy, loaded main is a resource entry and running digest equals server',async()=>{
    assert.equal((await read()).threadtitles.result,'ok');
    await change({compactThreads:true});assert.equal((await read()).compact.result,'ok');
    await change({compactThreads:false});
    assert.equal(await ev(`document.querySelector('script[src*="main-"]')!==null`),true);
    await ev(`document.querySelector('script[src*="main-"]').remove();1`);
    assert.ok(await ev(`performance.getEntriesByType('resource').some(x=>x.name.endsWith('/main-fixture.js'))`));
    assert.equal(await ev('window.__T3X_CHECK_TEST__.snapshot().version'),await(await f.get('/version')).text());
    await until(`window.__T3X_CHECK_TEST__.snapshot().results.threadtitles?.result==='ok'`);
    assert.equal(await ev(`Boolean(document.querySelector('.t3x-check,.t3x-check-dot'))`),false);
  });
  await t.test('downloaded font uses the same alias and stays healthy',async()=>{
    await change({fontThreadtitles:{family:'Downloaded fixture'}});
    await until(`document.fonts.check('14px "T3X Thread titles"') && [...document.fonts].some(f=>f.family==='T3X Thread titles'&&f.status==='loaded')`);
    assert.equal((await read()).threadtitles.result,'ok');
    assert.ok(f.requests.includes('/fonts/fixture.ttf'));
    await wake();await wait(5100);assert.equal((await result()).threadtitles.result,'ok');
    assert.equal(await ev(`Boolean(document.querySelector('.t3x-check,.t3x-check-dot'))`),false);
    await change({fontThreadtitles:{family:'T3 system font'}});
  });
  await t.test('eligibility ignores title hooks and excludes rename, drafts, search, zero height, offscreen, hidden and grouping',async()=>{
    await breakTitles();assert.equal((await read()).threadtitles.seen,2);assert.equal((await read()).threadtitles.matched,0);
    for(const [setup,undo] of [
      [`document.querySelector('#rows li').insertAdjacentHTML('beforeend','<input>')`,`document.querySelector('#rows input').remove()`],
      [`document.querySelector('#rows li div').dataset.testid='sidebar-draft-row'`,`document.querySelector('#rows li div').dataset.testid='sidebar-row-card'`],
      [`document.querySelector('#rows').id='sidebar-thread-search-results'`,`document.querySelector('#sidebar-thread-search-results').id='rows'`],
      [`document.querySelector('#rows li').style.cssText='height:0!important;min-height:0!important;padding:0!important;border:0!important;overflow:hidden;contain:size'`,`document.querySelector('#rows li').style=''`],
      [`document.querySelector('#rows li').style.transform='translateY(3000px)'`,`document.querySelector('#rows li').style=''`],
      [`document.querySelector('#side').hidden=true`,`document.querySelector('#side').hidden=false`],
      [`document.querySelector('#side').insertAdjacentHTML('beforeend','<div data-t3x="grouping-root" style="height:50px">Grouped</div>')`,`document.querySelector('[data-t3x="grouping-root"]').remove()`],
    ]) {await ev(setup+';1');assert.equal((await read()).threadtitles,undefined,setup);await ev(undo+';1');}
    await restore();
    await change({fontThreadtitles:{family:'off'}});assert.equal((await read()).threadtitles,undefined);
    assert.equal((await read()).composer,undefined);assert.equal((await read()).marker,undefined);assert.equal((await read()).older,undefined);
    await change({marker:'bar',foldOlder:true});await ev(`document.querySelector('[aria-current]').removeAttribute('aria-current');1`);assert.equal((await read()).marker,undefined);assert.equal((await read()).older,undefined);
    await change({marker:'off',foldOlder:false,fontThreadtitles:{family:'T3 system font'}});
  });
  await t.test('inserted probes require their anchors; header failure is observed twice and recovers',async()=>{
    await change({usageHeader:true,usageComposer:true,foldOlder:true,usageSidebar:true});
    const initial=await read();assert.equal(initial.header,undefined);assert.equal(initial.composer,undefined);assert.equal(initial.older,undefined);assert.equal(initial.bars.result,'ok');assert.equal(initial.panel.result,'ok');
    await ev(`document.body.insertAdjacentHTML('afterbegin','<div data-workspace-titlebar-controls style="height:30px"><div style="height:30px"></div></div><div data-chat-composer-actions="right" style="height:30px"></div>');1`);await wait(400);
    const healthy=await read();assert.equal(healthy.header.result,'ok');assert.equal(healthy.composer.result,'ok');
    await ev(`window.savedHeaderMount=window.__T3X_CHECK_TEST__.features.header.mount;window.__T3X_CHECK_TEST__.features.header.mount=()=>{};window.__T3X_CHECK_TEST__.features.header.node.remove();1`);await wake();
    await until(`window.__T3X_CHECK_TEST__.snapshot().results.header?.result==='broken'`);
    assert.equal(await ev(`window.__T3X_CHECK_TEST__.broken().includes('header')`),false,'inserted parts are checked but not named until Andy decides');
    await ev(`window.__T3X_CHECK_TEST__.features.header.mount=window.savedHeaderMount;1`);
    await change({usageHeader:false,usageComposer:false,foldOlder:false,usageSidebar:false});
    await ev(`document.querySelector('[data-workspace-titlebar-controls]').remove();document.querySelector('[data-chat-composer-actions]').remove();1`);
  });
  await t.test('two readings, settings cancellation and fonts-loading protection',async()=>{
    await breakTitles();const prior=f.requests.filter(x=>x.startsWith('/screen?')).length;
    await wake();await wait(300);assert.equal(f.requests.filter(x=>x.startsWith('/screen?')).length,prior,'one reading sends nothing');
    await change({oneRowTitles:true});await ev('window.__T3X_CHECK_TEST__.cancel();1');await wait(5100);assert.equal(f.requests.filter(x=>x.startsWith('/screen?')).length,prior,'cancelled settings pair sends nothing');
    await change({oneRowTitles:false});await ev(`Object.defineProperty(document.fonts,'status',{configurable:true,get:()=> 'loading'});1`);await wake();await wait(5100);assert.equal(f.requests.filter(x=>x.startsWith('/screen?')).length,prior);
    await ev(`delete document.fonts.status;1`);await wake();await until(`window.__T3X_CHECK_TEST__.broken().includes('threadtitles')`);
    assert.equal(await ev(`document.querySelector('.t3x-check-dot')!==null`),true);
  });
  await t.test('healthy pair clears unseen box, dot and tooltip within the same build',async()=>{
    await restore();await wake();await until(`!window.__T3X_CHECK_TEST__.broken().length`);
    assert.equal(await ev(`Boolean(document.querySelector('.t3x-check,.t3x-check-dot'))`),false);assert.equal(await ev(`document.querySelector('.t3x-star').title`),'Add-ons');
    assert.equal(JSON.parse(fs.readFileSync(f.screen)).results.find(x=>x.id==='threadtitles').result,'ok');
  });
  await t.test('main asset mismatch, missing build and no resource entry are unchecked',async()=>{
    f.write(f.keeper,{build:'0.1.10-nightly.20261116.4800',mainJs:'main-other.js'});await ev(`window.dispatchEvent(new Event('focus'));1`);await wait(200);await wake();assert.deepEqual(await ev('window.__T3X_CHECK_TEST__.broken()'),[]);
    f.write(f.keeper,{});await ev(`window.dispatchEvent(new Event('focus'));1`);await wait(200);await wake();assert.deepEqual(await ev('window.__T3X_CHECK_TEST__.broken()'),[]);
    f.write(f.keeper,{build:BUILD,mainJs:'main-fixture.js'});await ev(`window.dispatchEvent(new Event('focus'));1`);await wait(200);
    await ev(`performance.clearResourceTimings();1`);await breakTitles();const prior=f.requests.filter(x=>x.startsWith('/screen?')).length;await wake();await wait(5100);assert.equal(f.requests.filter(x=>x.startsWith('/screen?')).length,prior);
    await ev(`fetch('/assets/main-fixture.js').then(r=>r.text());`);await wake();await until(`window.__T3X_CHECK_TEST__.broken().length===1`);
  });
  await t.test('one and four names, private copy, clipboard outcomes and shown only while in view',async()=>{
    await ev(`window.__T3X_CHECK_TEST__.openPanel(document.querySelector('#anchor'));document.querySelector('.t3x-pop').style.maxHeight='150px';document.querySelector('.t3x-pop').scrollTop=1000;1`);
    await wait(100);assert.equal(await ev(`document.querySelector('.t3x-check').getAttribute('role')`),'status');
    assert.equal(await ev(`document.querySelector('.t3x-check > div').textContent`),"On T3 build 4736, Thread titles font isn't showing.");
    assert.equal(f.requests.filter(x=>x.includes('kind=shown')).length,0);assert.equal(await ev(`Boolean(document.querySelector('.t3x-check-dot'))`),true);
    await ev(`document.hasFocus=()=>false;document.querySelector('.t3x-pop').scrollTop=0;1`);await wait(150);
    assert.equal(f.requests.filter(x=>x.includes('kind=shown')).length,0,'unfocused view is not a shown event');
    assert.equal(await ev(`Boolean(document.querySelector('.t3x-check-dot'))`),true);
    await ev(`delete document.hasFocus;window.dispatchEvent(new Event('focus'));1`);await until(`!document.querySelector('.t3x-check-dot')`);
    await until(`!document.querySelector('.t3x-check-dot')`);
    assert.equal(f.requests.filter(x=>x.includes('kind=shown')).length,1);
    await ev(`document.querySelector('.t3x-pop').scrollTop=1000;1`);await wait(100);await ev(`document.querySelector('.t3x-pop').scrollTop=0;1`);await wait(100);
    assert.equal(f.requests.filter(x=>x.includes('kind=shown')).length,1,'viewing the line again sends no duplicate');
    await ev(`document.querySelector('.t3x-check-copy').click();1`);await until(`document.querySelector('.t3x-check-copy').textContent==='Copied'`);
    let copy=await ev('window.copied');assert.match(copy,/T3X Thread titles/);assert.match(copy,/--false-alarm/);assert.match(copy,/--confirm-real/);assert.doesNotMatch(copy,/PRIVATE_TITLE|PRIVATE_FONT_CANARY|private-1/);
    await wait(2100);await ev(`window.copyFails=true;document.querySelector('.t3x-check-copy').click();1`);await until(`document.querySelector('.t3x-check-copy').textContent==="Couldn't copy"`);assert.equal(await ev(`document.querySelector('.t3x-check-actions .t3x-muted').hidden`),true);await wait(2100);assert.equal(await ev(`document.querySelector('.t3x-check-copy').textContent`),'Copy fix request');
    await change({oneRowTitles:true,compactThreads:true,marker:'bar'});
    await ev(`document.querySelector('[data-testid="sidebar-row-card"]').setAttribute('aria-current','page');document.head.insertAdjacentHTML('beforeend','<style id="broken-marker">[aria-current]::after{content:none!important}</style>');1`);await wake();await until(`window.__T3X_CHECK_TEST__.broken().length===4`);
    assert.equal(await ev(`document.querySelector('.t3x-check > div').textContent`),"On T3 build 4736, 4 add-ons aren't showing: Thread titles font, One-row titles, Compact threads and Selected thread marker.");
    assert.equal(await ev(`document.querySelector('.t3x-star').title`),"Add-ons · 4 aren't showing");
    assert.doesNotMatch(f.requests.join('\n'),/PRIVATE_TITLE|PRIVATE_FONT_CANARY|private-1/);assert.doesNotMatch(fs.readFileSync(f.screen,'utf8'),/PRIVATE_TITLE|PRIVATE_FONT_CANARY|private-1/);
  });
  await t.test('false alarm hides its line and two distinct outcomes suppress all alert surfaces',async()=>{
    f.write(f.compat,{outcomes:[{build:BUILD,addon:'Thread titles font',outcome:'false-alarm'}],trial:{startedAt:'2026-11-01',endsAt:'2026-11-29'}});await ev(`window.dispatchEvent(new Event('focus'));1`);await wait(300);assert.equal(await ev('window.__T3X_CHECK_TEST__.broken().length'),3);
    f.write(f.compat,{outcomes:[{build:BUILD,addon:'Thread titles font',outcome:'false-alarm'},{build:BUILD,addon:'One-row titles',outcome:'false-alarm'}],trial:{startedAt:'2026-11-01',endsAt:'2026-11-29'}});await ev(`window.dispatchEvent(new Event('focus'));1`);await until(`!document.querySelector('.t3x-check,.t3x-check-dot')`);
    assert.equal(await ev(`document.querySelector('.t3x-star').title`),'Add-ons');
  });
  assert.deepEqual(c.errors,[]);
  await ev('window.t3xTeardown();1');
});
