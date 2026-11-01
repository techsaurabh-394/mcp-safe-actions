# Usage

## Install
```bash
npm install github:techsaurabh-394/mcp-safe-actions   # or: npm install mcp-safe-actions (after npm publish)
```

## Basic tool
See the [README quick start](../README.md#quick-start).

## Options
| Option | Default | Meaning |
|---|---|---|
| `risk` | `"destructive"` | `"destructive"` sets `destructiveHint: true`; `"write"` marks the tool as changing data without destroying it |
| `mode` | `"auto"` | `"auto"`, `"elicit"` (human prompt required), `"token"` or `"channel"` (your `approver` decides) |
| `approver` | none | Required for `mode: "channel"`. `(req) => boolean`; only an exact `true` approves |
| `store` | new `ApprovalStore()` | Share one store across tools, or tune `ttlMs` and `maxPending` |
| `audit` | none | A function receiving each event, or `fileAudit("path.jsonl")` |
| `annotations` | `{}` | Overrides merged into the tool annotations |
| `approvalTimeoutMs` | 300000 | How long to wait for the human; a timeout counts as "not approved" |
| `autoApprove` | none | `(args, plan) => boolean`. Only an exact `true` runs the call without asking. Ignored in `mode: "elicit"` |

## Audit events
```json
{"time":"2026-10-23T09:12:03.411Z","tool":"delete_file","event":"previewed","mode":"elicit","summary":"Permanently delete \"report.pdf\"","argsHash":"3f1c..."}
```
Events: `previewed`, `approved`, `declined`, `executed`, `failed`, `rejected`, `blocked`, `auto-approved`. In channel mode the audit `mode` is `channel`. Raw arguments are never logged.

## Auto-approve low-risk calls (policy)
```ts
registerConfirmedTool(server, {
  /* ... */
  autoApprove: ({ path }) => path.startsWith("scratch/"), // everything else still asks a human
});
```
Rules, all covered by tests: only an exact `true` skips the human; a throw or any other value (`"yes"`, `1`) asks as usual; `mode: "elicit"` ignores the policy because a human must always decide; the call is audited as `auto-approved` with mode `policy`. Keep the policy narrow, since it is a deliberate bypass of the approval step. Never base it on text the model wrote.

## Headless servers: approval channel (webhook)
For servers with no MCP client UI (a cron job, a background agent), send the plan to a service that can ask a person.
```ts
import { registerConfirmedTool, webhookApprover } from "mcp-safe-actions";

registerConfirmedTool(server, {
  /* ... */
  mode: "channel",
  approver: webhookApprover("https://approvals.example.com/ask", {
    headers: { authorization: `Bearer ${process.env.APPROVAL_KEY}` },
    timeoutMs: 10 * 60_000,
  }),
});
```
The request body is `{ tool, summary, details, argsHash }`. Your endpoint may hold the request open until someone clicks approve in Slack, a ticket or a dashboard, then answer `{ "approved": true }` with HTTP 2xx. **Anything else is "not approved"**: an error, another status, other JSON, a timeout, or `{ "approved": "true" }`. `autoApprove` is ignored in this mode.

A plain Slack *incoming* webhook cannot return an answer, so it cannot be used directly. Put a small service in between that posts to Slack and waits for the button click.
Do not log the endpoint secret, and make sure only your server can reach it: whoever controls the endpoint controls approval.

## Shared store and shorter tokens
```ts
import { ApprovalStore } from "mcp-safe-actions";
const store = new ApprovalStore({ ttlMs: 60_000, maxPending: 20 });
registerConfirmedTool(server, { /* ... */ store });
```

## Writing a good preview
- Say what will change in plain words, name the exact item, and say whether it can be undone.
- Do the lookups in `preview()` (does the file exist, how big is it) so you fail early with a clear error.
- Never change state in `preview()`.

## Re-check inside execute
```ts
execute: ({ path }) => {
  const st = statSync(path);               // still there? still a file?
  if (!st.isFile()) throw new Error("no longer a file");
  rmSync(path);
  return { content: [{ type: "text", text: "Deleted" }] };
}
```

## Testing your own tools
Use the SDK's in-memory transport. A client that sets `capabilities: { elicitation: {} }` and handles `ElicitRequestSchema` simulates a human; a client with `capabilities: {}` exercises the token fallback.
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const client = new Client({ name: "t", version: "1" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
const [c, s] = InMemoryTransport.createLinkedPair();
await server.connect(s);
await client.connect(c);
// call the tool and assert that nothing changed
```
`test/helpers.ts` in this repo is a complete example.

## Behaviour reference
| Situation | Result |
|---|---|
| Elicitation accepted and ticked | `execute()` runs |
| Elicitation declined, cancelled or unticked | Nothing runs, the model is told not to retry |
| Elicitation errors | Nothing runs, error returned |
| `mode: "elicit"` and no client support | Refused, no token issued |
| Token mode, no token | Preview plus a one-time token, nothing runs |
| Token mode, valid token and same arguments | `execute()` runs once |
| Reused, expired, unknown or mismatched token | Nothing runs, clear reason returned |

---
Maintained by **Saurabh Pathak** · [GitHub](https://github.com/techsaurabh-394) · [Buy me a coffee](https://buymeacoffee.com/saurabhdev)
