#!/usr/bin/env bash
# Truthful verification: runs each check, records real exit codes, prints a table. Exit code 1 if any FAIL.
cd "$(dirname "$0")/.." || exit 2
declare -a NAMES RESULTS
run() { local name="$1"; shift; local out; out=$("$@" 2>&1); local rc=$?; NAMES+=("$name"); if [ $rc -eq 0 ]; then RESULTS+=("PASS"); else RESULTS+=("FAIL"); echo "---- $name (exit $rc) ----"; echo "$out" | tail -25; fi; }
skip() { NAMES+=("$1"); RESULTS+=("SKIP ($2)"); }

run "install (frozen lockfile)" pnpm install --frozen-lockfile
for pkg in core db workers mcp-server; do run "typecheck @ros/$pkg" pnpm --filter "@ros/$pkg" typecheck; done
run "typecheck @ros/e2e" pnpm --filter @ros/e2e typecheck
if [ "${VERIFY_WEB:-0}" = "1" ]; then run "typecheck @ros/web" pnpm --filter @ros/web typecheck; else skip "typecheck @ros/web" "set VERIFY_WEB=1"; fi
run "tests (all packages)" pnpm -r test
if [ "${VERIFY_WEB:-0}" = "1" ]; then run "next build" pnpm --filter @ros/web build; else skip "next build" "set VERIFY_WEB=1"; fi
if [ -n "${DATABASE_URL:-}${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then NAMES+=("live Supabase conformance"); RESULTS+=("SEE: pnpm --filter @ros/db test output above"); else skip "live Supabase" "no credentials"; fi
skip "live n8n execution" "never run; workflows structure-checked only"
skip "live Gmail / ATS submit / push" "no credentials; unit-tested with mocks"

echo; printf '%-34s %s\n' "CHECK" "RESULT"; printf '%-34s %s\n' "-----" "------"
fail=0
for i in "${!NAMES[@]}"; do printf '%-34s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"; [[ "${RESULTS[$i]}" == FAIL* ]] && fail=1; done
exit $fail
