import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {prepareServerPaper} from '../lib/paper-preparation.ts';
import {readLocalPaper} from '../lib/local-reader.ts';
import {SharedSessionStore} from '../lib/shared-session.ts';
import {randomUUID} from 'node:crypto';

test('camera sources cannot fall back to a full-page image; gallery retains the complete source',async t=>{
  const image=await sharp({create:{width:800,height:1400,channels:3,background:'white'}}).jpeg().toBuffer();
  const camera=await prepareServerPaper(image,5,true,false), gallery=await prepareServerPaper(image,5,true,true);
  assert.equal(camera.allowDocument,false);assert.equal(camera.documentImage,undefined);
  assert.ok(camera.compactImage);assert.ok(gallery.documentImage);
  const c=await sharp(Buffer.from(camera.image,'base64')).metadata(),g=await sharp(Buffer.from(gallery.image,'base64')).metadata();
  assert.ok(c.height<=c.width*.61);assert.ok(g.height>g.width);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const calls=[];globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);return Response.json({done:true,response:'Adı Soyadı Örnek Öğrenci\nNumarası 00001234567\nPuan: 10 15 20 5 10\nNot: 60'});};
  const out=await readLocalPaper(camera.image,'single',new AbortController().signal,undefined,undefined,5,camera);
  assert.equal(calls.length,1);assert.equal(calls[0].images[0],camera.compactImage);
  assert.deepEqual(out.scores,['10','15','20','5','10']);assert.equal(out.readingStrategy,'compact-table');
});

test('capture source persists on each row and defaults safely for older clients',()=>{
  const store=new SharedSessionStore(':memory:');
  try {
    const capture=(source)=>store.mutate({action:'capture',opId:randomUUID(),examId:store.snapshot().examId,id:randomUUID(),mode:'single',source},new Uint8Array([1]));
    capture('gallery');capture('camera');const s=capture(undefined);
    assert.deepEqual(s.session.rows.map(r=>r.captureSource),['gallery','camera','camera']);
    assert.throws(()=>capture('unknown'),e=>e.status===400);
  } finally {store.close();}
});
