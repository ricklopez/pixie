#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HOME/.nvm/nvm.sh"
nvm use 24.19.0 >/dev/null
cd "$ROOT"
unset TYPESAFE_API_KEY OPENAI_API_KEY JEV_API_KEY FIREWORKS_API_KEY BROWSERBASE_API_KEY BROWSERBASE_PROJECT_ID
export GATEWAY_CLIENT_TOKEN="${GATEWAY_CLIENT_TOKEN:-client-token-local}"

name="MCP synthetic $(date +%s)"
created="$(node apps/cli/bin/pixie.js create "$name" --url http://127.0.0.1:4174/demo-portal --template eligibility-overview --allowed-origin http://127.0.0.1:4174 --json)"
automation_id="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))' <<<"$created")"
printf '%s\n' "$created"
definition_file="$(mktemp)"
trap 'rm -f "$definition_file"' EXIT
node apps/cli/bin/pixie.js definition get "$automation_id" -o "$definition_file"
node apps/cli/bin/pixie.js definition set "$automation_id" "$definition_file"
node apps/cli/bin/pixie.js test "$automation_id" --account acct_demo --input '{"memberId":"DEMO-1001"}' --follow
node apps/cli/bin/pixie.js publish "$automation_id"
node apps/cli/bin/pixie.js mcp call list_operations --args '{}'
started="$(node apps/cli/bin/pixie.js mcp call invoke --args "{\"automationId\":\"$automation_id\",\"accountId\":\"acct_demo\",\"input\":{\"memberId\":\"DEMO-1002\"},\"idempotencyKey\":\"mcp-e2e-$automation_id\"}")"
printf '%s\n' "$started"
run_id="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);console.log(x.runId??JSON.parse(x.content?.[0]?.text??"{}").runId)})' <<<"$started")"
for _ in $(seq 1 50); do
  current="$(node apps/cli/bin/pixie.js mcp call get_run --args "{\"automationId\":\"$automation_id\",\"runId\":\"$run_id\"}")"
  printf '%s\n' "$current"
  if node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const outer=JSON.parse(s);const inner=JSON.parse(outer.content[0].text);process.exit(inner.result?.accepted===true?0:1)})' <<<"$current"; then exit 0; fi
  sleep 0.2
done
echo "MCP run did not reach an accepted result" >&2
exit 1
