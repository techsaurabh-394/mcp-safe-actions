// Copyright (c) 2026 Saurabh Pathak. MIT License.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerConfirmedTool, webhookApprover, type Approver, type AuditEvent } from "../src/index.js";

async function rig(approver: Approver | undefined, extra: { autoApprove?: () => boolean; approvalTimeoutMs?: number } = {}) {
  const executed: string[] = [];
  const events: AuditEvent[] = [];
  const server = new McpServer({ name: "s", version: "1.0.0" });
  registerConfirmedTool(server, {
    name: "delete_file",
    description: "Delete a file.",
    inputSchema: { path: z.string() },
    mode: "channel",
    approver,
    audit: (e) => events.push(e),
    preview: ({ path }) => ({ summary: `Delete ${path}`, details: ["size: 1 KB"] }),
    execute: ({ path }) => {
      executed.push(path);
      return { content: [{ type: "text", text: `Deleted ${path}` }] };
    },
    ...extra,
  });
  const client = new Client({ name: "c", version: "1.0.0" }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  const call = async (path: string) => {
    const r = await client.callTool({ name: "delete_file", arguments: { path } });
    return { text: (r.content as Array<{ text: string }>)[0].text, isError: r.isError === true };
  };
  return { call, executed, events };
}

test("channel: approver returns true -> action runs, plan reaches the approver", async () => {
  let seen: unknown;
  const t = await rig((req) => ((seen = req), true));
  const r = await t.call("a.txt");
  assert.equal(r.text, "Deleted a.txt");
  assert.deepEqual(t.events.map((e) => e.event), ["previewed", "approved", "executed"]);
  assert.equal(t.events[0].mode, "channel");
  assert.equal((seen as { summary: string }).summary, "Delete a.txt");
  assert.deepEqual((seen as { details: string[] }).details, ["size: 1 KB"]);
});

test("channel: approver returns false -> nothing runs", async () => {
  const t = await rig(() => false);
  await t.call("a.txt");
  assert.equal(t.executed.length, 0);
  assert.ok(t.events.some((e) => e.event === "declined"));
});

test("channel: only an exact true approves (truthy values do not)", async () => {
  const t = await rig((() => "yes") as never);
  await t.call("a.txt");
  assert.equal(t.executed.length, 0);
});

test("channel: approver throws -> fails closed", async () => {
  const t = await rig(() => {
    throw new Error("slack down");
  });
  const r = await t.call("a.txt");
  assert.equal(r.isError, true);
  assert.equal(t.executed.length, 0);
});

test("channel: approver never answers -> times out, nothing runs", async () => {
  const t = await rig(() => new Promise<boolean>(() => {}), { approvalTimeoutMs: 50 });
  const r = await t.call("a.txt");
  assert.equal(r.isError, true);
  assert.match(r.text, /timed out/);
  assert.equal(t.executed.length, 0);
});

test("channel: autoApprove is ignored, the approver always decides", async () => {
  const t = await rig(() => false, { autoApprove: () => true });
  await t.call("a.txt");
  assert.equal(t.executed.length, 0);
});

test("channel: mode channel without an approver is rejected at registration", async () => {
  const server = new McpServer({ name: "s", version: "1.0.0" });
  assert.throws(
    () => registerConfirmedTool(server, { name: "x", description: "x", inputSchema: {}, mode: "channel", preview: () => ({ summary: "x" }), execute: () => ({ content: [] }) }),
    /needs an `approver`/
  );
});

const fakeFetch = (status: number, body: unknown, capture?: { init?: RequestInit }) =>
  (async (_u: unknown, init?: RequestInit) => {
    if (capture) capture.init = init;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
const req = { tool: "t", summary: "s", details: [], argsHash: "h" };

test("webhook: {approved:true} with 200 approves, and posts the plan as JSON with custom headers", async () => {
  const cap: { init?: RequestInit } = {};
  const ok = await webhookApprover("http://x", { fetch: fakeFetch(200, { approved: true }, cap), headers: { authorization: "Bearer k" } })(req);
  assert.equal(ok, true);
  assert.equal(cap.init?.method, "POST");
  assert.equal(JSON.parse(String(cap.init?.body)).summary, "s");
  assert.equal((cap.init?.headers as Record<string, string>).authorization, "Bearer k");
});

test("webhook: anything else is not approval", async () => {
  for (const [status, body] of [[200, { approved: false }], [200, { approved: "true" }], [200, {}], [500, { approved: true }], [403, { approved: true }]] as const) {
    assert.equal(await webhookApprover("http://x", { fetch: fakeFetch(status, body) })(req), false, `${status} ${JSON.stringify(body)}`);
  }
  await assert.rejects(async () => webhookApprover("http://x", { fetch: fakeFetch(200, "not json") })(req)); // thrown -> register treats as failed, fail closed
});
