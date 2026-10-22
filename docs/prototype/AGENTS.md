# Gateway contributor instructions

Read README.md, product-overview.md, spec.md, and demo.md before implementation. notes.md is historical and may contain superseded alternatives. The current deliverable is the recorder-to-Jev-to-endpoint slice, not a static mockup.

- Keep user inputs, typed outputs, independent assertions and observed evidence linked to immutable automation versions.
- Never treat the agent's DONE status, a successful HTTP response, or a CodeRabbit comment as proof of business correctness.
- Use synthetic test data. Never commit .env, credentials, session state, raw recordings, clinical information or runtime screenshots.
- Keep capture and execution adapters separate. Record unsupported events explicitly; do not silently drop them and claim complete replay.
- Preserve tenant/account isolation and validate origin/effect policy in code. Prompt instructions alone do not enforce permissions.
- Pin upstream engine revisions and preserve license notices. Don't modify the dental source repository during extraction.
- All model/browser integration tests must be opt-in; offline CI must not contact production portals or paid models.
- Add meaningful application tests and CI with the implementation. The initial repository check only validates documentation/scaffolding.
- Work through pull requests. No auto-merge or public deployment without user instruction.
- Report actual commands/results and live-vs-mocked evidence. Keep unimplemented functions visibly unavailable.
