import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sharedCommand } from "../lib/shared-client.ts";
import { newSession } from "../lib/scan-session.ts";
test("lost shared-command acknowledgements retry the same ID/body, but conflicts never retry", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const bodies = [], command = { action: "manual", id: randomUUID(), opId: randomUUID(), examId: randomUUID() };
  globalThis.fetch = async (_, options) => {
    bodies.push(options.body);
    if (bodies.length === 1) throw new TypeError("network acknowledgement lost");
    return Response.json({ revision: 1, examId: command.examId, paused: false, session: newSession() });
  };
  assert.equal((await sharedCommand(command)).revision, 1);
  assert.deepEqual(bodies, [JSON.stringify(command), JSON.stringify(command)]);
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return Response.json({ error: "conflict" }, { status: 409 }); };
  await assert.rejects(sharedCommand(command), error => error.status === 409);
  assert.equal(attempts, 1);
});
