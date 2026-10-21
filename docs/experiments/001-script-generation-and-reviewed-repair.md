# Experiment 001: script generation and reviewed repair

Status: proposed — planning only; implementation is not authorized.
Owner: Rick Lopez. Intended implementer after approval: Devin.

## Question

Can an agent-assisted browser demonstration produce a reusable script that executes without model calls, and can
an agent repair that script after a website change while preserving the API contract and avoiding duplicate writes?

This is a feasibility experiment, not a production-readiness claim or a framework build.

## Scope

Use an isolated, locally controlled Todo website with persistent state and disposable synthetic tasks. Start with
one browser environment and one thin invocation boundary. Do not build Studio, a hosted service, authentication
management, multiplayer editing, or a generic compiler. Do not modify the existing prototype or use real customer data.

Proposed implementation candidate: Playwright scripts with JSON contracts. Confirm feasibility before choosing it.
Inspect Ultrafast's available observations and actions. Determine whether a separate coding agent must translate its
trace into source; do not claim Ultrafast generates code if another component does so. Use reviewed, scoped browser
capabilities for exploration and repair; no unrestricted evaluation against production sites.

## Fixed contract

Use unique task IDs for the fixture and an exact synthetic-title prefix `pixie-demo `. List returns task IDs, titles,
and completion state. Create accepts a title; rename accepts an ID and new title; delete accepts an ID. Writes must
preserve unrelated tasks and completion states. Duplicate titles and missing/ambiguous targets require review.

Include a request ID for writes. Persist operation intent and known outcomes outside the browser process. The fixture
must support inspection of its actual persisted state by the test harness, independently of generated selectors.
The public contract and acceptance tests are frozen before inducing failures. Repair must not weaken or edit them.

## Sequence and gates

### 1. Establish the baseline

Demonstrate create, list, rename, and delete using Ultrafast in the fixture. Capture a sanitized trace and identify
which data can reliably support locator generation. Report any missing capability before designing around it.

Generate parameterized scripts rather than replaying coordinates or embedding demonstrated values. Record the
Ultrafast version, browser version, generator identity/version, dependencies, and artifact hash.

### 2. Prove model-free execution

Run at least ten complete CRUD sequences across distinct titles, including spaces, punctuation, and Unicode. Include
unrelated tasks with both completion states. Disable model access for the runner and instrument attempted model calls.

Require zero attempted model calls, exact intended state changes, and preservation of all unrelated records. Test
request replay, changed-payload reuse of a request ID, duplicate titles, missing IDs, and out-of-prefix writes.
Do not discard failures or silently retry until green; report every attempt and any manual intervention.

### 3. Change the website

Prepare baseline and altered fixture versions before running repair. Include:

- A cosmetic/layout change that should not break semantic locators.
- A behavior-preserving locator or navigation change designed to break the baseline script.
- An ambiguous target case that must stop for review rather than choose the first match.
- A changed business rule that cannot be solved while preserving the existing contract.

First show the actual baseline behavior on each variant. If the script already survives a change, record resilience;
do not manufacture a failure or a repair success.

### 4. Propose and validate a repair

Provide the failed step, sanitized page evidence, fixed contract, and allowed action scope to the repair process.
Produce a source diff and explanation. Run the unchanged acceptance suite against baseline and affected variants,
including held-out inputs. Freeze the test suite outside the repair agent's writable workspace.

Require human approval to promote the candidate. Demonstrate an auditable implementation revision change behind
the same contract version, plus rollback to the previous artifact. No automatic promotion in this experiment.

### 5. Exercise uncertain write recovery

Inject failure after create has persisted but before the runner receives confirmation. Repeat the same request ID.
The system must inspect/reconcile the persisted outcome, returning the existing result when conclusively established,
or stop as outcome-unknown/needs-review. It must not issue another create blindly. Assert the persisted task count
and identity using the independent fixture harness.

A pending or running request record is not proof of completion. Bound polling, retries, repair attempts, and elapsed
time. An exhausted budget must produce an explicit terminal result. Code rollback does not undo the created task.

## Required evidence

- Reproduction commands and pinned dependencies.
- Baseline and changed fixture definitions; generated script and repair diff.
- Contract/schema hash before and after repair, and immutable implementation hashes.
- Results for every test, including negative cases and independent persisted-state assertions.
- Model-call counts split into authoring, normal execution, and repair; latency and cost where measurable.
- Approval/promotion/rollback record, and uncertain-write recovery evidence.
- Limitations, manual steps, and a recommendation: proceed, narrow scope, or stop.

Success means all required checks pass without changing the contract or weakening verification. It demonstrates
only the controlled cases exercised, not general website self-maintenance or safe recovery on every external system.

## Out of scope and follow-up

Browserbase portability is a subsequent compatibility probe, not a prerequisite for proving the local loop. Real
portal authentication/MFA, arbitrary semantic extraction, general-purpose code generation, automatic repair promotion,
and production tenant isolation are separate work. Preserve room for them without building abstractions prematurely.

## Devin handoff — do not start building

Review this plan and README only. Respond with feasibility concerns, the smallest proposed implementation approach,
the Ultrafast/code-generator boundary, missing decisions, and suggested changes to the acceptance criteria.
Do not write implementation code, install dependencies, run paid browser/model experiments, create infrastructure,
merge this documentation PR, or start the experiment. Wait for Rick's explicit authorization to implement.
