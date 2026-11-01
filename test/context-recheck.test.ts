// Copyright (c) 2026 Saurabh Pathak. MIT License.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApprovalStore, registerConfirmedTool, type AuditEvent, type ConfirmedToolConfig } from "../src/index.js";

type Ctx = Record<string, unknown> | undefined | "throw" | string;
type Over = Partial<ConfirmedToolConfig<{ element_id: z.ZodString }>>;

/** `screen.now` is what resolve() sees. `onPrompt` runs while the human is deciding, so it can change the screen. */
async function setup(opts: { over?: Over; client?: "accept" | "none"; onPrompt?: () => void } = {}) {
  const screen: { now: Ctx } = { now: { label: "Open menu", role: "button", y: 10 } };
  const clicked: string[] = [];
  const events: AuditEvent[] = [];
  const prompts: string[] = [];
  const server = new McpServer({ name: "screen", version: "1" });
  const store = new ApprovalStore();
  const cfg: ConfirmedToolConfig<{ element_id: z.ZodString }> = {
    name: "click",
    description: "Click an element.",
    inputSchema: { element_id: z.string() },
    store,
    audit: (e) => events.push(e),
    preview: ({ element_id }) => ({ summary: `Click ${element_id}` }),
    execute: ({ element_id }) => {
      clicked.push(element_id);
      return { content: [{ type: "text", text: `Clicked ${element_id}` }] };
    },
    resolve: () => {
      if (screen.now === "throw") throw new Error("screen gone");
      return screen.now as never;
    },
    ...opts.over,
  };
  registerConfirmedTool(server, cfg);
  const client = opts.client ?? "accept";
  const c = new Client({ name: "c", version: "1" }, client === "none" ? { capabilities: {} } : { capabilities: { elicitation: {} } });
  if (client !== "none") {
    c.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      opts.onPrompt?.();
      return { action: "accept", content: { approve: true } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await c.connect(a);
  const call = async (args: Record<string, unknown>) => {
    const r = await c.callTool({ name: "click", arguments: { element_id: "e1", ...args } });
    return { text: (r.content as Array<{ text?: string }>)[0].text ?? "", isError: r.isError === true };
  };
  return { call, screen, clicked, events, prompts };
}

test("recheck: unchanged target runs after approval", async () => {
  const t = await setup();
  assert.equal((await t.call({})).text, "Clicked e1");
  assert.deepEqual(t.clicked, ["e1"]);
});

test("recheck: target changed while the human was deciding -> nothing runs", async () => {
  const t = await setup({ onPrompt: () => void (t0.screen.now = { label: "Buy now", role: "button", y: 10 }) });
  const t0 = t;
  const r = await t.call({});
  assert.deepEqual(t.clicked, []);
  assert.equal(r.isError, true);
  assert.match(r.text, /target changed/);
  assert.ok(t.events.some((e) => e.event === "context-changed"));
  assert.ok(!t.events.some((e) => e.event === "executed"));
});

test("recheck: second lookup that throws -> nothing runs (fail closed)", async () => {
  const t = await setup({ onPrompt: () => void (t0.screen.now = "throw") });
  const t0 = t;
  await t.call({});
  assert.deepEqual(t.clicked, []);
  assert.ok(t.events.some((e) => e.event === "context-changed"));
});

for (const [name, v] of [["undefined", undefined], ["a string", "gone"]] as const) {
  test(`recheck: second lookup returning ${name} -> nothing runs`, async () => {
    const t = await setup({ onPrompt: () => void (t0.screen.now = v) });
    const t0 = t;
    await t.call({});
    assert.deepEqual(t.clicked, []);
  });
}

test("recheck: also applies to auto-approved calls", async () => {
  let n = 0;
  const t = await setup({
    over: {
      resolve: () => ({ label: n++ === 0 ? "Open menu" : "Buy now", role: "button" }),
      autoApprove: (_a, _p, ctx) => ctx?.role === "button",
    },
    client: "accept",
  });
  await t.call({});
  assert.deepEqual(t.clicked, []);
  assert.deepEqual(t.events.map((e) => e.event), ["auto-approved", "context-changed"]);
});

test("recheck: pinFields ignores volatile fields but catches pinned ones", async () => {
  const t = await setup({
    over: { pinFields: ["label", "role"] },
    onPrompt: () => void (t0.screen.now = { label: "Open menu", role: "button", y: 999 }),
  });
  const t0 = t;
  assert.equal((await t.call({})).text, "Clicked e1");
  const u = await setup({
    over: { pinFields: ["label", "role"] },
    onPrompt: () => void (u0.screen.now = { label: "Pay", role: "button", y: 10 }),
  });
  const u0 = u;
  await u.call({});
  assert.deepEqual(u.clicked, []);
});

test("recheck: without pinFields any changed field blocks (e.g. url)", async () => {
  const t = await setup({ onPrompt: () => void (t0.screen.now = { label: "Open menu", role: "button", y: 11 }) });
  const t0 = t;
  await t.call({});
  assert.deepEqual(t.clicked, []);
});

test("recheck: target that was unknown when approved and is still unknown runs (human saw 'could not be identified')", async () => {
  const t = await setup({ over: { resolve: () => undefined as never } });
  assert.equal((await t.call({})).text, "Clicked e1");
  assert.match(t.prompts[0], /could not be identified/);
});

test("recheck: target unknown at approval but resolvable later -> nothing runs", async () => {
  let n = 0;
  const t = await setup({ over: { resolve: () => (n++ === 0 ? (undefined as never) : { label: "Buy now" }) } });
  await t.call({});
  assert.deepEqual(t.clicked, []);
});

test("recheck: tools without resolve are unaffected and resolve is not called", async () => {
  let calls = 0;
  const t = await setup({ over: { resolve: undefined } });
  void calls;
  assert.equal((await t.call({})).text, "Clicked e1");
});

test("recheck: resolve is called again right before execute (twice in total for one approval)", async () => {
  let calls = 0;
  const t = await setup({ over: { resolve: () => (calls++, { label: "Open menu", role: "button" }) } });
  await t.call({});
  assert.equal(calls, 2);
});

test("token flow: token only works for the same resolved target", async () => {
  const t = await setup({ client: "none" });
  const first = await t.call({});
  const token = /confirm_token="(approve_[0-9a-f]+)"/.exec(first.text)?.[1] ?? "";
  assert.ok(token);
  t.screen.now = { label: "Buy now", role: "button", y: 10 };
  const second = await t.call({ confirm_token: token });
  assert.equal(second.isError, true);
  assert.match(second.text, /no longer the one that was previewed/);
  assert.deepEqual(t.clicked, []);
  // target goes back: the same token still works once
  t.screen.now = { label: "Open menu", role: "button", y: 10 };
  assert.equal((await t.call({ confirm_token: token })).text, "Clicked e1");
  assert.deepEqual(t.clicked, ["e1"]);
});

test("token flow: target changes between token use and execution -> nothing runs", async () => {
  let calls = 0;
  const t = await setup({
    client: "none",
    over: { resolve: () => ({ label: ++calls <= 2 ? "Open menu" : "Buy now", role: "button" }) },
  });
  const first = await t.call({});
  const token = /confirm_token="(approve_[0-9a-f]+)"/.exec(first.text)?.[1] ?? "";
  await t.call({ confirm_token: token });
  assert.deepEqual(t.clicked, []);
  assert.ok(t.events.some((e) => e.event === "context-changed"));
});

test("store: context hash is part of the token binding", () => {
  const s = new ApprovalStore();
  const { token } = s.issue("t", { a: 1 }, "h1");
  assert.deepEqual(s.consume(token, "t", { a: 1 }, "h2"), { ok: false, reason: "context" });
  assert.deepEqual(s.consume(token, "t", { a: 1 }, undefined), { ok: false, reason: "context" });
  assert.deepEqual(s.consume(token, "t", { a: 1 }, "h1"), { ok: true });
  assert.deepEqual(s.consume(token, "t", { a: 1 }, "h1"), { ok: false, reason: "unknown" });
});
