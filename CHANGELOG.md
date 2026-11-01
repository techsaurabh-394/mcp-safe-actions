# Changelog

## 1.2.0
- `autoApprove(args, plan)` policy: let narrowly-defined low-risk calls run without a prompt; everything else still asks. Only an exact `true` counts, a throwing policy fails closed, and `mode: "elicit"` ignores it
- New audit event `auto-approved` (audit mode `policy`)
- `mode: "channel"` with an `approver` function and a `webhookApprover(url)` helper, for headless servers. Approves only on an exact `true` (webhook: HTTP 2xx and `{"approved": true}`); errors, other values and timeouts mean not approved. `autoApprove` is ignored in this mode
- Audit mode `channel`
- 15 new tests (64 total) and 10 new mutation checks (20 total, all caught)

## 1.1.0
- Approval prompt timeout (`approvalTimeoutMs`), counted as "not approved"
- `confirm_token` is now a reserved input name (clear error at registration)
- Example server hardened: symlinked folders and symlink targets can't be used to escape; regular files only; re-check after approval
- Test suite grown from 23 to 49 tests: edge cases, property tests, concurrency, real stdio end-to-end
- `npm run coverage` and `npm run mutation` (10 deliberate bugs, all caught); a weak audit test found by the mutation check was fixed
- Animated README assets, GitHub Actions overview, CODEOWNERS, CITATION.cff

## 1.0.0
- `registerConfirmedTool`: preview, then approval via MCP elicitation, with a one-time token fallback
- Modes: `auto`, `elicit`, `token`
- `ApprovalStore`: single-use, argument-bound, expiring tokens with a pending cap
- Audit events and `fileAudit` (JSONL, no raw arguments)
- Example server and runnable demo
