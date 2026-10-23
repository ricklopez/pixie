#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HOME/.nvm/nvm.sh"
nvm use 24.19.0 >/dev/null
cd "$ROOT"
unset TYPESAFE_API_KEY OPENAI_API_KEY JEV_API_KEY FIREWORKS_API_KEY BROWSERBASE_API_KEY BROWSERBASE_PROJECT_ID RENDER_API_KEY
export GATEWAY_DEV_TOKEN="${GATEWAY_DEV_TOKEN:-dev-token-local}"
export GATEWAY_CLIENT_TOKEN="${GATEWAY_CLIENT_TOKEN:-client-token-local}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"; node apps/cli/bin/pixie.js portal label-variant --disabled >/dev/null 2>&1 || true' EXIT
cli() { node apps/cli/bin/pixie.js "$@"; }

name="Render publication $(date +%s)"
created="$(cli create "$name" --url http://127.0.0.1:4174/demo-portal --template eligibility-overview --allowed-origin http://127.0.0.1:4174 --json)"
automation_id="$(node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d).id))' <<<"$created")"
cli definition get "$automation_id" --output "$tmp/definition.json"
node -e 'const fs=require("fs"),p=process.argv[1],d=JSON.parse(fs.readFileSync(p,"utf8"));d.adapterGenerator="recorded";fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$tmp/definition.json"
cli definition set "$automation_id" "$tmp/definition.json" --json >/dev/null
cli generate "$automation_id" --recording "$ROOT/fixtures/recorded-eligibility.json" --json >"$tmp/generated.json"
generated_hash="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(x.unsupported?.length)throw Error(JSON.stringify(x.unsupported));process.stdout.write(x.hash)' "$tmp/generated.json")"
echo "generated adapter hash=$generated_hash"
cli test "$automation_id" --engine script --input '{"memberId":"DEMO-1001"}' --follow --json >"$tmp/test.json"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(x.verification?.accepted!==true||x.run?.metrics?.providerCalls!==0)throw Error("script test did not pass with zero provider calls");console.log(`script test accepted ${x.verification.checks.filter(c=>c.passed).length}/${x.verification.checks.length}; providerCalls=${x.run.metrics.providerCalls}`)' "$tmp/test.json"

cli publish "$automation_id" --json >"$tmp/published.json"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(x.activation?.state!=="active"||x.artifact?.reused!==false)throw Error(JSON.stringify(x));console.log(`published artifact=${x.artifact.hash}; activation=${x.activation.state}`)' "$tmp/published.json"
cli publish "$automation_id" --json >"$tmp/reused.json"
node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")),b=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));if(b.artifact?.reused!==true||a.artifact?.hash!==b.artifact?.hash)throw Error(JSON.stringify(b));console.log(`republish reused artifact=${b.artifact.hash}`)' "$tmp/published.json" "$tmp/reused.json"

repo="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.repository)' "$tmp/published.json")"
cli ops "$repo" --json >"$tmp/ops-before.json"
old_adapter="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(x[0].adapterRevision))' "$tmp/ops-before.json")"
cli draft "$automation_id" --json >"$tmp/draft.json"
draft_id="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.id)' "$tmp/draft.json")"
cli test "$draft_id" --engine script --input '{"memberId":"DEMO-1001"}' --follow --json >"$tmp/draft-test.json"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(x.verification?.accepted!==true)throw Error("baseline draft test failed");console.log("draft baseline test accepted")' "$tmp/draft-test.json"
cli portal label-variant --enabled
if cli publish "$draft_id" --json >"$tmp/failed-publish.json"; then
  echo "expected the variant smoke test to fail" >&2
  exit 1
fi
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(x.activationState!=="failed"||!x.smokeRunId)throw Error(JSON.stringify(x));console.log(`label-variant smoke failed; activation=${x.activationState}; run=${x.smokeRunId}`)' "$tmp/failed-publish.json"
cli ops "$repo" --json >"$tmp/ops-after.json"
new_adapter="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(x[0].adapterRevision))' "$tmp/ops-after.json")"
if [[ "$old_adapter" != "$new_adapter" ]]; then
  echo "active binding changed after failed smoke ($old_adapter -> $new_adapter)" >&2
  exit 1
fi
echo "failed smoke preserved active adapter revision=$new_adapter"
echo "publication E2E completed"
