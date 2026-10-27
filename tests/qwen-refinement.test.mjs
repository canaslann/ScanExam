import test from 'node:test';
import assert from 'node:assert/strict';
import {refineQwenNumbers} from '../lib/qwen-refinement.ts';
import {normalizePaper} from '../lib/reader-contract.ts';
const reading = count => normalizePaper({fullName:'Örnek Öğrenci',studentNumber:'00001234567',scores:Array(count).fill('1'),writtenTotal:'99',
 courseCode:'DERS101',courseName:'Örnek Ders',pcMap:Array(count).fill('PÇ12'),uncertainFields:[]},count);

test('two matching literal views can correct a field, preserving its first reading and independent Not',()=>{
 const first=reading(3);
 const out=refineQwenNumbers(first,{studentNumber:['000012345678','000012345678'],scores:[['2','3','4'],['2','3','4']]});
 assert.equal(out.studentNumber,'000012345678');assert.deepEqual(out.scores,['2','3','4']);assert.equal(out.writtenTotal,'99');
 assert.deepEqual(out.alternatives.studentNumber,['00001234567','000012345678']);
 assert.deepEqual(out.alternatives.s3,['1','4']);assert.ok(out.reviewFields.includes('s3'));assert.deepEqual(first.scores,['1','1','1']);
});
test('disagreement, a lone answer, invalid text and a convenient total never select a replacement',()=>{
 const first=reading(3);
 const out=refineQwenNumbers(first,{studentNumber:['000001234567','00001234567'],scores:[['97','x',''],['1','x','']]});
 assert.equal(out.studentNumber,first.studentNumber);assert.deepEqual(out.scores,first.scores);assert.equal(out.writtenTotal,'99');
 assert.ok(out.reviewFields.includes('studentNumber'));assert.ok(out.reviewFields.includes('s2'));
 assert.equal(refineQwenNumbers(first,{studentNumber:['000001234567']}).studentNumber,first.studentNumber);
});
test('a third independent number view can resolve disagreement without a fixed digit count',()=>{
 const first=reading(3);
 const out=refineQwenNumbers(first,{studentNumber:['000012345678','00012345678','000012345678']});
 assert.equal(out.studentNumber,'000012345678');assert.ok(out.reviewFields.includes('studentNumber'));
 assert.equal(refineQwenNumbers(first,{studentNumber:['000012345678','00012345678','0000012345678']}).studentNumber,first.studentNumber);
});
test('all configured columns, blanks, zero and leading zeros are preserved for 1 to 30 questions',()=>{
 for(const n of [1,3,7,12,30]) {
  const first=reading(n), values=Array.from({length:n},(_,i)=>i%2?'0':'2');
  const out=refineQwenNumbers(first,{scores:[values,values],studentNumber:['000 01234567','00001234567']});
  assert.deepEqual(out.scores,values);assert.equal(out.scores.length,n);assert.equal(out.studentNumber,'00001234567');assert.equal(out.writtenTotal,'99');
  const short=refineQwenNumbers(first,{scores:[values.slice(0,-1),values.slice(0,-1)]});assert.deepEqual(short.scores,first.scores);
 }
});
