import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SharedSessionStore } from "../lib/shared-session.ts";
import { cellValue, rowSignature, sessionExam } from "../lib/scan-session.ts";
import { normalizePaper } from "../lib/reader-contract.ts";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "scanexam-shared-test-"));
  const filename = join(directory, "test.sqlite");
  const a = new SharedSessionStore(filename), b = new SharedSessionStore(filename);
  t.after(async () => { a.close(); b.close(); await rm(directory, { recursive: true }); });
  const command = (store, action, patch = {}, bytes) => store.mutate({ opId: randomUUID(), examId: store.snapshot().examId, action, ...patch }, bytes);
  return { a, b, filename, command };
}
const reading = (count = 5) => normalizePaper({ fullName: "İpek Örnek", studentNumber: "00001234567", scores: Array(count).fill("10"),
  writtenTotal: String(count * 10), courseCode: "BILM374-2022", courseName: "YAPAY ZEKA", pcMap: Array(count).fill("PÇ2"), uncertainFields: [] }, count);

test('optional roster is shared, updates existing and in-flight readings, preserves edits, and clears on a new exam',async t=>{
  const {a,b,command}=await fixture(t), id=randomUUID();
  command(a,'capture',{id,mode:'single'},new Uint8Array([1]));const job=a.claim();a.finish(id,job.token,{...reading(),fullName:'Ipek Ornek'});
  command(b,'roster',{previousId:null,fileName:'Liste.xlsx',students:[{studentNumber:'00001234567',fullName:'İpek Örnek'}]});
  let state=a.snapshot();assert.equal(state.session.rows[0].draft.fullName,'İpek Örnek');assert.equal(state.session.rows[0].draft.rosterMatch.original.fullName,'Ipek Ornek');
  assert.equal(b.snapshot().session.roster.id,state.session.roster.id);
  command(a,'roster',{previousId:state.session.roster.id,students:null});assert.equal(a.snapshot().session.rows[0].draft.fullName,'Ipek Ornek');
  const next=randomUUID();command(b,'capture',{id:next,mode:'single'},new Uint8Array([2]));const pending=a.claim();
  command(b,'roster',{previousId:null,fileName:'Güncel.xlsx',students:[{studentNumber:'00001234567',fullName:'İpek Örnek'}]});
  a.finish(next,pending.token,{...reading(),fullName:'Ipek Ornek'});assert.equal(b.snapshot().session.rows[1].draft.fullName,'İpek Örnek');
  command(a,'edit',{id,field:'fullName',previous:'İpek Örnek',value:'Elle Düzenlendi'});
  state=a.snapshot();command(b,'roster',{previousId:state.session.roster.id,fileName:'Yeni.xlsx',students:[{studentNumber:'00001234567',fullName:'İpek Yeni'}]});
  assert.equal(a.snapshot().session.rows[0].draft.fullName,'Elle Düzenlendi');
  state=a.snapshot();command(a,'reset',{revision:state.revision});assert.equal(b.snapshot().session.roster,undefined);
});

test('roster acknowledgement retries are idempotent, stale replacements conflict, and invalid imports are atomic',async t=>{
  const {a,b}=await fixture(t), request={action:'roster',opId:randomUUID(),examId:a.snapshot().examId,previousId:null,fileName:'Liste.xlsx',students:[{studentNumber:'00001234567',fullName:'İpek Örnek'}]};
  const first=a.mutate(request);assert.equal(b.mutate(request).session.roster.id,first.session.roster.id);
  assert.throws(()=>b.mutate({...request,opId:randomUUID()}),e=>e.status===409);
  const rev=a.snapshot().revision;
  assert.throws(()=>a.mutate({...request,opId:randomUUID(),previousId:first.session.roster.id,students:[{studentNumber:'abc',fullName:'Öğrenci'}]}),e=>e.status===400);
  assert.equal(a.snapshot().revision,rev);assert.equal(a.snapshot().session.roster.students.length,1);
});

test('explicit reread reuses the photo, refills empty identity edits and preserves populated teacher corrections',async t=>{
  const {a,b,command}=await fixture(t), id=randomUUID();command(a,'capture',{id,mode:'single'},new Uint8Array([1]));
  const first=a.claim();a.finish(id,first.token,reading());
  command(b,'edit',{id,field:'fullName',previous:'İpek Örnek',value:'\t'});
  command(b,'edit',{id,field:'s1',previous:'10',value:'12'});
  const before=a.snapshot();command(a,'reread',{id,signature:rowSignature(before.session.rows[0],before.session)});
  assert.equal(b.snapshot().session.rows[0].status,'queued');assert.deepEqual(a.photo(id),new Uint8Array([1]));
  const second=a.claim();a.finish(id,second.token,{...reading(),fullName:'Çağrı Öztürk'});
  const row=a.snapshot().session.rows[0];assert.equal(row.draft.fullName,'Çağrı Öztürk');assert.equal(row.draft.scores[0],'12');
  assert.throws(()=>command(b,'reread',{id,signature:rowSignature(before.session.rows[0],before.session)}),e=>e.status===409);
});

test("phone capture, source photo, model output and edits are visible to two independent database clients", async t => {
  const { a, b, command } = await fixture(t), id = randomUUID();
  const bytes = new Uint8Array([1, 2, 3]);
  command(a, "capture", { id, mode: "single" }, bytes);
  assert.equal(b.snapshot().session.rows[0].id, id);
  assert.deepEqual(b.photo(id), bytes);
  const job = b.claim();
  assert.equal(a.snapshot().session.rows[0].status, "reading");
  assert.equal(a.claim(), undefined, "a second process cannot start another simultaneous job");
  b.finish(id, job.token, reading());
  assert.equal(a.snapshot().session.rows[0].draft.fullName, "İpek Örnek");
  command(a, "edit", { id, field: "fullName", previous: "İpek Örnek", value: "Ayşe Örnek" });
  assert.equal(b.snapshot().session.rows[0].draft.fullName, "Ayşe Örnek");
});
test("idempotent uploads and commands never create duplicate rows or replay an edit", async t => {
  const { a, b } = await fixture(t), id = randomUUID(), opId = randomUUID();
  const request = { id, opId, examId: a.snapshot().examId, action: "capture", mode: "single" };
  const bytes = new Uint8Array([1]);
  a.mutate(request, bytes); b.mutate(request, bytes);
  assert.equal(a.snapshot().session.rows.length, 1);
  const edit = { action: "edit", id, opId: randomUUID(), examId: a.snapshot().examId, field: "s1", previous: "", value: "15" };
  a.mutate(edit); b.mutate(edit);
  assert.equal(a.snapshot().session.rows[0].draft.scores[0], "15");
});
test("acknowledgement retries work at a full queue, and replacement photos update check mode", async t => {
  const { a, b, command } = await fixture(t), id = randomUUID();
  command(a, "capture", { id, mode: "single" }, new Uint8Array([1]));
  const job = a.claim(); a.finish(id, job.token, undefined, "read failed");
  command(b, "capture", { id, mode: "double" }, new Uint8Array([2]));
  assert.equal(a.snapshot().session.rows[0].checkMode, "double");
  assert.deepEqual(a.photo(id), new Uint8Array([2]));
  for (let i = 1; i < 20; i++) command(a, "capture", { id: randomUUID(), mode: "single" }, new Uint8Array([3]));
  command(b, "capture", { id, mode: "double" }, new Uint8Array([2]));
  assert.equal(a.snapshot().session.rows.length, 20);
});
test("different-field edits merge; same-cell stale edits and stale approvals are rejected without overwriting", async t => {
  const { a, b, command } = await fixture(t), id = randomUUID();
  command(a, "capture", { id, mode: "single" }, new Uint8Array([1]));
  const job = a.claim(); a.finish(id, job.token, reading());
  const old = b.snapshot();
  command(a, "edit", { id, field: "s1", previous: "10", value: "15" });
  command(b, "edit", { id, field: "s2", previous: "10", value: "20" });
  assert.deepEqual(a.snapshot().session.rows[0].draft.scores.slice(0, 2), ["15", "20"]);
  assert.throws(() => command(b, "edit", { id, field: "s1", previous: "10", value: "5" }), error => error.status === 409);
  assert.throws(() => command(b, "approve", { id, signature: rowSignature(old.session.rows[0], old.session) }), error => error.status === 409);
  assert.equal(cellValue(a.snapshot().session.rows[0], "s1"), "15");
});

test("a valid reviewed row can be approved; duplicate and invalid rows return actionable client errors atomically", async t => {
  const { a, command } = await fixture(t), id = randomUUID();
  command(a, "capture", { id, mode: "single" }, new Uint8Array([1]));
  const job = a.claim(); a.finish(id, job.token, reading());
  let state = a.snapshot();
  command(a, "approve", { id, signature: rowSignature(state.session.rows[0], state.session) });
  assert.equal(a.snapshot().session.rows[0].confirmed.length, 8);
  const other = randomUUID();
  command(a, "capture", { id: other, mode: "single" }, new Uint8Array([2]));
  const second = a.claim(); a.finish(other, second.token, reading());
  state = a.snapshot();
  assert.throws(() => command(a, "approve", { id, signature: rowSignature(state.session.rows[0], state.session) }),
    error => error.status === 400 && /2\. satırda da var/.test(error.message));
  assert.equal(a.snapshot().revision, state.revision);
  command(a, "edit", { id, field: "studentNumber", previous: "00001234567", value: "00001234568" });
  command(a, "edit", { id, field: "s1", previous: "10", value: "" });
  state = a.snapshot();
  assert.throws(() => command(a, "approve", { id, signature: rowSignature(state.session.rows[0], state.session) }),
    error => error.status === 400 && /S1/.test(error.message));
  assert.equal(a.snapshot().revision, state.revision);
});
test("background reading preserves in-flight edits; cancellation prevents stale output from resurrecting a row", async t => {
  const { a, b, command } = await fixture(t), id = randomUUID();
  command(a, "capture", { id, mode: "single" }, new Uint8Array([1]));
  const job = a.claim();
  command(b, "edit", { id, field: "s2", previous: "", value: "15" });
  a.finish(id, job.token, reading());
  assert.equal(a.snapshot().session.rows[0].draft.scores[1], "15");
  assert.equal(sessionExam(a.snapshot().session).results[0].scores[1], 15);
  const secondId = randomUUID();
  command(a, "capture", { id: secondId, mode: "single" }, new Uint8Array([2]));
  const second = a.claim(); command(b, "cancel", { id: secondId });
  assert.equal(a.heartbeat(secondId, second.token), false);
  a.finish(secondId, second.token, reading());
  assert.equal(b.snapshot().session.rows.find(row => row.id === secondId).status, "error");
});
test("server queue is durable, resumes a dead lease and respects shared pause across clients", async t => {
  const { a, b, command } = await fixture(t), id = randomUUID();
  command(a, "capture", { id, mode: "double" }, new Uint8Array([1]));
  command(b, "pause", { paused: true }); assert.equal(a.claim(1000), undefined);
  command(a, "pause", { paused: false }); const job = a.claim(1000);
  assert.equal(b.claim(15000), undefined);
  const resumed = b.claim(17000); assert.equal(resumed.row.id, id); assert.notEqual(resumed.token, job.token);
  assert.equal(a.heartbeat(id, job.token, 18000), false);
  a.finish(id, job.token, reading()); assert.equal(b.snapshot().session.rows[0].status, "reading");
  b.finish(id, resumed.token, reading()); assert.equal(a.snapshot().session.rows[0].status, "done");
});
test("dynamic question/PÇ configuration survives snapshots, and old-exam uploads cannot enter a new exam", async t => {
  const { a, b, command } = await fixture(t);
  for (const count of [1, 3, 7, 12, 30]) {
    const current = a.snapshot();
    command(a, "meta", { key: "pcMap", previous: current.session.pcMap, value: Array(count).fill("PÇ12") });
    const id = randomUUID(); command(a, "capture", { id, mode: "single" }, new Uint8Array([1]));
    const job = a.claim(); assert.equal(job.row.draft.scores.length, count); a.finish(id, job.token, reading(count));
    assert.equal(b.snapshot().session.rows[0].draft.scores.length, count);
    const before = a.snapshot();
    command(a, "reset", { revision: before.revision });
    assert.equal(b.photo(id), undefined);
    assert.throws(() => b.mutate({ action: "capture", opId: randomUUID(), examId: before.examId, id: randomUUID(), mode: "single" }, new Uint8Array([1])), error => error.status === 409);
  }
});
test("manual completion and reset require real control, and invalid operations do not mutate the stored table", async t => {
  const { a, command } = await fixture(t), id = randomUUID();
  command(a, "capture", { id, mode: "single" }, new Uint8Array([1]));
  const before = a.snapshot();
  assert.throws(() => command(a, "reset", { revision: before.revision }), error => error.status === 409);
  assert.throws(() => command(a, "manual-complete", { id }));
  assert.throws(() => command(a, "meta", { key: "pcMap", previous: before.session.pcMap, value: ["PÇ0"] }));
  assert.equal(a.snapshot().revision, before.revision);
});
