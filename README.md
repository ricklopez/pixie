# Pixie

**Build browser workflows with agents. Run them as verified APIs. Repair them when websites change.**

Pixie aims to turn browser workflows into APIs that maintain themselves as websites change. Agents help author
and repair the automation; tested browser scripts handle ordinary execution without model calls. The caller gets
a stable contract backed by explicit verification and a review path when the outcome is uncertain.

> **Status: planning the rebuild; implementation has not started.** This repository contains direction and an
> experiment plan, not a working framework. It builds on lessons from the
> [Pixie prototype](https://github.com/ricklopezio/gateway/pull/2).
> See the [complete v1 product specification](product/README.md), [v1 launch plan](docs/v1-plan.md) and [Experiment 001](docs/experiments/001-script-generation-and-reviewed-repair.md).

## Sites and demos

The [sites directory](sites/README.md) includes the public Pixie landing page, vision site, and clickable v1 demo.
They are regular source folders in this repository, with local run instructions. The v1 demo illustrates local
verification, human handoff, Jev traces, and one-button Render publication; it does not implement the actual framework.

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
- **Browser infrastructure:** local Chrome for development and Browserbase as the selected hosted browser provider for v1.
  Saved contexts and human handoff are early acceptance gates; compatibility is not yet established.
- **Normal execution** should use scripts. Workflows needing ongoing semantic judgment may eventually declare explicit
  agent-assisted steps, but those are outside the first experiment.

We should reuse browser infrastructure rather than recreate it. An HTTP wrapper, hosted browser, or CLI alone is
not our differentiation. The hypothesis is that teams need a reusable way to maintain verified browser operations.

## Local to hosted in one publish

V1 targets **Render + Browserbase**. Build and test locally, then click **Publish API** in Studio. Pixie packages
the tested revision, deploys to the configured Render runtime, runs hosted checks through Browserbase, and activates
the REST/OpenAPI and MCP interfaces only after they pass. Failed publication preserves the previous active revision.

The open-source edition uses your own Render API key and Browserbase API key, with required project/workspace
settings. Configure providers once through secure setup; keep keys out of frontend code and source control.
You own the infrastructure accounts and charges. Local browser login is not automatically copied to the cloud.
This is the selected design, not an implemented deployment feature; the clickable demo uses no real keys or services.

## Models, repositories, and adapters

V1 separates the **Invoice model** (data shape), **operation contract** (inputs, outputs, permissions and verification),
**InvoiceRepository.listOverdue** (business interface), and **browser adapter** (verified script implementation).
REST and MCP use the same repository operation. Publish pins model/contract versions and the adapter revision;
reviewed locator repairs preserve the public contract. This borrows LoopBack architectural boundaries without
committing to LoopBack as a dependency.

Only supported methods are exposed; defining a model does not generate unrestricted CRUD. Database connectors
and external API adapters are next-phase work. A future database source or synchronized copy must explicitly
define identity, freshness and consistency. The internal run-state database is still required in v1.

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

## Authenticated workflows and human handoff in v1

Session persistence has three separate parts: a Browserbase Context for saved login state, a bounded live browser
session for interaction, and Pixie's durable run/checkpoint record for recovery. Saved authentication can expire;
keep-alive does not make a browser immortal or preserve a worker's execution state.

Bind each context to a tenant and authorized connection/login. Serialize runs using that login in v1. A caller
receives a run ID and, when blocked, an authenticated Pixie handoff link. The user can watch, take control, complete
login/MFA, and explicitly Resume. No raw CDP connection is exposed to the caller.

Before enabling human control, fence and cancel automation and wait for acknowledgment that it has stopped issuing
actions. Resume re-observes the page, checks account identity and checkpoint conditions, and reconciles uncertain
writes. It never blindly replays a whole script. Authentication handoff does not invoke Ultrafast or authorize repair.

Human login/MFA, bounded session lifetimes, Stop, context revocation, and restart cleanup belong in v1. Automated
MFA collection and unrestricted collaborative control do not. See the [v1 plan](docs/v1-plan.md) for acceptance gates
and the [first Lemonade end-to-end use case](product/v1-lemonade-use-case.md). All of this remains proposed, not implemented.

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

## Run the app locally

Requires Node.js 24 (the workspace requires Node.js 22.13 or newer), Python 3, `uv`, and local Chrome.

From the repository root:

```sh
source ~/.nvm/nvm.sh
nvm use 24
npm ci
npm run worker:sync
npm run build
node apps/cli/bin/pixie.js dev --scripted --headless --portal
```

This starts the API on `http://127.0.0.1:4180`, the synthetic portal on
`http://127.0.0.1:4174`, and Studio on `http://127.0.0.1:5173`. The scripted
engine uses no model calls. In a second terminal, run the synthetic eligibility
flow through the API and its separate client:

```sh
scripts/e2e-flow.sh
```

The CLI-only authoring flow creates and invokes a fresh synthetic eligibility
automation through the CLI:

```sh
scripts/e2e-cli.sh
```

Stop the local services with Ctrl-C in the first terminal. If `uv` is missing,
install it with the official installer at <https://docs.astral.sh/uv/>. If Chrome
is not discovered automatically, set `GATEWAY_CHROME_PATH` in your shell to its
executable path; do not put machine-specific paths in the repository.

### Build an automation from the CLI

With the local services running, create a synthetic eligibility automation and
review its definition as a file before saving it back through the API:

```sh
node apps/cli/bin/pixie.js accounts
node apps/cli/bin/pixie.js create "Eligibility overview" \
  --url http://127.0.0.1:4174/demo-portal \
  --template eligibility-overview
# Copy the auto-… ID from the create output.
node apps/cli/bin/pixie.js definition get <automation-id> -o eligibility.json
# Edit eligibility.json if needed, then validate and save it through the API.
node apps/cli/bin/pixie.js definition set <automation-id> eligibility.json
node apps/cli/bin/pixie.js test <automation-id> \
  --account acct_demo --input '{"memberId":"DEMO-1001"}' --follow
node apps/cli/bin/pixie.js publish <automation-id>
node apps/cli/bin/pixie.js invoke <automation-id> \
  --account acct_demo --input '{"memberId":"DEMO-1002"}' \
  --idempotency-key demo-member-1002 --follow
node apps/cli/bin/pixie.js runs --automation <automation-id>
```

Use `--json` on API commands for JSON output. `pixie record <automation-id>`
starts a recording and waits for Enter; perform the workflow in the dedicated
API-owned browser window. Recording requires a visible browser, so start the
app without `--headless`:

```sh
node apps/cli/bin/pixie.js dev --scripted --portal
```

The CLI does not drive the recording browser. `pixie keys create` displays a
newly created token once; store it securely. Existing tokens and provider keys
are never printed.
