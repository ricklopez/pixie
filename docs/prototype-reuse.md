# Prototype reuse notes for Experiment 001

## Reference revision

The Gateway implementation inspected for this local experiment is pinned to
`e977fb43736bbd6de0b69a19a7b4bcc91bda5ca6` (`origin/pr/2`) in the separate
`gateway-impl` worktree. The requested `2ffd7f6e6cea5ae4c0b03849f2f32c580e7bfd36`
object was not available from the remote. The selected revision contains the
verified implementation ancestors `21cc136` and `0f91b6d`.

Inspected paths include:

- `packages/definition/src/{todo,verify,validate,types}.ts` and their tests
- `packages/recorder/src/{types,sanitize,session,page-script}.ts` and sanitizer tests
- `workers/jev/gateway_worker/{controller,scripted,policy,conditions,extract,lists}.py`
- `workers/jev/tests/test_controller.py`
- `apps/api/src/{runs,auth,openapi}.ts`
- `apps/cli/src/main.ts`
- `apps/portal/src/{server,fixtures}.ts` and portal tests

## Reused as concepts

- Exact-target checks are performed before dispatch; an absent or ambiguous
  target stops for review rather than selecting the first match.
- The pre-write snapshot idea represented by `guardAt` informs the runner's
  before/after checks. Deterministic `fieldValue` and `listContainsInput`
  postcondition concepts are represented here by an independent authoritative
  `/__state` delta verifier.
- Recorder sanitization never stores typed values. The trace binds parameter
  names and locator candidates, and URL query strings and fragments are
  removed.
- A needs-review outcome is terminal for the attempted write and is not
  converted into a retry.
- Request IDs are bound to canonical payload hashes. A changed payload under
  the same request ID is a conflict; uncertain create writes reconcile against
  the visible request marker and then title without issuing another create.
- The CLI's failure-reporting conventions informed the append-only attempt log.

## Adapted and rejected

This experiment uses handwritten, explicitly `synthetic-scripted` Playwright
demonstrations and a deterministic trace-to-TypeScript template generator. It
does not use Gateway's model-per-step execution design, hosted APIs, portal,
worker, or automation service. Gateway implementation code was not copied into
Pixie; only the bounded local concepts above were adapted.

The fixture request marker (`data-request-id`) is deliberately synthetic and
visible in the UI. Its use for reconciliation is an unresolved product
assumption, not evidence that a real website or Ultrafast exposes an equivalent
marker. The local browser demonstration is not agent-authored or agent-repaired.

The Jev Ultrafast source carries an MIT license; no Jev Ultrafast source code
was copied into this experiment.
