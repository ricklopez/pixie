# Gateway implementation specification

**Date:** September 26, 2026  
**Status:** Implementable hackathon brief. Architecture choices below are bounded defaults; record justified changes in the PR. Product promises and failure semantics are acceptance requirements.

## 1. Objective

Implement a developer web app that records a human browser workflow and exposes the reviewed automation as typed API endpoints. Jev Ultrafast must power the demonstrated browser execution. Build one complete synthetic eligibility lookup first.

## 2. Technology boundaries

| Component | Default | Responsibility |
|---|---|---|
| Web studio | React + TypeScript | Recorder controls, definition review, test, publish, API explorer, run inspector |
| Gateway API | Node + TypeScript | Schema validation, identity, registry, account queue, run lifecycle |
| Storage | SQLite, one process | Definitions, revisions, runs, sanitized metadata |
| Recorder | Adapt dental authoring capture | Actual browser events, semantic target metadata, warnings, variables |
| Engine worker | Python >=3.12 + pinned Jev Ultrafast | Predict/act loop and controlled browser lifecycle |
| Browser | Dedicated controlled Chrome profile | Session state; never attach to an unrelated user profile |
| Artifacts | Local ignored storage for demo | Authorized extracts/screenshots and provenance |
| PR review | CodeRabbit GitHub App | Review repository changes; no runtime decisions |

Use Node subprocess spawning with argument arrays and structured stdin/stdout, not shell-interpolated tasks. Worker events are newline-delimited JSON with a protocol version and run ID; logs go to stderr. The API owns hard deadlines and cleanup. An HTTP worker is optional later.

The recorder's Playwright use does not imply the engine uses Playwright: Jev Ultrafast uses Browser Harness/CDP. Do not try to execute generated Playwright source in Jev. Adapt the reviewed flow definition into engine goals/checkpoints and output contracts.

## 3. Existing implementation to inspect

Private source: `https://github.com/relayvault/dental`, reviewed commit `387eeb6ac63db9e546970af0aeb33a0d973b38f0`.

- `client/src/features/workflows/portal-verification/RecorderPage.tsx`
- `server/src/features/workflow-engine/authoring/recording/`: driver, sanitizer, selectors, events and session lifecycle.
- `server/src/features/workflow-engine/authoring/compiler/`: inference, validation, deterministic renderer, checks and typechecker.
- `server/src/features/workflow-engine/authoring/contracts.ts` and `schemas.ts`.
- `server/src/features/workflow-engine/authoring/replay/runtime/`: constrained browser runtime and driver.

Extract generic interfaces and focused helpers, rather than importing the dental backend wholesale. Replace payer onboarding, practice DB assumptions, and UI-specific dependencies. Preserve secret handling and policy boundaries. Do not reuse payer-specific `lowering.ts` as the generic Gateway compiler: it imposes dental stage assumptions and additional action/host limits. Follow source-repository instructions and preserve attribution; confirm reuse authority if external distribution is later requested.

Engine source: `https://github.com/browser-use/jev-ultrafast`, reviewed commit `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`. Pin revision and retain MIT notice for incorporated source. Document any fork changes. No floating runtime download of main.

## 4. Workflow studio

States: `draft → recording → configuring → testing → ready → published`. Test failure returns to configuring with the failed checkpoint and retained sanitized trace. Edits after publication create a new draft; published revisions never mutate.

### Record

Create a named automation with an explicit start URL. Start provisions/connects a dedicated controlled browser and enables actual event capture. Stop flushes events and ends capture; report capture errors accurately. Show elapsed time, connected status, action count, unsupported-action warnings and a stop control. A screenshot/video by itself is not an executable recording.

The current reusable recorder uses an E2B desktop stream. Choose either that provider or a local companion supporting an explicitly controlled browser. A normal webpage cannot inspect arbitrary cross-origin tabs. If hosting access is unavailable, choose the local adapter; do not simulate recording.

### Review and parameterize

Show recorded actions and their semantic targets. Allow naming an input, selecting its type/required flag and confirmed field binding, selecting an output field, and defining success assertions. Credentials are account-secret references; do not retain their entered values. Recording must not embed the demonstration member ID as a replay constant.

MVP types: string, number, boolean, date-as-ISO-string. Reject unsupported transformations clearly. Declare exact-match identity checks independently of model inference.

### Test and publish

Run with different inputs. Display browser steps, model calls, elapsed time, final evidence and assertion results. Readiness requires at least one passing test for the exact draft checksum. A new edit invalidates that test. Publish writes an immutable revision and enables the endpoint set. It does not deploy a public website or claim third-party review.

## 5. Definition contract

One automation represents one business operation. Multiple automations can share the same authorized portal/account connection. Example conceptual definition (implement and validate a concrete schema):

```json
{
  "schemaVersion": "gateway.automation/v1",
  "id": "eligibility-overview",
  "revision": 1,
  "name": "Eligibility overview",
  "engine": "jev-ultrafast",
  "startUrl": "http://127.0.0.1:4174/demo-portal",
  "allowedOrigins": ["http://127.0.0.1:4174"],
  "effect": "read",
  "inputSchema": {
    "type": "object",
    "properties": {"memberId": {"type": "string", "minLength": 1}},
    "required": ["memberId"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "memberId": {"type": "string"},
      "eligibilityStatus": {"type": "string"},
      "observedAt": {"type": "string", "format": "date-time"}
    },
    "required": ["memberId", "eligibilityStatus", "observedAt"],
    "additionalProperties": false
  },
  "checkpoints": ["search-form", "member-result", "benefits-overview"],
  "assertions": [{"kind": "equalsInput", "output": "memberId", "input": "memberId"}]
}
```

The shorthand checkpoint names above require structured definitions in implementation: a reviewed objective, observable pre/postconditions, allowed effects, and extraction bindings. Persist source recording reference, input bindings, output bindings, definition checksum, engine revision, and limits. Checkpoint IDs cannot refer to arbitrary executable code supplied by clients.

Local HTTP/loopback is an explicit synthetic-demo exception bound to the configured fixture origin. General user-supplied targets require HTTPS and validation against private-network/metadata destinations, redirect escapes, and allowed origins. Do not weaken upstream safety globally to run a local fixture.

## 6. Jev adapter

Upstream `Agent` constructs its Browser internally. Add a narrow injection/connection seam so the worker uses Gateway's controlled session. Separate predict and act to expose the selected action and run policy checks before mutation. Continue to use current observed elements, not model-generated selectors or JavaScript.

Use the reviewed ordered checkpoints as the initial execution contract. A controller verifies each checkpoint, advances only after its assertions pass, and bounds attempts. Allow Jev to choose actions within a checkpoint; do not demand a literal replay of every demonstration click. Do not claim existing support for loading recorded flows into upstream.

Jev outputs decisions, not arbitrary text. Upstream's text helper requires another configured model. For confirmed input bindings, add a deterministic value-supply hook with target validation; credentials never go to the text helper. Expose any remaining text-model dependency clearly. On missing required credentials/configuration, fail setup visibly.

DONE means proceed to independent verification. It is not accepted completion. Preserve operation/target probabilities and confidence separately; do not label an invented combined score as a measured success probability. On model failure, stop or report a bounded retry; never silently switch to fake inference.

Origin and effect controls must be enforced around execution, not only in prompts. Agent actions on arbitrary sites are not inherently read-only. MVP restricts execution to the reviewed synthetic portal and supported actions. Real portal use requires its own validation and scoped authorization.

## 7. Runtime lifecycle

Run states: `queued → running → verifying → completed | needs_review | awaiting_auth | failed | cancelled`. Include precise reasons and timestamps. Model uncertainty/mismatched output yields needs_review; infrastructure failures yield failed. Detect login state before using awaiting_auth. A resumable auth flow is optional; if absent, explain how to authenticate and start a new run.

One active run per account; FIFO queue for the rest. A single worker is adequate. Persist interrupted runs as failed with `worker_interrupted` on restart; do not claim durable checkpoint recovery or exactly-once browser effects. Default limit: 60 actions and a configurable 120-second full-run deadline; tests may set lower limits. Worker termination must close owned tabs and release account leases where possible, with orphan reconciliation on restart.

Idempotency keys are scoped to caller, account, automation revision and canonical body. Repeated identical submissions return the existing run; a changed body with the same key returns 409. Do not automatically replay ambiguous browser mutations after a timeout.

## 8. API contract

All paths below are proposed acceptance contracts, not currently implemented endpoints.

| Method/path | Behavior |
|---|---|
| `GET /v1/automations` | Authorized registry entries and published revisions |
| `POST /v1/automations/:id/runs` | Validate revision, input and account access; return 202 with runId/statusUrl |
| `GET /v1/automations/:id/runs/:runId` | 200 run state and sanitized metadata |
| `GET /v1/automations/:id/runs/:runId/result` | 200 accepted envelope only when completed; otherwise 409 result_not_ready |
| `GET /v1/automations/:id/runs/:runId/evidence` | Authorized evidence metadata/links, independently access-checked |
| `GET /v1/automations/:id/openapi.json` | Generated typed contract for a published revision |
| `POST /v1/automations/:id/runs/:runId/cancel` | Idempotent cancellation request and accurate current state |

Invocation body: `revision`, `accountId`, `input`. Require a published revision explicitly for reproducibility. The authenticated caller determines tenant; do not trust a supplied tenantId. A local demo token can map server-side to a single tenant. Account IDs select only that tenant's authorized accounts. Keep any browser-session token server-side/HttpOnly; never bundle API/model secrets into client JavaScript.

Invalid input: 400. Missing authentication: 401. Unauthorized or cross-tenant object: 404 for resource reads. Unknown/unpublished automation: 404/409 as appropriate. Busy account queues normally; capacity overflow can return 429 with retry guidance.

Accepted envelope includes run ID, revision/checksum, data, observedAt, portalAsOf when supplied by the portal, evidence references, verification checks, model metadata and durations. Portal as-of date and observation timestamp are different. Do not expose raw cookies, credentials, prompts containing sensitive inputs, or unredacted upstream snapshots.

Cache is optional after the core flow. If included, scope by tenant/account/revision/normalized inputs; only accepted results can populate it, and original observation timestamps must survive cache hits.

## 9. Synthetic first workflow and output checks

Build a clearly labeled demo portal with a searchable fictional member directory, a result page, and benefit rows. Include two valid members with different data, a wrong-member fixture, incomplete benefits, and a login-required state. Do not copy real patient data or present the fixture as a live Delta Dental integration.

Inputs are demonstrated search parameters; for the synthetic portal use memberId. Outputs include exact memberId, eligibilityStatus, plan label, effective dates, maximum and deductible rows with period/network scope, and source date. Missing required values are unknown/error, never zero. Keep displayed contractual qualifications attached where relevant.

The real Delta Dental walkthrough observed login and an overview result, but not the intervening search/MFA steps. Full live integration is outside this first acceptance scope.

## 10. Evidence and persistence

Definitions, revisions, recording metadata and runs belong in SQLite. Evidence files live outside source control and are served through authorized handlers, not public static paths. Use opaque IDs and resolve them under the artifact root; reject traversal. Configurable retention and deletion can be documented limitations for the single-user demo but must not be falsely advertised as implemented.

Store account/browser secrets separately from exported definitions. Sanitize event labels, URLs and input values before durable storage. A private repository is not a suitable store for raw portal sessions or medical data.

## 11. Review and publication

Implementation PRs receive CodeRabbit review once its app is enabled. `.coderabbit.yaml` includes targeted review instructions for automations, schemas, API, recorder and worker.

Runtime-created automations do not trigger CodeRabbit by themselves. A later Git-backed publication adapter must export sanitized versioned files under `automations/<id>/`, OpenAPI under `openapi/`, and synthetic tests, then open a PR. Automatic PR creation is stretch scope. MVP may export these files for manual submission; label actual review status accurately.

Track reviewed commit SHA and artifact checksum. A review on an older commit cannot approve a changed definition. Do not equate a bot comment or lack of findings with certification. CodeRabbit does not run patient lookups or authorize production actions. Human merge/publication decisions remain explicit.

## 11a. Pixie v1 additions (delivered behavior)

See `docs/phases/pixie-v1.md` for the brief and `README.md` for commands. Delivered contracts:

- **Todo identity:** exact title, required `pixie-demo ` prefix; the site's numeric ids are array indexes and are never used as identity. Create refuses duplicates; update/delete refuse 0 or >1 matches; out-of-prefix/malformed input is refused. Postconditions verify counts, exact titles and unaffected siblings; update adds a `fieldValue` check and a pre-write `guardAt` snapshot. Deletion is the site's in-memory Trash, permanent after reload.
- **Browser isolation:** `BrowserPool` (apps/api/src/browsers.ts) launches one persistent Chrome per profile at `browser-data/<name>-<sha256(name) prefix>` (case-alias safe), one CDP port each, ports reserved atomically across concurrent launches and released on failure. Endpoints are re-attached only when the owner marker, live PID and `DevToolsActivePort` agree; otherwise refused. Studio recording uses `_recorder_<tenantId>`. `GATEWAY_CDP_URL` is a single shared dev browser: the pool serves one profile and refuses all others.
- **CLI:** `pixie init|doctor|dev|list|test|publish` from the checkout (apps/cli, private). Authoring/recording/review remain Studio actions and are stated as such in `pixie --help`.
- **Inspector:** React Flow view driven only by recorded worker events (`observation` and `policy_allowed` were added to the protocol); proposed/allowed/executed/verified are distinct.

## 12. Acceptance matrix

| ID | Scenario | Required evidence |
|---|---|---|
| A1 | Start/stop actual recording | Captured events match a human demonstration, with unsupported actions visible |
| A2 | Parameterization | Different member input runs without hand-editing connector code |
| A3 | Real Jev execution | Model calls and executed browser steps appear in run trace |
| A4 | Typed extraction | Accepted JSON matches the correct fixture and passes schema/assertions |
| A5 | Wrong identity | needs_review; accepted result endpoint remains unavailable |
| A6 | Missing output | needs_review; no fabricated default values |
| A7 | Model unavailable | Explicit failure; no fake success or hidden fallback |
| A8 | Expired login | awaiting_auth when actually detected, not an empty result |
| A9 | Account isolation | Cross-tenant run/evidence reads refused; same-account runs serialized |
| A10 | Versioning/idempotency | Immutable revisions; identical request deduped; changed-body conflict |
| A11 | Deadline/cancel | Owned session cleanup and explicit terminal state |
| A12 | Published API | Separate client invokes generated contract and retrieves evidence |
| A13 | Secret handling | No secrets in definitions, browser bundle, committed fixtures or logs |
| A14 | Review export | Export contains schemas/assertions and synthetic tests; review state is factual |

Status at delivery (details in README "Acceptance status" and PR #2): A1–A6, A9, A10, A12, A13 demonstrated (A3/A4 live with real Jev on the Todo site and eligibility fixture); A7 shown as explicit worker failure when the key is absent; A8 covered by the login-required eligibility fixture only in scripted mode; A11 deadline/cancel cleanup covered by tests, not a live rehearsal; A14 review export implemented as a downloadable file bundle (definitions, schemas, assertions, schema-derived synthetic fixture with per-run state/check outcomes only, OpenAPI, factual REVIEW.md; caller values, failure text, identities, secrets and browser state excluded by canary tests) — pending PM acceptance; automatic PR creation from the export is not implemented.

Offline tests must mock models and use synthetic browser fixtures. Paid model calls are opt-in live smoke tests. Add build/lint/typecheck/unit/integration/browser commands and CI, with passing output recorded in the PR. A mocked pass is not evidence of a working live Jev integration.

## 13. Delivery sequence

1. Prove capture and one live engine task in the controlled browser; record feasibility blockers immediately.
2. Build recording review and one input/output contract; preserve omission warnings.
3. Add worker adapter and independent verification; demonstrate a second input.
4. Add immutable publication, generated API and run/evidence inspector.
5. Add failure fixtures, isolation and lifecycle tests; then review export if time remains.
6. Rehearse demo and document actual results/limitations.

Cut optional analytics, extra integrations, natural-language dispatch and visual embellishment before cutting the real recorder-to-endpoint path. If that core cannot fit the remaining event time, report the smallest honest working slice and remaining tasks rather than hiding incomplete behavior.
