#!/usr/bin/env bash
# Drives the developer half of the demo against a running gateway API: create -> review -> test -> publish.
# Prints the automation id and revision, then invokes the published endpoint from scripts/demo-client.mjs.
# Recording is skipped here because it needs an interactive browser; the studio UI covers that path.
set -euo pipefail
A=${GATEWAY_URL:-http://127.0.0.1:4180}
DEV=${GATEWAY_DEV_TOKEN:-dev-token-local}
MEMBER=${1:-DEMO-1002}
auth=(-H "authorization: Bearer $DEV" -H "content-type: application/json")

created=$(curl -sf "$A/studio/automations" "${auth[@]}" -d '{"name":"Eligibility overview","startUrl":"http://127.0.0.1:4174/demo-portal","template":"eligibility-overview"}')
id=$(printf '%s' "$created" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
printf '%s' "$created" | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["definition"]))' >"/tmp/gateway-def-$id.json"
curl -sf -X PUT "$A/studio/automations/$id/definition" "${auth[@]}" --data-binary "@/tmp/gateway-def-$id.json" >/dev/null
echo "automation $id reviewed"

test=$(curl -sf "$A/studio/automations/$id/test" "${auth[@]}" -d '{"accountId":"acct_demo","input":{"memberId":"DEMO-1001"}}')
tid=$(printf '%s' "$test" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
for _ in $(seq 1 120); do
  state=$(curl -sf "$A/studio/runs/$tid" -H "authorization: Bearer $DEV" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["state"])')
  case $state in completed | needs_review | failed | awaiting_auth | cancelled) break ;; esac
  sleep 1
done
echo "test run $tid -> $state"
curl -sf "$A/studio/runs/$tid" -H "authorization: Bearer $DEV" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("metrics:",json.dumps(d["run"]["metrics"]));print("verification:",json.dumps(d.get("verification")))' | cut -c1-600
[ "$state" = completed ] || exit 1

rev=$(curl -sf "$A/studio/automations/$id/publish" -H "authorization: Bearer $DEV" -X POST | python3 -c 'import sys,json;print(json.load(sys.stdin)["revision"])')
echo "published $id revision $rev"
node "$(dirname "$0")/demo-client.mjs" "$id" "$rev" "$MEMBER"
