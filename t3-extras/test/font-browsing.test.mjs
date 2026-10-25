import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/extras.js',import.meta.url),'utf8');
const coreBox={window:{__T3X_TEST__:{}}};vm.runInNewContext(source,coreBox);const C=coreBox.window.__T3X_TEST__.core;
const defaults=C.readSettings(null);
const cat=[{name:'A',group:'hand',width:100,style:'print',source:'google',file:'a.woff2',size:110},{name:'Mac',group:'hand',width:200,style:'print',source:'mac'},{name:'Hidden',group:'hand',width:300,style:'joined',source:'google',file:'h.woff2'},{name:'B',group:'cond',width:400,style:'print',source:'google',file:'b.woff2',size:100}];
test('font navigation uses displayed order, filters, wrapping, missing anchors and changeability',()=>{
 const step=(current,d,c=cat,s=defaults)=>C.fontNeighbor(c,s,current,d,()=>false);
 assert.equal(step('off',1),'A');assert.equal(step('off',-1),'B');
 assert.equal(step('A',-1),'B');assert.equal(step('B',1),'A');assert.equal(step('A',1),'B');
 assert.equal(step('Mac',1),'B');assert.equal(step('Mac',-1),'A');
 assert.equal(step('Hidden',1),'B');assert.equal(step('Hidden',-1),'A');
 assert.equal(step('absent',1),'A');assert.equal(step('absent',-1),'B');
 assert.equal(step('A',1,[cat[0]]),null);assert.equal(step('off',1,[cat[0]]),'A');assert.equal(step('absent',-1,[cat[0]]),'A');
 assert.equal(step('Mac',1,[cat[0],cat[1]]),'A');assert.equal(step('off',1,[cat[1]]),null);assert.equal(step('off',1,[]),null);assert.equal(step('off',1,null),null);
 assert.equal(step('A',1,cat,{...defaults,printOnly:false}),'Hidden');
});
const tick=async()=>{for(let i=0;i<24;i++)await Promise.resolve()};
const fonts=source.slice(source.indexOf('  const DIGITLESS ='),source.indexOf('  // ---------- add-ons panel'));
function harness(){
 const faces=[],added=new Set(),fetches=new Map(),attrs=new Set();
 const settings={fontHead:{family:'off',size:null},fontBody:{family:'off',size:null},fontMain:{family:'off',size:null}};
 const ctx={disposed:false,pop:{kind:'panel'},settings,BASE:'http://fixture/',Map,FontFace:class{
  constructor(alias,src,options){Object.assign(this,{alias,src,options});faces.push(this)}
  load(){return new Promise((resolve,reject)=>{this.resolve=()=>resolve(this);this.reject=reject})}
 },D:{fonts:{add:f=>added.add(f),delete:f=>added.delete(f)},documentElement:{setAttribute:a=>attrs.add(a),removeAttribute:a=>attrs.delete(a)}},sizePct:x=>x,
 fetch:url=>{fetches.set(url,(fetches.get(url)||0)+1);return Promise.resolve({ok:true,arrayBuffer:()=>Promise.resolve(new ArrayBuffer(8))})},fillPopover(){}};
 vm.createContext(ctx);vm.runInContext(fonts+'\ncatalog='+JSON.stringify(cat.filter(f=>f.source==='google'))+';',ctx);
 return {ctx,faces,added,fetches,attrs,run:code=>vm.runInContext(code,ctx)};
}
test('real role loaders reject stale A→B→A, Off, failures, and stay independent',async()=>{
 const h=harness();const choose=(role,family)=>{h.ctx.settings[{head:'fontHead',body:'fontBody',main:'fontMain'}[role]]={family,size:null};return h.run(`applyRole('${role}')`)};
 const a1=choose('head','A');await tick();const b=choose('head','B');await tick();const a2=choose('head','A');const body=choose('body','B');await tick();
 const [fa,fb,fa2,fbody]=h.faces;fa2.resolve();fbody.resolve();await Promise.all([a2,body]);fb.resolve();fa.resolve();await Promise.all([a1,b]);
 assert.deepEqual([...h.added].map(f=>f.alias).sort(),['T3X Body','T3X Heading']);assert.ok(h.added.has(fa2));assert.equal(h.fetches.get('http://fixture/fonts/a.woff2'),1);
 assert.notEqual(fa.src,fa2.src,'each FontFace owns a sliced buffer');assert.equal(fa.options.unicodeRange,'U+0-2F, U+3A-10FFFF');
 const pending=choose('main','A');await tick();await choose('main','off');h.faces.at(-1).resolve();await pending;assert.ok(!h.attrs.has('data-t3x-fm'));
 const bad=choose('main','B');await tick();h.faces.at(-1).reject(Error('failed'));await bad;assert.ok(!h.attrs.has('data-t3x-fm'));assert.ok(h.attrs.has('data-t3x-fh'));
 const late=choose('main','A');await tick();h.ctx.disposed=true;h.faces.at(-1).resolve();await late;assert.ok(!h.attrs.has('data-t3x-fm'));
});
test('preview queue is demand-only, deduped, bounded, independent, and guarded on close/reopen/teardown',async()=>{
 const h=harness();assert.equal(h.fetches.size,0);assert.equal(h.faces.length,0);
 h.run(`catalog=Array.from({length:9},(_,i)=>({name:'Font '+i,source:'google',file:i+'.woff2'})); for(const f of catalog)queueFontName(f.name);queueFontName('Font 0')`);await tick();
 assert.equal(h.faces.length,4);assert.equal(h.run('nameActive'),4);assert.equal(h.run('nameFaces.size'),9);
 h.ctx.settings.fontHead={family:'Font 8',size:150};const role=h.run("applyRole('head')");await tick();assert.equal(h.faces.length,5,'role load bypasses full preview queue');
 h.faces[4].resolve();await role;assert.ok(h.attrs.has('data-t3x-fh'));
 h.faces[0].reject(Error('preview failed'));await tick();assert.equal(h.faces.length,6);h.run("queueFontName('Font 0')");await tick();assert.equal(h.faces.length,6,'failed preview is not retried during fills');
 const before=h.faces.length;h.run('closeFontPreviews()');h.ctx.pop=null;for(const f of h.faces.slice(1))f.resolve();await tick();assert.equal(h.faces.length,before,'queued work stopped on close');assert.deepEqual([...h.added].map(f=>f.alias),['T3X Heading']);
 h.ctx.pop={kind:'panel'};h.run("queueFontName('Font 8')");await tick();const preview=h.faces.at(-1);assert.equal(h.fetches.get('http://fixture/fonts/8.woff2'),1);assert.notEqual(preview.src,h.faces[4].src);assert.equal(preview.options.unicodeRange,undefined);assert.equal(preview.options.sizeAdjust,undefined);
 h.ctx.disposed=true;h.run('closeFontPreviews()');preview.resolve();await tick();assert.equal(h.run('nameActive'),0);assert.deepEqual([...h.added].map(f=>f.alias),['T3X Heading']);
});
test('unavailable local font drops an old role, and closing deletes only owned preview faces',async()=>{
 const h=harness();h.ctx.settings.fontHead={family:'A',size:150};const p=h.run("applyRole('head')");await tick();h.faces[0].resolve();await p;
 assert.ok(h.attrs.has('data-t3x-fh'));
 h.run(`catalog.push({name:'Missing Mac',source:'mac'});`);h.ctx.settings.fontHead={family:'Missing Mac',size:null};await h.run("applyRole('head')");assert.ok(!h.attrs.has('data-t3x-fh'));
 h.run("queueFontName('A')");await tick();const preview=h.faces.at(-1);preview.resolve();await tick();assert.ok(h.added.has(preview));
 const foreign={alias:'other addon'};h.added.add(foreign);h.run('closeFontPreviews()');assert.deepEqual([...h.added],[foreign]);
});
