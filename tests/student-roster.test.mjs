import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as XLSX from 'xlsx';
import { matchRoster, validateRosterStudents } from '../lib/student-roster.ts';
import { readRosterWorkbook, rosterStudentsFromSheet } from '../lib/student-roster-import.ts';
import { cellState, editCell, emptyRow, newSession, reconcileRoster } from '../lib/scan-session.ts';

const roster = (students) => ({id:randomUUID(),fileName:'Sınava girenler.xlsx',students:validateRosterStudents(students)});
const reading = (fullName,studentNumber) => ({fullName,studentNumber,scores:['3','2','10','8','8'],writtenTotal:'31',elapsedMs:14400,confidence:{},reviewFields:['fullName'],alternatives:{fullName:[fullName],s1:['3']}});
const students = [
  {studentNumber:'01240121019',fullName:'Şevval Sarı'},
  {studentNumber:'02230201013',fullName:'Recep Erdoğan'},
  {studentNumber:'032503230324',fullName:'Rabia Firdevs Karcı'},
];

test('optional roster preserves no-list behavior and matches literal IDs, leading zeros, accents and imperfect names',()=>{
  const list=roster(students), raw=reading('Sexual Sari','01240121019');
  assert.equal(matchRoster(raw),raw);
  const out=matchRoster(raw,list);
  assert.equal(out.fullName,'Şevval Sarı');assert.equal(out.studentNumber,'01240121019');assert.equal(out.rosterMatch.status,'matched');
  assert.equal(out.rosterMatch.original.fullName,'Sexual Sari');assert.ok(out.alternatives.fullName.includes('Sexual Sari'));
  assert.deepEqual(out.scores,raw.scores);assert.equal(out.writtenTotal,raw.writtenTotal);assert.equal(out.elapsedMs,raw.elapsedMs);
  assert.deepEqual(raw,reading('Sexual Sari','01240121019'),'the first reading is never mutated');
  for(const [name,number,expected] of [['Rabia Firdevs Kara','032503230324',students[2]],['Recep Erdogan','022302010I3',students[1]],['Erdoğan Recep','',students[1]],['','01240121019',students[0]]]){
    const result=matchRoster(reading(name,number),list);assert.equal(result.rosterMatch.status,'matched');assert.equal(result.fullName,expected.fullName);assert.equal(result.studentNumber,expected.studentNumber);
  }
});

test('close identities, duplicate names and absent evidence are not assigned to an arbitrary student',()=>{
  const list=roster([{studentNumber:'02230201013',fullName:'Ayşe Yılmaz'},{studentNumber:'02230201014',fullName:'Ayşe Yılmaz'}]);
  for(const raw of [reading('Ayse Yilmaz','02230201015'),reading('Ayşe Yılmaz',''),reading('','')]){
    const out=matchRoster(raw,list);assert.notEqual(out.rosterMatch.status,'matched');assert.equal(out.fullName,raw.fullName);assert.equal(out.studentNumber,raw.studentNumber);
  }
  assert.equal(matchRoster(reading('Ayşe Yılmaz','02230201014'),list).rosterMatch.status,'matched','an exact distinct ID resolves duplicate names');
  const out=matchRoster(reading('Tamamen Başka','99999999999'),list);assert.equal(out.rosterMatch.status,'unmatched');
});

test('a missing roster number and a conflicting exact number retain the paper name and explain the conflict',()=>{
  const list=roster([{studentNumber:'02230201013',fullName:'Başka Öğrenci'}]);
  const conflict=matchRoster(reading('Recep Erdoğan','02230201013'),list);
  assert.equal(conflict.fullName,'Recep Erdoğan');assert.equal(conflict.rosterMatch.reason,'number-name-conflict');
  const missing=matchRoster(reading('Nisa Koç','02230201064'),list);
  assert.equal(missing.fullName,'Nisa Koç');assert.equal(missing.rosterMatch.reason,'number-not-listed');
});

test('removing or replacing a list restores original OCR; teacher edits and approvals remain authoritative',()=>{
  const raw=reading('Sexual Sari','01240121019'), list=roster(students), out=matchRoster(raw,list);
  const restored=matchRoster(out);
  assert.equal(restored.fullName,raw.fullName);assert.equal(restored.studentNumber,raw.studentNumber);assert.equal(restored.rosterMatch,undefined);
  assert.deepEqual(restored.alternatives,raw.alternatives);assert.deepEqual(restored.reviewFields,raw.reviewFields);
  const replacement=roster([{studentNumber:'01240121019',fullName:'Şevval Sarı Yeni'}]);
  const replaced=matchRoster(out,replacement);assert.equal(replaced.rosterMatch.original.fullName,'Sexual Sari');
  const row={...emptyRow(5,randomUUID(),'single'),status:'done',draft:out};
  const edited=editCell(row,'fullName','Öğretmenin Yazdığı');assert.equal(reconcileRoster(edited,replacement),edited);
  const approved={...row,confirmed:['fullName','studentNumber']};assert.equal(reconcileRoster(approved,replacement),approved);
  const session={...newSession(),roster:list,rows:[row]};assert.equal(cellState(session,row,'fullName').color,'green');
  assert.equal(cellState({...session,roster:undefined},row,'fullName').color,'yellow');
});

test('roster validation deduplicates identical records and rejects conflicting IDs or incomplete lists',()=>{
  assert.equal(validateRosterStudents([students[0],students[0]]).length,1);
  assert.throws(()=>validateRosterStudents([students[0],{...students[0],fullName:'Başka Öğrenci'}]),/farklı isim/);
  assert.throws(()=>validateRosterStudents([{fullName:'İpek Örnek',studentNumber:'0000L23456'}]),/geçersiz/);
  assert.throws(()=>validateRosterStudents([]),/1–5000/);
});

test('Excel import detects report headers and separate names, preserves text and number-format zeros, supports sheet selection',()=>{
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Açıklama']]),'Bilgi');
  const ws=XLSX.utils.aoa_to_sheet([['Sınav Öğrenci Listesi'],[],['Sıra','Öğrenci No','Adı','Soyadı'],[1,'00001234567','Çağrı','İpek Öztürk'],[2,1234568,'Ayşe','Şen']]);
  ws.B5.z='00000000000';delete ws.B5.w;
  XLSX.utils.book_append_sheet(wb,ws,'Öğrenciler');
  const sheets=readRosterWorkbook(XLSX.write(wb,{type:'array',bookType:'xlsx'}));
  const sheet=sheets.find(s=>s.name==='Öğrenciler');assert.equal(sheet.columns.numberColumn,1);assert.equal(sheet.columns.surnameColumn,3);
  const entries=rosterStudentsFromSheet(sheet,sheet.columns);
  assert.deepEqual(entries,[{studentNumber:'00001234567',fullName:'Çağrı İpek Öztürk'},{studentNumber:'00001234568',fullName:'Ayşe Şen'}]);
  const plain={name:'Başlıksız',rows:[['01234567890','Şule Öztürk']],columns:{headerRow:-1,numberColumn:0,nameColumn:1,surnameColumn:-1}};
  assert.equal(rosterStudentsFromSheet(plain,plain.columns)[0].fullName,'Şule Öztürk');
  assert.throws(()=>rosterStudentsFromSheet({...plain,rows:[['01234567890','']]},plain.columns),/eksik\/geçersiz/);
});

test('a 5000-student comparison adds no model request and remains a small local operation',()=>{
  const students=Array.from({length:5000},(_,i)=>({studentNumber:String(12345000000+i),fullName:`Öğrenci ${String.fromCharCode(65+Math.floor(i/676)%26)}${String.fromCharCode(65+Math.floor(i/26)%26)}${String.fromCharCode(65+i%26)}`}));
  const list=roster(students), start=performance.now();
  for(let i=0;i<20;i++){
    const student=students[100+i*73], out=matchRoster(reading(student.fullName,student.studentNumber),list);
    assert.equal(out.fullName,student.fullName);assert.equal(out.rosterMatch.status,'matched');
  }
  const elapsed=performance.now()-start;assert.ok(elapsed<1000,`20 exact matches took ${elapsed}ms`);
  const target=students[2300], fuzzy=matchRoster(reading(target.fullName,target.studentNumber.slice(0,-1)+'X'),list);
  assert.notEqual(fuzzy.rosterMatch.status,'unmatched');
});
