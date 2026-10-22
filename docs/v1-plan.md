# Pixie v1: verified APIs for authenticated browser workflows

Status: proposed, planning only. No implementation, paid experiments, infrastructure provisioning, or merge is authorized.
Owner: Rick Lopez. Devin reviews feasibility and sequencing only until Rick explicitly authorizes implementation.

## Promise and scope

Describe and demonstrate a repeatable browser operation, review its contract, generate and test a script, publish
REST/OpenAPI and MCP interfaces, and inspect results. Agents assist authoring and reviewed repair; normal scripts
and authentication handoffs do not call a model. Initial customers are developers integrating business portals
without suitable APIs. Prioritize reads; support writes only with explicit target guards and verifiable outcomes.
GraphQL, automatic repair promotion, automated MFA retrieval, and general multiplayer editing are deferred.

CLI first: initialize a project, define an operation, connect an account, generate and test. Open Developer Studio
for live-session handoff, contract review, evidence, publishing, API exploration, and repair approval. CLI syntax
in previews is illustrative until implementation is approved. A clickable concept is not the product implementation.

## Deployment decision: local first, Render + Browserbase

Selected v1 target: Render hosts the Pixie API and execution worker; Browserbase hosts cloud browser sessions
and saved login contexts. Use a durable database for run checkpoints, operation revisions, deployment status,
connection references, and ownership leases. Provider compatibility and restart recovery remain acceptance gates.
Convex is not part of the selected v1 deployment. Keep the operation bundle independent of the hosting adapter.

The open-source edition uses the operator's own Render API key and Browserbase API key, plus the Browserbase
project ID and Render workspace/resource settings required by the providers. The operator owns those accounts
and pays their infrastructure charges directly. Connect providers once; subsequent verified revisions publish
through one button. Initial paid resource provisioning requires an explicit resource/cost review.

Keep provider keys in local environment or an OS credential store during setup; configure necessary runtime secrets
on the server. Never put keys in frontend bundles, browser storage, source control, logs, exports, or generated API
documentation. The Render management key belongs to the deployment controller, not ordinary execution workers.
Provider keys are separate from caller authentication and website login/MFA. The clickable demo accepts no real keys.

### One-button publish contract

1. Run the API and script locally, review the Studio browser/evidence view, and pass the frozen acceptance suite.
2. Select the configured Render + Browserbase target. Preflight checks credentials, permissions, dependencies,
   hosted reachability, and connection readiness. Cloud login may require a separate human handoff; never silently
   upload a local Chrome profile or assume local login transfers to Browserbase.
3. Click **Publish API**. Package the exact tested script, contract, checks, and pinned dependencies as an immutable
   revision; deploy it into the operator's Render runtime. Reuse that runtime across operations rather than provision
   a server for every endpoint. Generated/user scripts need isolation, resource bounds, and scoped secrets.
4. Run a hosted smoke test against the authorized Browserbase connection. Show preflight, deployment, test, and
   activation progress. Authentication required pauses publication with an actionable handoff; it is not success.
5. Activate only after the hosted checks pass. Return the hosted endpoint, OpenAPI docs, and MCP interface. Failed
   deployment or smoke test preserves the previous active revision; retry is idempotent. Rollback selects a prior
   immutable revision and does not undo external writes.

For long-running calls return a run ID/status and a guarded handoff link when needed. Persist pause/resume state
outside worker memory. Demonstrate the hosted API still works with the local CLI stopped. Render deployment does
not itself make browser execution durable; test restart cleanup, exclusive ownership, and safe continuation.

### Publication acceptance gates

- Missing/invalid provider configuration blocks deployment with an actionable error and no secret exposure.
- Local tests fail: Publish stays disabled. Hosted tests fail: no activation and old revision stays available.
- Repeated Publish does not duplicate resources or revisions. A crash mid-deploy can reconcile actual provider state.
- Local and hosted execution share the same contract and tested artifact; hosted differences are reported explicitly.
- Authenticated REST/OpenAPI and MCP work after the local process exits; context reuse and human handoff still work.
- Provider revocation, resource teardown, rollback, and secret rotation have explicit supported procedures.

## Three persistence layers

| Layer | Responsibility |
|---|---|
| Browserbase Context | Saved cookies/profile data per tenant + authorized connection/login |
| Browserbase live session | Open page during bounded execution and human intervention |
| Pixie run record | Durable operation/revision, checkpoint, intent/outcome, controller, generation, deadline, heartbeat |

Keep contexts separate across tenants and logins; authorize every connection and run access. Serialize runs per
login in v1, using one context writer. Wait for context persistence/sync before starting a successor session.
Saved state may expire or be revoked by the portal. Context failure must not silently downgrade an authenticated
run to the wrong or anonymous account. Report connection setup/authentication required.

Credential changes, disconnects, or explicit revocation invalidate the saved context and terminate/restrict relevant
live sessions. Define retention and deletion policy before launch. Persistent state is sensitive even without passwords.

## Handoff protocol

1. Start a run with the saved context and bounded keep-alive session; check authenticated account identity.
2. If login/MFA is needed, persist `awaiting_user` with reason and deadline. Return run ID and a permission-checked
   Pixie run-page link through REST/MCP. Keep polling/webhook behavior explicit; do not leave an HTTP call open indefinitely.
3. Watch is read-only. Take control requires authorization and atomically changes the control generation. Cancel/fence
   active automation and wait for acknowledgment before issuing interactive access. A UI shield alone is insufficient.
4. One authorized human owns control. Reject stale-generation requests; viewers cannot also drive. Audit transitions
   without credentials, OTPs, page contents, or sensitive links. Revoke/expire obsolete interactive access on resume;
   verify Browserbase enforcement rather than assuming a shield revokes a copied URL.
5. Only the controller may Resume; the server checks fresh ownership/generation, restores automation ownership,
   re-observes the current page, verifies account identity, and resumes from a safe checkpoint. Human actions may
   have changed business state. Reconcile any pending write before continuation. Resume grants no extra permissions.
6. Stop cancels further actions and releases the browser. Results already durably recorded remain. If ownership cannot
   be safely transferred or cancellation cannot be established, end the session rather than permit concurrent drivers.

No model-based repair for expired authentication. A changed selector goes to the separate repair workflow. A changed
business rule requires contract review. Uncertain outcomes remain explicit; neither authentication nor repair justifies
blind write replay.

## Security, deadlines, and recovery

Server-side Browserbase credentials and CDP connection only. Obtain bounded live-view access per authorized viewer;
never publish raw control URLs in API output, logs, exports, or chat. Pixie handoff pages require authentication and
run/tenant authorization. Recording off by default for authenticated workflows; any debugging capture needs explicit
scope, sanitization, retention, and access policy. Human login/MFA first; no credentials collected in the demo.

Set execution, idle-human, and total-session deadlines. Heartbeat active work and recover stale workers on restart.
If the browser survived, reacquire exclusive ownership and revalidate before continuation; otherwise terminate as
interrupted/needs_review and clean up. Do not restart writes automatically. Track paid-session cleanup and verify
release after completion, Stop, timeout, failed startup, and worker crash. Context persistence is not run recovery.

## Early acceptance gates

- Real Browserbase compatibility for the selected generated-script runtime and Ultrafast integration; a controlled
  hosted synthetic portal must be reachable by Browserbase. Localhost alone is not reachable from a cloud browser.
- Login and synthetic MFA via human control; same run resumes without losing its identity or duplicating work.
- Close the first browser; start a distinct session with the saved context and verify login reuse and account identity.
- Expire authentication and prove a new handoff works. Revoke/reset context and prove reuse is no longer possible.
- Race Take control against an in-flight action; no automation commands are newly issued after acknowledged takeover.
  Account for actions already dispatched; prove they settle before human access. Test stale Resume, duplicate actions,
  two viewers, unauthorized/cross-tenant access, and obsolete interactive URLs after transfer.
- Stop, human timeout, disconnect, and worker restart clean up sessions and leave honest run states.
- Keep all uncertain-write reconciliation checks from Experiment 001. No model calls in ordinary execution or handoff.
- Save sanitized evidence for every attempt; measure model calls, timings, and costs without invented metrics.

## Launch demo: CLI to Developer Studio

Use a clearly labeled synthetic supplier portal with two accounts, invoice pagination, login expiry, and controlled
layout variants. No patient data, real credentials, or payment execution.

1. CLI: initialize a project and describe `list-overdue-invoices` for a customer; show proposed contract and checks.
2. Open Studio; the first run waits for authentication. Open the live session, Take control, simulate/sign in on the
   synthetic portal, and Resume. Verify the correct account and return invoices with evidence.
3. Generate/test locally with varied inputs and freeze the contract. Configure user-owned Render and Browserbase
   credentials through secure setup (simulated in the clickable demo). Click Publish API, watch deployment and hosted
   smoke-test gates, then activate REST/OpenAPI and MCP from the same contract.
4. Stop the local CLI. Use the hosted API explorer and one supported MCP client to invoke it. A distinct Browserbase
   session reuses saved cloud authentication; local profile state is not implicitly transferred.
5. Change the portal layout. Show explicit failure, a scoped repair diff, unchanged test results, and human promotion.
6. Invoke the unchanged interface successfully. Inspect the implementation revision and demonstrate rollback.

Keep Todo CRUD as the engineering safety suite. Before launch, validate on at least one separately authorized real
portal; the fixture demonstrates mechanics, not universal site compatibility or production reliability.

## Build sequence after explicit approval

A. Local script-generation/repair experiment. B. Browserbase persistence and exclusive handoff spike. Both must pass.
C. Shared contracts, durable runs, connection authorization, REST/OpenAPI and MCP. D. CLI-to-Studio experience.
E. Render deployment adapter, secure bring-your-own-key setup, gated publication and rollback.
F. Regression evidence, failure recovery, demo rehearsal, and authorized real-portal validation.

Devin should identify uncertain Browserbase capabilities (especially interactive-access revocation and context sync),
propose the smallest technical approach, and report blockers. Do not assume provider behavior or start implementing.

## References

- Browserbase Contexts: https://docs.browserbase.com/platform/browser/core-features/contexts
- Live View: https://docs.browserbase.com/platform/browser/observability/session-live-view
- Long sessions: https://docs.browserbase.com/platform/browser/long-sessions/overview
- User-supplied Tandem single-patient workflow: design reference only; implementation not audited in this planning pass.
