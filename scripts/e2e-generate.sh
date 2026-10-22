#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HOME/.nvm/nvm.sh"
nvm use 24.19.0 >/dev/null
cd "$ROOT"
unset TYPESAFE_API_KEY OPENAI_API_KEY JEV_API_KEY FIREWORKS_API_KEY BROWSERBASE_API_KEY BROWSERBASE_PROJECT_ID
export GATEWAY_CLIENT_TOKEN="${GATEWAY_CLIENT_TOKEN:-client-token-local}"

name="Generated adapter synthetic $(date +%s)"
created="$(node apps/cli/bin/pixie.js create "$name" --url http://127.0.0.1:4174/demo-portal --template eligibility-overview --allowed-origin http://127.0.0.1:4174 --json)"
automation_id="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))' <<<"$created")"
printf '%s\n' "$created"
printf 'automation=%s\n' "$automation_id"
printf 'recorded fixture=%s\n' "$ROOT/fixtures/recorded-eligibility.json"
node apps/cli/bin/pixie.js generate "$automation_id" --recording "$ROOT/fixtures/recorded-eligibility.json"
