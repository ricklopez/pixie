# Pixie v1 — Todo CRUD and visible Jev execution

Status: Approved direction from Rick, 2026-09-26. Implementation and acceptance evidence pending.

## Scope and precedence

Product/Studio/CLI name: Pixie / pixie. GitHub repository remains ricklopezio/gateway. Build on the existing Phase 1 core. This brief supersedes eligibility as the primary demo target in product-overview.md, spec.md, demo.md and DEVIN_HANDOFF.md. Preserve the original verification, tenant isolation, versioning, evidence and failure requirements. Eligibility fixtures may remain regression examples. Update those canonical documents to reflect final delivered behavior.

Primary target: https://todo.uiineed.com/. Full CRUD through real browser interactions powered by Jev Ultrafast. No authentication/MFA/secret-manager product work, public deployment, auto-merge or additional paid agent sessions. Local end-to-end delivery comes first. E2B/Render packaging is optional after local acceptance; do not claim cloud support without a separately tested run. No package publication required.

## Deliverables

1. Working Pixie Studio: create connection, record, review/parameterize, test, publish immutable revision, copy API invocation and inspect output/evidence. A human must be able to author an automation, not only run hardcoded examples.
2. Four reviewed operations: create-todo, list-todos, update-todo, delete-todo. Inspect actual site behavior before choosing bindings; distinguish trash/soft deletion from permanent deletion. Use synthetic tasks with an explicit Pixie demo prefix. Do not alter unrelated tasks or bypass browser execution via internal data-store manipulation.
3. Stable account-scoped Chrome profile shared across operation runs, separate from ordinary personal Chrome. Graceful browser close/restart preserves the list. One active run per account; separate account profiles remain isolated. No fresh temporary profile per invocation. Provide a visible local browser for demo and explain where state lives. Protect remote debugging access.
4. Preserve existing /v1 automation run/status/result/evidence/OpenAPI contracts. Domain-friendly aliases are optional. Each CRUD operation remains async with verified results.
5. Safe task targeting: identify a genuinely stable observable identity if present. Otherwise use a supported unambiguous identity scheme and reject duplicate/ambiguous targets. Never use a transient DOM index as a persistent task ID, invent site IDs, or guess the first matching title. Report chosen identity contract and limitations.
6. Verify mutation postconditions independently, including new-item count/identity, exact updated values, unaffected sibling tasks and deletion semantics. Same idempotency key cannot repeat a write; ambiguous timeout must not silently replay a mutation. Report outcome uncertainty honestly.
7. React Flow run inspector: input -> validation/queue -> observation -> Jev decision -> policy check -> browser action -> observation; verification -> result/failure. Actual events drive node states and animations. Selecting a decision exposes actual operation/target, model, measured latency, separately reported upstream probabilities when available, and evidence. Proposed, allowed, executed and verified are distinct. Include chronological accessible event list, live-vs-replay labels and browser preview/evidence. Dark styling and restrained glow are welcome; no 3D graph or editable graph builder.
8. Minimal usable local CLI: pixie init <directory>, pixie dev, pixie doctor, pixie test, pixie publish if feasible within the implementation. Implement commands fully or mark explicitly unavailable; do not ship misleading stubs. First priority is a working install/init/dev/test/publish developer journey; document any Studio action that replaces a deferred command. Do not promise an npm package that is not published. Support installation from the private checkout. Never overwrite an existing project or secrets.
9. README and demo.md: fresh setup, exact run commands, required model variable names, recording walkthrough, CRUD client examples, three-minute presentation, limitations and true measurements. Rewrite PR title/body to reflect delivered Pixie scope.

## Required acceptance evidence

- P1: clean documented install starts API, Studio and dedicated browser; diagnostics accurately identify missing dependencies/model configuration.
- P2: a human records at least one Todo operation through Studio; new input runs without hand-editing core code. Prepared recordings for other operations are identified.
- P3: separate API client creates a new synthetic task, lists it, updates it, then deletes it; browser and accepted results agree at every step.
- P4: all four live demo operations include actual Jev decision evidence. If a read needs no mutation, include a real Jev-driven navigation/observation checkpoint and independent DOM extraction; no fabricated calls to satisfy a metric.
- P5: duplicate-title, nonexistent-target, malformed-input, failed-postcondition and ambiguous-write cases do not produce false accepted results or unintended changes.
- P6: repeated idempotent request does not duplicate writes; concurrent same-account requests serialize; cross-account run/evidence access is refused.
- P7: a task survives graceful browser restart in its dedicated profile; a different account cannot see it. Record process-crash recovery limitations.
- P8: inspector updates from actual events, handles failures and reconnects, and distinguishes recorded history from current execution. No secrets or full sensitive browser state in event payloads.
- P9: offline lint/typecheck/build/unit/integration checks pass; external browser/model tests are opt-in and distinguish real calls from scripted tests. Provide PR commit SHA and command output summaries.
- P10: live demo rehearsal and synthetic evidence/video where available. Explicitly enumerate unpassed P1-P10 and original relevant A1-A14; do not claim completion from CI alone.

## Sequence

Finish reusable Phase 1 plumbing, inspect real Todo site, prove CRUD/identity/persistence through the worker, wire Studio authoring, then live flow inspector and CLI packaging. Publish a draft PR early and update at milestones. Address actionable CodeRabbit feedback but distinguish summary-only coverage from a full review. Report blockers immediately while continuing independent work. Do not replace real execution with a mock to meet the presentation schedule.
