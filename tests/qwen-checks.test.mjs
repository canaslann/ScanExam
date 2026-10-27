import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {checkQwenNumbers} from '../lib/qwen-checks.ts';
import {normalizePaper} from '../lib/reader-contract.ts';

async function form(count){
 const width=640,height=384,data=new Uint8Array(width*height).fill(225);
 const h=(y,right)=>{for(let x=20;x<=right;x++)for(let dy=0;dy<2;dy++)data[(y+dy)*width+x]=40;};
 const v=(x,top,bottom)=>{for(let y=top;y<=bottom;y++)for(let dx=0;dx<2;dx++)data[y*width+x+dx]=40;};
 [15,70,100,125,145,160,220].forEach((y,i)=>h(y,i===3?533:620));
 [20,113,305,371,533,620].forEach(x=>v(x,100,145));
 const right=count<4?280:620;
 [226,250,274,298].forEach(y=>h(y,right));
 [20,...Array.from({length:count+1},(_,i)=>Math.round(96+(right-96)*i/count))].forEach(x=>v(x,226,274));
 [20,96,right].forEach(x=>v(x,274,298));
 return sharp(data,{raw:{width,height,channels:1}}).png().toBuffer();
}
const reading=count=>normalizePaper({fullName:'Örnek Öğrenci',studentNumber:'00001234567',scores:Array(count).fill('1'),writtenTotal:'99',
 courseCode:'DERS101',courseName:'Örnek Ders',pcMap:Array(count).fill('PÇ12'),uncertainFields:[]},count);

test('real geometric crop checks and both score schemas include every configured column through S30',async()=>{
 for(const count of [1,3,7,12,30]){
  let calls=0;const first=reading(count),values=Array(count).fill('2');
  const out=await checkQwenNumbers(await form(count),first,async(image,schema,prompt)=>{
   calls++;assert.ok(Buffer.isBuffer(image));assert.ok(image.length>0);assert.ok(!prompt.includes('0000012345678'));
   if(schema.properties.scores){
    assert.equal(schema.properties.scores.minItems,count);assert.equal(schema.properties.scores.maxItems,count);
    assert.ok(prompt.includes(`S1 through S${count}`));
    return {...(schema.properties.studentNumber?{studentNumber:'0000012345678'}:{}),scores:values};
   }
   return {studentNumber:'0000012345678'};
  },new AbortController().signal);
  assert.equal(calls,3,`both score views and a separate number view for ${count} questions`);
  assert.deepEqual(out.scores,values);assert.equal(out.writtenTotal,'99');assert.equal(out.studentNumber,'0000012345678');
 }
});
test('unmatched geometry keeps the first full reading and never invents field crops',async()=>{
 const blank=await sharp({create:{width:640,height:384,channels:3,background:'white'}}).png().toBuffer();
 const first=reading(7);
 const out=await checkQwenNumbers(blank,first,()=>{assert.fail('unknown geometry must not request a crop reading');},new AbortController().signal);
 assert.deepEqual(out,first);
});
test('a number disagreement gets a third source view and requires two agreeing readings',async()=>{
 const first=reading(3);first.writtenTotal='3';first.reviewFields=[];
 const images=[];let calls=0;
 const out=await checkQwenNumbers(await form(3),first,async(image,schema)=>{
  assert.equal(schema.properties.scores,undefined);images.push(image.toString('base64'));
  return {studentNumber:++calls===2?'00012345678':'0000012345678'};
 },new AbortController().signal);
 assert.equal(calls,3);assert.equal(new Set(images).size,3);
 assert.equal(out.studentNumber,'0000012345678');assert.equal(out.writtenTotal,'3');assert.deepEqual(out.scores,first.scores);
});
test('optional failure preserves primary data and completed alternatives; user cancellation still aborts',async()=>{
 const bytes=await form(3),first=reading(3);let calls=0;
 const out=await checkQwenNumbers(bytes,first,async()=>{
  if(++calls===1)return {studentNumber:'0000012345678',scores:['2','2','2']};throw new Error('optional read failed');
 },new AbortController().signal);
 assert.deepEqual(out.scores,first.scores);assert.equal(out.studentNumber,first.studentNumber);assert.equal(out.writtenTotal,'99');
 assert.deepEqual(out.alternatives.s1,['1','2']);assert.ok(out.warnings.some(w=>w.includes('tamamlanamadı')));
 const controller=new AbortController();
 await assert.rejects(checkQwenNumbers(bytes,first,async()=>{controller.abort();controller.signal.throwIfAborted();},controller.signal));
});
