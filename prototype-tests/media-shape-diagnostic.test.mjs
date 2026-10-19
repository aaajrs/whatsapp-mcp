import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readScopedMedia,mediaShapeDiagnostics} from '../src/whatsapp/media-read.ts';
import {encodeRaw,decodeRaw} from '../src/whatsapp/raw.ts';
const policy={groupJid:'123456@g.us',ownerJids:['123456@s.whatsapp.net'],maxBytes:1024,notBefore:100};
const request={chat:policy.groupJid,message_id:'synthetic-id'};
const record={chatJid:request.chat,id:request.message_id,fromMe:true,senderJid:null,sentAt:200,deleted:false};
const media={mimetype:'image/png',fileLength:8,directPath:'/synthetic-secret',mediaKey:new Uint8Array(32).fill(7),fileSha256:new Uint8Array(32),fileEncSha256:new Uint8Array(32)};
const archive=message=>decodeRaw(encodeRaw({key:{remoteJid:request.chat,id:request.message_id,fromMe:true},message}));
async function denied(message,flag){
 const raw=archive(message);let downloaded=false;
 await assert.rejects(readScopedMedia(policy,request,record,raw,async()=>{downloaded=true;return new Uint8Array(8)},()=>record),e=>{
  assert.match(e.message,/^UNSUPPORTED_MESSAGE /);const d=JSON.parse(e.message.slice('UNSUPPORTED_MESSAGE '.length));assert.equal(d[flag],true);assert.ok(Object.values(d).every(v=>typeof v==='boolean'));
  for(const forbidden of ['123456','synthetic-secret','mediaKey','messageSecret','paddingBytes']) assert.equal(e.message.includes(forbidden),false);
  return true;
 });assert.equal(downloaded,false);
}
test('real protobuf direct image plus normal metadata is distinguished',()=>assert.equal(mediaShapeDiagnostics(archive({imageMessage:media,messageContextInfo:{deviceListMetadataVersion:2,messageSecret:new Uint8Array(32).fill(9)}}).message).directMediaPlusContextOnly,true));
test('real protobuf context expiry is distinguished without accepting it',()=>denied({imageMessage:media,messageContextInfo:{messageAddOnDurationInSecs:10}},'contextHasExpiry'));
test('real protobuf sharing restriction distinguished without accepting it',()=>denied({imageMessage:media,messageContextInfo:{limitSharing:{}}},'contextHasSharingRestriction'));
for(const [wrapper,flag] of [['ephemeralMessage','hasEphemeralWrapper'],['viewOnceMessage','hasViewOnceWrapper'],['viewOnceMessageV2','hasViewOnceWrapper'],['viewOnceMessageV2Extension','hasViewOnceWrapper'],['documentWithCaptionMessage','hasDocumentCaptionWrapper'],['editedMessage','hasEditedWrapper'],['deviceSentMessage','hasDeviceSentWrapper']])test(`real protobuf ${wrapper} stays denied`,()=>denied({[wrapper]:{message:{imageMessage:media}}},flag));
test('unknown top-level field represented only by boolean',()=>{const d=mediaShapeDiagnostics({arbitrary_private_field:'do not disclose'});assert.equal(d.hasOtherField,true);assert.equal(JSON.stringify(d).includes('arbitrary_private_field'),false)});
