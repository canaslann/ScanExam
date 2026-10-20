import test from 'node:test';
import assert from 'node:assert/strict';
import {RapidCameraCapture} from '../lib/rapid-camera-capture.ts';
import {detectLivePaper} from '../lib/live-detection.ts';

const valid={box:{left:20,top:220,width:400,height:80},acceptable:true};

test('rapid camera immediately hands the exact accepted source frame to the existing capture callback',async()=>{
  const camera=new RapidCameraCapture(),frame={original:'1600px colour frame'},saved=[];
  assert.equal(await camera.accept(frame,valid,0,async image=>{saved.push(image);}), 'captured');
  assert.equal(saved.length,1);assert.equal(saved[0],frame);
  assert.equal(await camera.accept({later:true},valid,90,async()=>assert.fail('duplicate')), 'remove');
});

test('rapid camera waits for durable save, rejects concurrent frames and rearms after removal',async()=>{
  const camera=new RapidCameraCapture();let finish;const saved=[];
  const pending=camera.accept('first',valid,0,image=>{saved.push(image);return new Promise(resolve=>{finish=resolve;});});
  assert.equal(await camera.accept('second',valid,90,async()=>assert.fail('save still pending')), 'saving');
  finish();await pending;
  const absent={box:null,acceptable:false};
  assert.equal(await camera.accept(null,absent,200,async()=>assert.fail()), 'remove');
  assert.equal(await camera.accept(null,absent,800,async()=>assert.fail()), 'searching');
  assert.equal(await camera.accept('next paper',valid,890,async image=>saved.push(image)), 'captured');
  assert.deepEqual(saved,['first','next paper']);
});

test('failed saves never latch a paper or claim successful capture; unsharp frames never save',async()=>{
  const camera=new RapidCameraCapture();
  assert.equal(await camera.accept('blur',{...valid,acceptable:false},0,async()=>assert.fail()), 'searching');
  await assert.rejects(camera.accept('paper',valid,90,async()=>{throw new Error('disk full');}),/disk full/);
  const saved=[];assert.equal(await camera.accept('retry',valid,180,async image=>saved.push(image)), 'captured');
  assert.deepEqual(saved,['retry']);
});

function page(complete){
  const width=640,height=384,gray=new Uint8Array(width*height).fill(225);
  const h=(y,right)=>{for(let x=20;x<=right;x++)for(let dy=0;dy<2;dy++)gray[(y+dy)*width+x]=40;};
  const v=(x,top,bottom)=>{for(let y=top;y<=bottom;y++)for(let dx=0;dx<2;dx++)gray[y*width+x+dx]=40;};
  if(complete){[15,70,100,125,145,160,220].forEach((y,i)=>h(y,i===3?533:620));[20,113,305,371,533,620].forEach(x=>v(x,100,145));}
  else h(70,620);
  [226,250,274,298].forEach(y=>h(y,416));
  [20,96,160,224,288,352,416].forEach(x=>v(x,226,274));[20,96,416].forEach(x=>v(x,274,298));
  const rgba=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<gray.length;i++){rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=gray[i];rgba[i*4+3]=255;}
  return {pixels:rgba.buffer,width,height,questionCount:5};
}

test('new rapid worker uses option 1 validation and rejects a score-only frame',async t=>{
  const previous=globalThis.self,outputs=[];globalThis.self={postMessage:value=>outputs.push(value)};
  t.after(()=>{if(previous===undefined)delete globalThis.self;else globalThis.self=previous;});
  await import('../lib/rapid-camera.worker.ts');
  for(const complete of [true,false]){
    const data=page(complete);
    globalThis.self.onmessage({data});
    const actual=outputs.at(-1),expected=detectLivePaper(new Uint8ClampedArray(data.pixels),data.width,data.height,5,false);
    assert.deepEqual(actual,expected);
    if(complete)assert.ok(actual.box);else{assert.equal(actual.box,null);assert.equal(actual.acceptable,false);}
  }
});
