import { startFixture } from "./server.js";

const fixture = await startFixture({
  variant: (process.env.FIXTURE_VARIANT ?? "baseline") as "baseline" | "cosmetic" | "locator-break" | "ambiguous" | "rule-change",
  port: Number(process.env.PORT ?? 4174),
  dbPath: process.env.FIXTURE_DB ?? "experiments-001.sqlite"
});
console.log(`Fixture ${fixture.variant} listening at ${fixture.baseUrl}`);
process.once("SIGINT", () => void fixture.close().then(() => process.exit(0)));
process.once("SIGTERM", () => void fixture.close().then(() => process.exit(0)));
