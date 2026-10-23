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
trap 'rm -rf "$tmp"; node apps/cli/bin/pixie.js portal label-variant --disabled >/dev/null 2>&1 || true' EXIT
cli() { node apps/cli/bin/pixie.js "$@"; }
assert_accepted() {
  node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!(x.verification?.accepted ?? x.accepted)) process.exit(1)' "$1"
}
wait_for_run() {
  local id="$1" output="$2" state=""
  for _ in $(seq 1 60); do
    cli run "$id" --json >"$output"
    state="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(x.run?.state ?? x.state ?? "")' "$output")"
    case "$state" in completed|needs_review|failed|cancelled) return 0 ;; esac
    sleep 1
  done
  echo "run $id did not reach a terminal state" >&2
  return 1
}

name="Generated adapter lifecycle $(date +%s)"
created="$(cli create "$name" --url http://127.0.0.1:4174/demo-portal --template eligibility-overview --allowed-origin http://127.0.0.1:4174 --json)"
automation_id="$(node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d).id))' <<<"$created")"
echo "$created"
echo "automation=$automation_id"

cli definition get "$automation_id" --output "$tmp/definition.json"
node -e 'const fs=require("fs");const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));d.adapterGenerator="recorded";fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$tmp/definition.json"
cli definition set "$automation_id" "$tmp/definition.json" --json

cli generate "$automation_id" --recording "$ROOT/fixtures/recorded-eligibility.json" --json >"$tmp/generated.json"
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.unsupported?.length)throw Error(JSON.stringify(x.unsupported));console.log(`generated hash=${x.hash}`)' "$tmp/generated.json"
cli test "$automation_id" --engine script --input '{"memberId":"DEMO-1001"}' --follow --json >"$tmp/script-test.json"
test_run_id="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(x.run.id)' "$tmp/script-test.json")"
echo "script test run=$test_run_id"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(x.verification?.accepted!==true||x.run?.metrics?.providerCalls!==0)process.exit(1);console.log(`test accepted ${x.verification.checks.filter(c=>c.passed).length}/${x.verification.checks.length}; providerCalls=${x.run.metrics.providerCalls}`)' "$tmp/script-test.json"

cli publish "$automation_id" --json
cli invoke "$automation_id" --revision 1 --input '{"memberId":"DEMO-1001"}' --follow --json >"$tmp/initial-invoke.json"
assert_accepted "$tmp/initial-invoke.json"
echo "initial invocation accepted"

cli portal label-variant --enabled
failed="$(cli invoke "$automation_id" --revision 1 --input '{"memberId":"DEMO-1001"}' --json)"
failed_run_id="$(node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d).id))' <<<"$failed")"
echo "label variant failure run=$failed_run_id"
wait_for_run "$failed_run_id" "$tmp/failed-run.json"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r=x.run??x;if(!["failed","needs_review"].includes(r.state)||r.metrics?.actions!==0)process.exit(1);console.log(`label variant failed before write; state=${r.state}; actions=${r.metrics.actions}`)' "$tmp/failed-run.json"

node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const s=x.source.replace(`{"label":"Member ID"}`,`{"label":"Subscriber ID"}`);if(s===x.source)throw Error("expected input locator was absent");fs.writeFileSync(process.argv[2],s)' "$tmp/generated.json" "$tmp/repair.mjs"
repair="$(cli repair "$automation_id" --run "$failed_run_id" --source "$tmp/repair.mjs" --json)"
echo "$repair"
repair_id="$(node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d).id))' <<<"$repair")"
cli repairs "$automation_id" --json
node -e 'const x=JSON.parse(process.argv[1]);if(x.state!=="awaiting_approval"||x.gates?.length!==3||x.gates.some(g=>!g.passed))process.exit(1);console.log("frozen_suite, replay, verifier: passed")' "$repair"
cli approve "$repair_id" --json
cli invoke "$automation_id" --revision 1 --input '{"memberId":"DEMO-1001"}' --follow --json >"$tmp/repaired-invoke.json"
assert_accepted "$tmp/repaired-invoke.json"
echo "repaired invocation accepted"
cli rollback "$automation_id" --json
echo "generated-adapter lifecycle completed"
