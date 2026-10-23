// Copyright (c) 2026 Saurabh Pathak. MIT License.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalStore } from "../src/index.js";
import { setup, tokenFrom } from "./helpers.js";

// ---------- elicitation path ----------
test("elicitation: user approves -> action runs and prompt shows the plan", async () => {
  const t = await setup({ client: "accept" });
  const r = await t.call({ path: "a.txt" });
  assert.equal(r.text, "Deleted a.txt");
  assert.deepEqual(t.executed, [{ path: "a.txt" }]);
  assert.match(t.prompts[0], /Delete a\.txt/);
  assert.match(t.prompts[0], /size: 1 KB/);
  assert.deepEqual(t.events.map((e) => e.event), ["previewed", "approved", "executed"]);
});

test("elicitation: user declines -> nothing runs", async () => {
  const t = await setup({ client: "decline" });
  const r = await t.call({ path: "a.txt" });
  assert.match(r.text, /did not approve/);
  assert.equal(t.executed.length, 0);
  assert.ok(t.events.some((e) => e.event === "declined"));
});

test("elicitation: user cancels -> nothing runs", async () => {
  const t = await setup({ client: "cancel" });
  await t.call({ path: "a.txt" });
  assert.equal(t.executed.length, 0);
});

test("elicitation: accepted but box not ticked -> nothing runs", async () => {
  const t = await setup({ client: "accept-unticked" });
  await t.call({ path: "a.txt" });
  assert.equal(t.executed.length, 0);
});

test("elicitation: a model-supplied token cannot skip the human prompt", async () => {
  const t = await setup({ client: "decline" });
  const r = await t.call({ path: "a.txt", confirm_token: "approve_deadbeef" });
  assert.equal(t.executed.length, 0);
  assert.match(r.text, /did not approve/);
});

test("elicitation: prompt failure fails closed", async () => {
  const t = await setup({ client: "throw" });
  const r = await t.call({ path: "a.txt" });
  assert.equal(r.isError, true);
  assert.equal(t.executed.length, 0);
});

// ---------- token fallback ----------
test("token flow: first call previews and changes nothing", async () => {
  const t = await setup({ client: "none" });
  const r = await t.call({ path: "a.txt" });
  assert.match(r.text, /NOTHING HAS BEEN CHANGED/);
  assert.match(r.text, /Delete a\.txt/);
  assert.ok(tokenFrom(r.text));
  assert.equal(t.executed.length, 0);
});

test("token flow: second call with token runs the action once", async () => {
  const t = await setup({ client: "none" });
  const token = tokenFrom((await t.call({ path: "a.txt" })).text);
  const r = await t.call({ path: "a.txt", confirm_token: token });
  assert.equal(r.text, "Deleted a.txt");
  assert.equal(t.executed.length, 1);
  assert.deepEqual(t.events.map((e) => e.event), ["previewed", "approved", "executed"]);
});

test("token flow: a token cannot be reused", async () => {
  const t = await setup({ client: "none" });
  const token = tokenFrom((await t.call({ path: "a.txt" })).text);
  await t.call({ path: "a.txt", confirm_token: token });
  const again = await t.call({ path: "a.txt", confirm_token: token });
  assert.equal(again.isError, true);
  assert.match(again.text, /not valid/);
  assert.equal(t.executed.length, 1);
});

test("token flow: token only works for the previewed arguments", async () => {
  const t = await setup({ client: "none" });
  const token = tokenFrom((await t.call({ path: "a.txt" })).text);
  const r = await t.call({ path: "OTHER.txt", confirm_token: token });
  assert.equal(r.isError, true);
  assert.match(r.text, /arguments differ/);
  assert.equal(t.executed.length, 0);
});

test("token flow: invented token is rejected", async () => {
  const t = await setup({ client: "none" });
  const r = await t.call({ path: "a.txt", confirm_token: "approve_0000" });
  assert.equal(r.isError, true);
  assert.equal(t.executed.length, 0);
});

test("token flow: expired token is rejected", async () => {
  let now = 1_000;
  const store = new ApprovalStore({ ttlMs: 1000, now: () => now });
  const t = await setup({ client: "none", store });
  const token = tokenFrom((await t.call({ path: "a.txt" })).text);
  now += 5_000;
  const r = await t.call({ path: "a.txt", confirm_token: token });
  assert.equal(r.isError, true);
  assert.match(r.text, /expired/);
  assert.equal(t.executed.length, 0);
});

// ---------- modes ----------
test("mode elicit: client without elicitation is refused, no token issued", async () => {
  const store = new ApprovalStore();
  const t = await setup({ client: "none", mode: "elicit", store });
  const r = await t.call({ path: "a.txt" });
  assert.equal(r.isError, true);
  assert.match(r.text, /cannot show approval prompts/);
  assert.equal(store.size(), 0);
  assert.equal(t.executed.length, 0);
  assert.ok(t.events.some((e) => e.event === "blocked"));
});

test("mode token: uses tokens even when the client supports elicitation", async () => {
  const t = await setup({ client: "accept", mode: "token" });
  const r = await t.call({ path: "a.txt" });
  assert.match(r.text, /NOTHING HAS BEEN CHANGED/);
  assert.equal(t.prompts.length, 0);
  assert.equal(t.executed.length, 0);
});

// ---------- errors ----------
test("preview failure: nothing runs, clear error", async () => {
  const t = await setup({ client: "accept", failPreview: true });
  const r = await t.call({ path: "a.txt" });
  assert.equal(r.isError, true);
  assert.match(r.text, /file not found/);
  assert.equal(t.executed.length, 0);
});

test("execute failure after approval is reported and audited", async () => {
  const t = await setup({ client: "accept", failExecute: true });
  const r = await t.call({ path: "a.txt" });
  assert.equal(r.isError, true);
  assert.match(r.text, /disk is read-only/);
  assert.ok(t.events.some((e) => e.event === "failed"));
});

// ---------- tool metadata ----------
test("tool is listed with destructive annotation, warning text and optional confirm_token", async () => {
  const t = await setup({ client: "none" });
  const tool = (await t.client.listTools()).tools[0];
  assert.equal(tool.annotations?.destructiveHint, true);
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.match(tool.description ?? "", /DESTRUCTIVE/);
  const props = (tool.inputSchema as { properties: Record<string, unknown>; required?: string[] }).properties;
  assert.ok("confirm_token" in props);
  assert.ok(!(tool.inputSchema.required ?? []).includes("confirm_token"));
});

test("risk write: not marked destructive", async () => {
  const t = await setup({ client: "none", risk: "write" });
  const tool = (await t.client.listTools()).tools[0];
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.match(tool.description ?? "", /CHANGES DATA/);
});

test("audit never contains raw arguments", async () => {
  const t = await setup({ client: "accept" });
  await t.call({ path: "super-secret-name.txt" });
  const hashOnly = t.events.every((e) => !JSON.stringify(e).includes('"path"') && e.argsHash?.length === 64);
  assert.ok(hashOnly);
});
