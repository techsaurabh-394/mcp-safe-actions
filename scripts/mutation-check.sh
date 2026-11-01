#!/usr/bin/env bash
# Copyright (c) 2026 Saurabh Pathak. MIT License.
# Proves the tests protect the safety rules: it breaks the code on purpose, one bug at a time,
# and checks that the test suite FAILS for each one. Exits 1 if any bug slips through.
set -uo pipefail
cd "$(dirname "$0")/.."
BACKUP="$(mktemp -d)"
cp src/*.ts "$BACKUP"/
restore() { cp "$BACKUP"/*.ts src/; }
trap restore EXIT

missed=0
mutate () { # description, file, old text, new text
  restore
  python3 - "$2" "$3" "$4" <<'PY' || { echo "SETUP ERROR: could not apply: $1"; missed=$((missed+1)); return; }
import sys
f, old, new = sys.argv[1:4]
t = open(f, encoding="utf-8").read()
if old not in t:
    sys.exit(1)
open(f, "w", encoding="utf-8").write(t.replace(old, new, 1))
PY
  failing=$(npm test 2>&1 | grep -E "^# fail" | awk '{print $3}')
  if [ "${failing:-0}" -gt 0 ]; then echo "caught  ($failing failing)  $1"; else echo "MISSED                  $1"; missed=$((missed+1)); fi
}

mutate "a token can be used twice"                          src/store.ts    $'this.pending.delete(token);\n    return { ok: true };' "return { ok: true };"
mutate "token not bound to the arguments"                   src/store.ts    "entry.argsHash !== hashArgs(args)" "false"
mutate "token not bound to the tool"                        src/store.ts    "entry.tool !== tool ||" ""
mutate "tokens never expire"                                src/store.ts    "if (entry.expiresAt <= this.now()) {" "if (false) {"
mutate "approval prompt error runs the action (fail open)"  src/register.ts 'return text(`The approval prompt failed, so nothing was changed: ${msg}`, true); // fail closed' 'return run(args, "elicit", plan.summary, argsHash);'
mutate "declined prompt still runs the action"              src/register.ts 'if (answer.action === "accept" && answer.content?.approve === true) {' "if (true) {"
mutate "unticked approve box counts as yes"                 src/register.ts " && answer.content?.approve === true" ""
mutate "a model-supplied token skips the human prompt"      src/register.ts 'if (canElicit && mode !== "token") {' 'if (canElicit && mode !== "token" && !confirm_token) {'
mutate "mode elicit allows clients with no prompt"          src/register.ts 'if (mode === "elicit" && !canElicit) {' "if (false) {"
mutate "secret arguments leak into the audit log"           src/register.ts 'emit("executed", m, { summary, argsHash });' 'emit("executed", m, { summary: JSON.stringify(args), argsHash });'
mutate "a throwing policy fails open"                       src/register.ts 'auto = false; // fail closed' 'auto = true;'
mutate "any truthy policy value skips the human"            src/register.ts 'auto = (await cfg.autoApprove(args, plan, context)) === true;' 'auto = Boolean(await cfg.autoApprove(args, plan, context));'
mutate "mode elicit lets the policy skip the human"         src/register.ts 'if (cfg.autoApprove && mode !== "elicit" && mode !== "channel" && !gated) {' 'if (cfg.autoApprove && mode !== "channel" && !gated) {'
mutate "policy ignores the answer and always approves"      src/register.ts 'if (auto) {' 'if (true) {'
mutate "channel: any truthy approver value approves"        src/register.ts '])) === true;' '])) ? true : false;'
mutate "channel: approver error runs the action"            src/register.ts 'return text(`The approval channel failed, so nothing was changed: ${msg}`, true); // fail closed' 'return run(args, "channel", plan.summary, argsHash);'
mutate "channel: declined approver still runs the action"   src/register.ts 'if (ok) {' 'if (true) {'
mutate "channel: autoApprove can skip the approver"         src/register.ts 'mode !== "elicit" && mode !== "channel" && !gated) {' 'mode !== "elicit" && !gated) {'
mutate "webhook: HTTP error status counts as approval"      src/approver.ts 'if (!res.ok) return false;' ''
mutate "webhook: any truthy approved value approves"        src/approver.ts 'return body.approved === true;' 'return Boolean(body.approved);'
mutate "context: gated target still auto-approved"          src/register.ts 'if (cfg.autoApprove && mode !== "elicit" && mode !== "channel" && !gated) {' 'if (cfg.autoApprove && mode !== "elicit" && mode !== "channel") {'
mutate "context: resolver error fails open"                 src/register.ts $'        } catch {\n          contextOk = false;\n        }' $'        } catch {\n          contextOk = true;\n        }'
mutate "context: non-object resolver result fails open"     src/register.ts 'else contextOk = false;' 'else contextOk = true;'
mutate "context: gate never matches"                        src/register.ts 'gated = contextMatchesGate(context, cfg.gate);' 'gated = false;'
mutate "context: gate error fails open"                     src/register.ts $'        } catch {\n          gated = true;' $'        } catch {\n          gated = false;'
mutate "context: gate ignores the fields list"              src/register.ts 'const keys = gate.fields ?? Object.keys(ctx);' 'const keys = Object.keys(ctx);'
mutate "context: human is not shown the target"             src/register.ts 'plan = { ...plan, details: [...(plan.details ?? []), ...lines] };' ''
mutate "context: unknown target is not shown as unknown"    src/register.ts '"target: could not be identified"' '"ok"'
mutate "context: policy not given the resolved context"     src/register.ts 'cfg.autoApprove(args, plan, context)' 'cfg.autoApprove(args, plan)'
mutate "context: gate without resolve accepted"             src/register.ts 'if (cfg.gate && !cfg.resolve) {' 'if (false) {'
mutate "context: resolver result ignored for non-strings"   src/register.ts 'typeof ctx[k] === "string" && re.test' 're.test'

restore
echo
if [ "$missed" -eq 0 ]; then echo "All bugs were caught by the tests."; else echo "$missed bug(s) slipped through. Strengthen the tests."; exit 1; fi
