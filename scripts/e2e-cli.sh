#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
unset TYPESAFE_API_KEY OPENAI_API_KEY JEV_API_KEY FIREWORKS_API_KEY BROWSERBASE_API_KEY
export GATEWAY_URL=${GATEWAY_URL:-http://127.0.0.1:4180}
export GATEWAY_STUDIO_URL=${GATEWAY_STUDIO_URL:-http://127.0.0.1:5173}
PORTAL_ORIGIN=${GATEWAY_PORTAL_ORIGIN:-http://127.0.0.1:4174}
export GATEWAY_DEV_TOKEN=${GATEWAY_DEV_TOKEN:-dev-token-local}
export GATEWAY_CLIENT_TOKEN=${GATEWAY_CLIENT_TOKEN:-client-token-local}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
printf '{"apiUrl":"%s","studioUrl":"%s","portalOrigin":"%s","accountId":"acct_demo"}\n' \
  "$GATEWAY_URL" "$GATEWAY_STUDIO_URL" "$PORTAL_ORIGIN" > "$TMP/pixie.json"
pixie() {
  (cd "$TMP" && node "$ROOT/apps/cli/bin/pixie.js" "$@")
}

curl -fsS "$GATEWAY_URL/health" >/dev/null

echo "== create from eligibility template =="
create_json=$(pixie --json create "CLI eligibility E2E" \
  --url "$PORTAL_ORIGIN/demo-portal" --template eligibility-overview)
printf '%s\n' "$create_json"
automation_id=$(printf '%s' "$create_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "automation: $automation_id"

echo "== definition round trip =="
pixie definition get "$automation_id" -o "$TMP/definition.json"
pixie definition set "$automation_id" "$TMP/definition.json"

echo "== Studio test --follow =="
test_output=$(pixie test "$automation_id" --account acct_demo \
  --input '{"memberId":"DEMO-1001"}' --follow)
printf '%s\n' "$test_output"
printf '%s\n' "$test_output" | rg -q 'verification: accepted \(16/16 checks passed\)'
test_run_id=$(printf '%s\n' "$test_output" | sed -n 's/^test run \([^ ]*\) queued.*/\1/p' | head -n1)
test -n "$test_run_id"

echo "== publish =="
publish_json=$(pixie --json publish "$automation_id")
printf '%s\n' "$publish_json"
revision=$(printf '%s' "$publish_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])')

echo "== public invoke --follow =="
invoke_args=(invoke "$automation_id" --revision "$revision" --account acct_demo \
  --input '{"memberId":"DEMO-1002"}' --idempotency-key "e2e-cli-$automation_id" --follow)
first_invoke=$(pixie "${invoke_args[@]}")
printf '%s\n' "$first_invoke"
printf '%s\n' "$first_invoke" | rg -q 'verification: accepted \(16/16 checks passed\)'
first_run_id=$(printf '%s\n' "$first_invoke" | sed -n 's/^run \([^ ]*\) started;.*/\1/p' | head -n1)
test -n "$first_run_id"

echo "== replay same idempotency key =="
second_invoke=$(pixie "${invoke_args[@]}")
printf '%s\n' "$second_invoke"
second_run_id=$(printf '%s\n' "$second_invoke" | sed -n 's/^run \([^ ]*\) reused;.*/\1/p' | head -n1)
test "$second_run_id" = "$first_run_id"

echo "== CLI run listing =="
pixie runs --automation "$automation_id"
runs_json=$(pixie --json runs --automation "$automation_id")
printf '%s' "$runs_json" | python3 -c '
import json,sys
runs=json.load(sys.stdin)
assert len(runs) == 2, f"expected exactly the test and public run, got {len(runs)}"
assert {run["kind"] for run in runs} == {"test", "endpoint"}, runs
assert len({run["id"] for run in runs}) == 2
print(f"CLI run list: {len(runs)} distinct runs (test + endpoint)")
'

echo "== inspect runs with events =="
pixie run "$test_run_id" --events
pixie run "$first_run_id" --events

echo "== verify Studio sees CLI-created runs =="
studio_runs=$(curl -fsS "$GATEWAY_URL/studio/runs?automationId=$automation_id" \
  -H "authorization: Bearer $GATEWAY_DEV_TOKEN")
printf '%s\n' "$studio_runs"
printf '%s' "$studio_runs" | python3 -c '
import json,sys
runs=json.load(sys.stdin)
assert len(runs) == 2, f"expected 2 Studio runs, got {len(runs)}"
assert {run["id"] for run in runs} == set(sys.argv[1:]), runs
assert {run["kind"] for run in runs} == {"test", "endpoint"}, runs
print("Studio run history: test and endpoint run are both visible")
' "$test_run_id" "$first_run_id"

echo "E2E CLI flow passed: automation=$automation_id revision=$revision testRun=$test_run_id publicRun=$first_run_id"
