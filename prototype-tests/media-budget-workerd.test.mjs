import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {transform} from 'esbuild';
const source = await readFile(new URL('../src/whatsapp/media-budget.ts', import.meta.url),'utf8');
const {code} = await transform(source,{loader:'ts',format:'esm'});
const script = `import {DurableObject} from 'cloudflare:workers';\n${code}
export class Budget extends DurableObject {
 async fetch(req) {
  const {now, corrupt} = await req.json();
  if (corrupt) { this.ctx.storage.sql.exec('UPDATE media_read_budget SET attempts = -1'); return new Response('ok'); }
  try { reserveMediaAttempt(this.ctx.storage, now); return new Response('reserved'); }
  catch(e) { return new Response(e.message, {status:429}); }
 }
}
export default {fetch(){return new Response('local synthetic test')}};`;
const options = path => convertV4MiniflareOptions({modules:true,script,name:'media-budget-test',compatibilityDate:'2026-10-08',durableObjects:{BUDGET:{className:'Budget',useSQLite:true}},resourcePersistencePath:path,cf:false,telemetry:{enabled:false}});
const stub = async (mf,name='synthetic') => {const ns=await mf.getDurableObjectNamespace('BUDGET');return ns.get(ns.idFromName(name));};
const call = async (s,now,extra={}) => { const r=await s.fetch('https://local.test',{method:'POST',body:JSON.stringify({now,...extra})});return {status:r.status,text:await r.text()}; };
test('workerd persistent media budget: spacing, hourly cap, restart, concurrency and corrupt-state denial', {skip: process.env.RUN_OFFLINE_WORKERD !== '1'},async()=>{
 const path=await mkdtemp(join(tmpdir(),'media-budget-'));
 let mf;
 try {
  mf=new Miniflare(options(path));
  let s=await stub(mf);
  assert.equal((await call(s,100000)).status,200);
  assert.equal((await call(s,100001)).text,'MEDIA_RATE_LIMITED');
  assert.equal((await call(s,99999)).text,'MEDIA_RATE_LIMITED');
  for(let i=1;i<30;i++) assert.equal((await call(s,100000+i*10000)).status,200);
  assert.equal((await call(s,410000)).text,'MEDIA_RATE_LIMITED');
  await mf.dispose();
  mf=new Miniflare(options(path));
  s=await stub(mf);
  assert.equal((await call(s,420000)).text,'MEDIA_RATE_LIMITED');
  assert.equal((await call(s,3700000)).status,200);
  const c=await stub(mf,'concurrent');
  const results=await Promise.all(Array.from({length:8},()=>call(c,100000)));
  assert.equal(results.filter(r=>r.status===200).length,1);
  assert.equal(results.filter(r=>r.text==='MEDIA_RATE_LIMITED').length,7);
  await call(c,100000,{corrupt:true});
  assert.equal((await call(c,4000000)).text,'MEDIA_BUDGET_UNAVAILABLE');
  assert.equal((await call(s,-1)).text,'MEDIA_BUDGET_UNAVAILABLE');
 } finally {if(mf) await mf.dispose();await rm(path,{recursive:true,force:true});}
});
