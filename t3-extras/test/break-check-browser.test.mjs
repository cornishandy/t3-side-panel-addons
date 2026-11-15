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
if(!localStorage.getItem('t3x:settings:v1'))localStorage.setItem('t3x:settings:v1',JSON.stringify({fontThreadtitles:{family:'T3 system font',size:null},fontSources:{threadtitles:'own'},compactThreads:false,oneRowTitles:false,marker:'off',usageHeader:false,usageComposer:false,usageSidebar:false,burnTells:false,handoverButton:false,chainPill:false,foldOlder:false}));
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
    assert.equal(await ev(`window.__T3X_CHECK_TEST__.broken().includes('header')`),true,'visible inserted pieces are named');
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

// The service still validates reports. Only invented state/heat is overlaid in the fixture's
// fetch responses, so refreshes use the production async paths rather than assigning internals.
const namesPage=assets=>page(assets)
  .replace('<div id="side"', '<div data-workspace-titlebar-controls style="height:30px"><div style="height:30px"></div></div><div data-chat-composer-actions="right" style="height:30px"></div><div id="side"')
  .replace('<ul id="rows">','<ul id="rows"><li data-testid="sidebar-active-placeholder"></li>')
  .replace('PRIVATE_TITLE_2</span>','PRIVATE_TITLE_2</span><span class="group/sidebar-status-slot"><span>3d</span></span>')
  .replace('window.__T3X_CHECK_TEST__={};',`window.__T3X_CHECK_TEST__={};
window.statePatch=JSON.parse(localStorage.getItem('fixture:state')||'{}');
window.burnPatch=JSON.parse(localStorage.getItem('fixture:burn')||'{"threads":{}}');
const realFetch=window.fetch.bind(window);
window.fetch=async (...args)=>{
  const url=new URL(args[0],location.href);
  if(url.pathname==='/burn')return new Response(JSON.stringify(window.burnPatch));
  const res=await realFetch(...args);
  if(url.pathname==='/state'){
    const body={...await res.json(),...window.statePatch};
    if(window.statePatch.tools===null)delete body.tools;
    return new Response(JSON.stringify(body),{status:res.status,headers:res.headers});
  }
  return res;
};`);
const OFF={fontThreadtitles:{family:'off',size:null},fontSources:{threadtitles:'own'},compactThreads:false,oneRowTitles:false,marker:'off',usageHeader:false,usageComposer:false,usageSidebar:false,burnTells:false,handoverButton:false,chainPill:false,foldOlder:false};
const CHAIN={short:'test',position:1,length:2};
const LOCAL={localEnvironmentId:'local01',tools:{handover:true},handover:{chain:CHAIN}};
const USAGE={fetchedAt:Date.now(),labs:[{id:'claude',fetchedAt:Date.now(),live:true,windows:[{role:'long',usedPct:30,resetsAt:Date.now()+86400000,lengthSec:604800}]}]};
const HOT={threads:{thread1:{tier:'hot',rateUsdPerHour:42,hotForMin:6}}};

test('break-check names: approved labels, visible pieces, anchors, copy and refreshes', {timeout:150000},async t=>{
  const f=await fixture(t,namesPage),c=await chrome(t,f.base+'/',f.dir),{ev,until,send}=c;
  const text=()=>ev(`document.querySelector('.t3x-check > div')?.textContent??null`);
  const title=()=>ev(`document.querySelector('.t3x-star').title`);
  const dot=()=>ev(`Boolean(document.querySelector('.t3x-check-dot'))`);
  const open=async()=>{await ev(`if(!document.querySelector('.t3x-pop'))window.__T3X_CHECK_TEST__.openPanel(document.querySelector('#anchor'));1`);};
  const copy=async()=>{await ev(`window.copied=null;document.querySelector('.t3x-check-copy').click();1`);return until('window.copied');};
  const refresh=async patch=>{await ev(`window.statePatch=${JSON.stringify(patch)};window.__T3X_CHECK_TEST__.fetchState({fresh:true})`);await ev('window.__T3X_CHECK_TEST__.cancel();1');};
  const seed=async({ids=[],settings={},state=LOCAL,burn={threads:{}},hash='#/local01/thread1'}={})=>{
    const version=await ev('window.__T3X_CHECK_TEST__.snapshot().version');
    const results=Object.fromEntries(ids.map(id=>[id,{result:'broken',seen:2,matched:0}]));
    f.write(f.screen,{results:[]});
    f.write(f.compat,{trial:{startedAt:'2026-11-15',endsAt:'2026-11-30'},outcomes:[]});
    await ev(`window.t3xTeardown();new Promise(resolve=>{const r=indexedDB.deleteDatabase('t3code:connection-runtime');r.onsuccess=()=>resolve(true)})`);
    await ev(`localStorage.setItem('t3x:settings:v1',${JSON.stringify(JSON.stringify({...OFF,...settings}))});localStorage.setItem('fixture:state',${JSON.stringify(JSON.stringify(state))});localStorage.setItem('fixture:burn',${JSON.stringify(JSON.stringify(burn))});localStorage.setItem('t3x:break-check:v1',${JSON.stringify(JSON.stringify({[JSON.stringify([BUILD,version,'1'])]:results}))});location.hash=${JSON.stringify(hash)};1`);
    await send('Page.reload');
    await until(`window.__T3X_CHECK_TEST__?.snapshot?.().version && document.querySelector('.t3x-star')`);
    await until(`Object.keys(window.__T3X_CHECK_TEST__.snapshot().results).length===${ids.length}`);
    await ev(`window.__T3X_CHECK_TEST__.cancel();for(const id of ${JSON.stringify(ids)}){const feature=window.__T3X_CHECK_TEST__.features[id];if(feature){feature.mount=()=>{};feature.node?.remove();}}window.__T3X_CHECK_TEST__.ui();1`);
  };
  await t.test('Settings has exactly the four approved renames and keeps Thread burn tells',async()=>{
    await seed({settings:{usageSidebar:true,settingsOpen:true}});await open();
    const labels=await ev(`[...document.querySelectorAll('.t3x-set-label')].map(x=>x.textContent)`);
    for(const label of ['Header glyphs','Tightest lab in composer','One row per lab in sidebar','Compact lab rows in a short window','Thread burn tells','Pinned label and line'])assert.ok(labels.includes(label),label);
    for(const old of ['Header glyphs (one per lab)','Composer: the tightest lab','Sidebar: one row per lab','Sidebar: compact in a short window'])assert.ok(!f.js.includes(old),old);
  });
  await t.test('header glyph fallback has the approved plural sentence and singular tooltip count',async()=>{
    await seed({ids:['header'],settings:{usageHeader:true}});await open();
    assert.equal(await text(),"On T3 build 4736, Header glyphs aren't showing.");
    assert.equal(await title(),"Add-ons · 1 isn't showing");
    assert.equal(await ev(`document.querySelector('.t3x-star').getAttribute('aria-label')`),await title());
  });
  await t.test('remote chain has no alert; route change to a local chain re-renders',async()=>{
    await seed({ids:['header'],settings:{chainPill:true},hash:'#/remote1/thread1'});await open();
    assert.equal(await text(),null);assert.equal(await dot(),false);assert.equal(await title(),'Add-ons');
    await ev(`location.hash='#/local01/thread1';1`);
    await until(`document.querySelector('.t3x-check > div')?.textContent==="On T3 build 4736, Handover chain pill isn't showing."`);
  });
  await t.test('composer counts its two visible pieces but copy has one internal part and command pair',async()=>{
    await seed({ids:['composer'],settings:{usageComposer:true,handoverButton:true},state:{...LOCAL,usage:USAGE}});await open();
    assert.equal(await text(),"On T3 build 4736, 2 add-ons aren't showing: Tightest lab in composer and Prepare handover button.");
    const copied=await copy();assert.match(copied,/composer: Tightest lab in composer; Prepare handover button \(as shown on the thread open when copied\)/);
    assert.match(copied,/Tightest lab in composer — Settings label "Tightest lab in composer"/);
    assert.match(copied,/Prepare handover button — Settings label "Prepare handover button"/);
    assert.match(copied,/its spot on screen: yes; the add-on's node inside it: no\./);
    for(const command of ['false-alarm','confirm-real'])assert.equal(copied.split(`--${command} "composer"`).length-1,1);
    for(const header of ['T3 version: '+BUILD,'Add-ons version:','Checker version: 1','Repo: ~/Documents/ChatGPT/t3-side-panel-addons'])assert.ok(copied.includes(header));
  });
  await t.test('row, Older, bars and header names follow table order; copy preserves per-part diagnostics',async()=>{
    await seed({ids:['threadtitles','older','bars','header','panel'],settings:{fontThreadtitles:{family:'T3 system font'},foldOlder:true,usageSidebar:true,usageHeader:true,chainPill:true,burnTells:true},burn:HOT});await open();
    await until(`document.querySelector('.t3x-check')?.dataset.checkNames.includes('burn')`);
    assert.equal(await text(),"On T3 build 4736, 6 add-ons aren't showing: Thread titles font, Older threads section, One row per lab in sidebar, Header glyphs, Handover chain pill and Thread burn tells in the header.");
    const copied=await copy();assert.match(copied,/threadtitles: Thread titles font/);assert.match(copied,/Fonts… → Thread titles/);
    assert.match(copied,/looked for title hook[\s\S]*eligible rows seen: 2; rows matched: 0\./);
    assert.match(copied,/Thread burn tells in the header — Settings label "Thread burn tells"/);
    assert.doesNotMatch(copied,/^panel:|--false-alarm "panel"|PRIVATE_TITLE|PRIVATE_FONT_CANARY|private-1/m);
    for(const id of ['Thread titles font','Older','bars','header'])for(const command of ['false-alarm','confirm-real'])assert.equal(copied.split(`--${command} "${id}"`).length-1,1);
    assert.equal(copied.split('\nheader:').length-1,1);
  });
  await t.test('lone plural row and lone singular row use approved grammar',async()=>{
    await seed({ids:['onerow'],settings:{oneRowTitles:true}});await open();assert.equal(await text(),"On T3 build 4736, One-row titles aren't showing.");
    await seed({ids:['marker'],settings:{marker:'bar'}});await open();assert.equal(await text(),"On T3 build 4736, Selected thread marker isn't showing.");
  });
  await t.test('seen stays per header part when another thread adds the chain piece',async()=>{
    await seed({ids:['header'],settings:{usageHeader:true,chainPill:true},hash:'#/remote1/thread1'});
    const version=await ev('window.__T3X_CHECK_TEST__.snapshot().version');
    f.write(f.screen,{results:[{build:BUILD,id:'header',addon:'header',version,checker:'1',result:'broken',seen:2,matched:0}]});
    assert.equal(await dot(),true);await open();
    await until('!document.querySelector(".t3x-check-dot")');
    await until(`window.__T3X_CHECK_TEST__.snapshot().results.header?.result==='broken'`);
    // Wait for the real keeper acknowledgement, rather than only the synchronous viewed bit.
    for(let i=0;i<100&&!JSON.parse(fs.readFileSync(f.screen)).results[0].firstShownAt;i++)await wait(10);
    assert.ok(JSON.parse(fs.readFileSync(f.screen)).results[0].firstShownAt);
    const before=f.requests.filter(x=>x.includes('kind=shown')&&x.includes('addon=header')).length;
    await ev(`location.hash='#/local01/thread2';1`);
    await until(`document.querySelector('.t3x-check')?.dataset.checkNames==='glyphs,chain'`);
    assert.equal(await dot(),false);
    assert.equal(f.requests.filter(x=>x.includes('kind=shown')&&x.includes('addon=header')).length,before);
    assert.equal(await title(),"Add-ons · 2 aren't showing");
  });
  await t.test('Older is unread during filled drag markers and its update leaves rows alone',async()=>{
    await seed({settings:{foldOlder:true}});
    assert.equal(await ev(`window.__T3X_CHECK_TEST__.read().older.result`),'ok');
    const hidden=await ev(`document.querySelector('[data-t3x="older"]').hidden`);
    await ev(`document.querySelector('[data-testid="sidebar-active-placeholder"]').innerHTML='<i>drag hint</i>';1`);
    assert.equal(await ev(`window.__T3X_CHECK_TEST__.read().older`),undefined);
    assert.equal(await ev(`const f=window.__T3X_CHECK_TEST__.features.older;f.update(f.node);f.node.hidden`),hidden);
    await ev(`document.querySelector('[data-testid="sidebar-active-placeholder"]').replaceChildren();1`);
    assert.equal(await ev(`window.__T3X_CHECK_TEST__.read().older.result`),'ok');
  });
  await t.test('cached inserted failures require current anchors for box, dot, tooltip, copy and shown',async()=>{
    const selectors={header:'[data-workspace-titlebar-controls]',composer:'[data-chat-composer-actions]',bars:'[data-slot="sidebar-footer"]',older:'#rows'};
    const names={header:'Header glyphs',composer:'Prepare handover button',bars:'One row per lab in sidebar',older:'Older threads section'};
    for(const id of Object.keys(selectors)){
      await seed({ids:['threadtitles',id],settings:{fontThreadtitles:{family:'T3 system font'},usageHeader:true,handoverButton:true,usageSidebar:true,foldOlder:true}});
      // Give the panel a separate eligible footer when the bars anchor is hidden/removed.
      if(id==='bars')await ev(`const p=window.__T3X_CHECK_TEST__.features.panel;document.body.append(p.node);p.find=()=>({el:document.body,why:'on'});1`);
      const selector=JSON.stringify(selectors[id]);
      for(const mode of ['hidden','offscreen','removed']){
        await ev(`window.testAnchor=document.querySelector(${selector});window.testParent=testAnchor.parentElement;window.testNext=testAnchor.nextSibling;${mode==='hidden'?'testAnchor.hidden=true':mode==='offscreen'?"testAnchor.style.transform='translateY(3000px)'":'testAnchor.remove()'};window.__T3X_CHECK_TEST__.ui();1`);
        const prior=f.requests.filter(x=>x.includes('kind=shown')&&x.includes('addon='+id)).length;
        await open();assert.equal(await text(),"On T3 build 4736, Thread titles font isn't showing.",id+' '+mode);
        assert.equal(await title(),"Add-ons · 1 isn't showing");
        await until('!document.querySelector(".t3x-check-dot")'); // only the other part has just been viewed
        const copied=await copy();assert.ok(!copied.includes(names[id]),id+' '+mode);assert.ok(!copied.includes(`--false-alarm "${id}"`));
        await ev('window.__T3X_CHECK_TEST__.seen();1');
        assert.equal(f.requests.filter(x=>x.includes('kind=shown')&&x.includes('addon='+id)).length,prior);
        assert.equal(await ev(`window.__T3X_CHECK_TEST__.snapshot().results[${JSON.stringify(id)}].result`),'broken');
        await ev(`if(!testAnchor.isConnected)testParent.insertBefore(testAnchor,testNext);testAnchor.hidden=false;testAnchor.style.transform='';window.__T3X_CHECK_TEST__.ui();1`);
        assert.ok((await text()).includes(names[id]),id+' restored');
      }
    }
    // A header anchor is eligible even when its insertion child itself is missing.
    await seed({ids:['header'],settings:{usageHeader:true}});await ev(`document.querySelector('[data-workspace-titlebar-controls]').replaceChildren();window.__T3X_CHECK_TEST__.ui();1`);await open();
    assert.equal(await text(),"On T3 build 4736, Header glyphs aren't showing.");
  });
  await t.test('burn requires locality and a chip; handover names a disabled visible button and honors tool gates',async()=>{
    await seed({ids:['header'],settings:{burnTells:true},burn:HOT,hash:'#/remote1/thread1'});await open();assert.equal(await text(),null);
    await seed({ids:['header'],settings:{burnTells:true},burn:{threads:{thread1:{tier:'building',rateUsdPerHour:42}}}});await open();assert.equal(await text(),null);
    await seed({ids:['composer'],settings:{handoverButton:true},hash:'#/remote1/thread1',state:{...LOCAL,tools:null}});await open();
    assert.equal(await text(),"On T3 build 4736, Prepare handover button isn't showing.");
    assert.equal(await ev(`const f=window.__T3X_CHECK_TEST__.features.composer;f.update(f.node,[],Date.now());f.node.querySelector('.t3x-handover').getAttribute('aria-disabled')`),'true');
    assert.equal(await ev(`window.__T3X_CHECK_TEST__.features.composer.node.querySelector('.t3x-handover').hidden`),false);
    await refresh({...LOCAL,tools:{handover:false}});assert.equal(await text(),null);assert.equal(await dot(),false);assert.equal(await title(),'Add-ons');
  });
  await t.test('unknown configured lab supplies a composer summary with no measured percentages',async()=>{
    await seed({ids:['composer'],settings:{usageComposer:true}});
    await ev(`new Promise((resolve,reject)=>{const r=indexedDB.open('t3code:connection-runtime',1);r.onupgradeneeded=()=>r.result.createObjectStore('server-config');r.onsuccess=()=>{const db=r.result,tx=db.transaction('server-config','readwrite');tx.objectStore('server-config').put({schemaVersion:1,environmentId:'local01',config:{providers:[{driver:'codex',instanceId:'codex',enabled:true}]}},'local01');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=reject};r.onerror=reject})`);
    await refresh(LOCAL);await open();
    await until(`document.querySelector('.t3x-check > div')?.textContent==="On T3 build 4736, Tightest lab in composer isn't showing."`);
    assert.equal(await ev(`const f=window.__T3X_CHECK_TEST__.features.composer;f.node.querySelector('.t3x-meters').textContent.includes('Codex —')`),true);
    await ev(`new Promise(resolve=>{const r=indexedDB.deleteDatabase('t3code:connection-runtime');r.onsuccess=()=>resolve(true)})`);
  });
  await t.test('open panel names and copy update after state and independent burn refreshes',async()=>{
    await seed({ids:['header'],settings:{chainPill:true,burnTells:true}});await open();
    assert.equal(await text(),"On T3 build 4736, Handover chain pill isn't showing.");
    await refresh({...LOCAL,handover:{chain:null}});assert.equal(await text(),null);
    await refresh(LOCAL);assert.equal(await text(),"On T3 build 4736, Handover chain pill isn't showing.");
    await ev(`window.burnPatch=${JSON.stringify(HOT)};window.__T3X_CHECK_TEST__.fetchBurn()`);
    assert.equal(await text(),"On T3 build 4736, 2 add-ons aren't showing: Handover chain pill and Thread burn tells in the header.");
    let copied=await copy();assert.match(copied,/Handover chain pill; Thread burn tells in the header/);assert.match(copied,/Settings label "Thread burn tells"/);
    await ev(`window.burnPatch={threads:{}};window.__T3X_CHECK_TEST__.fetchBurn()`);
    assert.equal(await text(),"On T3 build 4736, Handover chain pill isn't showing.");copied=await copy();assert.doesNotMatch(copied,/Thread burn tells/);
  });
  await t.test('preservation: header and composer keep their existing fallback, locality and tool visibility',async()=>{
    await seed({settings:{usageHeader:true,usageComposer:true,chainPill:true,burnTells:true,handoverButton:true},state:{...LOCAL,usage:USAGE},burn:HOT});
    const hidden=()=>ev(`Object.fromEntries(['header','composer'].flatMap(id=>[...window.__T3X_CHECK_TEST__.features[id].node.children].map(x=>[x.getAttribute('data-t3x'),x.hidden])))`);
    await until(`window.__T3X_CHECK_TEST__.features.header.node.querySelector('.t3x-burn-hdr').hidden===false`);
    assert.deepEqual(await hidden(),{'burn-hdr':false,chain:false,'hdr-usage':false,handover:false,meters:false});
    await ev(`location.hash='#/remote1/thread1';1`);
    await until(`window.__T3X_CHECK_TEST__.features.header.node.querySelector('.t3x-chain').hidden===true`);
    assert.deepEqual(await hidden(),{'burn-hdr':true,chain:true,'hdr-usage':false,handover:false,meters:false});
    await refresh({...LOCAL,tools:{handover:false}});
    assert.deepEqual(await hidden(),{'burn-hdr':true,chain:true,'hdr-usage':false,handover:true,meters:true});
    assert.equal(await ev(`window.__T3X_CHECK_TEST__.features.header.node.querySelector('.t3x-hdr-usage').textContent`),'Usage —');
  });
  await t.test('inserted-part false alarm removes all its displayed pieces and alert surfaces',async()=>{
    await seed({ids:['header'],settings:{usageHeader:true,chainPill:true}});await open();
    assert.equal(await text(),"On T3 build 4736, 2 add-ons aren't showing: Header glyphs and Handover chain pill.");
    f.write(f.compat,{outcomes:[{build:BUILD,addon:'header',outcome:'false-alarm'}]});
    await ev('window.__T3X_CHECK_TEST__.fetchState({fresh:true})');
    assert.equal(await text(),null);assert.equal(await dot(),false);assert.equal(await title(),'Add-ons');
  });
  assert.deepEqual(c.errors,[]);await ev('window.t3xTeardown();1');
});
