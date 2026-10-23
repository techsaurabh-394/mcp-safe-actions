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

restore
echo
if [ "$missed" -eq 0 ]; then echo "All bugs were caught by the tests."; else echo "$missed bug(s) slipped through. Strengthen the tests."; exit 1; fi
