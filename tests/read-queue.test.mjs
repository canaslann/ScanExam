import test from "node:test";
import assert from "node:assert/strict";
import {
  QueueGate,
  readWithBusyRetry,
  abortableDelay,
} from "../lib/read-queue.ts";
import { emptyRow } from "../lib/scan-session.ts";

test("FIFO gate blocks concurrent requests, accepts late captures and continues after errors", () => {
  const gate = new QueueGate(),
    rows = [emptyRow(7, "a", "single"), emptyRow(7, "b", "double")];
  assert.equal(gate.claim(rows, false).id, "a");
  rows[0].status = "reading";
  rows.push(emptyRow(7, "c", "single"));
  assert.equal(gate.claim(rows, false), undefined);
  gate.release("wrong");
  assert.equal(gate.claim(rows, false), undefined);
  rows[0].status = "error";
  gate.release("a");
  assert.equal(gate.claim(rows, true), undefined);
  assert.equal(gate.claim(rows, false).id, "b");
  rows[1].status = "done";
  gate.release("b");
  assert.equal(gate.claim(rows, false).id, "c");
  rows[2].status = "done";
  gate.release("c");
  assert.equal(gate.claim(rows, false), undefined);
});
test("busy reader is retried with bounded backoff without replacing the row", async () => {
  const delays = [],
    controller = new AbortController();
  let attempts = 0,
    notices = 0;
  const result = await readWithBusyRetry(
    async () => {
      if (++attempts < 4) throw { status: 409 };
      return "same row";
    },
    controller.signal,
    () => notices++,
    async (delay) => {
      delays.push(delay);
    },
  );
  assert.equal(result, "same row");
  assert.deepEqual(delays, [2000, 4000, 8000]);
  assert.equal(notices, 3);
  attempts = 0;
  await assert.rejects(
    readWithBusyRetry(
      async () => {
        attempts++;
        throw { status: 409 };
      },
      controller.signal,
      () => {},
      async () => {},
    ),
  );
  assert.equal(attempts, 6);
});
test("non-busy errors are not silently retried; cancellation prevents another request", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(
    readWithBusyRetry(
      async () => {
        attempts++;
        throw { status: 503 };
      },
      controller.signal,
      () => {},
    ),
  );
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(
    readWithBusyRetry(
      async () => {
        attempts++;
        throw { status: 409 };
      },
      controller.signal,
      () => {},
      async () => {
        controller.abort();
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(attempts, 1);
  await assert.rejects(abortableDelay(30_000, controller.signal), {
    name: "AbortError",
  });
});
