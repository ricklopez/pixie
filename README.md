# Pixie

**Build browser workflows with agents. Run them as verified APIs. Repair them when websites change.**

Pixie aims to turn browser workflows into APIs that maintain themselves as websites change. Agents help author
and repair the automation; tested browser scripts handle ordinary execution without model calls. The caller gets
a stable contract backed by explicit verification and a review path when the outcome is uncertain.

> **Status: planning the rebuild; implementation has not started.** This repository contains direction and an
> experiment plan, not a working framework. It builds on lessons from the
> [Pixie prototype](https://github.com/ricklopezio/gateway/pull/2).
> See [Experiment 001](docs/experiments/001-script-generation-and-reviewed-repair.md).

## The problem

Business data and actions often live behind websites with no suitable API. Browser scripts and agent prompts can
access them, but applications need dependable dependencies: explicit inputs and outputs, controlled side effects,
safe retry behavior, evidence of completion, and maintenance when the website changes.

Our focus is preserving the API contract while maintaining the browser integration underneath it. A changed button
should not require every caller to edit its code. A changed business rule must not be silently treated as a button repair.

## Proposed lifecycle

1. **Demonstrate and author.** Use local Chrome and Jev Ultrafast to explore an authorized workflow. Capture actions,
   semantic targets, input bindings, and observed outcomes with sensitive values excluded from durable artifacts.
2. **Generate.** Produce a parameterized browser script with stable locators, explicit waits, bounded actions,
   preconditions, and postconditions. A successful trace is a starting point, not proof of generality.
3. **Validate.** Execute without a model across different inputs and negative cases. Check identity, completeness,
   and side effects independently of agent completion claims.
4. **Publish.** Package the script, contract, verification checks, dependencies, and required browser capabilities
   as an immutable implementation revision associated with an API contract version.
5. **Execute and observe.** Run the tested script without model calls on the normal path. Return verified data or
   an explicit failure/review state, with sanitized evidence and execution history.
6. **Repair under review.** On a supported failure, let the agent propose a narrowly scoped patch. Retest it against
   the unchanged contract and regression suite. Require human approval before promotion in the first experiment.

Script generation and repair are capabilities we must build around Ultrafast; they are not demonstrated features
of the prototype. Deterministic instructions do not make a changing website deterministic. Verification runs every time.

## Boundaries and execution options

- **Pixie** owns contracts, execution policy, verification, versioning, review, and repair promotion.
- **Ultrafast** is the initial candidate for browser exploration and repair assistance. Code generation may require
  a separate coding agent; the experiment must establish that boundary rather than assume Ultrafast emits scripts.
- **Browser infrastructure** may be local Chrome or a supported provider such as Browserbase. Browserbase integration
  and artifact portability require compatibility testing; they are not established capabilities.
- **Normal execution** should use scripts. Workflows needing ongoing semantic judgment may eventually declare explicit
  agent-assisted steps, but those are outside the first experiment.

We should reuse browser infrastructure rather than recreate it. An HTTP wrapper, hosted browser, or CLI alone is
not our differentiation. The hypothesis is that teams need a reusable way to maintain verified browser operations.

## Contracts and maintenance

| Change | Proposed treatment |
|---|---|
| Locator, layout, or navigation repair that preserves behavior | New implementation revision behind the same contract |
| Changed input requirements, output meaning, or permitted side effects | Explicit contract revision and caller migration decision |
| Expired login or MFA | Authentication handoff, not a script repair |
| Ambiguous target or uncertain write outcome | Reconciliation or human review before further action |

Published artifacts remain immutable. A reviewed promotion changes which implementation serves a contract; callers
may pin an implementation for reproducibility. Keep promotion history and allow rollback. Rolling code back does not
undo external side effects.

A failed script must not automatically become an unrestricted agent run. Repairing future executions and recovering
a partially completed execution are separate responsibilities. A timeout after a write must not trigger a blind retry.

## Lessons from the prototype

- Todo CRUD showed the value of exact-target guards, before/after checks, explicit review states, and idempotency.
  API request deduplication alone does not solve an uncertain browser-side write.
- Hacker News showed that schema-valid output can still be wrong: presence/type checks did not establish uniqueness
  or relevance. Acceptance criteria must express the actual promise, with uncertainty acknowledged where necessary.
- The prototype called the model during execution; it did not export standalone scripts from successful runs.
- Browser lifecycle, account isolation, authentication, and sanitized evidence remain essential even with scripted execution.
- A model's `DONE` or an HTTP success response is not proof that the business operation succeeded.

## First milestone

Prove one small loop using a controlled Todo fixture: agent-assisted authoring, generated scripts, model-free CRUD,
a deliberate website change, a proposed repair, independent regression checks, and human-approved promotion.
Include an ambiguous write outcome to establish that recovery does not duplicate the action.

The [experiment plan](docs/experiments/001-script-generation-and-reviewed-repair.md) defines scope, gates, evidence,
and stopping conditions. Do not build the broader framework or begin this experiment until explicitly authorized.

## Acknowledgements

The prototype used [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast) as its browser decision engine.
