// Copyright (c) 2026 Saurabh Pathak. MIT License.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalStore, hashArgs, stableStringify } from "../src/index.js";

test("stableStringify ignores key order and undefined values", () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: undefined } }), stableStringify({ a: { d: 2 }, b: 1 }));
  assert.notEqual(hashArgs({ a: 1 }), hashArgs({ a: 2 }));
});

test("token is single-use and bound to tool and args", () => {
  const s = new ApprovalStore();
  const { token } = s.issue("t", { a: 1 });
  assert.deepEqual(s.consume(token, "other", { a: 1 }), { ok: false, reason: "mismatch" });
  assert.deepEqual(s.consume(token, "t", { a: 2 }), { ok: false, reason: "mismatch" });
  assert.deepEqual(s.consume(token, "t", { a: 1 }), { ok: true });
  assert.deepEqual(s.consume(token, "t", { a: 1 }), { ok: false, reason: "unknown" });
});

test("tokens expire", () => {
  let now = 0;
  const s = new ApprovalStore({ ttlMs: 100, now: () => now });
  const { token } = s.issue("t", {});
  now = 101;
  assert.deepEqual(s.consume(token, "t", {}), { ok: false, reason: "expired" });
  assert.equal(s.size(), 0);
});

test("pending tokens are capped, oldest dropped first", () => {
  const s = new ApprovalStore({ maxPending: 2 });
  const a = s.issue("t", { n: 1 });
  s.issue("t", { n: 2 });
  s.issue("t", { n: 3 });
  assert.equal(s.size(), 2);
  assert.deepEqual(s.consume(a.token, "t", { n: 1 }), { ok: false, reason: "unknown" });
});
