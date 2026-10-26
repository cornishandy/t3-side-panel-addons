import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
const source=fs.readFileSync(new URL('../public/extras.js',import.meta.url),'utf8'),box={window:{__T3X_TEST__:{}}};vm.runInNewContext(source,box);const C=box.window.__T3X_TEST__.core;
test('Migration truth table copies Body family AND size; independent false flags and 16 Interface flags preserved',()=>{
 for(const composer of [false,true])for(const quotes of [false,true])for(const plantext of [false,true])for(const size of [null,80,125,150]){
  const fontTargets={composer,quotes,plantext,...Object.fromEntries(C.INTERFACE_TARGETS.map(([k],i)=>[k,k==='plantext'?plantext:i%2===0]))};
  const input={fontBody:{family:'Kalam',size},fontHead:{family:'Caveat',size:115},fontMain:{family:'Neucha',size:140},fontTargets};const out=C.readSettings(JSON.stringify(input));
  for(const k of ['fontComposer','fontQuotes'])assert.deepEqual(JSON.parse(JSON.stringify(out[k])),input.fontBody);
  assert.deepEqual(JSON.parse(JSON.stringify(out.fontInterface)),input.fontMain);assert.equal(out.fontPlans.family,plantext?'Neucha':'off');assert.equal(out.fontReasoning.family,'off');assert.equal(out.fontQuestions.family,'off');assert.equal(out.fontViz.family,'off');
  for(const [k,v]of Object.entries(fontTargets))assert.equal(out.fontTargets[k],v);
  assert.deepEqual(JSON.parse(JSON.stringify(C.readSettings(JSON.stringify(out)))),JSON.parse(JSON.stringify(out)));
 }
 assert.equal(C.INTERFACE_TARGETS.length,16);
});
test('Migration respects explicit independent choices and schema2 Off; legacy presets migrate once',()=>{
 const s=C.readSettings(JSON.stringify({fontBody:{family:'Kalam',size:150},fontComposer:{family:'off',size:null},fontQuotes:{family:'Caveat',size:80}}));assert.equal(s.fontComposer.family,'off');assert.equal(s.fontQuotes.family,'Caveat');assert.equal(s.fontQuotes.size,80);
 const native=C.readSettings(JSON.stringify({fontSchema:2,fontBody:{family:'Kalam',size:150}}));assert.equal(native.fontComposer.family,'off');
 const legacy=C.readSettings(JSON.stringify({font:'3A'}));assert.equal(legacy.fontComposer.family,'Kalam');assert.equal(legacy.fontQuotes.family,'Kalam');assert.equal(legacy.fontHead.family,'Caveat');
});
test('Actual complete addon teardown removes all role attributes and owned faces',()=>{
 const roleStart=source.indexOf('  const ROLE ='),roleEnd=source.indexOf('\n  let catalog =',roleStart),start=source.indexOf('  W.t3xTeardown = () => {'),end=source.indexOf('    delete W.t3xTeardown;',start)+'    delete W.t3xTeardown;\n  };'.length;
 assert.ok(roleStart>0&&roleEnd>roleStart&&start>0&&end>start);
 const attrs=new Set(),faces=new Set(),ctx={W:{},disposed:false,routeToken:0,inflight:null,requests:new Set(),t3Pending:new Set(),rafId:0,cleanups:[],timers:new Set(),features:{},OWN:'data-t3x',ROOT_ATTRS:[],teardownVisualization(){},closePopover(){},endInspector(){},closeFontWorkspace(){},closeFontPreviews(){},D:{querySelectorAll:()=>[],documentElement:{removeAttribute:a=>attrs.delete(a)},fonts:{delete:f=>faces.delete(f)}}};vm.createContext(ctx);vm.runInContext(source.slice(roleStart,roleEnd)+'\nthis.roles=ROLE;',ctx);
 ctx.roleFaces={};for(const [key,r]of Object.entries(ctx.roles)){attrs.add(r.attr);const face={key};faces.add(face);ctx.roleFaces[key]={face};}
 vm.runInContext(source.slice(start,end)+'\nW.t3xTeardown();',ctx);assert.equal(attrs.size,0);assert.equal(faces.size,0);assert.equal(ctx.disposed,true);assert.equal(ctx.W.t3xTeardown,undefined);
});
