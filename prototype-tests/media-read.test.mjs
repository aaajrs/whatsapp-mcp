import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readScopedMedia } from '../src/whatsapp/media-read.ts';
const policy = { groupJid: 'test@g.us', ownerJids: ['owner@s.whatsapp.net'], maxBytes: 1024, notBefore: 100 };
const request = { chat: policy.groupJid, message_id: 'test-id' };
const record = { chatJid: request.chat, id: request.message_id, fromMe: true, senderJid: policy.ownerJids[0], sentAt: 200, deleted: false };
const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,0]);
const raw = () => ({ key: { remoteJid: request.chat, id: request.message_id, fromMe: true }, message: { imageMessage: { mimetype: 'image/png', fileLength: bytes.length, directPath: '/synthetic', mediaKey: new Uint8Array(32), fileSha256: new Uint8Array(32), fileEncSha256: new Uint8Array(32) } } });
async function run({p=policy,q=request,r=record,m=raw(),d=async()=>bytes,c=()=>record}={}) { return readScopedMedia(p,q,r,m,d,c); }
test('disabled by default', async()=> { await assert.rejects(run({p:null}),/MEDIA_DISABLED/); });
test('returns verified bytes and provenance, never media keys',async()=> {const out=await run(); assert.deepEqual(out.data,bytes); assert.equal(out.source,'downloaded_attachment'); assert.equal('mediaKey' in out,false);});
for (const [name, options, error] of [
 ['wrong group',{q:{...request,chat:'other@g.us'}},'OUT_OF_SCOPE'],
 ['wrong archive message',{r:{...record,id:'other'}},'OUT_OF_SCOPE'],
 ['non-owner',{r:{...record,fromMe:false}},'NOT_OWNER'],
 ['conflicting sender',{r:{...record,senderJid:'stranger'}},'NOT_OWNER'],
 ['deleted',{r:{...record,deleted:true}},'MEDIA_UNAVAILABLE'],
 ['old attachment',{r:{...record,sentAt:99}},'BEFORE_ACTIVATION'],
 ['missing record',{r:null},'MEDIA_UNAVAILABLE'],
]) test(name,async()=> {let called=false; await assert.rejects(run({...options,d:async()=>{called=true;return bytes}}),new RegExp(error));assert.equal(called,false);});
for(const [name, edit, error] of [
 ['raw identity mismatch',m=>{m.key.id='wrong'},'IDENTITY_MISMATCH'],
 ['raw sender mismatch',m=>{m.key.participant='stranger'},'IDENTITY_MISMATCH'],
 ['view once',m=>{m.message.imageMessage.viewOnce=true},'VIEW_ONCE'],
 ['view-once wrapper',m=>{m.message={viewOnceMessage:{message:m.message}}},'UNSUPPORTED_MESSAGE'],
 ['ephemeral wrapper',m=>{m.message={ephemeralMessage:{message:m.message}}},'UNSUPPORTED_MESSAGE'],
 ['expiry metadata',m=>{m.message.imageMessage.contextInfo={expiration:50}},'EPHEMERAL_MEDIA'],
 ['unsupported type',m=>{m.message.imageMessage.mimetype='image/svg+xml'},'UNSUPPORTED_TYPE'],
 ['too large',m=>{m.message.imageMessage.fileLength=1025},'MEDIA_SIZE_LIMIT'],
 ['missing size',m=>{delete m.message.imageMessage.fileLength},'MEDIA_SIZE_LIMIT'],
 ['no media key',m=>{delete m.message.imageMessage.mediaKey},'MISSING_DOWNLOAD_METADATA'],
]) test(name,async()=>{const m=raw();edit(m);let called=false;await assert.rejects(run({m,d:async()=>{called=true;return bytes}}),new RegExp(error));assert.equal(called,false)});
test('download error redacted',async()=>assert.rejects(run({d:async()=>{throw new Error('secret')}}),/^Error: DOWNLOAD_FAILED$/));
test('size mismatch',async()=>assert.rejects(run({d:async()=>bytes.slice(1)}),/DOWNLOAD_SIZE_MISMATCH/));
test('signature mismatch',async()=>assert.rejects(run({d:async()=>new Uint8Array(bytes.length)}),/CONTENT_TYPE_MISMATCH/));
test('revocation race',async()=>assert.rejects(run({c:()=>({...record,deleted:true})}),/MEDIA_UNAVAILABLE/));
test('PDF binary path',async()=>{const m=raw();m.message={documentMessage:{...m.message.imageMessage,mimetype:'application/pdf',fileLength:5}};const out=await run({m,d:async()=>Uint8Array.from([37,80,68,70,45])});assert.equal(out.mimetype,'application/pdf')});

// Exercise the exact archive serialization boundary, using the pinned protobuf.
// Plain object fixtures alone miss outer-envelope lifecycle metadata.
import { encodeRaw, decodeRaw } from '../src/whatsapp/raw.ts';
const archived = m => {
  const encoded = encodeRaw(m);
  assert.ok(encoded instanceof Uint8Array);
  return decodeRaw(encoded);
};
test('protobuf archive roundtrip permits ordinary image without lifecycle metadata', async()=> {
  const out = await run({m:archived(raw())});
  assert.deepEqual(out.data, bytes);
});
for (const [name, fields, error] of [
  ['expired envelope', {ephemeralStartTimestamp:200, ephemeralDuration:10}, 'EPHEMERAL_MEDIA'],
  ['future ephemeral envelope', {ephemeralStartTimestamp:2147483647, ephemeralDuration:86400}, 'EPHEMERAL_MEDIA'],
  ['ephemeral start only', {ephemeralStartTimestamp:200}, 'EPHEMERAL_MEDIA'],
  ['ephemeral duration only', {ephemeralDuration:10}, 'EPHEMERAL_MEDIA'],
  ['explicit zero ephemeral start', {ephemeralStartTimestamp:0}, 'EPHEMERAL_MEDIA'],
  ['explicit zero ephemeral duration', {ephemeralDuration:0}, 'EPHEMERAL_MEDIA'],
  ['ephemeral transition', {ephemeralOffToOn:true}, 'EPHEMERAL_MEDIA'],
  ['ephemeral out of sync', {ephemeralOutOfSync:true}, 'EPHEMERAL_MEDIA'],
  ['clear media', {clearMedia:true}, 'MEDIA_UNAVAILABLE'],
  ['revoked envelope', {revokeMessageTimestamp:200}, 'MEDIA_UNAVAILABLE'],
  ['zero revoke timestamp', {revokeMessageTimestamp:0}, 'MEDIA_UNAVAILABLE'],
  ['revoke deletion stub', {messageStubType:1}, 'MEDIA_UNAVAILABLE'],
  ['unknown stub', {messageStubType:0}, 'MEDIA_UNAVAILABLE'],
]) test(`protobuf archive rejects ${name} before downloading`, async()=> {
  const m = archived({...raw(), ...fields});
  for (const field of Object.keys(fields)) assert.ok(Object.hasOwn(m,field));
  let called=false;
  await assert.rejects(run({m,d:async()=>{called=true;return bytes}}), new RegExp(error));
  assert.equal(called,false);
});

for (const kind of ['imageMessage','documentMessage']) test(`ordinary transport sidecar permits ${kind} through protobuf`,async()=>{
 const m=raw(); const data=kind==='imageMessage'?bytes:Uint8Array.from([37,80,68,70,45]);
 const media={...m.message.imageMessage,mimetype:kind==='imageMessage'?'image/png':'application/pdf',fileLength:data.length};
 m.message={[kind]:media,messageContextInfo:{deviceListMetadataVersion:2,messageSecret:new Uint8Array(32).fill(9)}};
 const out=await run({m:archived(m),d:async()=>data});assert.deepEqual(out.data,data);
 assert.equal(JSON.stringify({...out,data:undefined}).includes('messageSecret'),false);
});
for(const sidecar of [{messageAddOnDurationInSecs:0},{messageAddOnExpiryType:0},{limitSharing:{}},{limitSharingV2:{}},{unknownField:true},[],true,'context'])test(`reject unsafe sidecar ${JSON.stringify(sidecar)}`,async()=>{
 const m=raw();m.message.messageContextInfo=sidecar;let called=false;
 await assert.rejects(run({m,d:async()=>{called=true;return bytes}}),/UNSUPPORTED_MESSAGE/);assert.equal(called,false);
});
test('normal sidecar does not bypass view once',async()=>{
 const m=raw();m.message.messageContextInfo={deviceListMetadataVersion:2};m.message.imageMessage.viewOnce=true;
 let called=false;await assert.rejects(run({m,d:async()=>{called=true;return bytes}}),/VIEW_ONCE/);assert.equal(called,false);
});
