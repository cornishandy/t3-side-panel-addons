import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
export const SRC=fileURLToPath(new URL('..',import.meta.url));
export const BUILD='0.1.10-nightly.20261115.4736';
export async function fixture(t, page) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'t3x-break-'));
  fs.mkdirSync(path.join(dir,'public')); fs.mkdirSync(path.join(dir,'home'));
  for(const name of ['fonts.json','font-about.json']) fs.copyFileSync(path.join(SRC,name),path.join(dir,name));
  const fonts=JSON.parse(fs.readFileSync(path.join(dir,'fonts.json'),'utf8'));
  fonts.families.push({name:'Downloaded fixture',source:'google',group:'sans',style:'print',file:'fixture.ttf',size:100});
  fonts.files.push({file:'fixture.ttf'});writeFixtureFont();
  function writeFixtureFont() {fs.mkdirSync(path.join(dir,'fonts'));fs.writeFileSync(path.join(dir,'fonts/fixture.ttf'),fixtureFont());}
  fs.writeFileSync(path.join(dir,'fonts.json'),JSON.stringify(fonts));
  const js=fs.readFileSync(path.join(SRC,'public/extras.js'),'utf8').replace('const BASE = "http://127.0.0.1:8793/";','const BASE = location.origin + "/";');
  const css=fs.readFileSync(path.join(SRC,'public/extras.css'),'utf8');
  fs.writeFileSync(path.join(dir,'public/extras.js'),js); fs.writeFileSync(path.join(dir,'public/extras.css'),css);
  const keeper=path.join(dir,'keeper.json'), compat=path.join(dir,'compat.json'), screen=path.join(dir,'screen.json');
  const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
  write(keeper,{build:BUILD,mainJs:'main-fixture.js'});
  write(compat,{trial:{startedAt:'2026-11-15T00:00:00.000Z',endsAt:'2026-11-30T04:59:00.000Z'},outcomes:[]});
  const requests=[]; let handler;
  const server=http.createServer((req,res)=>{
    requests.push(req.url);
    if(req.url==='/') {res.setHeader('Content-Type','text/html');return res.end(page?.({js,css})??'');}
    if(req.url==='/assets/main-fixture.js') {res.setHeader('Content-Type','text/javascript');return res.end('window.mainFixtureLoaded=true;');}
    // The fixture stands in for the t3code://app page's Origin header only.
    req.headers.origin='t3code://app';
    handler(req,res);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  Object.assign(process.env,{T3X_DIR:dir,T3X_PORT:String(server.address().port),T3X_HOME:path.join(dir,'home'),T3X_STATEV2:path.join(dir,'none.sqlite'),T3X_LAB_USAGE:path.join(dir,'none'),T3X_HANDOVER_BIN:path.join(dir,'none'),T3X_HANDOVER_STATE:path.join(dir,'none'),T3X_ENV_ID_FILE:path.join(dir,'none'),T3X_KEEPER_STATE:keeper,T3X_KEEPER_COMPAT:compat,T3X_SCREEN_FILE:screen});
  ({handler}=await import(`../server.mjs?fixture=${encodeURIComponent(dir)}`));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const get=async(p,method='GET')=>fetch(base+p,{method});
  return {dir,base,get,keeper,compat,screen,write,requests,js,css};
}
// A minimal generated TrueType face, used only to exercise the downloaded-font path.
// No installed fonts, network font downloads or third-party fixture are needed.
function fixtureFont() {
  const tables={};
  const table=(tag,size)=>tables[tag]=Buffer.alloc(size);
  let b=table('head',54);b.writeUInt32BE(0x10000,0);b.writeUInt32BE(0x10000,4);b.writeUInt32BE(0x5f0f3cf5,12);b.writeUInt16BE(1000,18);b.writeUInt16BE(8,46);b.writeInt16BE(2,48);
  b=table('hhea',36);b.writeUInt32BE(0x10000,0);b.writeInt16BE(800,4);b.writeInt16BE(-200,6);b.writeUInt16BE(500,10);b.writeInt16BE(1,18);b.writeUInt16BE(1,34);
  b=table('maxp',32);b.writeUInt32BE(0x10000,0);b.writeUInt16BE(1,4);b.writeUInt16BE(2,14);
  b=table('hmtx',4);b.writeUInt16BE(500,0);table('glyf',12);b=table('loca',4);b.writeUInt16BE(6,2);
  b=table('cmap',36);b.writeUInt16BE(1,2);b.writeUInt16BE(3,4);b.writeUInt16BE(1,6);b.writeUInt32BE(12,8);b.writeUInt16BE(4,12);b.writeUInt16BE(24,14);b.writeUInt16BE(2,18);b.writeUInt16BE(2,20);b.writeUInt16BE(0xffff,26);b.writeUInt16BE(0xffff,30);b.writeUInt16BE(1,32);
  b=table('post',32);b.writeUInt32BE(0x30000,0);
  b=table('OS/2',78);b.writeInt16BE(500,2);b.writeUInt16BE(400,4);b.writeUInt16BE(5,6);b.writeUInt16BE(0x40,62);b.writeUInt16BE(0xffff,66);b.writeInt16BE(800,68);b.writeInt16BE(-200,70);b.writeUInt16BE(800,74);b.writeUInt16BE(200,76);
  const names=[[1,'Fixture'],[2,'Regular'],[4,'Fixture Regular'],[6,'Fixture-Regular']];
  const strings=names.map(([,s])=>Buffer.from(s,'utf16le').swap16());
  b=table('name',6+names.length*12+strings.reduce((n,s)=>n+s.length,0));b.writeUInt16BE(names.length,2);b.writeUInt16BE(6+names.length*12,4);
  let at=0;names.forEach(([id],i)=>{const o=6+i*12;for(const [j,v]of [3,1,0x409,id,strings[i].length,at].entries())b.writeUInt16BE(v,o+j*2);strings[i].copy(b,6+names.length*12+at);at+=strings[i].length;});
  const tags=Object.keys(tables).sort(),n=tags.length;let offset=12+16*n;
  const sum=buf=>{let v=0;for(let i=0;i<buf.length;i+=4)v=(v+buf.readUInt32BE(i))>>>0;return v;};
  const padded=buf=>Buffer.concat([buf,Buffer.alloc((4-buf.length%4)%4)]);
  const out=Buffer.alloc(offset+tags.reduce((n,t)=>n+padded(tables[t]).length,0));out.writeUInt32BE(0x10000,0);out.writeUInt16BE(n,4);out.writeUInt16BE(128,6);out.writeUInt16BE(3,8);out.writeUInt16BE(n*16-128,10);
  let head;
  tags.forEach((tag,i)=>{const o=12+i*16,p=padded(tables[tag]);out.write(tag,o,4,'ascii');out.writeUInt32BE(sum(p),o+4);out.writeUInt32BE(offset,o+8);out.writeUInt32BE(tables[tag].length,o+12);p.copy(out,offset);if(tag==='head')head=offset;offset+=p.length;});
  out.writeUInt32BE((0xb1b0afba-sum(out))>>>0,head+8);return out;
}
