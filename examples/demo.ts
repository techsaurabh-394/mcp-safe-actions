// Copyright (c) 2026 Saurabh Pathak. MIT License.
// Runs both approval flows in one process and prints what happens. No API key, no client app needed.
//   npm run demo
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerConfirmedTool, type AuditEvent } from "../src/index.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "safe-actions-"));
const file = (n: string) => path.join(dir, n);
const say = (who: string, msg: string) => console.log(`${who.padEnd(9)} ${msg.replace(/\n/g, "\n" + " ".repeat(10))}`);

function build(events: AuditEvent[]) {
  const server = new McpServer({ name: "demo", version: "1.0.0" });
  registerConfirmedTool(server, {
    name: "delete_file",
    description: "Permanently delete a file.",
    inputSchema: { name: z.string() },
    audit: (e) => events.push(e),
    preview: ({ name }) => ({ summary: `Permanently delete "${name}"`, details: ["This cannot be undone."] }),
    execute: async ({ name }) => {
      (await import("node:fs")).rmSync(file(name));
      return { content: [{ type: "text", text: `Deleted ${name}` }] };
    },
  });
  return server;
}

async function connect(server: McpServer, client: Client) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
}
const text = (r: unknown) => ((r as { content: Array<{ text?: string }> }).content[0].text ?? "");

async function flowWithElicitation(approve: boolean) {
  console.log(`\n=== Client WITH approval prompts (MCP elicitation). The human says ${approve ? "YES" : "NO"} ===`);
  writeFileSync(file("report.pdf"), "x");
  const events: AuditEvent[] = [];
  const client = new Client({ name: "c", version: "1" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    say("Human", `sees a prompt:\n${req.params.message}`);
    say("Human", approve ? "ticks Approve" : "declines");
    return approve ? { action: "accept", content: { approve: true } } : { action: "decline" };
  });
  await connect(build(events), client);
  say("Model", 'calls delete_file { name: "report.pdf" }');
  const r = await client.callTool({ name: "delete_file", arguments: { name: "report.pdf" } });
  say("Server", text(r));
  say("Check", `report.pdf still exists: ${existsSync(file("report.pdf"))}`);
  say("Audit", events.map((e) => e.event).join(" -> "));
}

async function flowWithToken() {
  console.log("\n=== Client WITHOUT approval prompts (two-step token fallback) ===");
  writeFileSync(file("old-notes.txt"), "x");
  const events: AuditEvent[] = [];
  const client = new Client({ name: "c", version: "1" }, { capabilities: {} });
  await connect(build(events), client);
  say("Model", 'calls delete_file { name: "old-notes.txt" }');
  const first = text(await client.callTool({ name: "delete_file", arguments: { name: "old-notes.txt" } }));
  say("Server", first);
  say("Check", `old-notes.txt still exists: ${existsSync(file("old-notes.txt"))}`);
  const token = /confirm_token="(approve_[0-9a-f]+)"/.exec(first)?.[1] ?? "";
  say("Model", "asks the user, gets a yes, calls again with the token");
  say("Server", text(await client.callTool({ name: "delete_file", arguments: { name: "old-notes.txt", confirm_token: token } })));
  say("Check", `old-notes.txt still exists: ${existsSync(file("old-notes.txt"))}`);
  say("Model", "tries to reuse the same token");
  say("Server", text(await client.callTool({ name: "delete_file", arguments: { name: "old-notes.txt", confirm_token: token } })));
  say("Audit", events.map((e) => e.event).join(" -> "));
}

await flowWithElicitation(true);
await flowWithElicitation(false);
await flowWithToken();
