#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HOME/.nvm/nvm.sh"
nvm use 24.19.0 >/dev/null
cd "$ROOT"
unset TYPESAFE_API_KEY OPENAI_API_KEY JEV_API_KEY FIREWORKS_API_KEY BROWSERBASE_API_KEY BROWSERBASE_PROJECT_ID
export GATEWAY_CLIENT_TOKEN="${GATEWAY_CLIENT_TOKEN:-client-token-local}"

name="Contracts synthetic $(date +%s)"
created="$(node apps/cli/bin/pixie.js create "$name" --url http://127.0.0.1:4174/demo-portal --template eligibility-overview --allowed-origin http://127.0.0.1:4174 --json)"
automation_id="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))' <<<"$created")"
repo="$automation_id"
printf '%s\n' "$created"
definition_file="$(mktemp)"
trap 'rm -f "$definition_file"' EXIT

node apps/cli/bin/pixie.js definition get "$automation_id" -o "$definition_file"
node apps/cli/bin/pixie.js definition set "$automation_id" "$definition_file"
node apps/cli/bin/pixie.js test "$automation_id" --account acct_demo --input '{"memberId":"DEMO-1001"}' --follow
node apps/cli/bin/pixie.js publish "$automation_id"

draft1="$(node apps/cli/bin/pixie.js draft "$automation_id" --json)"
draft1_id="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))' <<<"$draft1")"
node apps/cli/bin/pixie.js definition get "$draft1_id" -o "$definition_file"
node -e 'const fs=require("node:fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.outputs.push({name:"optionalNote",type:"string",required:false,description:"Optional note",extractor:{kind:"labelValue",checkpointId:"benefits-overview",label:"Optional note"}});fs.writeFileSync(p,JSON.stringify(d,null,2))' "$definition_file"
node apps/cli/bin/pixie.js definition set "$draft1_id" "$definition_file"
node apps/cli/bin/pixie.js test "$draft1_id" --account acct_demo --input '{"memberId":"DEMO-1001"}' --follow
node apps/cli/bin/pixie.js publish "$draft1_id"

draft2="$(node apps/cli/bin/pixie.js draft "$draft1_id" --json)"
draft2_id="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))' <<<"$draft2")"
node apps/cli/bin/pixie.js definition get "$draft2_id" -o "$definition_file"
node -e 'const fs=require("node:fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.outputs=d.outputs.filter(x=>x.name!=="deductibleNetwork");fs.writeFileSync(p,JSON.stringify(d,null,2))' "$definition_file"
node apps/cli/bin/pixie.js definition set "$draft2_id" "$definition_file"
node apps/cli/bin/pixie.js diff "$draft2_id"
node apps/cli/bin/pixie.js test "$draft2_id" --account acct_demo --input '{"memberId":"DEMO-1001"}' --follow
node apps/cli/bin/pixie.js publish "$draft2_id"

node apps/cli/bin/pixie.js invoke --repo "$repo" --method get --version 1 --account acct_demo --input '{"memberId":"DEMO-1002"}' --follow
node apps/cli/bin/pixie.js invoke --repo "$repo" --method get --version 2 --account acct_demo --input '{"memberId":"DEMO-1002"}' --follow
