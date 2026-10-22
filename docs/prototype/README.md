# Pixie (repository: Gateway)

**Show it once. Call it as an API.**

Pixie turns a recorded browser workflow into a typed, versioned, independently verified API. A developer records a
workflow in a controlled Chrome, reviews inputs/outputs/checkpoints, tests it through Jev Ultrafast, publishes an
immutable revision, and a separate client calls the generated `/v1` endpoints. Every run keeps its Jev decisions,
browser evidence and verification results; failures are reported as `needs_review`, never as fabricated success.

The product/Studio/CLI name is **Pixie**; the GitHub repository and internal package names remain **Gateway**.
Primary v1 demo: full Todo CRUD on <https://todo.uiineed.com/> (see [docs/phases/pixie-v1.md](docs/phases/pixie-v1.md)).
The synthetic eligibility portal remains as a regression fixture.

## Layout

| Path | What it is |
|---|---|
| `apps/api` | Node/Fastify gateway: Studio API, `/v1` published endpoints, run lifecycle, SQLite, evidence, `BrowserPool` |
| `apps/studio` | React/Vite Pixie Studio: record, review, test, publish, API explorer, React Flow run inspector |
| `apps/cli` | `pixie` local CLI (installed from this checkout; **not published to npm**) |
| `apps/portal` | Synthetic eligibility portal fixture (offline regression data) |
| `packages/recorder` | Controlled Chrome launcher (ownership-checked CDP), Playwright-over-CDP recorder, sanitizer |
| `packages/definition` | Typed automation definition contract, checksums, Todo/eligibility templates |
| `workers/jev` | Python worker: NDJSON protocol, Jev Ultrafast adapter (pinned), checkpoint controller, extraction, guards |
| `scripts/pixie_todo_demo.sh` | End-to-end live Todo demo / P7 isolation rehearsal script |
| `docs-site/` | Documentation site, owned separately (not edited by the implementation PR) |

## Requirements

- Node `>=22.13` (developed on 22.23.3), npm
- Python 3.12 and [`uv`](https://docs.astral.sh/uv/) for the worker
- Google Chrome / Chromium (`GATEWAY_CHROME_PATH` overrides discovery; macOS bundle paths are probed)
- `TYPESAFE_API_KEY` for live Jev execution (`GATEWAY_ENGINE=live`). Never commit it; the CLI never writes it.

Engine: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) pinned at
`1231850a0bf1a0c0341fe408ef1668dbbfdfac46` (MIT; see [docs/research/jev-ultrafast.md](docs/research/jev-ultrafast.md)).
The private `relayvault/dental` recorder was **not** accessible (HTTP 403); the recorder here is a local generic
implementation, no dental code was reused.

## Install and run

```sh
npm install
npm run worker:sync          # uv sync for workers/jev (pins jev-ultrafast)
npm run build                # definition -> recorder -> portal -> api -> cli -> studio
```

Run through the CLI (recommended):

```sh
alias pixie="node $PWD/apps/cli/bin/pixie.js"   # runs from this checkout; no npm package
pixie init ~/pixie-proj && cd ~/pixie-proj
export TYPESAFE_API_KEY=...  # from your shell/secret manager only
pixie doctor                 # Node, uv/worker env, pinned Jev revision, Chrome, model var, build, API/Studio health
pixie dev                    # API :4180 (visible dedicated Chrome per account) + Studio :5173; Ctrl-C closes everything
```

Or run the pieces directly:

```sh
GATEWAY_ENGINE=live GATEWAY_BROWSER_VISIBLE=1 TYPESAFE_API_KEY=... node apps/api/dist/main.js   # API + browsers
npm run dev -w apps/studio                                                                    # Studio (dev-token-local)
GATEWAY_ENGINE=scripted node apps/api/dist/main.js && npm run dev -w apps/portal             # offline eligibility demo
```

Studio: <http://127.0.0.1:5173> (developer token `dev-token-local`). API: <http://127.0.0.1:4180>
(client token `client-token-local`). Synthetic portal: <http://127.0.0.1:4174>.

### Environment variables

| Variable | Meaning |
|---|---|
| `TYPESAFE_API_KEY` | Jev Ultrafast / TypeSafe key; required when `GATEWAY_ENGINE=live` |
| `GATEWAY_ENGINE` | `live` (real Jev) or `scripted` (offline, no model; fixtures only) |
| `GATEWAY_BROWSER_VISIBLE` | `1` = visible Chrome windows for demos; otherwise headless |
| `GATEWAY_CHROME_PORT` | First remote-debugging port (default `9333`); each account profile takes the next free port |
| `GATEWAY_CHROME_PATH` | Chrome executable override |
| `GATEWAY_DATA_DIR` | SQLite, evidence and browser profiles (default `artifacts/gateway`) |
| `GATEWAY_CDP_URL` | **Dev only.** Attach to one externally managed browser instead of launching per-account Chrome. This is a single shared browser with **no account isolation**: the API serves the first account/tenant profile that asks and refuses every other one. |
| `GATEWAY_DEV_TOKEN` | Studio token used by the CLI (default `dev-token-local`) |

## `pixie` CLI

```
pixie init <directory>          create pixie.json, .env.example, .gitignore, README; refuses a non-empty directory; never writes secrets
pixie doctor                    diagnostics with exact missing items (never prints secret values)
pixie dev [--scripted] [--headless] [--portal]
pixie list                      this tenant's automations, states and published revisions
pixie test <automationId> [--account <id>] [--input '<json>']   Studio test run; prints checks, accepted data or failure reason, evidence URL
pixie publish <automationId>    next immutable revision; prints checksum, OpenAPI URL and a client curl
```

Not CLI commands (by design, Studio does them): creating an automation, recording in the dedicated browser,
reviewing/parameterizing inputs, outputs and checkpoints. `pixie test`/`publish` operate on automations authored
in Studio. No npm package is published; install from this checkout.

## Todo CRUD contract (primary demo)

Operations: `create-todo`, `list-todos`, `update-todo`, `delete-todo`, each an async `/v1` automation with
independent verification.

- **Identity:** the site stores tasks in browser-profile `localStorage` (`uiineed-todos`) and reassigns numeric
  `id`s from array index on every load, so they are *not* stable. Pixie uses the **exact title** as identity.
- **Prefix:** every write must target a title starting with `pixie-demo `; other tasks are never touched.
- **Refusals (`needs_review`, no change made):** duplicate title on create; 0 or >1 matches on update/delete;
  out-of-prefix or malformed input; failed postcondition.
- **Verification:** counts before/after, exact new title present / old absent, unaffected siblings unchanged,
  update `fieldValue` check. Delete goes to the site's in-memory Trash; it is permanent after reload.
- **Execution:** real Jev drives the browser (typing/clicking); Pixie never edits the site's data store directly.

Run it end to end (needs the live API running):

```sh
scripts/pixie_todo_demo.sh publish            # creates acct_todo, live-tests and publishes the 4 ops
scripts/pixie_todo_demo.sh crud <suffix>      # separate client: create -> list -> update -> delete -> list + safety cases
scripts/pixie_todo_demo.sh isolation-before <s>; <restart API>; scripts/pixie_todo_demo.sh isolation-after <s>   # P7
```

## Browser isolation (P7)

- One persistent Chrome profile per account under `<GATEWAY_DATA_DIR>/browser-data/<accountId>-<sha256 prefix>`;
  the digest keeps `acct_A`/`acct_a` apart on case-insensitive volumes (macOS). Studio recording uses a per-tenant
  profile `_recorder_<tenantId>`.
- Each profile gets its own CDP port; ports are reserved atomically across concurrent first launches and released
  if Chrome fails to start.
- A profile's endpoint is re-attached only when `pixie-owner.json`, the live PID and Chrome's `DevToolsActivePort`
  agree; occupied or unowned ports are refused, never hijacked.
- Before handing out a cached or re-attached owned endpoint the pool checks `/json/list`, not just `/json/version`:
  a Chrome whose last tab was closed (healthy version endpoint, no page targets — Playwright's `connectOverCDP`
  then fails with "Browser context management is not supported") gets one `about:blank` opened via
  `PUT /json/new` and stays running; an unreachable one is closed, dropped and relaunched on the same port. Only
  Chromes the pool launched or whose ownership marker validated are touched. A failed `RecordingSession.start()` (e.g.
  the start URL refuses the connection) closes only its own tab, detaches its screencast and disconnects; other
  tabs in that Chrome are untouched. Regression: unit test with a fake CDP server and opt-in real-Chrome
  closed-last-tab and failed-navigation tests (`GATEWAY_BROWSER_TESTS=1`).
- Graceful shutdown (SIGINT/SIGTERM, `pixie dev` Ctrl-C) closes every dedicated Chrome and clears the owner marker.
  **Limitation (not rehearsed as acceptance evidence):** after an API crash (SIGKILL) the dedicated Chrome keeps
  running; the next API start re-attaches to it only if marker, PID and `DevToolsActivePort` still agree, otherwise
  it refuses that port and launches the profile on the next free one. Nothing reaps orphaned Chromes automatically.
- Same-account runs serialize; cross-tenant run/evidence/account access is refused (tests in `apps/api/test`).

## Checks

```sh
npm run lint && npm run typecheck && npm test      # offline: no portals, no paid model calls
npm run build
npm run test:browser                               # opt-in (sets GATEWAY_BROWSER_TESTS=1): real Chrome restart/isolation + recorder tests
scripts/pixie_todo_demo.sh all <suffix>            # opt-in: real Jev on todo.uiineed.com (paid model calls)
python3 scripts/check_repository.py                # documentation/scaffolding check
```

Offline CI covers definition, recorder (sanitizer, ownership refusal, Chrome discovery), portal, API (lifecycle,
idempotency, isolation, BrowserPool), CLI and Studio flow-model tests. Scripted-engine tests do **not** prove live
Jev behavior; live evidence is recorded in PR #2 and `demo.md`.

## Acceptance status (P1–P10, honest)

| ID | Status | Evidence / gap |
|---|---|---|
| P1 | Pass (local) | `pixie doctor`/`pixie dev` start API+Studio+dedicated Chrome; doctor names missing uv/Chrome/key/build/services |
| P2 | Pass (live, UI-driven) | Blank draft → real Studio recording of a synthetic Todo create (recording `e2cfd83c…`, navigate/input/click captured, values omitted) → title parameterized + typed `tasks` output + `listContainsInput` assertion in the Studio editor → Studio test `a6bef1ea…` (create 7→8) → revision 1 (`8d53f166…`) → separate `/v1` client with a second title, run `5617ba7c…` (create 8→9, 3 real jev-1.13.0 calls). Driven through the real Studio UI by Playwright, not by a human hand |
| P3 | Pass (live) | `scripts/pixie_todo_demo.sh crud`: separate client create→list→update→delete, browser and accepted results agree |
| P4 | Pass (live) | All four ops run through real Jev (jev-1.13.0) with decision evidence; list uses a Jev navigation/observation checkpoint plus DOM extraction |
| P5 | Pass (live) | duplicate, nonexistent, ambiguous, out-of-prefix, malformed → `needs_review`, no change |
| P6 | Pass | Idempotency, same-account serialization, cross-tenant refusal (offline tests + live rehearsal) |
| P7 | Pass (graceful) | Live restart/isolation rehearsal + `GATEWAY_BROWSER_TESTS=1` real-Chrome test; process-crash recovery is manual (above) |
| P8 | Pass | React Flow inspector driven by recorded worker events, live/replay badge, failures shown; payloads redact input values |
| P9 | Pass | lint/typecheck/build/test green offline; browser/model tests opt-in |
| P10 | Partial | Live rehearsal and a draft video exist; final submission intentionally held for Rick |

## Review export (A14)

Studio → Publish → "Download review export" (or `GET /studio/automations/<id>/export`) returns text files for a
Git-backed review: `automations/<id>/revision-<n>/{definition,input.schema,output.schema,assertions}.json` +
`REVISION.md` (checksum, gate test run; no publisher identity), `tests/<id>/revision-<n>.synthetic.json` (a fixture
generated from the input schema plus, per recorded run, only the terminal state and per-check pass/fail),
`openapi/<id>.json` and `REVIEW.md`, which states factually that no automated review has examined the export.
Never exported: caller input values and failure/verification text from real runs (they can carry PII, secrets or
quoted page content), secrets (only `secretRef` names appear), browser profiles/cookies/localStorage, screenshots,
raw evidence, idempotency keys, API keys and caller/publisher identities. A negative test runs a caller input and a
failure message containing PII/secret canaries and asserts none of it reaches the bundle. Drafts without a
published revision are refused (409). Opening the PR automatically is not implemented; PM acceptance of A14 is
pending re-review of this hardening.

## Review workflow

Work in a branch and open a pull request; no auto-merge or public deployment. CodeRabbit currently provides
summary-only coverage on this repository. Keep credentials, browser profiles, raw recordings, cookies and runtime
evidence (`artifacts/`) out of Git; all demo data is synthetic.
