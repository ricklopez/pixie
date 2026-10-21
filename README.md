# Pixie

**Show it once. Call it as an API.**

Pixie turns a browser workflow that a person demonstrates once into a typed, versioned, independently verified API
that other software can call.

> **Status:** rebuild in progress. This repository currently contains only this README. It is a clean rebuild of the
> Pixie prototype developed in [`ricklopezio/gateway`](https://github.com/ricklopezio/gateway)
> ([PR #2](https://github.com/ricklopezio/gateway/pull/2)).

## The problem

More and more essential business data and actions live only behind websites: portals with no API, internal tools,
SaaS dashboards. Browser automations and agent workflows are becoming de facto data sources, but they are usually
built as one-off scripts or unconstrained agent prompts. Applications that depend on them need what any other
enterprise data source provides:

- a stable, typed contract (inputs, outputs, errors)
- versioning, so a change never silently alters a published behavior
- account-scoped execution and session isolation
- progress, deadlines and explicit failure states
- results that are checked against evidence, not just reported by a model

Pixie is the API framework layer for browser automations: the "LoopBack for browser workflows".

## How it works

1. **Record** — create an automation with a start URL and demonstrate the task in a dedicated, controlled Chrome.
   Real browser events are captured with semantic targets; typed values are not stored.
2. **Review and parameterize** — mark variable inputs (typed, required/optional), outputs, ordered checkpoints and
   success assertions. Credentials are secret references, never recorded values.
3. **Test** — run with different inputs. The agent (Jev Ultrafast) chooses actions within the reviewed checkpoints;
   deterministic checks verify identity, schema and completeness independently of the model.
4. **Publish** — write an immutable revision and expose its `/v1` endpoints plus an OpenAPI document. A new edit
   creates a new draft; published revisions never change.
5. **Invoke** — a separate client calls the endpoint and gets either verified, typed data or an explicit
   `needs_review` result with the reason. A wrong or incomplete result is never reported as success.
6. **Inspect** — every run keeps its decisions, browser evidence and verification results for review.

## Core principles

- **Verified, not trusted.** Model output proposes actions; independent checks decide whether a result is accepted.
- **Proposed ≠ allowed ≠ executed ≠ verified.** Each stage of an action is distinguished and recorded.
- **Immutable revisions.** Callers pin to a version; publishing requires a passing test of the exact draft checksum.
- **Isolation by default.** Each account gets its own browser profile and serialized execution; tenants cannot see
  each other's runs, evidence or sessions.
- **No secrets at rest in definitions, exports or logs.** Exports exclude caller inputs, browser state and identities.
- **Honest scope.** No fabricated metrics or invented reasoning in the UI; limitations are documented.

## Planned components

| Component | Responsibility |
|---|---|
| Studio (web) | Record, review, test, publish, API explorer, run inspector (data-flow / decision view) |
| API | Schema validation, identity, registry, account queue, run lifecycle, `/v1` endpoints |
| Recorder | Controlled Chrome over CDP, event capture, sanitization |
| Definition | Typed automation contract, checksums, assertions |
| Engine worker | Jev Ultrafast action loop driven by reviewed checkpoints, extraction, guards |
| CLI (`pixie`) | `init`, `doctor`, `dev`, `list`, `test`, `publish` |

Technology choices for the rebuild will be recorded here as they are made.

## Lessons carried over from the prototype

- One controlled Chrome per account profile, reached over CDP, can be shared by the recorder and the Jev engine
  without forking the engine.
- Writes (create/update/delete) need pre-write guards and post-write assertions; duplicate, ambiguous, nonexistent or
  out-of-scope targets must end in `needs_review` with no change.
- Browser pools need atomic port reservation, collision-safe profile directories and recovery when a Chrome loses its
  last tab.
- Review exports must be generated from schemas, not copied from real runs.

## Acknowledgements

- Agent engine: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT).
