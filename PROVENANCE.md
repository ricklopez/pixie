# Prototype provenance

## Source

The imported application prototype comes from `ricklopezio/gateway` at
`e977fb43736bbd6de0b69a19a7b4bcc91bda5ca6` (`origin/pr/2`), checked out in
the separate `/home/ubuntu/repos/gateway-impl` worktree. The Gateway worktree
was not modified.

## Imported files

The tracked files from these paths were archived from that exact commit:

- `apps/{api,studio,cli,portal}/`
- `packages/{definition,recorder}/`
- `workers/jev/`
- `scripts/{e2e-flow.sh,pixie_todo_demo.sh,demo-client.mjs,check_repository.py}`
- `automations/`
- `eslint.config.js`, `tsconfig.base.json`, root `package.json`,
  `package-lock.json`, and `.env.example`
- `docs/research/` and `docs/phases/`, relocated to
  `docs/prototype/{research,phases}/`
- Gateway's root `AGENTS.md`, `DEVIN_HANDOFF.md`, `notes.md`, `spec.md`,
  `demo.md`, `product-overview.md`, and `README.md`, relocated under
  `docs/prototype/` for reference. Pixie's root `README.md` was not replaced.

The root manifest was imported as a reviewable source snapshot and is then
adapted for the Pixie repository: its package name is `pixie`, while workspace
package names and `GATEWAY_*` environment variable names remain unchanged.
Gateway's ignore patterns are merged into Pixie's root `.gitignore`; the
Gateway `.gitignore` was not copied over Pixie's file.

## Excluded

The archive contains only files tracked at the source commit. No `.env`,
artifacts, databases, browser profiles, recordings, screenshots, generated
runtime state, or untracked files were copied. The private `relayvault/dental`
recorder was never accessed or used. Pixie's existing `product/`, `sites/`,
and Experiment 001 files were not imported or changed; PR #4 was not
cherry-picked or duplicated.

The source repository has no tracked `LICENSE` or `COPYING` file. The
`workers/jev` dependency remains pinned to
`browser-use/jev-ultrafast@1231850a0bf1a0c0341fe408ef1668dbbfdfac46`. That
upstream project is MIT-licensed; its attribution and license reference are
preserved in `docs/prototype/research/jev-ultrafast.md`. Jev source code itself
was not copied.

The imported `.env.example` contains only blank configuration values and
non-secret setting names; it contains no credentials.
