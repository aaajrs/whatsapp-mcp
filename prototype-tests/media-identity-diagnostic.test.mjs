import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readScopedMedia,mediaIdentityDiagnostics} from '../src/whatsapp/media-read.ts';
import {encodeRaw,decodeRaw} from '../src/whatsapp/raw.ts';
const policy={groupJid:'123456@g.us',ownerJids:['123456@s.whatsapp.net','654321@lid'],maxBytes:1024,notBefore:100};
const requested={chat:policy.groupJid,message_id:'synthetic-id'};
const record={chatJid:requested.chat,id:requested.message_id,fromMe:true,senderJid:null,sentAt:200,deleted:false};
const image={mimetype:'image/png',fileLength:8,directPath:'/sensitive-synthetic-path',mediaKey:new Uint8Array(32).fill(7),fileSha256:new Uint8Array(32),fileEncSha256:new Uint8Array(32)};
const raw=()=>({key:{remoteJid:requested.chat,id:requested.message_id,fromMe:true,participant:'654321@lid'},message:{imageMessage:image}});
const roundtrip=m=>decodeRaw(encodeRaw(m));
const diagnostics= m=>mediaIdentityDiagnostics(policy,requested,m);
test('pinned protobuf preserves key and top-level participant, camelCase and fromMe boolean',()=>{
 const m=roundtrip({...raw(),participant:'123456@s.whatsapp.net'});
 const d=diagnostics(m);
 for(const k of ['keyPresent','chatMatches','idMatches','fromMePresent','fromMeTrue','keyParticipantMatches','envelopeParticipantMatches']) assert.equal(d[k],true,k);
});
for(const field of ['key','envelope']) test(`device-qualified ${field} author is diagnosed but still denied before download`,async()=>{
 const m=raw(); if(field==='key')m.key.participant='654321:7@lid';else m.participant='123456:8@s.whatsapp.net';
 const decoded=roundtrip(m); let downloaded=false;
 await assert.rejects(readScopedMedia(policy,requested,record,decoded,async()=>{downloaded=true;return new Uint8Array(8)},()=>record),e=>{
  assert.match(e.message,/^IDENTITY_MISMATCH /);
  const d=JSON.parse(e.message.slice('IDENTITY_MISMATCH '.length));
  assert.equal(d[`${field}ParticipantMatches`],false);
  assert.equal(d[`${field}ParticipantNormalizedMatches`],true);
  assert.ok(Object.values(d).every(v=>typeof v==='boolean'));
  for(const forbidden of ['123456','654321','synthetic','mediaKey','directPath'])assert.equal(e.message.includes(forbidden),false);
  return true;
 });
 assert.equal(downloaded,false);
});
for(const [name,edit,flag] of [
 ['chat',m=>m.key.remoteJid='999999@g.us','chatMatches'],
 ['id',m=>m.key.id='other','idMatches'],
 ['false fromMe',m=>m.key.fromMe=false,'fromMeTrue'],
 ['missing fromMe',m=>delete m.key.fromMe,'fromMeTrue'],
 ['unrelated participant',m=>m.key.participant='999999@lid','keyParticipantMatches'],
]) test(`protobuf diagnostic identifies ${name} mismatch without values`,()=>{
 const m=raw();edit(m);const d=diagnostics(roundtrip(m));assert.equal(d[flag],false);assert.ok(Object.values(d).every(v=>typeof v==='boolean'));
});
test('out-of-scope request does not receive identity diagnostics',async()=>{
 await assert.rejects(readScopedMedia(policy,{...requested,chat:'999999@g.us'},record,raw(),async()=>new Uint8Array(),()=>record),e=>e.message==='OUT_OF_SCOPE');
});
