// Copyright (c) 2026 Saurabh Pathak. MIT License.
// Spawns the real example server as a child process and talks to it over stdio, like Claude Desktop would.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tokenFrom } from "./helpers.js";

const serverJs = fileURLToPath(new URL("../examples/files-server.js", import.meta.url));

async function start() {
  const base = mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  const dir = path.join(base, "files");
  const outside = path.join(base, "outside");
  mkdirSync(dir);
  mkdirSync(outside);
  writeFileSync(path.join(dir, "a.txt"), "hello");
  writeFileSync(path.join(outside, "secret.txt"), "do not delete");
  const audit = path.join(base, "audit.jsonl");
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [serverJs], env: { ...process.env, FILES_DIR: dir, AUDIT_LOG: audit }, stderr: "pipe" })
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Array<{ text?: string }>)[0].text ?? "", isError: r.isError === true };
  };
  return { client, call, dir, outside, audit };
}

test("stdio: list, preview, approve with token, delete", async () => {
  const s = await start();
  try {
    const tools = (await s.client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["delete_file", "list_files"]);
    assert.equal(tools.find((t) => t.name === "delete_file")?.annotations?.destructiveHint, true);

    assert.equal((await s.call("list_files", {})).text, "a.txt");
    const preview = await s.call("delete_file", { path: "a.txt" });
    assert.match(preview.text, /NOTHING HAS BEEN CHANGED/);
    assert.ok(existsSync(path.join(s.dir, "a.txt")), "file must survive the preview");

    const done = await s.call("delete_file", { path: "a.txt", confirm_token: tokenFrom(preview.text) });
    assert.equal(done.text, "Deleted a.txt");
    assert.ok(!existsSync(path.join(s.dir, "a.txt")));

    const events = readFileSync(s.audit, "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
    assert.deepEqual(events, ["previewed", "approved", "executed"]);
  } finally {
    await s.client.close();
  }
});

test("stdio: path traversal is refused before any approval step", async () => {
  const s = await start();
  try {
    const r = await s.call("delete_file", { path: "../outside/secret.txt" });
    assert.equal(r.isError, true);
    assert.match(r.text, /outside the allowed folder/);
    assert.ok(existsSync(path.join(s.outside, "secret.txt")));
  } finally {
    await s.client.close();
  }
});

test("stdio: a symlinked folder cannot be used to escape", async () => {
  const s = await start();
  try {
    symlinkSync(s.outside, path.join(s.dir, "link"), "dir");
    const r = await s.call("delete_file", { path: "link/secret.txt" });
    assert.equal(r.isError, true);
    assert.ok(existsSync(path.join(s.outside, "secret.txt")), "file outside the folder must be untouched");
  } finally {
    await s.client.close();
  }
});

test("stdio: folders and symlinks themselves are refused", async () => {
  const s = await start();
  try {
    mkdirSync(path.join(s.dir, "sub"));
    symlinkSync(path.join(s.outside, "secret.txt"), path.join(s.dir, "shortcut"));
    assert.equal((await s.call("delete_file", { path: "sub" })).isError, true);
    assert.equal((await s.call("delete_file", { path: "shortcut" })).isError, true);
    assert.ok(existsSync(path.join(s.outside, "secret.txt")));
  } finally {
    await s.client.close();
  }
});

test("stdio: a token from one file cannot delete another", async () => {
  const s = await start();
  try {
    writeFileSync(path.join(s.dir, "b.txt"), "b");
    const tok = tokenFrom((await s.call("delete_file", { path: "a.txt" })).text);
    const r = await s.call("delete_file", { path: "b.txt", confirm_token: tok });
    assert.equal(r.isError, true);
    assert.ok(existsSync(path.join(s.dir, "b.txt")));
    assert.ok(existsSync(path.join(s.dir, "a.txt")));
  } finally {
    await s.client.close();
  }
});
