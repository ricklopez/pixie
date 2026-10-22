# Pixie (Gateway) — product overview

**Date:** September 26, 2026  
**Status:** Pixie v1 delivered locally on PR #2: Studio, `/v1` published endpoints, real Jev execution, account-scoped browsers, React Flow inspector and the `pixie` CLI. Primary demo is Todo CRUD on todo.uiineed.com (`docs/phases/pixie-v1.md`); the eligibility lookup below remains the motivating example and a scripted regression fixture. Honest acceptance status is in README.md. Product/Studio/CLI name: Pixie; repository: Gateway.

## Product promise

**Show it once. Call it as an API.**

A developer demonstrates a browser task, identifies variable inputs and expected outputs, tests it with different data, and publishes an endpoint set. Other software can invoke the operation without implementing browser control, session handling, and result checks itself.

The engineering analogy is LoopBack for browser automations. The user-facing explanation is a demonstration becoming a callable service.

## Problem and users

Some essential business tasks are available only through a website. A browser agent can attempt a task, but an application also needs a stable contract, input validation, account-scoped execution, progress, failure handling, and a result tied to evidence.

The primary user is a developer integrating such a workflow into an application. The secondary user is the application calling the endpoint. An operator may restore login when a session expires.

The first motivating workflow is Delta Dental eligibility and benefits retrieval for Tandem. That establishes a real need, while the framework remains independent of dental terminology. The public demo uses a controlled synthetic portal with fictional members; it must be clearly labeled as such.

## Core experience

1. Create and name an automation in the developer web app.
2. Open a controlled browser and record a human demonstration.
3. Review captured steps and warnings; mark input fields, output fields, and success conditions.
4. Test with different synthetic inputs and watch the actual execution.
5. Inspect accepted output or a concrete exception alongside evidence.
6. Publish an immutable version and copy its API example.
7. Invoke that API from a separate client and observe a new run.

The first viewport is the automation workspace. Avoid an elaborate marketing page or empty analytics dashboard.

## Why the recording matters

A recording communicates navigation, field meaning, checkpoints, and intended outcome. It is not proof that every captured click is necessary, that replay will work, or that results are correct. The developer confirms the reusable contract. The first implementation uses reviewed ordered checkpoints to constrain agent execution rather than treating the whole recording as an unconstrained prompt.

## Role of Jev

Jev Ultrafast supplies the action-selection loop over observed browser elements. Gateway supplies the recorded workflow contract and execution control. Jev can also assess narrow questions about output evidence; deterministic identity/schema/completeness checks remain authoritative.

The engine does not natively record human demonstrations, import our workflow definitions, isolate Gateway accounts, or return our business schema. Building that bridge is the implementation task. A separate text model is required by upstream for generated text entry; exact confirmed values should use a controlled binding extension where implemented.

## Differentiation to demonstrate

Our contribution is the recorder-to-contract-to-endpoint lifecycle and independently checked results. Attribute the existing recorder foundation and Jev Ultrafast engine openly. Avoid claiming to have invented browser agents or the upstream action loop.

A second input producing the correct different result demonstrates parameterization. An incomplete result producing `needs_review` demonstrates meaningful acceptance behavior. These are more valuable than a dashboard full of integrations.

## Hackathon judging alignment

The user-supplied event slide lists four equally weighted criteria:

| Criterion | Proof in the product |
|---|---|
| Use of Jev, 25% | Real action decisions visible during a browser run, with model and call metadata |
| Originality, 25% | Human demonstration becomes a reusable API contract and endpoint set |
| Technical, 25% | A working client request, understandable schemas, keyboard-usable authoring controls, explicit failures |
| Anti-Slop, 25% | Small coherent flow; every visible control works; clean loading/error states and readable evidence |

The slide supersedes the earlier main brief's unspecified five-dimension summary for this pitch. Exact event eligibility for pre-existing code still needs organizer confirmation.

## Scope and boundaries

Must deliver one real recorded synthetic lookup end to end: capture, review, parameterize, test through Jev, publish locally, invoke, verify, inspect evidence. Local publication means registration in the running Gateway instance; it does not mean public internet deployment or CodeRabbit approval.

Defer a connector marketplace, billing, generalized MFA collection, production insurance integration, arbitrary iframe/pop-up support, multi-region workers, and autonomous recovery from any UI change. GitHub-backed publication review is a follow-on to the core demo, though PR review of implementation code can run immediately once the app is connected.

## Success measures

- A developer creates the demo automation through the web app without editing its implementation by hand.
- A different input changes the task and verified result, without changing framework code.
- Browser execution and Jev use are actual, visible, and attributable.
- Missing evidence, wrong identity, and uncertain completion do not become accepted results.
- A client receives stable schemas and understandable progress/failure states.

Do not promise a speedup or reliability percentage until measured against a stated baseline. Report engine time and full request time separately.
