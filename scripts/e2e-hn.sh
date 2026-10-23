#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HOME/.nvm/nvm.sh"
nvm use 24.19.0 >/dev/null
cd "$ROOT"
unset TYPESAFE_API_KEY OPENAI_API_KEY JEV_API_KEY FIREWORKS_API_KEY BROWSERBASE_API_KEY BROWSERBASE_PROJECT_ID
export GATEWAY_DEV_TOKEN="${GATEWAY_DEV_TOKEN:-dev-token-local}"
export GATEWAY_CLIENT_TOKEN="${GATEWAY_CLIENT_TOKEN:-client-token-local}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cli() { node apps/cli/bin/pixie.js "$@"; }

created="$(cli create "Hacker News $(date +%s)" --url https://news.ycombinator.com/news --template hn-front-page --json)"
printf '%s\n' "$created"
automation_id="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))' <<<"$created")"
echo "automation: $automation_id"

echo "== definition round trip =="
cli definition get "$automation_id" -o "$tmp/definition.json"
cli definition set "$automation_id" "$tmp/definition.json"

echo "== scripted test --follow =="
test_output="$(cli test "$automation_id" --account acct_demo --input '{}' --follow)"
printf '%s\n' "$test_output"
printf '%s\n' "$test_output" | rg -q 'verification: accepted \([0-9]+/[0-9]+ checks passed\)'

echo "== generate from a zero-action recording =="
generated="$(cli generate "$automation_id" --recording "$ROOT/fixtures/recording-empty.json" --json)"
printf '%s\n' "$generated" >"$tmp/generated.json"
node -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(x.unsupported?.length||!x.source||!x.hash)throw Error(JSON.stringify(x.unsupported));console.log(`generated adapter hash=${x.hash}; unsupported=${x.unsupported.length}`)' "$tmp/generated.json"

echo "== script engine test --follow =="
script_test="$(cli test "$automation_id" --engine script --account acct_demo --input '{}' --follow)"
printf '%s\n' "$script_test"
printf '%s\n' "$script_test" | rg -q 'verification: accepted \([0-9]+/[0-9]+ checks passed\)'
printf '%s\n' "$script_test" | rg -q 'providerCalls=0'

echo "== publish =="
published="$(cli publish "$automation_id" --json)"
printf '%s\n' "$published"
revision="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).revision))' <<<"$published")"

echo "== REST invoke --follow =="
invoke_output="$(cli invoke "$automation_id" --revision "$revision" --account acct_demo --input '{}' --idempotency-key "hn-rest-$automation_id" --follow)"
printf '%s\n' "$invoke_output"
printf '%s\n' "$invoke_output" | rg -q 'verification: accepted \([0-9]+/[0-9]+ checks passed\)'
invoke_data="$(printf '%s\n' "$invoke_output" | sed -n 's/^data: //p' | tail -n1)"
printf '%s\n' "$invoke_data" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const data=JSON.parse(s);if(!Array.isArray(data.stories)||data.stories.length<3)throw Error("invoke result contains fewer than three stories");console.log("first three stories:");console.log(JSON.stringify(data.stories.slice(0,3),null,2))})'

echo "== MCP invoke and get_run =="
mcp_started="$(cli mcp call invoke --args "{\"automationId\":\"$automation_id\",\"accountId\":\"acct_demo\",\"input\":{},\"idempotencyKey\":\"hn-mcp-$automation_id\"}")"
printf '%s\n' "$mcp_started"
mcp_run_id="$(printf '%s\n' "$mcp_started" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const outer=JSON.parse(s);const result=JSON.parse(outer.content[0].text);console.log(result.runId??result.id)})')"
for _ in $(seq 1 50); do
  mcp_current="$(cli mcp call get_run --args "{\"automationId\":\"$automation_id\",\"runId\":\"$mcp_run_id\"}")"
  if printf '%s\n' "$mcp_current" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const outer=JSON.parse(s);const inner=JSON.parse(outer.content[0].text);process.exit(inner.result?.accepted===true&&inner.result.checks?.every(c=>c.passed)?0:1)})'; then
    break
  fi
  sleep 0.2
done
printf '%s\n' "$mcp_current"
printf '%s\n' "$mcp_current" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const outer=JSON.parse(s);const inner=JSON.parse(outer.content[0].text);if(inner.result?.accepted!==true||!inner.result.checks?.every(c=>c.passed))throw Error("MCP run was not accepted with all checks passed");console.log(`MCP verification accepted (${inner.result.checks.length}/${inner.result.checks.length} checks passed)`)})'

echo "E2E Hacker News passed: automation=$automation_id revision=$revision REST run accepted; MCP run=$mcp_run_id accepted"
