import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture,BUILD} from './break-check-fixture.mjs';
test('screen GET: strict tokens, stale versions, shown, atomic private persistence and keeper projections',async t=>{
  const f=await fixture(t);
  const version=await (await f.get('/version')).text();
  const p=new URLSearchParams({kind:'result',build:'4736',addon:'threadtitles',result:'broken',version,checker:'1',seen:'2',matched:'0'});
  const report=()=>f.get('/screen?'+p);
  assert.equal((await report()).status,204);
  assert.equal(fs.statSync(f.screen).mode&0o777,0o600);
  assert.equal(fs.readdirSync(f.dir).some(n=>n.endsWith('.tmp')),false);
  let stored=JSON.parse(fs.readFileSync(f.screen)); assert.equal(stored.results[0].firstShownAt,undefined);
  const shown=new URLSearchParams({kind:'shown',build:'4736',addon:'threadtitles',version,checker:'1'});
  assert.equal((await f.get('/screen?'+shown)).status,204);
  const first=JSON.parse(fs.readFileSync(f.screen)).results[0].firstShownAt;
  assert.equal((await f.get('/screen?'+shown)).status,204);
  assert.equal(JSON.parse(fs.readFileSync(f.screen)).results[0].firstShownAt,first);
  for(const [key,value] of [['addon','not-an-addon'],['seen','10001'],['matched','3'],['seen','-1'],['result','unchecked'],['checker','2'],['title','PRIVATE'],['seen','2.1']]) {
    const invalid=new URLSearchParams(p); invalid.set(key,value);assert.equal((await f.get('/screen?'+invalid)).status,400,key);
  }
  assert.equal((await f.get('/screen?'+p+'&seen=2')).status,400);
  assert.equal((await f.get('/screen?'+p,'POST')).status,405);
  const options=await f.get('/screen','OPTIONS');assert.equal(options.headers.get('Access-Control-Allow-Methods'),'GET');
  p.set('result','ok');p.set('matched','2');assert.equal((await report()).status,204);
  p.set('version','0000000000000000');p.set('result','broken');p.set('matched','0');assert.equal((await report()).status,409);
  assert.equal(JSON.parse(fs.readFileSync(f.screen)).results[0].result,'ok');
  p.set('version',version);
  f.write(f.compat,{trial:{startedAt:'2026-01-01',endsAt:'2026-01-02'},outcomes:[{build:BUILD,addon:'Thread titles font',outcome:'false-alarm'},{build:'0.1.1',addon:'Wrapped titles',outcome:'false-alarm'}]});
  let state=await (await f.get('/state')).json();assert.deepEqual(state.t3Build,{full:BUILD,label:'4736'});assert.equal(state.t3MainJs,'main-fixture.js');assert.equal(state.compat.trial.alertsStopped,true);assert.equal(state.screen.length,1);
  // A different build's record is retained, but ignored by the loaded page.
  f.write(f.keeper,{build:'0.1.1',mainJs:'main-next.js'});p.set('build','0.1.1');assert.equal((await report()).status,204);
  assert.equal(JSON.parse(fs.readFileSync(f.screen)).results.length,2);
  for(const target of [f.keeper,f.compat,f.screen]) fs.writeFileSync(target,'{broken');
  state=await (await f.get('/state')).json();assert.equal(state.t3Build,null);assert.equal(state.t3MainJs,null);assert.equal(state.compat.trial,null);assert.deepEqual(state.screen,[]);
  fs.unlinkSync(f.keeper);fs.unlinkSync(f.compat);state=await (await f.get('/state')).json();assert.equal(state.t3Build,null);
  assert.equal((await report()).status,409);
  assert.doesNotMatch(fs.readFileSync(f.screen,'utf8'),/PRIVATE/);
});

test('a rejected screen report logs one fixed reason word, never a request value',async t=>{
  const f=await fixture(t);
  const lines=[],real=console.log;console.log=(...a)=>lines.push(a.join(' '));t.after(()=>{console.log=real;});
  const version=await (await f.get('/version')).text();
  const p=new URLSearchParams({kind:'result',build:'4736',addon:'threadtitles',result:'broken',version,checker:'1',seen:'2',matched:'0'});
  const status=async q=>(await f.get('/screen?'+q)).status;
  assert.equal(await status(p+'&title=PRIVATE_TITLE'),400);
  assert.equal(await status(new URLSearchParams({...Object.fromEntries(p),seen:'1',matched:'2'})),400);
  assert.equal(await status(new URLSearchParams({...Object.fromEntries(p),version:'0123456789abcdef'})),409);
  assert.equal(await status(new URLSearchParams({...Object.fromEntries(p),build:'9876'})),409);
  assert.equal(await status(new URLSearchParams({kind:'shown',build:'4736',addon:'onerow',version,checker:'1'})),409);
  assert.equal(await status(p),204);
  assert.deepEqual(lines.filter(l=>/^\S+ screen /.test(l)).map(l=>l.replace(/^\S+ /,'')),['screen 400 params','screen 400 result','screen 409 version','screen 409 build','screen 409 notbroken']);
  assert.doesNotMatch(lines.join('\n'),/PRIVATE_TITLE|0123456789abcdef|9876|onerow/);
});

test('a running old payload cannot overwrite a current healthy result after a code update',async t=>{
  const f=await fixture(t);
  const old=await(await f.get('/version')).text();
  const params=new URLSearchParams({kind:'result',build:'4736',addon:'threadtitles',version:old,checker:'1',result:'broken',seen:'2',matched:'0'});
  assert.equal((await f.get('/screen?'+params)).status,204);
  fs.appendFileSync(f.dir+'/public/extras.js','\n// a new installed payload\n');
  assert.equal((await f.get('/screen?'+params)).status,409);
  const current=await(await f.get('/version')).text();assert.notEqual(current,old);
  params.set('version',current);params.set('result','ok');params.set('matched','2');assert.equal((await f.get('/screen?'+params)).status,204);
  params.set('version',old);params.set('result','broken');params.set('matched','0');assert.equal((await f.get('/screen?'+params)).status,409);
  const lines=JSON.parse(fs.readFileSync(f.screen)).results;assert.equal(lines.length,2);assert.equal(lines.find(x=>x.version===current).result,'ok');
});
