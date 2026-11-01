// Copyright (c) 2026 Saurabh Pathak. MIT License.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./helpers.js";

const lowRisk = ({ path }: { path: string }) => path.startsWith("tmp/");

test("policy: low-risk call runs without asking, and is logged as auto-approved", async () => {
  const t = await setup({ client: "decline", autoApprove: lowRisk });
  const r = await t.call({ path: "tmp/a.txt" });
  assert.equal(r.text, "Deleted tmp/a.txt");
  assert.equal(t.prompts.length, 0);
  assert.deepEqual(t.events.map((e) => e.event), ["auto-approved", "executed"]);
  assert.equal(t.events[0].mode, "policy");
});

test("policy: high-risk call still goes to the human, who declines -> nothing runs", async () => {
  const t = await setup({ client: "decline", autoApprove: lowRisk });
  await t.call({ path: "important.txt" });
  assert.equal(t.executed.length, 0);
  assert.equal(t.prompts.length, 1);
});

test("policy: high-risk call on a client without prompts gets the token flow, nothing runs", async () => {
  const t = await setup({ client: "none", autoApprove: lowRisk });
  const r = await t.call({ path: "important.txt" });
  assert.match(r.text, /NOTHING HAS BEEN CHANGED YET/);
  assert.equal(t.executed.length, 0);
});

test("policy: a throwing policy fails closed and asks the human", async () => {
  const t = await setup({
    client: "decline",
    autoApprove: () => {
      throw new Error("boom");
    },
  });
  await t.call({ path: "tmp/a.txt" });
  assert.equal(t.executed.length, 0);
  assert.equal(t.prompts.length, 1);
});

test("policy: only an exact true counts (truthy values do not skip approval)", async () => {
  const t = await setup({ client: "decline", autoApprove: (() => "yes") as never });
  await t.call({ path: "tmp/a.txt" });
  assert.equal(t.executed.length, 0);
  assert.equal(t.prompts.length, 1);
});

test("policy: mode elicit ignores the policy, a human must always decide", async () => {
  const t = await setup({ client: "decline", mode: "elicit", autoApprove: () => true });
  await t.call({ path: "tmp/a.txt" });
  assert.equal(t.executed.length, 0);
  assert.equal(t.prompts.length, 1);
});
