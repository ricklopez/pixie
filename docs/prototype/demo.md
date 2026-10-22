# Pixie hackathon demo

**Headline:** Show it once. Call it as an API.  
**Audience:** Jevathon technical/product judges.  
**Status:** Live Todo CRUD rehearsed with real Jev (jev-1.13.0) on 2026-09-26 (`scripts/pixie_todo_demo.sh all`); a narrated 4-minute draft video exists locally and is **not submitted**. The eligibility portal sections below remain as the scripted regression demo.

## Pixie v1 live demo (primary)

1. `pixie dev` (or the direct commands in README) with `TYPESAFE_API_KEY` set; visible dedicated Chrome for `acct_todo` appears on first run.
2. `scripts/pixie_todo_demo.sh publish` — each of create/list/update/delete is live-tested, then published as revision 1 (Studio shows checksum + OpenAPI).
3. `scripts/pixie_todo_demo.sh crud <suffix>` — a separate client creates `pixie-demo <suffix>`, lists it, renames it, deletes it, lists again; each result is accepted only after independent checks (counts, exact titles, siblings). Then the safety cases: duplicate create, nonexistent delete, out-of-prefix delete → `needs_review`, nothing changed.
4. Studio → run inspector: React Flow stages lit by real events, Jev decision detail (operation, target, model, latency), per-step browser evidence.
5. Optional P7: `isolation-before <s>` → Ctrl-C the API → restart → `isolation-after <s>` shows the task survived in `acct_todo` and `acct_todo_b` cannot see or delete it.

Known visible limitation: upstream Jev drives a background CDP tab, so the visible window does not animate typing; the per-step screenshots in Studio are the browser evidence. Observed live timings (single rehearsal, not a benchmark): create 3 model calls / 3 actions; from the P7 rehearsal run records: list 16–20 s, delete 23 s, refused delete 16 s (request-to-terminal, including independent verification).

## 30-second pitch

“We build software for dental practices, where some information still requires someone to sign into a portal, find a patient, and read several screens. Gateway lets a developer demonstrate that browser process, define its inputs and outputs, and publish it as an API. Jev drives the browser decisions, and Gateway checks the result before returning it to the application.”

## What is original

The recorder-to-service lifecycle: human demonstration, reviewed API contract, versioned endpoints, and independently verified output. Attribute the reused Tandem recorder and Browser Use Jev Ultrafast engine. Confirm organizer rules about pre-existing code; do not imply imported components were built during the event.

## Demonstration setup

- Run Gateway and a clearly labeled synthetic eligibility portal.
- Use fictional `DEMO-1001` and `DEMO-1002` with different expected results.
- Use a dedicated browser profile without real patient sessions.
- Validate Jev access and any configured text-model access before presenting.
- Open the developer studio and a separate API client/terminal.
- Prepare a fresh draft; have an honestly labeled previously recorded example as backup.
- Confirm the demo's exact success assertions, expected values and failure fixture.
- Verify all URLs and commands against the implemented README. Paths here are target contracts.

## Three-minute walkthrough

| Time | Action | What to say / prove |
|---|---|---|
| 0:00–0:20 | Show the portal and Gateway | “This is a synthetic portal modeling the eligibility lookup we need to integrate.” |
| 0:20–0:55 | Start recording, demonstrate one lookup, stop | Actual browser capture, not a prerecorded animation posing as live input |
| 0:55–1:20 | Name memberId input and output fields; review assertions | The developer decides what varies and what counts as success |
| 1:20–1:50 | Test using DEMO-1002; show Jev decisions | The engine operates the browser with a different input |
| 1:50–2:15 | Publish the tested revision and call the API | A separate software client can invoke the operation |
| 2:15–2:40 | Inspect result plus evidence; run incomplete-result fixture | Correct result accepted; insufficient evidence yields needs_review |
| 2:40–3:00 | Close on endpoint/contract and attribution | “Demonstrate the task, define the result, and let your application call it.” |

If the live workflow cannot fit this timing, demonstrate one real recording step then use a clearly labeled saved recording for review. Do not speed up footage without disclosure or label prepared results as fresh execution. Adjust the length to the organizer's actual allotted demo time.

## Example API request

Illustrative until implementation validates the generated contract. Use an environment-held demo token; do not project its value.

```sh
curl -sS "$GATEWAY_URL/v1/automations/eligibility-overview/runs"   -H "Authorization: Bearer $GATEWAY_API_TOKEN"   -H 'Content-Type: application/json'   -H 'Idempotency-Key: demo-second-member-1'   -d '{"revision":1,"accountId":"demo-account","input":{"memberId":"DEMO-1002"}}'
```

Expected: 202 with runId and statusUrl. Poll until terminal, then fetch result only if completed. For a fresh repeat demonstration use a new idempotency key; reusing the same key intentionally returns the existing run.

## Explain Jev's contribution precisely

Show an observed element list, chosen operation/target and actual model metadata. Explain that Jev Ultrafast uses Jev to select browser actions; a separate helper can generate text where required. Gateway adds contract enforcement, execution lifecycle, extraction and completion checks. Do not claim Jev itself records human actions or that DONE proves success.

## Judge evidence

| Criterion, 25% each | Evidence to keep visible |
|---|---|
| Use of Jev | Real calls and browser action history |
| Originality | Recorded example becomes reusable endpoint with changed input |
| Technical | Valid client request, typed output, wrong-record/missing-field rejection |
| Anti-Slop | Working controls, clear states, readable interface, no fabricated metrics |

## Measured-results sheet

Fill only after actual execution. Unknown values remain blank.

| Measurement | Observed result |
|---|---|
| Engine revision and model | jev-ultrafast `1231850a`, model `jev-1.13.0` (live, TypeSafe) |
| Recording-to-publish time | P2 Studio rehearsal: record → parameterize → test → publish in one sitting; Studio test run 9–10 s of Jev execution (3 model calls, 2 actions) |
| Full API request-to-result time | Eligibility DEMO-1002 ~1.1 s scripted engine; Todo live: list 16–20 s, delete 23 s (P7 rehearsal run records, request-to-terminal) |
| Engine-only duration / model calls | Todo create: 3 model calls / 3 actions; eligibility: 3 calls / 3 actions; first live seam call 142 ms |
| Correct second-member output | Verified (DEMO-1002 accepted, checks pass) |
| Wrong-member / incomplete-output rejection | Verified (DEMO-2001, DEMO-3001 → needs_review); Todo duplicate/nonexistent/out-of-prefix → needs_review |
| Auth expiry / deadline behavior | Scripted fixture + tests only; not rehearsed live |

No general speed or reliability claim follows from a single run.

## Failure recovery during presentation

- Model/API outage: show the real error, then a labeled prior successful run if available.
- Browser setup failure: use a labeled recording of the actual product, state what failed live.
- Incorrect result: show the failed assertion and exception, do not edit data to pretend it passed.
- Unimplemented feature: remove its interactive control or label it unavailable; do not stage fake interaction.

## Submission checklist

- Confirm event rules, deadline and allowed prior work; the supplied brief said submit before 2:30 p.m. PT September 26.
- Include repository access instructions, a working demo link or local run instructions, and short video if accepted by organizers.
- Describe precisely which parts were built during the event.
- Verify repo/video contain only synthetic records and no credentials.
- If pursuing the CodeRabbit Coding Agent award, document actual Coding Agent use. CLI review alone is a different capability.
- General CodeRabbit tool-use award requires a public post according to the supplied screenshot; prepare it separately and publish only with user authorization.
- No submission, social post, credit redemption or organizer message is authorized by this file.
