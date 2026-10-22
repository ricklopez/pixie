# Jev Ultrafast as Gateway's browser engine

**Date:** 2026-09-26
**Status:** Source review; recommended for a hackathon feasibility spike, not integrated or live-tested.
**Question:** Can browser-use/jev-ultrafast power Gateway?
**Reviewed revision:** `1231850a0bf1a0c0341fe408ef1668dbbfdfac46` (repository HEAD when fetched).

## Verdict

Yes, as the first execution adapter. Keep Gateway's typed service contract, account queue, policy, extraction, and independent result acceptance around it. Its native use of Jev makes the hackathon integration substantive without requiring semantic routing to every API request.

## Source-backed findings

- Python >=3.12, package version 0.1.0, dependencies on browser-harness 0.1.13 and httpx. The root license is MIT. [Package](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/pyproject.toml), [license](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/LICENSE).
- `Agent(url, goals, record_dir=None, screenshots=False)` observes a page, asks Jev for operation and compatible target choices, then executes the selected observed action. `run()` yields snapshots; `command('predict')` and `command('act', ...)` separate selection and execution. History includes decisions, timing, usage, and text-helper calls. [Agent](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/agent.py).
- Text entry uses a separate OpenAI-compatible text model. Even known strings in the goal pass through this helper. Jev chooses actions but does not generate the field text. The code validates choice distributions and generated JSON; it does not gate execution on a minimum confidence threshold. [Model](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/model.py).
- Browser creation calls Browser Harness's daemon and CDP directly, opens a tab in the existing profile, and closes the owned tab afterward. There is no constructor parameter for an injected Browserbase connection or isolated per-account context. Retargeting requires an adapter change, not merely an environment switch. [Browser implementation](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/browser.py).
- Targets reference observed nodes. The executor checks freshness, current geometry, and occlusion. The agent consumes a pending decision before execution and retains executed action history across stale observations. These are useful protections, not proof of business correctness.
- Built-in limits include 60 executed actions, 120 model decisions, and a stop after three non-wait actions without page change. Gateway still needs a whole-run deadline, cancellation, and normalized errors.
- `done` is a model-selected stop state. The flight example separately checks actual route, date, settings, and results. Follow this pattern for every service's business postconditions. [Independent verifier](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/examples/flights.py).

## Practical limits

The README explicitly excludes frames, shadow roots, canvas, uploads, pop-up tabs, nested scrolling, and arbitrary keyboard widgets from this MVP. These features can be material blockers for portal integrations. It also says tabs share the existing Chrome profile. Its reported flight timings use a small task-specific sample and should not be projected onto Gateway workloads. [README](https://github.com/browser-use/jev-ultrafast/tree/1231850a0bf1a0c0341fe408ef1668dbbfdfac46).

The inspected runtime does not enforce Gateway's allowed origins, read-only business policy, tenant authorization, or durable account locks. A generic click can submit a consequential action; a prompt saying read-only is not an enforced action policy. For the demo, use a controlled synthetic portal and dedicated browser profile. Production isolation requires a separately controlled browser context/profile per tenant and account; separate worker processes alone do not isolate the shared browser profile.

Optional screenshots and snapshots provide raw material for evidence. Gateway must associate evidence with run/account/version, apply retention and redaction, and extract typed outputs. Agent snapshots contain page text, entered values, and model requests, so they should not be exposed wholesale through the public API.

## Proposed integration

```text
TypeScript Gateway API and service registry
  → account queue
  → Python worker running a pinned Jev Ultrafast revision
  → observed browser actions
  → service-specific extraction and deterministic checks
  → optional Jev evidence assessment
  → accepted result or explicit exception
```

Use a local subprocess with structured JSON input and newline-delimited JSON events for the first adapter. Keep credentials in the worker environment, not command-line arguments. Do not port the engine to TypeScript during the hackathon. The worker owns browser lifecycle; the gateway owns deadlines and a cleanup protocol that closes the owned tab before forced process termination where possible.

A connector supplies its start URL, goal template derived from validated arguments, output schema, extractor, and verifier. Agent mode can coexist with a future deterministic recorded-script adapter. A successful exploratory run is a trace, not automatically a stable replayable connector.

Map `ready` and `predicted` to running. Map `done` to a verification phase, then completed only when postconditions pass. Map `blocked` to needs-review with a reason. Use awaiting-auth only when login expiry is actually detected. Map exceptions and budget/deadline exhaustion to explicit failure reasons. Capture final evidence before closing the tab.

## Bounded validation plan

Spend 20–30 minutes proving one synthetic portal task, typed extraction, trace capture, and independent success checks. Then test wrong-record data, incomplete results, expired login, and budget exhaustion. Verify failed or uncertain runs cannot populate the accepted cache. Test session reuse separately from account isolation. Measure full request latency including setup and verification, alongside the engine's own timing.

If a required portal depends on unsupported frames or widgets, retain the service API and substitute a deterministic browser adapter. Pin the engine revision and record modifications. Preserve the upstream license notice when incorporating code.

## Review boundary

Read README, AGENTS, package metadata, license, agent/browser/model/questions implementations, flight verification example, and offline test source. No dependencies were installed, no browser automation was launched, and no model API calls or benchmarks were run. Findings establish architectural fit and specific gaps, not empirical reliability.
