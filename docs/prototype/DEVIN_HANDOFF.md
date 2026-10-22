# Devin implementation handoff

## Task prompt

Implement Gateway in this repository: a developer records a browser workflow, confirms typed inputs/outputs and checkpoints, tests it through Jev Ultrafast, then publishes a versioned endpoint set that another client can call. Follow `product-overview.md`, `spec.md`, and `demo.md`. `notes.md` is historical discussion, not an additional backlog.

Deliver the complete synthetic eligibility-lookup slice described in the spec, including a different-input run and rejection of wrong/incomplete results. This is implementation work; do not stop at a plan or a static dashboard.

## Starting state

The repository contains documentation and review/CI scaffolding only. There is no application yet. First inspect the actual repository; do not assume subsequent work has not occurred. The local author's .env was deliberately excluded; obtain required secrets through Devin's approved secret mechanism and never print them.

## Source dependencies

Read private `relayvault/dental` at `387eeb6ac63db9e546970af0aeb33a0d973b38f0` if available, especially the files listed in `spec.md`. Read its AGENTS.md and CLAUDE.md before any edits. Reuse recorder/compiler concepts and focused code with permission; do not modify the source repository or import clinical records. Access to Gateway does not imply access to dental. If inaccessible, report that concrete dependency and implement the minimal generic capture interface locally if it can meet the spec; do not claim source reuse that did not occur.

Pin public `browser-use/jev-ultrafast` to `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`. Inspect its instructions and retain MIT attribution for copied code. Keep upstream changes narrow: controlled browser injection, reviewed checkpoint orchestration, validated exact-input binding, and events/cleanup.

## Order of work

1. Prove a real controlled-browser recording and a real Jev task independently. Resolve the capture/engine session connection seam before designing a large UI.
2. Implement the typed workflow definition, input/output review, and synthetic fixture portal.
3. Implement the worker protocol, Jev adapter, verification and failure states.
4. Integrate publication, generated OpenAPI/endpoints, test client, and run/evidence inspector.
5. Run acceptance cases A1–A14, documenting any not completed; add actual application CI.
6. Update README with reproducible setup and commands. Record real smoke-test evidence and limitations. Open a PR; address substantive CodeRabbit findings when review is available.

Use a `devin/` branch; preserve unrelated changes. Do not push directly to main or auto-merge. Keep the scope bounded: recorder and real execution are required; billing, marketplace and production payer support are not.

## Decisions already made / flexibility

Primary engine is Jev Ultrafast. Recorder can use Playwright. The initial execution contract uses developer-reviewed checkpoints with independent assertions. Use React/TypeScript studio, Node gateway, Python worker, SQLite by default. You may choose a lightweight server framework, component library and local/hosted capture provider without approval when behavior remains intact. Record material tradeoffs in the PR.

If deadlines or missing access make the complete scope infeasible, report the specific working slice and blockers. Do not replace capture, live model calls, or endpoint execution with mocks while describing them as implemented.

## Delivery evidence

Return PR URL, instructions to run, checks executed, actual live-vs-mocked test boundary, a short demonstration capture with synthetic data, measured latency/call counts, and unresolved risks. Do not claim CodeRabbit is active without an actual review/check on the relevant commit.

## External actions

The task is implementation in this private repo and opening an implementation PR. No production portal login, patient data use, public deployment, GitHub App permission expansion, public post, hackathon submission, paid account purchase, or automatic merge is part of this handoff.
