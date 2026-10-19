import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMediaPolicy} from '../src/whatsapp/media-policy.ts';
const valid={groupJid:'123456@g.us',ownerJids:['123456@s.whatsapp.net','654321@lid'],maxBytes:2097152,notBefore:1800000000};
test('private runtime policy accepts exact validated shape, no source identifiers',()=>assert.deepEqual(parseMediaPolicy(JSON.stringify(valid)),valid));
for(const [name,value] of [
 ['missing',undefined],['empty',''],['null','null'],['invalid JSON','{'],['array','[]'],['too long',' '.repeat(2049)],
 ...Object.keys(valid).map(key=>[`${key} missing`,JSON.stringify(Object.fromEntries(Object.entries(valid).filter(([k])=>k!==key)))]),
 ...[
 ['unknown field',{extra:true}],['wrong group',{groupJid:'123456@s.whatsapp.net'}],['group whitespace',{groupJid:'123456@g.us '}],
 ['owner group',{ownerJids:['123456@g.us']}],['empty owners',{ownerJids:[]}],['duplicate owners',{ownerJids:['123456@lid','123456@lid']}],['too many owners',{ownerJids:['123456@lid','234567@lid','345678@lid']}],
 ['oversize',{maxBytes:2097153}],['zero size',{maxBytes:0}],['fractional size',{maxBytes:1.2}],['string size',{maxBytes:'2'}],
 ['zero cutoff',{notBefore:0}],['millisecond cutoff',{notBefore:1800000000000}],['string cutoff',{notBefore:'1800000000'}],['fractional cutoff',{notBefore:1800000000.5}],
 ].map(([name,override])=>[name,JSON.stringify({...valid,...override})])
]) test(`private runtime policy fails closed: ${name}`,()=>assert.equal(parseMediaPolicy(value),null));
