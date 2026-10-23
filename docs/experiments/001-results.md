# Experiment 001: local Todo script generation and reviewed repair

## Scope and reproduction

This report covers only the synthetic, local Todo fixture. It does not claim
real Ultrafast authoring, real-site reliability, or agent repair. G1 is **not
passed**.

From the repository root:

```sh
cd experiments/001-todo
npm ci
npx playwright install chromium
npm run generate
npm test
npm run typecheck
npm audit
```

The package requires Node `>=22`. The verified local versions were Node
`22.23.4`, npm `10.9.9`, Playwright `1.55.1`, TypeScript `5.9.3`, tsx
`4.20.6`, `@types/node` `24.10.0`, `better-sqlite3` fallback `13.0.3`, and
Chromium `140.0.7339.186` (Playwright build `v1193`). This run used Node's
built-in `node:sqlite`; `better-sqlite3` is available when that module is not.
Playwright was pinned to `1.55.1` after `npm audit` identified a high-severity
browser-download integrity advisory in `1.55.0`; the updated dependency audit
reports zero vulnerabilities.

## Evidence and results

Committed trace inputs are under `experiments/001-todo/capture/traces/`;
generated baseline modules and their trace/output hashes are under
`experiments/001-todo/generated/baseline/`. The generated code is deterministic
and contains operation parameters rather than demonstration values. The
committed contract-lock SHA-256 is
`c3ecb42f85b223e5af851946b5033ae124f931628ef4b0a664a8a9b8235606b6`.

| Operation | Trace SHA-256 | Generated output SHA-256 |
| --- | --- | --- |
| create | `1b36ca84b84eab5bba3e2b098c8075260441ebbe30efbec6b3c65e83a2b07ce4` | `da741dca803cb9db13c45fb284764d3c79f7e687c0f782a7672084056588c03e` |
| list | `80910627d2ae1bd6a9611f5a2bfe26ebf2ab2d2dda6accc7f1a4c2c460b2e4e2` | `bda29c2b83d8dd2635ab6800afd3dcc814b77d63a4c0792cbfd00dbc97c3cead` |
| rename | `c7159125e56265619726e3e8d705b595c1eb2a222adc6d30f951cd681ae815f3` | `f5e7b37e038beb69842d2fcd8d2f321765cb1e808870dc5fcb33f4e57b9d4c66` |
| delete | `9d3c9e69745c0850d77cf402581df3b18268889576d2b1ddcbf66bbabd3b9a45` | `2c76e17762310e94ef7dff9960d44c18c5fcf97f08925b4e55083ab4dc92f196` |

`evidence/variant-outcomes.json` records all four observed baseline-script
operations per fixture variant. Each result records dispatch and model-host
attempt counts:

| Variant | Create | List | Rename | Delete |
| --- | --- | --- | --- | --- |
| baseline | completed (1) | completed (0) | completed (1) | completed (1) |
| cosmetic | completed (1) | completed (0) | completed (1) | completed (1) |
| locator-break | completed (1) | completed (0) | failed (0) | completed (1) |
| ambiguous | completed (1) | completed (0) | needs_review (0) | needs_review (0) |
| rule-change | contract_revision_required (0) | completed (0) | contract_revision_required (0) | contract_revision_required (0) |

Numbers in parentheses are browser write dispatches. Every recorded operation
had zero model-host attempts. The locator-break rename fails before dispatch;
the ambiguous target is never resolved by selecting the first matching row.
The rule-change variant rejects writes under the frozen contract; direct
fixture requests also confirmed that the new required reason and 20-character
limit are enforced.

Ten complete CRUD sequences with punctuation, accents, CJK, emoji, and
unrelated done/undone tasks passed the independent `/__state` verifier.
Idempotent replays, changed-payload conflicts, duplicate-title and missing-ID
guards, prefix rejection, all three uncertain-create fault points, frozen
contract enforcement, repair scope, approval, promotion, and rollback passed.
The human-authored locator candidate passed the frozen candidate suite on both
baseline and locator-break; it is not an agent-generated repair. After
rollback, a baseline CRUD sequence passed again.

The `npm test` verification run passed all 13 tests (0 failures); strict
`npm run typecheck` (`tsc --noEmit`) passed. The plumbing suite regenerated
module output in memory and confirmed byte-for-byte generator determinism.
Model-call accounting by phase:

| Phase | Model-host attempts |
| --- | ---: |
| Synthetic scripted capture | 0 (no model adapter invoked) |
| Deterministic generation | 0 |
| Frozen CRUD, guards, and uncertainty tests | 0 counted |
| Repair validation and rollback | 0 counted |
| Paid-provider refusal test | 0 (refused before any call) |

`evidence/test-attempts.jsonl` is append-only and contains all 52 test attempts
from four offline test runs, including every failed attempt: 43 passed and
nine failed. The nine failed test attempts were resolved before the final
passing run:

- `runs ten exact CRUD sequences with Unicode, punctuation, and unrelated
  rows` failed twice. First, generated `delete` used a reserved function name;
  after that was corrected, the runner did not recognize the delete script's
  successful postcondition. The generator now exports the operation through
  a legal function alias, and the runner confirms deletion from visible state.
- `records actual baseline-script outcomes for every fixture variant` failed
  twice for the same generated-delete and delete-terminal issues; the final
  matrix now records all four operations for all five variants.
- `rejects contract-scope changes and requires approval before promotion`
  failed twice because the baseline suite's delete operation was not marked
  completed. It passes after the delete postcondition change, and the rollback
  test now also executes a full baseline CRUD sequence.
- `accepts only the human-authored locator repair after baseline and
  locator-break checks` failed twice because the candidate postcondition read
  `args.title` instead of `args.newTitle`; this caused the 1.8-second UI
  confirmation timeout. The candidate now checks the rename value and safely
  narrows the target row.
- `reconciles uncertain create writes without issuing a second create` failed
  once because Chromium transparently retried the deliberately dropped
  before-persist request. A focused local probe observed the first request
  with the injected fault and a second request with the same request ID. The
  before-persist fault now returns an explicit 503, while the fixture's unique
  request-ID constraint and same-payload deduplication prevent duplicate rows
  when a dropped after-persist request is retried by the browser.

Two earlier typecheck runs also failed. The initial run caught the reserved
`delete` identifier. The next caught a missing `undefined` return in that
generated function, the candidate postcondition typo/null narrowing, an
exact-optional-property typing issue in capture, and invalid overload spreads
in the Node request guard. All were corrected before the successful strict
typecheck. The initial dependency audit reported one high-severity Playwright
advisory; upgrading to `1.55.1` resolved it, and the final audit is clean.

## Boundaries and unresolved gaps

- There is no real Ultrafast authoring trace and no agent-generated repair.
- The demonstration source is `synthetic-scripted`; handwritten fixture
  interactions must not be described as agent-generated.
- The fixture exposes a synthetic `data-request-id` row marker for uncertainty
  reconciliation. Whether an actual target system can provide a safe
  equivalent remains unresolved.
- The sample is small and local; no real websites, customer data, hosted
  browsers, or paid model calls were used.
- A dropped local HTTP write can be transparently retried by Chromium. The
  fixture deduplicates by request ID so such a retry cannot create a duplicate;
  the write-dispatch count reflects intercepted Playwright requests, not
  browser-internal network retries.
- The deterministic templates and repair candidate do not establish general
  model-free authoring or safe real-world repair.
- `contract_revision_required` is observed for the rule-change variant; a
  contract change is required before that UI can be automated under this
  frozen contract.

## Proposed bounded paid experiment (not authorized or run)

If separately approved, test Ultrafast authoring of four operations on this
fixture through a tunnel-free local Chrome setup, followed by one reviewed
agent repair attempt against the behavior-preserving locator-break variant.
Use only the explicitly approved TYPESAFE and OpenAI credentials, retain
sanitized traces, and stop after that single repair. No hosted deployment or
real website is proposed.

**Cost bound (call caps, not a dollar quote):** at most 4 Ultrafast authoring
sessions x 30 model decisions = 120 Ultrafast decision calls, plus at most 4
text-helper calls per session (16), plus 1 coding-model repair proposal (at most
3 attempts). The hard cap is about 140 model calls, enforced and counted at the
network layer, and the run aborts at the cap. No browser-provider charges, because
it uses local Chrome. Dollar cost depends on the operator's current TYPESAFE/OpenAI
pricing and must be confirmed from their billing pages before approval. This
document makes no invented cost claim.
