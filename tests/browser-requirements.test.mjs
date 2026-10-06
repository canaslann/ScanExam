import assert from "node:assert/strict";
import test from "node:test";
import { queueStartupIssue } from "../lib/browser-requirements.ts";

test("insecure phone connections are not mislabeled as unsupported browsers", () => {
  for (const hasLocks of [false, true]) {
    const message = queueStartupIssue({ secureContext: false, hasLocks });
    assert.match(message, /Bu bağlantı güvenli değil/);
    assert.match(message, /HTTPS/);
    assert.match(message, /desteklenmediği anlamına gelmez/);
  }
});

test("secure but unsupported browsers retain single-writer protection and actionable guidance", () => {
  const message = queueStartupIssue({ secureContext: true, hasLocks: false });
  assert.match(message, /Bağlantı güvenli/);
  assert.match(message, /Web Locks/);
  assert.match(message, /Safari, Chrome veya Edge/);
  assert.match(message, /tarama başlatılmadı/);
});

test("secure supported browsers, including localhost, can initialize the queue", () => {
  assert.equal(queueStartupIssue({ secureContext: true, hasLocks: true }), null);
});
