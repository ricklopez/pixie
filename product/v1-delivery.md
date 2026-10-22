# V1 delivery, acceptance and decisions

Planning only. Implementation begins only after explicit approval. No provider resources or real portal writes
are authorized by this document. A clickable demo is design evidence, not a passing product test.

## Delivery sequence

| Gate | Deliverable after build approval | Exit evidence |
|---|---|---|
| G0 — scope freeze | Review this package and resolve blocking choices | Approved scope, supported operations and decision log. |
| G1 — generation feasibility | Existing Experiment 001 on controlled Todo fixture | Generated scripts, ten varied CRUD cycles, zero runner model calls, exact-target/uncertain-write checks, reviewed repair. |
| G2 — authenticated execution | Browserbase context and human-control spike | First login, distinct-session reuse, expiry, fencing, stale-control rejection, cleanup and restart tests. |
| G3 — core runtime | Models/contracts/repos/adapters, durable runs, access and shared REST/MCP binding | Contract parity, isolation, leases, async outcomes and negative authorization tests. |
| G4 — CLI and Studio | Every screen/state in experience spec | Keyboard/responsive checks; synchronized browser/results/flow; no fabricated runtime events. |
| G5 — first real E2E | Authorized Lemonade list/detail integration | Source/account/field/completeness checks and saved-auth repeat run; unsupported methods absent. |
| G6 — publication | BYOK Render deployment and hosted Browserbase execution | Smoke-gated activation, prior revision preservation, rollback and independence from local CLI. |
| G7 — release readiness | Failure rehearsal, runbooks, docs, install validation | Fresh install, backup/restore, rotation, cleanup, capacity and full demo evidence. |

## Acceptance matrix

| Test ID | Requirement | Pass condition |
|---|---|---|
| A01 | F01 setup | Clean checkout bootstraps with documented prerequisites; missing config has actionable redacted diagnostics. |
| A02 | F02–05 architecture | API handlers invoke repository, adapter does portal work; model/contract/adapter versions independently pinned. |
| A03 | F06 generation | Parameterized source handles held-out inputs; generator/model/dependency identities recorded. |
| A04 | F09 deterministic tests | Ten Todo CRUD cycles, Unicode/duplicate/missing targets; preserve unrelated data; zero attempted model calls. |
| A05 | F07 persistence | Different Browserbase session IDs reuse one authorized context after close/sync and verify same account. |
| A06 | F08 handoff | First login and expired auth pause/resume; no automation dispatch after acknowledged human takeover. |
| A07 | F08 concurrency | Two viewers, duplicate/stale Resume and copied old control URL cannot produce concurrent controllers. |
| A08 | F15 recovery | Stop, human deadline, worker/browser crash release sessions and yield honest state; uncertain writes never replay blindly. |
| A09 | F09 visualization | Flow events match durable history; deterministic run shows zero model calls, replay controls do not affect execution. |
| A10 | F11 parity | REST and selected MCP client invoke same operation/schema; caller cannot access another project/connection/run. |
| A11 | F12 publishing | Failed local tests block publish; failed hosted tests preserve active version; retry does not duplicate resources. |
| A12 | F12 independence | Hosted REST/MCP operation succeeds with local CLI stopped. |
| A13 | F13 repair | Frozen unchanged suite passes against candidate; only explicit human approval promotes; rollback selects prior artifact. |
| A14 | F14 secrets | No keys, OTPs, cookies, raw control URLs or private screenshots in repo, frontend, logs, exports or generated docs. |
| A15 | F15 operations | Backup restore, credential rotation, revocation and teardown rehearsed; orphan session reconciliation verified. |
| A16 | Lemonade | Read contract passes with authorized account, exact identity and completeness; conditional methods not misrepresented. |
| A17 | Capacity | Per-context serialization, queue cap and run deadlines enforced under concurrent requests and stale-worker recovery. |
| A18 | UX | Keyboard navigation, visible focus, text status labels, reduced motion, responsive layout and every empty/error state. |

Track all attempts, including failed ones. Report authoring, normal-run and repair model calls separately; measure
latency/cost where possible. No numerical reliability claim is a release outcome until supported by actual evidence.
Proposed minimum repeatability gate: ten hosted synthetic read runs plus three authorized real-portal read runs,
with no silent incorrect acceptance. These counts demonstrate a bounded test, not universal reliability.

## Decisions to resolve before implementation/release

| ID | Decision | Proposed direction / blocking scope |
|---|---|---|
| D01 | Meaning of Lemonade CRUD | Policy reads mandatory; quote drafts conditional. Confirm draft-only scope and portal capabilities before enabling writes. |
| D02 | Ultrafast → code generation | Establish actual trace/code-generator integration; no assumption Ultrafast directly exports runnable scripts. Blocks G1. |
| D03 | Runtime compatibility | Pin Node, browser, Playwright/Ultrafast/SDK versions after compatibility spike. Blocks G1/G2. |
| D04 | Exclusive live control | Prove revocation/fencing; fallback closes session if old control access cannot be safely revoked. Blocks G2. |
| D05 | Generated-code isolation | Choose sandbox and enforce network/secret/resource bounds. Blocks production execution. |
| D06 | Hosted identity/MCP client | OIDC provider and supported client/auth setup; prove bearer flow or implement required OAuth before claiming client support. |
| D07 | Deployment artifact transport | Choose immutable artifact/Git build route and Render API reconciliation; pin resource plans and budget before provisioning. |
| D08 | Evidence/retention | Default capture off, short result retention; choose private storage only if required; validate deletion and backups policy. |
| D09 | Real portal feasibility | Authorized first login, context reuse, account identity, list/detail coverage and allowed subdomains need live evidence. |
| D10 | Lease/queue durability | Validate proposed Postgres queue and fencing under crash/concurrency; avoid unproven exactly-once claims. |

Rick owns product/scope approval; implementer supplies feasibility findings and evidence. Changes to this baseline
must state user impact, affected acceptance IDs and whether they change the public contract. A failed gate narrows
scope or blocks release; it is not waived by a visually successful demo.

## Launch deliverables

- Installable CLI and local Studio; hosted API/Studio and bounded worker deployment.
- Versioned model/repository/browser-adapter example, controlled Todo CRUD suite and qualified Lemonade integration.
- Authenticated REST/OpenAPI and one demonstrated MCP client integration.
- Browserbase first-login/reuse/handoff, durable run history, tests and truthful execution visualization.
- Secure provider setup, gated Render publish, repair review/promotion and rollback.
- Operator documentation: install, configuration, login, tests, API usage, publish, recover, rotate, restore, disconnect and teardown.
- Sanitized demo script/evidence, known limitations and unsupported operations.

## Demo truthfulness

Keep three labels distinct: concept-site simulation, controlled fixture evidence, and authorized live-portal evidence.
Never show fixture success as live insurance CRUD. Never publish the user's screenshots or personal account data.
The existing demo need not be changed to implement this documentation task; any later demo update must retain
its simulated status until backed by a real runtime.
