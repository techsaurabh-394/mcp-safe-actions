// Copyright (c) 2026 Saurabh Pathak. MIT License.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ApprovalStore, fileAudit, hashArgs } from "../src/index.js";

test("fileAudit writes one JSON line per event", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "audit-")), "nested", "audit.jsonl");
  const sink = fileAudit(file);
  sink({ time: "t1", tool: "x", event: "previewed", mode: "token", summary: "s", argsHash: "h" });
  sink({ time: "t2", tool: "x", event: "executed", mode: "token" });
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ["previewed", "executed"]);
});

test("fileAudit never throws when the path is unwritable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "audit-"));
  const blocker = path.join(dir, "file");
  writeFileSync(blocker, "x");
  const sink = fileAudit(path.join(blocker, "cannot", "audit.jsonl")); // parent is a regular file
  assert.doesNotThrow(() => sink({ time: "t", tool: "x", event: "blocked", mode: "elicit" }));
});

// Small seeded PRNG so the property test is reproducible.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function randomValue(r: () => number, depth = 0): unknown {
  const k = Math.floor(r() * (depth > 2 ? 4 : 6));
  if (k === 0) return Math.floor(r() * 1000);
  if (k === 1) return String.fromCharCode(97 + Math.floor(r() * 26)).repeat(1 + Math.floor(r() * 4));
  if (k === 2) return r() > 0.5;
  if (k === 3) return null;
  if (k === 4) return Array.from({ length: Math.floor(r() * 3) }, () => randomValue(r, depth + 1));
  return randomObject(r, depth + 1);
}
function randomObject(r: () => number, depth = 0): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (let i = 0; i < 1 + Math.floor(r() * 4); i++) o[`k${Math.floor(r() * 8)}`] = randomValue(r, depth);
  return o;
}
function shuffled<T extends Record<string, unknown>>(o: T, r: () => number): T {
  const keys = Object.keys(o).sort(() => r() - 0.5);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = o[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? shuffled(v as Record<string, unknown>, r) : v;
  }
  return out as T;
}

test("property: hash ignores key order for 300 random argument objects", () => {
  const r = rng(42);
  for (let i = 0; i < 300; i++) {
    const obj = randomObject(r);
    assert.equal(hashArgs(obj), hashArgs(shuffled(obj, r)));
  }
});

test("property: changing any value changes the hash for 300 random objects", () => {
  const r = rng(7);
  for (let i = 0; i < 300; i++) {
    const obj = randomObject(r);
    const copy = { ...obj, __extra: i };
    assert.notEqual(hashArgs(obj), hashArgs(copy));
  }
});

test("expiry boundary: a token is invalid exactly at its expiry time", () => {
  let now = 1000;
  const s = new ApprovalStore({ ttlMs: 500, now: () => now });
  const { token } = s.issue("t", {});
  now = 1499;
  assert.deepEqual(s.consume(token, "t", {}), { ok: true });
  const second = s.issue("t", {});
  now = 1999;
  assert.deepEqual(s.consume(second.token, "t", {}), { ok: false, reason: "expired" });
});

test("tokens look random and unique across 1000 issues", () => {
  const s = new ApprovalStore({ maxPending: 5000 });
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(s.issue("t", { i }).token);
  assert.equal(seen.size, 1000);
  for (const t of seen) assert.match(t, /^approve_[0-9a-f]{32}$/);
});
