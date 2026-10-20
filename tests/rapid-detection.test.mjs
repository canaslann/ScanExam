import test from 'node:test';
import assert from 'node:assert/strict';
import {rapidScoreGrid} from '../lib/rapid-detection.ts';
function input(){const width=800,height=480,dark=new Uint8Array(width*height);const lines=[{y:120,left:20,right:780,slope:0,coverage:1},...[300,324,348,372].map(y=>({y,left:30,right:530,slope:0,coverage:1}))];for(const x of [30,130,210,290,370,450,530])for(let y=300;y<=348;y++)dark[y*width+x]=1;return {width,height,dark,lines};}
test('rapid capture accepts a complete measured score grid when upper rows curve',()=>{const x=input();const box=rapidScoreGrid(x.lines,x.dark,x.width,x.height,5);assert.ok(box);assert.ok(box.top<=300&&box.top+box.height>=372);});
test('rapid capture rejects missing rows, missing dividers, wrong counts and an isolated table',()=>{const x=input();assert.equal(rapidScoreGrid(x.lines.slice(0,-1),x.dark,800,480,5),null);assert.equal(rapidScoreGrid(x.lines.slice(1),x.dark,800,480,5),null);for(const n of [1,3,4,7])assert.equal(rapidScoreGrid(x.lines,x.dark,800,480,n),null);for(let y=300;y<=348;y++)x.dark[y*800+290]=0;assert.equal(rapidScoreGrid(x.lines,x.dark,800,480,5),null);});
