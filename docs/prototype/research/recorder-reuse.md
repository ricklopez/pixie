# Reusing Tandem's browser authoring pipeline in Gateway

**Date:** 2026-09-26
**Status:** Read-only source inspection; reuse recommendation, no extraction or live replay performed.
**Question:** Which existing recorder-to-Playwright components can support Gateway's developer recording and endpoint publishing flow?
**Checkout:** `submodules/dental` at `387eeb6ac63db9e546970af0aeb33a0d973b38f0`, with unrelated dirty changes preserved.

## Verdict

The recorder, compiler, and replay components already exist. Adapt this authoring pipeline rather than building a recorder from scratch. Gateway's new contribution is a general automation definition and generated endpoint set. Keep Jev Ultrafast as an alternative execution adapter; it is not a replacement for recording or compilation.

## Confirmed implementation

Paths below are relative to `submodules/dental`.

| Layer | Source | Behavior |
|---|---|---|
| Web recorder | `client/src/features/workflows/portal-verification/RecorderPage.tsx:20` | Hosted browser stream in an iframe, elapsed time, stop, fullscreen, mark moment, observed-host warning |
| Recorder transport | `server/src/features/workflow-engine/authoring/recording/e2b-recorder.driver.ts:84` | Playwright CDP connection to sandbox Chrome; injected click/change/allowed-key listeners; navigation and popup observations; start/poll/stop commands |
| Sanitization and selectors | `authoring/recording/sanitize.ts`, `authoring/recording/selectors.ts:15` under the same workflow-engine directory | Sanitized events, variable-oriented actions, selector primary/fallbacks, output-marked extraction |
| Compiler | `authoring/compiler/compiler.ts:125` | Confirmed-flow validation, deterministic rendering, static checks, generated-source typechecking |
| Generated bundle | `authoring/compiler/render.ts:247,412` | Typed runtime code, flow JSON, selector JSON, input/output JSON schemas, test cases, capability policy, provenance and checksums |
| Replay contract | `authoring/replay/runtime/driver.ts:24` | Navigation, locators, click/fill/select/check/press/wait and text/value reads |
| Actual replay | `authoring/replay/runtime/sandbox-entrypoint.ts:254` | Playwright-backed sandbox execution using CDP |

The recorder daemon deliberately omits entered field values. Parameter inference and secret references are part of the authoring design; replay cannot simply reuse all literal inputs from a recording.

## Important distinction

The compiler generates `browser/browser.ts` exporting `run(runtime: RelayBrowserRuntime)`. This is typed code against Tandem's constrained runtime, backed by Playwright. It is not a standalone Playwright test that can be copied and run without the runtime. Reuse the contracts, policy enforcement, and adapter with the compiler, or explicitly retarget the generator.

`server/src/features/recording` and `client/src/features/recording/ScreenRecorder.tsx` concern screen/video recording; the executable browser authoring path is under `workflow-engine/authoring` and `workflows/portal-verification`.

## Constraints confirmed in source

- Recorder sanitizer skips second-tab and subframe actions with warnings. A recording can continue while omitting such actions; completion of recording does not prove complete replay coverage.
- The separate payer-specific `authoring/lowering.ts` rejects multi-origin navigation and keypress actions and depends on ordered payer stages. These restrictions belong to that lowering path, not all generic compiler capabilities.
- E2B session provisioning, live-view streaming, tenant/practice authorization, Prisma persistence, artifact storage, and payer onboarding are dependencies that require adaptation.
- Output extraction needs explicit output definitions and assertions. A demonstration alone does not establish a business result contract.
- Authoring bundles are restricted to demo/staging replay by existing policy. General endpoint publication is new Gateway work; do not silently bypass Tandem's existing approval/certification rules.

The earlier MetLife investigation (HQ research note dated September 18; not bundled here) documents a real recording that had not completed the builder-to-runtime path. Its saved-session findings were not re-queried during this review. They reinforce the need to prove recording, compilation, replay, and result verification together rather than infer readiness from component existence.

## Recommended Gateway boundary

```text
Developer web recorder
  → sanitized events and reviewed parameters/outputs
  → generic BrowserFlowDefinition
  → versioned bundle + JSON schemas
  → Gateway endpoint generation and service registry
  → deterministic Playwright adapter OR Jev agent adapter
  → independent verification + typed result + evidence
```

Extract/adapt raw-event contracts, sanitization, selector building, flow schemas, compiler rendering/validation, runtime interfaces, and focused tests. Adapt the recorder UI to generic automation terminology. Replace payer/practice repositories with Gateway's tenant/account/automation storage ports. Avoid importing the payer-family lowering stage into the generic engine.

For the first recorded workflow, deterministic replay is the shortest route to preserving the exact demonstrated behavior. Jev can provide bounded evidence assessment and, where separately tested, an agent execution mode. Automatic switching from a failed replay to free-form agent actions should not be assumed safe or correct; make engine selection explicit in the service definition.

## Validation before calling reuse complete

Record one synthetic lookup from the web UI, parameterize it, compile it, run with a different input, and verify typed results. Exercise unsupported frames/tabs, missing output, selector drift, identity mismatch, and expired login. Show the actual omissions and failure states. Preserve secret handling and account boundaries when replacing storage/runtime adapters.

No runtime tests were run in this review. No credentials, database rows, patient values, raw recordings, or portal screenshots were read from local stores or copied into this note. No dental code was modified.
