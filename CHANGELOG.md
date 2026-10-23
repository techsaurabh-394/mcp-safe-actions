# Changelog

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
