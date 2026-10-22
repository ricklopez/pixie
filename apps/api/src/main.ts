import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { todoScript } from "@gateway/definition";
import { bootstrap, buildApp } from "./app.js";
import { BrowserbaseProvider, LocalBrowserProvider } from "./browser-provider.js";
import { BrowserPool, recorderProfile } from "./browsers.js";
import { openDatabase } from "./db.js";
import { SubprocessRunner } from "./worker.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const env = process.env;
const port = Number(env.GATEWAY_PORT ?? 4180);
const dataDir = resolve(env.GATEWAY_DATA_DIR ?? resolve(root, "artifacts/gateway"));
const portalOrigin = env.GATEWAY_PORTAL_ORIGIN ?? "http://127.0.0.1:4174";
const engine = (env.GATEWAY_ENGINE ?? "live") as "live" | "scripted";
const publicBaseUrl = env.GATEWAY_PUBLIC_URL ?? `http://127.0.0.1:${port}`;

mkdirSync(dataDir, { recursive: true });
const db = openDatabase(resolve(dataDir, "gateway.sqlite"));
bootstrap(
  db,
  {
    developer: env.GATEWAY_DEV_TOKEN ?? "dev-token-local",
    client: env.GATEWAY_CLIENT_TOKEN ?? "client-token-local",
    otherTenantClient: env.GATEWAY_OTHER_CLIENT_TOKEN ?? "other-client-token-local"
  },
  portalOrigin
);

// One dedicated Chrome profile per account under browser-data/<accountId> (plus one for the Studio recorder);
// GATEWAY_CDP_URL collapses them onto a single external browser for development only.
const browsers = new BrowserPool({
  root: resolve(dataDir, "browser-data"),
  basePort: Number(env.GATEWAY_CHROME_PORT ?? 9333),
  mode: env.GATEWAY_BROWSER_VISIBLE === "1" ? "visible" : "headless",
  onRecovered: (name, cdpUrl) => console.warn(`browser profile ${name}: no open tabs on ${cdpUrl}; opened about:blank to restore a usable context`),
  ...(env.GATEWAY_CDP_URL ? { fixedCdpUrl: env.GATEWAY_CDP_URL } : {})
});
const localProvider = new LocalBrowserProvider(browsers);
const browserbaseProvider = new BrowserbaseProvider({ projectId: env.BROWSERBASE_PROJECT_ID });
if (env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID) await browserbaseProvider.sweepOrphans();

if (engine === "live" && !env.TYPESAFE_API_KEY) {
  console.error("GATEWAY_ENGINE=live requires TYPESAFE_API_KEY in the environment (never in the repository). Set GATEWAY_ENGINE=scripted for an offline demo without a model.");
  process.exit(2);
}

const runner = new SubprocessRunner({ workerDir: resolve(root, "workers/jev"), cdpUrl: (accountId) => browsers.cdpUrlFor(accountId) });
const { app, shutdown } = buildApp({
  db,
  runner,
  evidenceRoot: resolve(dataDir, "evidence"),
  cdpUrl: (tenantId) => browsers.cdpUrlFor(recorderProfile(tenantId)),
  browserProviders: { local: localProvider, browserbase: browserbaseProvider },
  browserbaseProvider,
  browserProfiles: () => browsers.profiles(),
  allowLoopback: env.GATEWAY_ALLOW_LOOPBACK !== "0",
  publicBaseUrl,
  logger: env.GATEWAY_LOG !== "0",
  selectEngine: (definition, input) =>
    engine === "live"
      ? { engine: "live" }
      : {
          engine: "scripted",
          script: todoScript(definition, input) ?? [
            { operation: "TYPE_TEXT", label: "Member ID" },
            { operation: "CLICK", label: "Search" },
            { operation: "CLICK", label: "View benefits overview" }
          ]
        }
});

await app.listen({ port, host: "127.0.0.1" });
console.log(`gateway api listening on http://127.0.0.1:${port} (engine=${engine}, data=${dataDir})`);

const stop = async () => {
  await shutdown();
  await browsers.closeAll();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
