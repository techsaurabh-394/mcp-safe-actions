# Security model

## The problem
An AI agent can call a tool that deletes data. Asking the model to "confirm first" is not a control: the model decides whether to ask, and a prompt-injected model can decide not to.

## What mcp-safe-actions enforces
| Threat | Protection |
|---|---|
| Model calls the tool and it just runs | `execute()` is unreachable until approval |
| Model tries to approve its own action (elicitation) | The approval prompt is sent to the human through the client; the model gets only the result |
| Model guesses or invents a token | Tokens are 128-bit random, stored server-side, and checked |
| Model reuses a token | Tokens are consumed on first use |
| Model swaps the arguments after a preview | Tokens are bound to a hash of the exact arguments and the tool name |
| Old token used later | Tokens expire (default 5 minutes) |
| Prompt UI crashes or the client errors | Fails closed: no execution |
| Memory growth from many previews | Pending tokens are capped; oldest dropped first |
| Secrets in the audit log | Only a short summary and an argument hash are logged |

## What it can't protect against
1. **Token mode has no proof of a human.** In the fallback, the *model* carries the token. A model that doesn't ask the user can call twice. Treat token mode as friction plus a log. Use `mode: "elicit"` when a human gate is mandatory.
2. **A compromised or malicious client.** If the client auto-approves elicitation prompts, the human gate is gone. Elicitation is only as trustworthy as the client UI.
3. **Preview/execute drift (TOCTOU).** If the world changes between preview and execute, the user approved something different. Re-validate inside `execute()`.
4. **A dishonest preview.** If your `preview()` describes a different action than `execute()` performs, the approval is meaningless. Keep them in lockstep and test them together.
5. **Everything outside the gated tools.** This library doesn't sandbox your server, restrict filesystem or network access, or protect tools you didn't wrap.

## Recommendations
- Use `risk: "destructive"` for deletes and overwrites; the tool is annotated so clients can show warnings.
- Write previews a non-technical person can understand: what, which one, how big, can it be undone.
- Re-check preconditions in `execute()` (the file still exists, still the same size).
- For high-impact actions, require elicitation (`mode: "elicit"`).
- Keep the audit log somewhere the agent can't write to.
- Validate inputs (for example block path traversal) in `preview()` so bad input fails before any prompt is shown.

## Reporting a vulnerability
Email saurabhpathak394@gmail.com with steps to reproduce. Please allow a few days to fix before publishing details.

---
Maintained by **Saurabh Pathak** · [GitHub](https://github.com/techsaurabh-394) · [Buy me a coffee](https://buymeacoffee.com/saurabhdev)
