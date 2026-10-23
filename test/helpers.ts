// Copyright (c) 2026 Saurabh Pathak. MIT License.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApprovalStore, registerConfirmedTool, type AuditEvent, type ConfirmMode } from "../src/index.js";

export type ClientBehaviour = "none" | "accept" | "decline" | "cancel" | "accept-unticked" | "throw";

export async function setup(opts: { client: ClientBehaviour; mode?: ConfirmMode; risk?: "destructive" | "write"; store?: ApprovalStore; failExecute?: boolean; failPreview?: boolean }) {
  const executed: Array<{ path: string }> = [];
  const events: AuditEvent[] = [];
  const prompts: string[] = [];

  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerConfirmedTool(server, {
    name: "delete_file",
    description: "Delete a file.",
    inputSchema: { path: z.string() },
    risk: opts.risk,
    mode: opts.mode,
    store: opts.store,
    audit: (e) => events.push(e),
    preview: ({ path }) => {
      if (opts.failPreview) throw new Error("file not found");
      return { summary: `Delete ${path}`, details: ["size: 1 KB"] };
    },
    execute: ({ path }) => {
      if (opts.failExecute) throw new Error("disk is read-only");
      executed.push({ path });
      return { content: [{ type: "text", text: `Deleted ${path}` }] };
    },
  });

  const client = new Client({ name: "test-client", version: "1.0.0" }, opts.client === "none" ? { capabilities: {} } : { capabilities: { elicitation: {} } });
  if (opts.client !== "none") {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      if (opts.client === "throw") throw new Error("ui crashed");
      if (opts.client === "decline") return { action: "decline" };
      if (opts.client === "cancel") return { action: "cancel" };
      if (opts.client === "accept-unticked") return { action: "accept", content: { approve: false } };
      return { action: "accept", content: { approve: true } };
    });
  }
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);

  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "delete_file", arguments: args });
    const first = (r.content as Array<{ type: string; text?: string }>)[0];
    return { text: first.text ?? "", isError: r.isError === true };
  };
  return { client, server, call, executed, events, prompts };
}

export const tokenFrom = (t: string): string => /confirm_token="(approve_[0-9a-f]+)"/.exec(t)?.[1] ?? "";

/** Build a server with several confirmed tools sharing one store, and connect a client. */
export async function connectPair(register: (server: McpServer) => void, clientCaps: Record<string, unknown> = {}) {
  const server = new McpServer({ name: "multi", version: "1.0.0" });
  register(server);
  const client = new Client({ name: "c", version: "1" }, { capabilities: clientCaps as never });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  return { server, client };
}
