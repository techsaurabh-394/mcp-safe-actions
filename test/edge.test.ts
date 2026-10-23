// Copyright (c) 2026 Saurabh Pathak. MIT License.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApprovalStore, registerConfirmedTool } from "../src/index.js";
import { connectPair, setup, tokenFrom } from "./helpers.js";

const textOf = (r: unknown) => ((r as { content: Array<{ text?: string }> }).content[0].text ?? "");

test("registering an input named confirm_token is rejected (name is reserved)", () => {
  const server = new McpServer({ name: "x", version: "1" });
  assert.throws(
    () =>
      registerConfirmedTool(server, {
        name: "t",
        description: "d",
        inputSchema: { confirm_token: z.string() },
        preview: () => ({ summary: "s" }),
        execute: () => ({ content: [] }),
      }),
    /reserved/
  );
});

test("approval prompt timeout fails closed", async () => {
  const executed: string[] = [];
  const server = new McpServer({ name: "x", version: "1" });
  registerConfirmedTool(server, {
    name: "t",
    description: "d",
    inputSchema: { a: z.string() },
    approvalTimeoutMs: 50,
    preview: () => ({ summary: "s" }),
    execute: () => {
      executed.push("ran");
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const client = new Client({ name: "c", version: "1" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, () => new Promise(() => {})); // human never answers
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  const r = await client.callTool({ name: "t", arguments: { a: "1" } });
  assert.equal(r.isError, true);
  assert.deepEqual(executed, []);
});

test("explicit form capability works like plain elicitation", async () => {
  const executed: string[] = [];
  const { client } = await connectPair(
    (server) =>
      registerConfirmedTool(server, {
        name: "t",
        description: "d",
        inputSchema: { a: z.string() },
        preview: () => ({ summary: "s" }),
        execute: () => (executed.push("ran"), { content: [{ type: "text", text: "ok" }] }),
      }),
    { elicitation: { form: {} } }
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
  const r = await client.callTool({ name: "t", arguments: { a: "1" } });
  assert.equal(textOf(r), "ok");
  assert.equal(executed.length, 1);
});

test("a url-only elicitation client is treated as having no approval prompt (token flow)", async () => {
  const { client } = await connectPair(
    (server) =>
      registerConfirmedTool(server, {
        name: "t",
        description: "d",
        inputSchema: { a: z.string() },
        preview: () => ({ summary: "s" }),
        execute: () => ({ content: [{ type: "text", text: "ran" }] }),
      }),
    { elicitation: { url: {} } }
  );
  assert.match(textOf(await client.callTool({ name: "t", arguments: { a: "1" } })), /NOTHING HAS BEEN CHANGED/);
});

test("mode elicit works when the client supports elicitation", async () => {
  const t = await setup({ client: "accept", mode: "elicit" });
  assert.equal((await t.call({ path: "a" })).text, "Deleted a");
});

test("preview runs once and execute runs once per approved call", async () => {
  let previews = 0;
  let executes = 0;
  const { client } = await connectPair(
    (server) =>
      registerConfirmedTool(server, {
        name: "t",
        description: "d",
        inputSchema: { a: z.string() },
        preview: () => (previews++, { summary: "s" }),
        execute: () => (executes++, { content: [{ type: "text", text: "ok" }] }),
      }),
    { elicitation: { } }
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
  await client.callTool({ name: "t", arguments: { a: "1" } });
  assert.deepEqual([previews, executes], [1, 1]);
});

test("argument order does not matter when confirming", async () => {
  const executed: unknown[] = [];
  const { client } = await connectPair((server) =>
    registerConfirmedTool(server, {
      name: "t",
      description: "d",
      inputSchema: { a: z.string(), b: z.number() },
      preview: () => ({ summary: "s" }),
      execute: (args) => (executed.push(args), { content: [{ type: "text", text: "ok" }] }),
    })
  );
  const first = textOf(await client.callTool({ name: "t", arguments: { a: "x", b: 2 } }));
  const r = await client.callTool({ name: "t", arguments: { b: 2, a: "x", confirm_token: tokenFrom(first) } });
  assert.equal(textOf(r), "ok");
  assert.equal(executed.length, 1);
});

test("unicode and nested-looking strings are bound exactly", async () => {
  const executed: unknown[] = [];
  const { client } = await connectPair((server) =>
    registerConfirmedTool(server, {
      name: "t",
      description: "d",
      inputSchema: { name: z.string() },
      preview: ({ name }) => ({ summary: `do ${name}` }),
      execute: (args) => (executed.push(args), { content: [{ type: "text", text: "ok" }] }),
    })
  );
  const first = textOf(await client.callTool({ name: "t", arguments: { name: "रिपोर्ट 📄.pdf" } }));
  const tok = tokenFrom(first);
  const wrong = await client.callTool({ name: "t", arguments: { name: "रिपोर्ट 📄.pdF", confirm_token: tok } });
  assert.equal(wrong.isError, true);
  const ok = await client.callTool({ name: "t", arguments: { name: "रिपोर्ट 📄.pdf", confirm_token: tok } });
  assert.equal(textOf(ok), "ok");
});

test("many previews at once get distinct tokens, each works independently", async () => {
  const executed: string[] = [];
  const { client } = await connectPair((server) =>
    registerConfirmedTool(server, {
      name: "t",
      description: "d",
      inputSchema: { id: z.string() },
      preview: ({ id }) => ({ summary: id }),
      execute: ({ id }) => (executed.push(id), { content: [{ type: "text", text: id }] }),
    })
  );
  const ids = ["a", "b", "c", "d", "e"];
  const previews = await Promise.all(ids.map((id) => client.callTool({ name: "t", arguments: { id } })));
  const tokens = previews.map((p) => tokenFrom(textOf(p)));
  assert.equal(new Set(tokens).size, 5);
  await Promise.all(ids.map((id, i) => client.callTool({ name: "t", arguments: { id, confirm_token: tokens[i] } })));
  assert.deepEqual([...executed].sort(), ids);
});

test("two simultaneous uses of one token execute exactly once", async () => {
  let executes = 0;
  const { client } = await connectPair((server) =>
    registerConfirmedTool(server, {
      name: "t",
      description: "d",
      inputSchema: { id: z.string() },
      preview: ({ id }) => ({ summary: id }),
      execute: () => (executes++, { content: [{ type: "text", text: "ok" }] }),
    })
  );
  const tok = tokenFrom(textOf(await client.callTool({ name: "t", arguments: { id: "x" } })));
  const [a, b] = await Promise.all([
    client.callTool({ name: "t", arguments: { id: "x", confirm_token: tok } }),
    client.callTool({ name: "t", arguments: { id: "x", confirm_token: tok } }),
  ]);
  assert.equal(executes, 1);
  assert.equal([a, b].filter((r) => r.isError).length, 1);
});

test("a token from one tool cannot approve another tool, even with a shared store", async () => {
  const ran: string[] = [];
  const store = new ApprovalStore();
  const { client } = await connectPair((server) => {
    for (const name of ["tool_a", "tool_b"]) {
      registerConfirmedTool(server, {
        name,
        description: "d",
        inputSchema: { id: z.string() },
        store,
        preview: () => ({ summary: name }),
        execute: () => (ran.push(name), { content: [{ type: "text", text: name }] }),
      });
    }
  });
  const tok = tokenFrom(textOf(await client.callTool({ name: "tool_a", arguments: { id: "1" } })));
  const r = await client.callTool({ name: "tool_b", arguments: { id: "1", confirm_token: tok } });
  assert.equal(r.isError, true);
  assert.deepEqual(ran, []);
});

test("execute may return a tool error result and it passes through untouched", async () => {
  const { client } = await connectPair(
    (server) =>
      registerConfirmedTool(server, {
        name: "t",
        description: "d",
        inputSchema: { a: z.string() },
        preview: () => ({ summary: "s" }),
        execute: () => ({ content: [{ type: "text", text: "nope" }], isError: true }),
      }),
    { elicitation: {} }
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
  const r = await client.callTool({ name: "t", arguments: { a: "1" } });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), "nope");
});

test("custom annotations override the defaults", async () => {
  const { client } = await connectPair((server) =>
    registerConfirmedTool(server, {
      name: "t",
      description: "d",
      inputSchema: {},
      annotations: { destructiveHint: false, openWorldHint: true },
      preview: () => ({ summary: "s" }),
      execute: () => ({ content: [] }),
    })
  );
  const tool = (await client.listTools()).tools[0];
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.equal(tool.annotations?.openWorldHint, true);
});

test("pending-token cap applies through the tool", async () => {
  const store = new ApprovalStore({ maxPending: 2 });
  const { client } = await connectPair((server) =>
    registerConfirmedTool(server, {
      name: "t",
      description: "d",
      inputSchema: { id: z.string() },
      store,
      preview: () => ({ summary: "s" }),
      execute: () => ({ content: [{ type: "text", text: "ok" }] }),
    })
  );
  const first = tokenFrom(textOf(await client.callTool({ name: "t", arguments: { id: "1" } })));
  await client.callTool({ name: "t", arguments: { id: "2" } });
  await client.callTool({ name: "t", arguments: { id: "3" } });
  assert.equal(store.size(), 2);
  const r = await client.callTool({ name: "t", arguments: { id: "1", confirm_token: first } });
  assert.equal(r.isError, true); // evicted
});

test("secret argument values never reach the audit log (only the developer-written summary and a hash do)", async () => {
  const events: string[] = [];
  const { client } = await connectPair(
    (server) =>
      registerConfirmedTool(server, {
        name: "rotate",
        description: "d",
        inputSchema: { api_key: z.string() },
        audit: (e) => events.push(JSON.stringify(e)),
        preview: () => ({ summary: "Rotate the credentials" }),
        execute: () => ({ content: [{ type: "text", text: "rotated" }] }),
      }),
    { elicitation: {} }
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
  await client.callTool({ name: "rotate", arguments: { api_key: "sk-SECRET-123" } });
  assert.ok(events.length >= 3);
  for (const e of events) assert.ok(!e.includes("sk-SECRET-123"), `secret leaked into audit event: ${e}`);
});
