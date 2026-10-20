import assert from 'node:assert/strict';
import test from 'node:test';
import {readFastIdentity} from '../lib/fast-identity.ts';
const paper={identityTextImage:'header',identityImage:'labels',identity:{fullNameZoom:'name'}};
const raw='Adı Soyadı İpek K04\nNumarası 00001234567\nDersin Kodu ve Adı BILM374-2022 Yapay Zeka';

test('a malformed name gets a local cell read and independent language reading without altering the number',async()=>{
  const calls=[];const out=await readFastIdentity(paper,5,async(image)=>{calls.push(image);return raw;},async()=>({fullName:'İpek Koç',studentNumber:'99999999999'}),new AbortController().signal,async(image)=>{calls.push(image);return 'İpek kog';});
  assert.deepEqual(calls,['header','name']);assert.equal(out.fullName,'İpek Koç');assert.equal(out.studentNumber,'00001234567');
  assert.deepEqual(out.alternatives.fullName,['İpek K04','İpek kog','İpek Koç']);assert.ok(out.reviewFields.includes('fullName'));
});
test('optional reader expiration retains the literal name instead of blanking it or replacing characters',async()=>{
  const out=await readFastIdentity(paper,5,async()=>raw,async()=>{throw new Error('deadline');},new AbortController().signal,async()=>{throw new Error('deadline');});
  assert.equal(out.fullName,'İpek K04');assert.equal(out.studentNumber,'00001234567');assert.ok(out.reviewFields.includes('fullName'));
});
test('a complete ordinary identity does not reread its name or call the second model',async()=>{
  const out=await readFastIdentity(paper,5,async()=>raw.replace('İpek K04','Çağrı Öztürk'),async()=>assert.fail('no language call'),new AbortController().signal,async()=>assert.fail('no crop call'));
  assert.equal(out.fullName,'Çağrı Öztürk');assert.equal(out.studentNumber,'00001234567');
});
