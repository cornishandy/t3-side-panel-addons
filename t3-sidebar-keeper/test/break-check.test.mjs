// Isolated functions from the real keeper: no app, installer or installed state access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import * as acorn from '../vendor/acorn/acorn.mjs';
const source = fs.readFileSync(new URL('../keeper.mjs',import.meta.url),'utf8');
const ast = acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'});
function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'keeper-check-')); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const notices=[], logs=[], output=[];
  const context=vm.createContext({fs,path,Buffer,Date,HOME:home,STATE:path.join(home,'state.json'),COMPAT:path.join(home,'compat.json'),SCREEN:path.join(home,'screen.json'),ADDON_NAMES:['Wrapped titles','Thread titles font','One-row titles'],process:{pid:process.pid,env:{},argv:[]},bundleVersion:()=>build,spawnSync:(_cmd,args)=>{notices.push(args);return {status:0};},log:s=>logs.push(s),console:{log:s=>output.push(JSON.parse(s))},withLock:fn=>fn(),writeAt:(fd,buf,pos)=>fs.writeSync(fd,buf,0,buf.length,pos)});
  for(const name of ['notify','writeFileDurable','loadState','saveState','readJson','initCompat','trialState','compatStatus','buildLabel','noticeFor','notifyApply','cmdOutcome','cmdTrialReport']) {
    const n=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name); vm.runInContext(source.slice(n.start,n.end),context);
  }
  const run=code=>vm.runInContext(code,context);
  return {home,context,run,notices,logs,output,read:n=>JSON.parse(fs.readFileSync(path.join(home,n),'utf8')),write:(n,j)=>fs.writeFileSync(path.join(home,n),JSON.stringify(j))};
}
const build='0.1.10-nightly.20261115.4736';
test('notice precedence, exact copy, subtitles, labels and deduplication',t=>{
  const f=fixture(t);
  for(const wrote of [false,true]) {
    const r=f.run(`noticeFor({version:'${build}',failed:['minWidth'],wrote:${wrote}},['Wrapped titles'])`);
    assert.equal(r.body,"Couldn't fully apply the sidebar fix to build 4736. Ask an agent to update it.");
    assert.equal(r.subtitle,'Wrapped titles may need an update');
  }
  assert.equal(f.run(`noticeFor({version:'${build}',failed:[],wrote:true},[]).body`),'Re-applied to build 4736. Press Shift-Cmd-R in T3 to reload.');
  assert.equal(f.run(`noticeFor({version:'${build}',failed:[],wrote:false},['Wrapped titles']).body`),'Your T3 sidebar changes are on build 4736.');
  assert.equal(f.run(`noticeFor({version:'1.2.3',failed:[],wrote:true},[]).subtitle`),'');
  assert.equal(f.run(`noticeFor({version:'1.2.3',failed:[],wrote:true},['a','b']).subtitle`),'2 add-ons may need an update');
  assert.equal(f.run(`buildLabel('1.2.3')`),'1.2.3');
  const out=`{version:'${build}',failed:[],wrote:true,missingHooks:['selector']}`;
  f.run(`notifyApply(${out});notifyApply(${out})`); assert.equal(f.notices.length,1);
  f.run(`notifyApply({...${out},failed:['wrap']})`); assert.equal(f.notices.length,2);
  assert.doesNotMatch(JSON.stringify(f.notices),/markup|selector|minWidth|wrap:/);
  assert.match(f.notices[0][1],/subtitle "Wrapped titles may need an update"/);
  assert.equal(f.read('compat.json').events.length,1);
});
test('compat survives replacement saves; mainJs carries within a build and clears in wait/error paths',t=>{
  const f=fixture(t); f.run('initCompat()'); const before=fs.readFileSync(path.join(f.home,'compat.json'),'utf8');
  f.run(`saveState({build:'${build}',mainJs:'main-A.js',status:'patched'});saveState({build:'${build}',status:'restored'})`);
  assert.equal(f.read('state.json').mainJs,'main-A.js');
  f.run(`saveState({build:'build-B',status:'waiting-first-launch'})`); assert.equal(f.read('state.json').mainJs,null);
  f.run(`saveState({build:'build-C',mainJs:'main-A.js',status:'patched'})`); assert.equal(f.read('state.json').mainJs,'main-A.js','rediscovery can retain the same basename in a new build');
  assert.equal(fs.readFileSync(path.join(f.home,'compat.json'),'utf8'),before);
  for(const line of source.split('\n').filter(l=>l.includes('saveState({ ...state')&&l.includes('build: version'))) assert.match(line,/mainJs: state.build === version/);
  assert.match(source,/mainJs: out.mainJs/);
});
test('shown event merge, commands, idempotence, corrections, live kill test and trial report',t=>{
  const f=fixture(t); f.run('initCompat()'); const c=f.read('compat.json');
  c.trial.startedAt='2026-01-01T00:00:00.000Z'; c.trial.endsAt='2026-01-02T00:00:00.000Z';
  c.events=[{build,addon:'Wrapped titles',layer:'marker',firstShownAt:'2026-11-15T15:00:00.000Z'}]; f.write('compat.json',c);
  f.write('state.json',{build});
  f.write('screen.json',{results:[{build,addon:'Wrapped titles',firstShownAt:'2026-11-15T15:01:00.000Z'},{build,addon:'Thread titles font',firstShownAt:'2026-11-15T15:02:00.000Z'},{build,addon:'One-row titles'}]});
  assert.equal(f.run('compatStatus().events.length'),3,'unshown observation is not an event');
  f.context.process.argv=['node','keeper','--false-alarm','Wrapped titles']; f.run(`cmdOutcome('false-alarm')`);
  const before=fs.readFileSync(path.join(f.home,'compat.json'),'utf8'); f.run(`cmdOutcome('false-alarm')`);assert.equal(fs.readFileSync(path.join(f.home,'compat.json'),'utf8'),before);
  assert.equal(f.run('compatStatus().trial.falseAlarms'),1,'two layers count once');
  f.context.process.argv[3]='Thread titles font'; f.run(`cmdOutcome('false-alarm')`);
  assert.equal(f.run('compatStatus().trial.alertsStopped'),true); assert.equal(f.run('compatStatus().trial.ended'),true);
  f.run(`notifyApply({version:'${build}',failed:[],wrote:true,missingHooks:['x']})`); assert.doesNotMatch(f.notices[0][1],/subtitle/);
  f.run(`cmdOutcome('real')`); assert.equal(f.run('compatStatus().trial.alertsStopped'),false); assert.equal(f.logs.length,3);
  const screen=f.read('screen.json');screen.results[2].firstShownAt='2026-11-15T15:03:00.000Z';f.write('screen.json',screen);
  f.run('cmdTrialReport()'); assert.equal(f.output[0]['confirmed real'].length,1);assert.equal(f.output[0]['confirmed false alarm'].length,2);assert.equal(f.output[0]['never sent to an agent'].length,1);
  f.run(`initCompat()`); assert.equal(f.read('compat.json').trial.startedAt,c.trial.startedAt);
  assert.match(source,/results,\n    compat: compatStatus\(missingHooks\)/);
});

test('actual auto/apply/restore command saves preserve compat and main asset only within the build',t=>{
  const f=fixture(t), archive=path.join(f.home,'fixture.asar'), backups=path.join(f.home,'backups');
  fs.writeFileSync(archive,'fixture');fs.mkdirSync(backups);
  Object.assign(f.context,{ASAR:archive,BACKUPS:backups,KEEPER_VERSION:17,UNITS:[],zlib,reminderTick:()=>{},loaderKeyId:()=> 'key',asarIdentity:()=>({tag:1}),asarKey:id=>String(id.tag),bundleVersion:()=>f.context.currentBuild,launchedByT3:()=>f.context.launched,readLayout:()=>({}),identityOfFd:()=>({tag:1}),sameFile:(a,b)=>a?.tag===b?.tag,commit:()=>({produced:{tag:1}}),reminders:{noteRestored:()=>{}}});
  for(const name of ['cmdAuto','recordApply','cmdRestore']) {const n=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);vm.runInContext(source.slice(n.start,n.end),f.context);}
  f.run('initCompat()');const original=fs.readFileSync(path.join(f.home,'compat.json'),'utf8');
  f.context.currentBuild=build;f.context.launched=true;
  f.context.out={version:build,mainJs:'main-A.js',checked:{tag:1},produced:null,results:{},failed:[],missingHooks:[],wrote:false};f.context.apply=()=>f.context.out;
  f.run('cmdAuto()');assert.equal(f.read('state.json').mainJs,'main-A.js');
  f.context.out.mainJs=null;f.run('recordApply(out)');assert.equal(f.read('state.json').mainJs,'main-A.js');
  const state=f.read('state.json');state.produced={build,identity:{tag:1}};f.write('state.json',state);
  fs.writeFileSync(path.join(backups,build+'.json.gz'),zlib.gzipSync(JSON.stringify({files:{}})));
  f.run('cmdRestore()');assert.equal(f.read('state.json').mainJs,'main-A.js');
  // Changing the version of an unlaunched archive cannot inherit the old basename.
  f.context.currentBuild='0.1.11';f.context.launched=false;const restored=f.read('state.json');restored.key=null;f.write('state.json',restored);
  f.run('cmdAuto()');assert.equal(f.read('state.json').mainJs,null);
  f.write('state.json',{build,mainJs:'main-A.js'});f.context.launched=true;f.context.apply=()=>{throw Error('fixture failure');};f.run('cmdAuto()');assert.equal(f.read('state.json').mainJs,null);
  assert.equal(fs.readFileSync(path.join(f.home,'compat.json'),'utf8'),original);
});
