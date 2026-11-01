// Copyright (c) 2026 Saurabh Pathak. MIT License.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { contextMatchesGate, registerConfirmedTool, type AuditEvent, type ConfirmedToolConfig } from "../src/index.js";

const ELEMENTS: Record<string, { label: string; role: string }> = {
  e1: { label: "Open menu", role: "button" },
  e2: { label: "Buy now", role: "button" },
  e3: { label: "Delete account", role: "link" },
  e4: { label: "Allow notifications", role: "button" },
};

type Over = Partial<ConfirmedToolConfig<{ element_id: z.ZodString }>>;

async function setup(over: Over = {}, client: "none" | "decline" = "decline") {
  const clicked: string[] = [];
  const events: AuditEvent[] = [];
  const prompts: string[] = [];
  const server = new McpServer({ name: "screen", version: "1" });
  const cfg: ConfirmedToolConfig<{ element_id: z.ZodString }> = {
    name: "click",
    description: "Click an element.",
    inputSchema: { element_id: z.string() },
    audit: (e) => events.push(e),
    preview: ({ element_id }) => ({ summary: `Click ${element_id}` }),
    execute: ({ element_id }) => {
      clicked.push(element_id);
      return { content: [{ type: "text", text: `Clicked ${element_id}` }] };
    },
    resolve: ({ element_id }) => ELEMENTS[element_id],
    gate: { pattern: /\b(buy|delete|send|pay|grant|allow)\b/i, fields: ["label"] },
    autoApprove: (_a, _p, ctx) => ctx?.role === "button" || ctx?.role === "link",
    ...over,
  };
  registerConfirmedTool(server, cfg);
  const c = new Client({ name: "c", version: "1" }, client === "none" ? { capabilities: {} } : { capabilities: { elicitation: {} } });
  if (client !== "none") {
    c.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return { action: "decline" };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await c.connect(a);
  const call = async (element_id: string) => {
    const r = await c.callTool({ name: "click", arguments: { element_id } });
    return (r.content as Array<{ text?: string }>)[0].text ?? "";
  };
  return { call, clicked, events, prompts };
}

test("context: harmless target is auto-approved using the resolved context", async () => {
  const t = await setup();
  assert.equal(await t.call("e1"), "Clicked e1");
  assert.equal(t.prompts.length, 0);
  assert.deepEqual(t.events.map((e) => e.event), ["auto-approved", "executed"]);
});

test("context: a 'Buy now' target is gated even though the policy would approve it", async () => {
  const t = await setup();
  await t.call("e2");
  assert.deepEqual(t.clicked, []);
  assert.equal(t.prompts.length, 1);
});

test("context: delete and allow labels are gated too", async () => {
  const t = await setup();
  await t.call("e3");
  await t.call("e4");
  assert.deepEqual(t.clicked, []);
  assert.equal(t.prompts.length, 2);
});

test("context: the approval prompt shows the human what is being clicked", async () => {
  const t = await setup();
  await t.call("e2");
  assert.match(t.prompts[0], /target label: Buy now/);
  assert.match(t.prompts[0], /target role: button/);
});

test("context: a gated target on a client without prompts gets the token flow, nothing runs", async () => {
  const t = await setup({}, "none");
  const r = await t.call("e2");
  assert.match(r, /NOTHING HAS BEEN CHANGED YET/);
  assert.match(r, /target label: Buy now/);
  assert.deepEqual(t.clicked, []);
});

test("context: resolver that throws fails closed, human decides", async () => {
  const t = await setup({ resolve: () => { throw new Error("screen gone"); } });
  await t.call("e1");
  assert.deepEqual(t.clicked, []);
  assert.equal(t.prompts.length, 1);
  assert.match(t.prompts[0], /could not be identified/);
});

test("context: throwing resolver is not auto-approved even by a policy that always says yes", async () => {
  const t = await setup({ resolve: () => { throw new Error("screen gone"); }, autoApprove: () => true });
  await t.call("e1");
  assert.deepEqual(t.clicked, []);
  assert.equal(t.prompts.length, 1);
});

test("context: a gate that throws fails closed, even with an always-yes policy", async () => {
  const badFields = new Proxy([] as string[], { get() { throw new Error("bad gate"); } });
  const t = await setup({ gate: { pattern: /buy/, fields: badFields }, autoApprove: () => true });
  await t.call("e1");
  assert.deepEqual(t.clicked, []);
  assert.equal(t.prompts.length, 1);
});

test("context: resolver that rejects fails closed", async () => {
  const t = await setup({ resolve: () => Promise.reject(new Error("nope")) });
  await t.call("e1");
  assert.deepEqual(t.clicked, []);
  assert.equal(t.prompts.length, 1);
});

for (const [name, value] of [["undefined", undefined], ["null", null], ["a string", "Open menu"], ["an array", ["x"]]] as const) {
  test(`context: resolver returning ${name} (unknown target) is never auto-approved`, async () => {
    const t = await setup({ resolve: () => value as never, autoApprove: () => true });
    await t.call("e1");
    assert.deepEqual(t.clicked, []);
    assert.equal(t.prompts.length, 1);
  });
}

test("context: unknown element id (resolver finds nothing) is never auto-approved", async () => {
  const t = await setup({ autoApprove: () => true });
  await t.call("nope");
  assert.deepEqual(t.clicked, []);
  assert.equal(t.prompts.length, 1);
});

test("context: a /g regex gives the same answer on every call", async () => {
  const t = await setup({ gate: { pattern: /buy/gi, fields: ["label"] } });
  await t.call("e2");
  await t.call("e2"); // a /g regex must give the same answer every time (no lastIndex state)
  assert.deepEqual(t.clicked, []);
  assert.equal(t.prompts.length, 2);
});

test("context: gate only inspects the listed fields", async () => {
  const t = await setup({ resolve: () => ({ label: "Open menu", role: "button", note: "buy" }), gate: { pattern: /buy/, fields: ["label"] } });
  assert.equal(await t.call("e1"), "Clicked e1");
});

test("context: gate without fields inspects every string field", async () => {
  const t = await setup({ resolve: () => ({ label: "Continue", url: "https://shop/checkout/pay" }), gate: { pattern: /\bpay\b/i } });
  await t.call("e1");
  assert.deepEqual(t.clicked, []);
  assert.equal(t.prompts.length, 1);
});

test("context: gate cannot be bypassed by a policy that returns true", async () => {
  const t = await setup({ autoApprove: () => true });
  await t.call("e2");
  assert.deepEqual(t.clicked, []);
});

test("context: the policy receives the resolved context as its third argument", async () => {
  let seen: unknown;
  const t = await setup({ autoApprove: (_a: unknown, _p: unknown, ctx: unknown) => { seen = ctx; return true; } } as never);
  await t.call("e1");
  assert.deepEqual(seen, { label: "Open menu", role: "button" });
});

test("context: without resolve nothing changes (existing behaviour)", async () => {
  const t = await setup({ resolve: undefined, gate: undefined, autoApprove: () => true });
  assert.equal(await t.call("e2"), "Clicked e2");
});

test("context: gate without resolve is a registration error", async () => {
  const server = new McpServer({ name: "x", version: "1" });
  assert.throws(
    () =>
      registerConfirmedTool(server, {
        name: "t",
        description: "d",
        inputSchema: { a: z.string() },
        gate: { pattern: /x/ },
        preview: () => ({ summary: "s" }),
        execute: () => ({ content: [] }),
      }),
    /gate.*resolve/
  );
});

test("context: contextMatchesGate ignores non-string values", () => {
  assert.equal(contextMatchesGate({ n: 5, b: true, l: "Buy" }, { pattern: /5|true/ }), false);
  assert.equal(contextMatchesGate({ l: "Buy" }, { pattern: /buy/i }), true);
});
