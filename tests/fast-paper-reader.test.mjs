import assert from 'node:assert/strict';
import test from 'node:test';
import {upperFormFrame} from '../lib/camera-frame.ts';
import {readFastPaper} from '../lib/fast-paper-reader.ts';
const p={fastScoresImage:'grades',identityImage:'identity',scoreRowImage:'row',scoreCells:[0,1,2].map(i=>({color:`cell${i}`,padded:`pad${i}`})),totalImage:'total'};
const grades='<table><tr><td>Dersin Kodu ve Adı</td><td>BILM374-2022 Yapay Zeka</td></tr></table><table><tr><td>Soru-PÇ ilişkisi</td><td>(S1)-PÇ2</td><td>(S2)-PÇ1</td><td>(S3)-PÇ3</td></tr><tr><td>Puan:</td><td>10</td><td>15</td><td>20</td></tr><tr><td>Not:</td><td>45</td></tr></table>';
test('all web camera captures match the same centred upper-form preview on portrait and landscape streams',()=>{for(const [w,h] of [[2560,1440],[1080,1920],[640,480]]){const b=upperFormFrame(w,h);assert.ok(b.width<=1600);assert.ok(Math.abs(b.height/b.width-.6)<.002);assert.ok(b.sourceX>=0&&b.sourceY>=0);assert.equal(b.sourceX*2+b.sourceWidth,w);assert.equal(b.sourceY*2+b.sourceHeight,h);}});
test('scores and Turkish identity begin together, preserve leading zeros, and need only one request each',async()=>{const calls=[];let finishGrades;const promise=readFastPaper(p,3,async image=>{calls.push(image);return new Promise(resolve=>{finishGrades=resolve;});},async()=>{calls.push('identity');return {fullName:'Çağrı İpek Öztürk',studentNumber:'00001234567'};},new AbortController().signal);assert.deepEqual(calls,['grades','identity']);finishGrades(grades);const out=await promise;assert.equal(out.fullName,'Çağrı İpek Öztürk');assert.equal(out.studentNumber,'00001234567');assert.deepEqual(out.scores,['10','15','20']);assert.equal(out.writtenTotal,'45');assert.equal(out.courseCode,'BILM374-2022');assert.deepEqual(out.confidence,{});});
test('an absent identity reader recovers literal identity while keeping completed scores',async()=>{const calls=[];const out=await readFastPaper(p,3,async()=>grades,async()=>undefined,new AbortController().signal,async image=>{calls.push(image);return 'Adı Soyadı İpek Örnek\nNumarası 00001234567';});assert.deepEqual(calls,['identity']);assert.equal(out.fullName,'İpek Örnek');assert.equal(out.studentNumber,'00001234567');assert.deepEqual(out.scores,['10','15','20']);});
test('expired optional recovery never clears completed cells or invents zeros',async()=>{const out=await readFastPaper(p,3,async()=>grades.replace('<td>15</td>','<td></td>'),async()=>({fullName:'İpek Örnek',studentNumber:'00001234567'}),new AbortController().signal,async()=>{throw new Error('recovery budget expired');});assert.deepEqual(out.scores,['10','','20']);assert.equal(out.writtenTotal,'45');});
test('cancelling a fast read still aborts instead of publishing a completed row',async()=>{const c=new AbortController();c.abort();await assert.rejects(readFastPaper(p,3,async()=>grades,async()=>undefined,c.signal),{name:'AbortError'});});
test('the numeric pair preserves leading zeros and supplies a literal missing Not independently of score arithmetic',async()=>{const fp={...p,numericCheckImage:'numeric-pair',identity:{studentNumberZoom:'number'}};const out=await readFastPaper(fp,3,async()=>grades.replace('>45<','><'),async()=>({fullName:'İpek Örnek',studentNumber:'0000L234567'}),new AbortController().signal,async image=>{assert.equal(image,'numeric-pair');return '00001234567\n78';});assert.equal(out.studentNumber,'00001234567');assert.equal(out.writtenTotal,'78');assert.deepEqual(out.scores,['10','15','20']);assert.ok(out.reviewFields.includes('studentNumber'));});
test('a faint missing Not is recovered from its original row context without rewriting scores',async()=>{let checks=0;const fp={...p,scoreTextImage:'score-band'};const out=await readFastPaper(fp,3,async()=>grades.replace('>45<','><'),async()=>({fullName:'İpek Örnek',studentNumber:'00001234567'}),new AbortController().signal,async image=>{checks++;assert.equal(image,'score-band');return 'Puan: 10 15 20\nNot: 78';});assert.equal(checks,1);assert.equal(out.writtenTotal,'78');assert.deepEqual(out.scores,['10','15','20']);assert.ok(out.reviewFields.includes('writtenTotal'));});
test('an already valid Not does not invoke the extra reader',async()=>{const out=await readFastPaper(p,3,async()=>grades,async()=>({fullName:'İpek Örnek',studentNumber:'00001234567'}),new AbortController().signal,async()=>assert.fail('no recovery'));assert.equal(out.writtenTotal,'45');});

test('the 120-second hard deadline includes preparation in both control modes and releases the reader',async t=>{const {readLocalPaper}=await import('../lib/local-reader.ts');const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async()=>assert.fail('expired budget must not submit an image');for(const mode of ['single','double'])await assert.rejects(readLocalPaper('page',mode,new AbortController().signal,undefined,undefined,3,{...p,image:'page',regions:{scores:'scores',student:'student',course:'course'},identity:{studentNumberZoom:'number'},preparationStartedAt:Date.now()-121000}),e=>e.status===504&&e.message.includes('120'));});

test('crossing the 20-second target does not abort primary scores or identity',async t=>{
  const {readLocalPaper}=await import('../lib/local-reader.ts');const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const images=[];
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.signal.aborted,false,'primary recognition remains live after 20 seconds');
    if(url.endsWith('/api/ps'))return Response.json({models:[{name:'glm-ocr-eot:q8_0',size_vram:0}]});
    const body=JSON.parse(options.body);images.push(body.images[0]);
    return Response.json({done:true,response:body.images[0]==='grades'?grades:'Adı Soyadı İpek Örnek\nNumarası 00001234567'});
  };
  const out=await readLocalPaper('page','single',new AbortController().signal,undefined,undefined,3,{...p,image:'page',preparationStartedAt:Date.now()-21000});
  assert.deepEqual(images,['grades','identity']);assert.equal(out.fullName,'İpek Örnek');assert.equal(out.studentNumber,'00001234567');assert.deepEqual(out.scores,['10','15','20']);assert.equal(out.writtenTotal,'45');
});

test('camera upper-form and gallery document reads both continue after 20 seconds',async t=>{
  const {readLocalPaper}=await import('../lib/local-reader.ts');const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(_url,options)=>{assert.equal(options.signal.aborted,false);return Response.json({done:true,response:'Adı Soyadı İpek Örnek\nNumarası 00001234567\nPuan: 10 15 20\nNot: 45'});};
  for(const extra of [{allowDocument:false,compactImage:'upper'},{allowDocument:true,documentImage:'page'}]) {
    const out=await readLocalPaper('page','single',new AbortController().signal,undefined,undefined,3,{image:'page',...extra,preparationStartedAt:Date.now()-21000});
    assert.equal(out.fullName,'İpek Örnek');assert.deepEqual(out.scores,['10','15','20']);
  }
});

test('a repeated rewritten total stays populated and retains its source alternative for review',async()=>{const out=await readFastPaper(p,3,async()=>grades.replace('>45<','>70 70<'),async()=>({fullName:'İpek Örnek',studentNumber:'00001234567'}),new AbortController().signal);assert.equal(out.writtenTotal,'70');assert.deepEqual(out.scores,['10','15','20']);assert.deepEqual(out.alternatives.writtenTotal,['70 70']);assert.ok(out.reviewFields.includes('writtenTotal'));});

test('native identity supplies labelled metadata and preserves visual name alternatives without rechecking every number',async()=>{
  const fp={...p,numericCheckImage:'pair',identity:{studentNumberZoom:'number'}};
  const out=await readFastPaper(fp,3,async()=>grades.replace('Dersin Kodu ve Adı','Other label'),async()=>({fullName:'İpek Örnek',studentNumber:'00001234567',courseCode:'BILM374-2022',courseName:'Yapay Zeka',alternatives:{fullName:['İpek Örnex','İpek Örnek']},reviewFields:['fullName']}),new AbortController().signal,async()=>assert.fail('no redundant numeric pair'),true);
  assert.equal(out.fullName,'İpek Örnek');assert.equal(out.studentNumber,'00001234567');assert.equal(out.courseCode,'BILM374-2022');
  assert.deepEqual(out.scores,['10','15','20']);assert.deepEqual(out.alternatives.fullName,['İpek Örnex','İpek Örnek']);assert.ok(out.reviewFields.includes('fullName'));
});

test('CPU reading retains complete native fields without a competing name request',async t=>{
  const {readLocalPaper}=await import('../lib/local-reader.ts');const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
  const images=[];globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/api/ps'))return Response.json({models:[{name:'glm-ocr-eot:q8_0',size_vram:0}]});
    const body=JSON.parse(options.body);const image=body.images?.[0] || body.messages?.[0].images[0];images.push(image);
    if(url.endsWith('/api/chat')) return Response.json({done:true,message:{content:JSON.stringify({fullName:'İpek Örnek',studentNumber:'00001234567'})}});
    return Response.json({done:true,response:image==='grades'?grades:'Adı Soyadı İpek Örnek\nNumarası 00001234567'});
  };
  const out=await readLocalPaper('page','single',new AbortController().signal,undefined,undefined,3,{...p,image:'page',identityTextImage:'header',regions:{scores:'scores',student:'student',course:'course'},identity:{studentNumberZoom:'number'},preparationStartedAt:Date.now()});
  assert.deepEqual(images,['grades','header']);assert.equal(out.fullName,'İpek Örnek');assert.equal(out.studentNumber,'00001234567');assert.deepEqual(out.scores,['10','15','20']);
});

test('an excessive score is replaced only when its row and isolated cell independently agree',async()=>{
  const bad=grades.replace('>15<','>75<').replace('>45<','>46<'), calls=[];
  const out=await readFastPaper(p,3,async()=>bad,async()=>({fullName:'İpek Örnek',studentNumber:'00001234567'}),new AbortController().signal,async(image)=>{calls.push(image);if(image==='row')return '10 15 20';if(image==='cell1')return '15';throw new Error('unexpected crop');},true);
  assert.deepEqual(calls,['row','cell1']);assert.deepEqual(out.scores,['10','15','20']);assert.equal(out.writtenTotal,'46');assert.deepEqual(out.alternatives.s2,['75','15']);assert.ok(out.reviewFields.includes('s2'));
});
test('a total above 100 is never clamped, inferred from Not or changed after conflicting visual reads',async()=>{
  const out=await readFastPaper(p,3,async()=>grades.replace('>15<','>75<').replace('>45<','>44<'),async()=>({fullName:'İpek Örnek',studentNumber:'00001234567'}),new AbortController().signal,async(image)=>image==='row'?'10 15 20':'17',true);
  assert.deepEqual(out.scores,['10','75','20']);assert.equal(out.writtenTotal,'44');assert.ok(out.warnings.some(w=>w.includes('100')));
});
test('an invalid written Not is read from its own crop while retaining the rejected literal alternative',async()=>{
  const fp={...p,totalContrastImage:'contrast',scoreTextImage:'band'}, calls=[];
  const out=await readFastPaper(fp,3,async()=>grades.replace('>45<','>215<'),async()=>({fullName:'İpek Örnek',studentNumber:'00001234567'}),new AbortController().signal,async(image)=>{calls.push(image);assert.equal(image,'contrast');return '45';},true);
  assert.deepEqual(calls,['contrast']);assert.equal(out.writtenTotal,'45');assert.deepEqual(out.alternatives.writtenTotal,['215','45']);assert.deepEqual(out.scores,['10','15','20']);
});

test('a complete second visual row agreeing with the written Not recovers a single overflow without inventing digits',async()=>{
  const calls=[];const out=await readFastPaper(p,3,async()=>grades.replace('>15<','>75<'),async()=>({fullName:'İpek Örnek',studentNumber:'00001234567'}),new AbortController().signal,async image=>{calls.push(image);assert.equal(image,'row');return '10 15 20';},true);
  assert.deepEqual(calls,['row']);assert.deepEqual(out.scores,['10','15','20']);assert.deepEqual(out.alternatives.s2,['75','15']);
});
