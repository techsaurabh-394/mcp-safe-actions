# Testing

```bash
npm test            # build, then 49 tests
npm run coverage    # same, with Node's built-in coverage report
npm run mutation    # break the code on purpose; the tests must notice
npm run demo        # watch both approval flows
```

## What the 49 tests cover
| Group | File | What it proves |
|---|---|---|
| Approval flows | `test/safe-actions.test.ts` | Elicitation approve, decline, cancel, unticked box; failure of the prompt fails closed; token flow (preview, approve, reuse, wrong arguments, invented, expired); modes; error paths; tool metadata |
| Edge cases | `test/edge.test.ts` | Reserved name, prompt timeout, `form` vs `url` elicitation capabilities, argument order, unicode, 5 concurrent previews, **two simultaneous uses of one token run once**, cross-tool tokens with a shared store, custom annotations, token cap, **secret values never reach the audit log** |
| Store, audit, hashing | `test/store.test.ts`, `test/audit-and-hash.test.ts` | Single-use, binding, expiry boundary, cap and eviction, 1000 unique random tokens, JSONL audit file, audit never throws on a bad path, **property tests** (300 random argument objects: hash ignores key order, changes when values change) |
| Real process, real stdio | `test/stdio.e2e.test.ts` | Spawns the example server as a child process and talks MCP over stdio: preview leaves the file alone, token approval deletes it, audit log written, **path traversal blocked, symlinked-folder escape blocked, folders and symlinks refused, token for one file can't delete another** |

Human behaviour is simulated by an in-memory MCP client that sets `capabilities: { elicitation: {} }` and answers prompts (accept, decline, cancel, error, never answer).

## Coverage
Library source (`src/`): **100% of lines and functions**; branches 100% (`audit`, `register`) and 96.8% (`store`).
Run `npm run coverage` for the current numbers.

## Mutation check: do the tests actually protect the rules?
High coverage only shows code ran, not that a bug would be caught. `scripts/mutation-check.sh` injects **10 deliberate bugs**, one at a time, runs the suite, and requires it to fail each time:

| Injected bug | Caught |
|---|---|
| A token can be used twice | yes |
| Token not bound to the arguments | yes |
| Token not bound to the tool | yes |
| Tokens never expire | yes |
| A failing approval prompt runs the action (fail open) | yes |
| A declined prompt still runs the action | yes |
| An unticked approve box counts as yes | yes |
| A model-supplied token skips the human prompt | yes |
| `mode: "elicit"` allows clients with no prompts | yes |
| Secret arguments leak into the audit log | yes |

**An honest note:** the first version of the audit-leak test was too weak. Injecting the bug did not fail any test, so the check reported it as missed. The test was rewritten to use a real secret value (`sk-SECRET-123`) and now fails when the bug is injected. This is exactly why the mutation check exists.

## Not covered
- Real MCP clients such as Claude Desktop: their approval UI can't be automated here. Try the example server with your client and a throwaway folder.
- Platforms other than Linux and macOS filesystems (the symlink tests use POSIX symlinks).

## Add tests for your own tools
See [USAGE.md](USAGE.md#testing-your-own-tools) and copy `test/helpers.ts`.

---
Maintained by **Saurabh Pathak** · [GitHub](https://github.com/techsaurabh-394) · [Buy me a coffee](https://buymeacoffee.com/saurabhdev)
