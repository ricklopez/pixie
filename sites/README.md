# Pixie sites and clickable demos

These folders contain source, not Git submodules. Clone this repository to get the sites together with the product plans.

| Folder | Purpose | Hosted version |
| --- | --- | --- |
| `pixie-public` | Original public landing page | https://pixie.so |
| `pixie-vision` | Product vision and pitch | https://pixie-vision.ricklopezio.chatgpt.site |
| `pixie-v1-demo` | Interactive CLI → Studio → Render publication concept | https://pixie-v1-demo.ricklopezio.chatgpt.site |

## V1 clickable demo

Requires Node.js 20.19+ (or a current supported LTS) and npm.

```sh
cd sites/pixie-v1-demo
npm ci
npm run dev
```

Open the printed localhost URL (default port 4201). For a production bundle:

```sh
npm run build
```

The demo uses React and Framer Motion. All CLI commands, browser sessions, Jev traces, key setup, API calls,
and Render deployment steps are simulated. No provider credentials are needed. No real product implementation is included.

Suggested walkthrough: CLI setup → Studio → Connection → simulated sign-in/MFA → local verification → Test replay
→ API → simulated Render/Browserbase setup → Publish API → Stop local CLI → invoke hosted sample. Repair remains available.

## Public landing page

The original site includes the particle theme, design-system pages, interactive previews, and a Worker-backed
signup form. Preview uses a local Miniflare database; production signup records are not included.

```sh
cd sites/pixie-public
npm ci
npm run build
npm test
node scripts/preview.mjs
```

Open http://127.0.0.1:4189. Requires a Node version supported by the locked Miniflare release (use Node 22 LTS or later).
`public/` and `server/` are authored source; `dist/server/index.js` is the existing tracked deployment bundle.

## Vision site

This is a buildless site; `dist/index.html` is its authored source and is intentionally tracked.

```sh
python3 -m http.server 4202 --directory sites/pixie-vision/dist
```

## Publishing and source ownership

The `.openai/hosting.json` files preserve the identity of each existing Codex Site. They contain deployment metadata,
not credentials. Changes in GitHub do not automatically publish a Site. To publish, synchronize the selected folder
into that Site's dedicated publishing checkout, build it where required, and use the Sites workflow for that exact
project ID. Preserve the Site's audience. Do not run the standalone Sites Git helper inside this monorepo: it owns
its checkout's Git remote and commit/push process. Never replace this repository's origin with a Site source remote.

Dependencies, generated Vite bundles, local environment files, and Git credentials are not included. Authored static
assets may live under `dist/` for the buildless sites. Provider configuration for the future open-source product is
specified in `docs/v1-plan.md`; none is needed for these previews.
