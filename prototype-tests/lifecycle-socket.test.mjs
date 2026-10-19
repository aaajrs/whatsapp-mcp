// Offline only: actual patched socket/router and pinned JS core; bridge/client/network are stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { hostRuntime as actualRuntime } from '@oxidezap/baileyrs/lib/Runtime/host.js';
import { readFile, unlink } from 'node:fs/promises';

const output = new URL('./lifecycle-socket.generated.mjs', import.meta.url);
await build({entryPoints:['src/whatsapp/socket.ts'],outdir:'prototype-tests',entryNames:'lifecycle-socket.generated',bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'offline-fixtures',setup(b){
 b.onResolve({filter:/^(\.\/media-read|@oxidezap\/baileyrs\/lib\/Runtime\/host\.js|@oxidezap\/baileyrs\/host)$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='./media-read'?'export const MEDIA_POLICY={groupJid:"synthetic@g.us"};':args.path.endsWith('/host.js')?'export const hostRuntime=globalThis.__lifecycleRuntime;':'export default function(){throw new Error("disabled branch unexpectedly reached")}',loader:'js'}));
}}],outExtension:{'.js':'.mjs'}});
const counts={init:0, created:0, free:0, run:0, disconnect:0, flush:0};
const clients=[];
let delayCreation;
let failureInit=false;
globalThis.__lifecycleRuntime={...actualRuntime,loggerSink:()=>{},bridge:{...actualRuntime.bridge,
 initWasmEngine(){counts.init++; if(failureInit){failureInit=false;throw new Error('synthetic init failure')}},
 async createWhatsAppClient(_transport,http){counts.created++;const c={http,run(){counts.run++},waitForRunCompletion(){return new Promise(()=>{})},async getJid(){},async getLid(){},async getAccount(){},async setDeviceProps(){},async disconnect(){counts.disconnect++},free(){counts.free++}};clients.push(c);if(delayCreation) await delayCreation;return c;}
}};
const {makeSocket}=await import(output.href);
const config=()=>({auth:{creds:{},store:{async get(){},async flush(){counts.flush++}}},version:[2,3000,0]});
const settle=()=>new Promise(r=>setTimeout(r,20));
const originalFetch=globalThis.fetch;
const originalWebSocket=globalThis.WebSocket;
globalThis.WebSocket=class{constructor(){throw new Error('NETWORK PROHIBITED')}};
const requests=[];
globalThis.fetch=async(url,init)=>{requests.push({url,init});return new Response(new Uint8Array([1,2,3]),{status:200})};

test('real pinned JS factory + enabled socket: init retry, multi-socket isolation, sync routing, end/recreate',async()=>{
 try {
  failureInit=true;
  const failed=makeSocket(config(), true);await settle();await failed.end();
  assert.equal(counts.init,1);assert.equal(counts.created,0);
  const a=makeSocket(config(), true);const b=makeSocket(config(), true);await settle();
  assert.equal(counts.init,2,'failed engine init retries; successful init runs once across factories');
  assert.equal(counts.created,2);assert.equal(counts.run,2);
  const ca=clients[0], cb=clients[1];const path='/media/synthetic';const url='https://mmg.whatsapp.net'+path;
  await ca.http.execute(url,'GET',{},null);
  assert.equal(requests.at(-1).init.signal,undefined,'outside scope original sync callback');
  await a.withBoundedMedia(path,16,async()=>{
   await ca.http.execute(url,'GET',{},null);assert.ok(requests.at(-1).init.signal);assert.equal(requests.at(-1).init.redirect,'error');
   await cb.http.execute(url,'GET',{},null);assert.equal(requests.at(-1).init.signal,undefined,'other socket unaffected');
   await ca.http.execute('https://sync.invalid/other','POST',{'x-test':'synthetic'},new Uint8Array([9]));assert.equal(requests.at(-1).init.signal,undefined);assert.equal(requests.at(-1).init.method,'POST');assert.deepEqual(requests.at(-1).init.headers,{'x-test':'synthetic'});assert.deepEqual(requests.at(-1).init.body,new Uint8Array([9]));
  });
  const bounded=requests.find(r=>r.init.signal);assert.equal(bounded.init.signal.aborted,true,'scope releases transport on success');
  await assert.rejects(a.withBoundedMedia(path,16,async()=>{throw new Error('synthetic failure')}),/synthetic failure/);
  await ca.http.execute(url,'GET',{},null);assert.equal(requests.at(-1).init.signal,undefined,'failure restores original callback');
  await Promise.all([a.end(),a.end(),b.end()]);assert.equal(counts.free,2,'client release once');
  const c=makeSocket(config(), true);await settle();assert.equal(counts.init,2);await c.end();assert.equal(counts.free,3);
  let release;delayCreation=new Promise(r=>{release=r});const d=makeSocket(config(), true);await settle();const ending=d.end();let ended=false;ending.then(()=>ended=true);await settle();assert.equal(ended,false,'end joins pending creation');release();await ending;delayCreation=undefined;
  assert.equal(counts.free,4);assert.equal(counts.run,3,'late client is not started after end');
  assert.match(await readFile('src/whatsapp/socket.ts','utf8'),/mediaEnabled = false/);
  console.log(JSON.stringify({result:'PASS',runtime:'Node actual pinned JS core; stub bridge/client/fetch',counts,syntheticRequests:requests.length}));
 } finally {globalThis.fetch=originalFetch;globalThis.WebSocket=originalWebSocket;delete globalThis.__lifecycleRuntime;await unlink(output);}
});
