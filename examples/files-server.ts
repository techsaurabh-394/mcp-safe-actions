#!/usr/bin/env node
// Copyright (c) 2026 Saurabh Pathak. MIT License.
// A small file server where deleting needs human approval.
//   FILES_DIR   folder the tools may touch (default ./sandbox)
//   AUDIT_LOG   optional path for the JSONL audit log
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileAudit, registerConfirmedTool } from "../src/index.js";

const configured = path.resolve(process.env.FILES_DIR ?? "./sandbox");
mkdirSync(configured, { recursive: true });
const root = realpathSync(configured);

/**
 * Resolve a user path and make sure it really is inside the folder.
 * The parent folder is resolved through symlinks, so a link that points outside cannot be used to escape.
 */
function inside(rel: string): string {
  const full = path.resolve(root, rel);
  const parent = realpathSync(path.dirname(full)); // throws if the folder does not exist
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error("path is outside the allowed folder");
  return path.join(parent, path.basename(full));
}
const kb = (n: number) => `${(n / 1000).toFixed(1)} KB`;

const server = new McpServer({ name: "files-server", version: "1.0.0" });

server.registerTool(
  "list_files",
  { description: "List files in the allowed folder.", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => {
    const names = readdirSync(root);
    return { content: [{ type: "text", text: names.length ? names.join("\n") : "(empty)" }] };
  }
);

registerConfirmedTool(server, {
  name: "delete_file",
  description: "Permanently delete one file from the allowed folder.",
  inputSchema: { path: z.string().describe("File name relative to the allowed folder") },
  audit: process.env.AUDIT_LOG ? fileAudit(process.env.AUDIT_LOG) : undefined,
  preview: ({ path: rel }) => {
    const st = lstatSync(inside(rel)); // throws if it does not exist; does not follow symlinks
    if (!st.isFile()) throw new Error("only regular files can be deleted (not folders or symlinks)");
    return { summary: `Permanently delete "${rel}" (${kb(st.size)})`, details: ["This cannot be undone."] };
  },
  execute: ({ path: rel }) => {
    const target = inside(rel);
    if (!lstatSync(target).isFile()) throw new Error("no longer a regular file"); // re-check after approval
    rmSync(target);
    return { content: [{ type: "text", text: `Deleted ${rel}` }] };
  },
});

await server.connect(new StdioServerTransport());
console.error(`files-server running on stdio, folder: ${root}`);
