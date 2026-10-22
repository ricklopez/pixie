# V1 review decisions and bounded implementation handoff

Date: 2026-10-21. Source: Devin review of 09cb3c8 in session
[108033b08f7e4755829947e9e9575f52](https://app.devin.ai/sessions/108033b08f7e4755829947e9e9575f52).
Rick authorized closing gaps and starting implementation if ready. This decision authorizes only the local G1
milestone below. Later cloud/portal gates are not cleared. This document supersedes conflicting earlier wording.

## Review disposition

| Gap | Decision | Remaining gate |
|---|---|---|
| Portal scope | Initial Lemonade milestone is list/detail reads. Quote CRUD remains an uncommitted capability investigation, not a launch dependency. Todo provides required CRUD. | Authorized real-portal probe before G5; stop/narrow if unavailable. Screenshots establish intended web UI, not verified automation. |
| Human-control secrecy | Watch uses authenticated Pixie-mediated transient frames; no provider control URL. Only the authorized controller may receive interactive provider access, transiently, never logs/exports. | Prove provider behavior; do not assume a documented short-lived URL or revocation API exists. |
| Resume | Default fallback ends old session, confirms termination, waits boundedly for persistence and opens a replacement. Same Pixie run ID, new browser session. | Recheck identity and reconstruct a safe read checkpoint. Page/form state may be lost. Uncertain writes remain needs_review; no blind restart. |
| Isolation | Operator-owned reviewed scripts only; untrusted code hosting is out of scope. Per-run process and minimal environment are baseline controls, not a sandbox. | Hosted execution requires proven OS/network isolation or brokered browser capabilities. Browser routing alone cannot constrain arbitrary Node network/file access. |
| Generation | Record real action/locator evidence, emit parameterized script with explicit unsupported-step failures. Templates are the first candidate. | Test Ultrafast trace boundary; do not assume CDP always yields semantic locators. Handwritten fixture scripts must not be labeled generated. |
| Publication | Deploy generic runtime initially; ordinary Publish stores a bounded immutable bundle, tests inactive binding and switches pointer. Runtime upgrades are separate deployments. | Hash/size/dependency/authorization validation, DB artifact storage and provider reconciliation tests. No arbitrary dependency installation per call. |
| Queue | Postgres leasing/fencing, at-least-once scheduling, one context writer. | DB fencing alone cannot cancel dispatched browser effects; controller must acknowledge stopped dispatch before transfer. |
| Data | Encrypt sensitive accepted results, seven-day default retention, sanitized events; no bulk object storage in baseline. | Verify provider recording/log settings and retention; do not claim ZDR without plan evidence. |
| Identity/MCP | Local-token auth first. Hosted OIDC and named MCP client validation remain separate release gates. MCP invoke returns run handle; get_run polls. | Select provider/client before hosted implementation; no claim of universal client compatibility. |

## Clarified behavior

- Resource outside caller scope returns 404; 403 means an in-scope action is forbidden.
- Add verifying → failed; awaiting_user → interrupted; queued → expired; interrupted → failed for a definitively
  failed read. Uncertain effects go to needs_review. Recovery never silently repeats a write.
- Contexts are separate per environment. First hosted connection requires its own login. Do not reuse a local
  cloud-browser context across environments merely to avoid a second MFA prompt.
- Session timeout is per browser; run wall-clock deadline survives replacements. Proposed total run budget: 1800
  seconds including queue/human waits, queue budget 300 seconds, with earliest deadline winning.
- A user disconnecting a connection invalidates pending handoffs, stops/fences active work, cancels queued runs,
  then deletes context. Retain only sanitized audit records under retention policy; failed deletion is visible.
- A second run waits behind a context lease, including during handoff, until its queue/run deadline. No second writer.
- App transport parity means the same stored accepted result for the same run through REST/MCP. Independent live
  executions may legitimately differ; don't demand byte-identical results across distinct runs.
- Models/contracts follow semantic compatibility: removed fields, changed meaning or newly required inputs require
  a major version; compatible optional additions require minor version; implementation-only repairs change adapter
  revision. Published versions immutable. Callers explicitly pin contract major/version; migration is opt-in.
- Context sync has no assumed completion event. Bound the wait/retry and verify authenticated identity in the next
  session. Failed reuse is auth_required, never anonymous acceptance.

## Missing Studio flows now required

Settings → API tokens: issue a token once, scope to operations/connections, set expiry, rotate and revoke; show only
fingerprint afterward. Revocation blocks new requests and sensitive result access, with active-run policy explicit.
Settings → members: operator invites an OIDC identity, assigns role/connections and revokes membership. First hosted
operator is bootstrapped through an explicit configured issuer/subject allowlist, never first-user-wins signup.
Account operators see only assigned connections/runs; caller tokens do not grant Studio access.

Contract → new version: copy published definition to draft, show compatibility diff, test and publish separately;
old version remains callable until explicitly retired. Retirement lists affected bindings and blocks new calls.
API → MCP: explain invoke/get_run, auth errors and awaiting_user link; human opens protected Studio, not raw provider URL.
Settings → delete project: show affected resources, stop runs, revoke tokens/access, delete contexts and sensitive data,
then apply retention to sanitized audit history. Failed first-publish resources appear in cleanup with explicit teardown.

## Additional acceptance

- A07: old control URL cannot drive the retired session after Resume; otherwise fail the handoff gate.
- A14: watch viewer receives no control URL; sensitive result fields never enter event/flow payloads.
- A19: zero orphan sessions after completion/stop/deadline/crash, with session time measured.
- A20: every injected failure has one honest final state; no implicit uncertain-write retries.
- A21: token/member revocation, first-operator bootstrap and cross-scope access tested.
- A22: artifact hash reuse is idempotent; crash between smoke and activation preserves/reconciles valid active binding.
- A23: total run deadline survives replacement sessions; context waiting cannot extend it indefinitely.

## Prototype reference map — inspect before writing new code

Prototype repository: [ricklopezio/gateway](https://github.com/ricklopezio/gateway).
Implementation snapshot observed locally: `2ffd7f6e6cea5ae4c0b03849f2f32c580e7bfd36` in pixie-review checkout.
The gateway checkout at `940017309b8823249a288493e6e020c8acdd9513` is earlier docs/scaffolding; do not mistake it
for the implementation. Fetch the implementation revision or a verified descendant, preserving provenance/licenses.

| Reference path in prototype | What to inspect and carry forward |
|---|---|
| `AGENTS.md`, `README.md`, `product-overview.md`, `spec.md`, `demo.md` | Existing intent, safety rules and live-vs-mocked evidence distinctions. |
| `packages/definition/src/todo.ts`, `verify.ts`, `validate.ts` and tests | Typed contracts, independent checks, exact-target safeguards; inspect limitations before reuse. |
| `packages/recorder/src/` and recorder tests | Capture/action schema, sanitization, unsupported events and session isolation. |
| `workers/jev/gateway_worker/{controller,scripted,policy,conditions,extract,lists}.py` | Agent/script boundary, policy checks, verification and list completeness. |
| `workers/jev/tests/test_controller.py` | Regression scenarios; do not copy sensitive fixtures blindly. |
| `apps/api/src/{runs,worker,auth,openapi}.ts` and API tests | Durable run/API patterns, auth, OpenAPI and uncertainty handling. |
| `apps/studio/src/RunInspector.tsx`, `apps/studio/test/flow-model.test.ts` | Recorded Jev flow and verification UI behavior; don't fabricate events. |
| `apps/cli/src/main.ts` and CLI tests | Existing CLI conventions and error behavior. |
| `apps/portal/src/` and portal tests | Controlled fixture approach. |

New repo references: `docs/experiments/001-script-generation-and-reviewed-repair.md`, all `product/` docs,
`sites/pixie-v1-demo/{src,test-flow,architecture,publish-api}.jsx`, and `sites/pixie-public/` design system.
Prototype code is reference material, not permission to copy runtime databases, .env files, screenshots or recordings.
Write a reuse/gaps note with pinned upstream paths and tests before implementation. Preserve good behaviors and
correct flaws; don't port the model-per-step execution design into ordinary deterministic execution.

## Authorized first build slice

Devin may start G1 on a NEW `codex/` branch in ricklopez/pixie based on this spec revision. Do not merge PR #2.
Implement only local synthetic Todo fixture, locator/action capture and script-generation candidate, model-disabled
runner, contract/verifier and Experiment 001 safety tests. Normal dependency installation and offline tests allowed.
Reference the prototype first and document reuse decisions. No full Studio, hosted runtime, insurance adapter,
provider provisioning, deployment, real-account login or mutations in this slice.

No paid model/browser calls are authorized by this handoff. Implement authoring integration behind an opt-in boundary;
recorded/synthetic inputs can test plumbing but cannot satisfy the real agent-generation feasibility gate. If that
live evidence is necessary, report the exact bounded experiment, credentials needed and cost estimate for approval.
Do not relabel fixtures as real generation. Do not weaken the frozen suite to pass.

Deliver a draft PR, reproducible commands, all test attempts, model-call instrumentation, reuse note and explicit
remaining evidence gaps. Stop after this slice and report; G1 not fully passed until actual generation/repair evidence
exists. Do not continue into G2–G7 automatically. Rick's conditional authorization enables this bounded start, not
an assertion that unresolved cloud/portal risks are solved.

Reference check: [Browserbase live view](https://docs.browserbase.com/platform/browser/observability/session-live-view)
uses an interactive URL and illustrates read-only embedding via pointer-event disabling. This is not evidence of
server-enforced viewer authorization or per-link revocation. Confirm those separately before implementation claims.
